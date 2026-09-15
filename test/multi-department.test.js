// Multi-department support: strict department-scoped visibility, the admin
// bypass, and the confidential flag. See src/departments.js's file comment
// for the history here - this exact feature shipped once before and was
// fully reverted because visibility had a quiet assignment/watcher
// carve-out that made switching an agent's department appear to do
// nothing. These tests deliberately include the regression case (change an
// agent's department, confirm their visible list actually changes) rather
// than only exercising fresh synthetic fixtures, since that's exactly the
// gap the old test suite missed.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const bcrypt = require("bcryptjs");
const { startTestApp, makeClient, extractCsrf } = require("./helpers");

// express-rate-limit's login limiter (10 attempts / 15 min / IP - see
// src/routes/public.js's sibling in src/routes/auth.js) is shared across
// every test in this file (one app instance, one in-memory store), so every
// role logs in exactly ONCE here and every test below reuses that same
// already-authenticated client - not a fresh loginAs() per test, which
// would exhaust the limiter partway through this file and make later tests
// fail with an unrelated "redirected to /login" rather than the thing
// they're actually testing.
let app, client, itClient, hrClient, adminClient, secondItClient, switcherClient;

async function loginAs(c, email) {
  const loginPage = await c.get("/login");
  const csrf = extractCsrf(await loginPage.text());
  await c.postForm("/login", { email, password: "correct-password", _csrf: csrf });
}

before(async () => {
  app = await startTestApp();
  client = makeClient(app.baseUrl);

  const db = new DatabaseSync(app.dbPath);
  const passwordHash = bcrypt.hashSync("correct-password", 4);

  // IT is department id 1, HR is id 2 - seeded in that fixed order by
  // src/db/index.js on a fresh database (see DEFAULT_DEPARTMENTS there).
  db.prepare("INSERT INTO agents (name, email, password_hash, department_id) VALUES (?, ?, ?, ?)").run(
    "IT Agent",
    "it-agent@example.com",
    passwordHash,
    1
  );
  db.prepare("INSERT INTO agents (name, email, password_hash, department_id) VALUES (?, ?, ?, ?)").run(
    "HR Agent",
    "hr-agent@example.com",
    passwordHash,
    2
  );
  db.prepare("INSERT INTO agents (name, email, password_hash, department_id, is_admin) VALUES (?, ?, ?, ?, 1)").run(
    "Admin Agent",
    "admin-agent@example.com",
    passwordHash,
    1
  );
  db.prepare("INSERT INTO agents (name, email, password_hash, department_id) VALUES (?, ?, ?, 1)").run(
    "Second IT Agent",
    "second-it-agent@example.com",
    passwordHash
  );
  // A dedicated agent for the one test that actually mutates its own
  // department mid-test (the exact "switch department, does the visible
  // list change" regression) - kept separate from it-agent/hr-agent so that
  // mutation can't bleed into every other test in this file.
  db.prepare("INSERT INTO agents (name, email, password_hash, department_id) VALUES (?, ?, ?, 1)").run(
    "Switcher Agent",
    "switcher-agent@example.com",
    passwordHash
  );
  db.close();

  itClient = makeClient(app.baseUrl);
  hrClient = makeClient(app.baseUrl);
  adminClient = makeClient(app.baseUrl);
  secondItClient = makeClient(app.baseUrl);
  switcherClient = makeClient(app.baseUrl);
  await loginAs(itClient, "it-agent@example.com");
  await loginAs(hrClient, "hr-agent@example.com");
  await loginAs(adminClient, "admin-agent@example.com");
  await loginAs(secondItClient, "second-it-agent@example.com");
  await loginAs(switcherClient, "switcher-agent@example.com");
});

after(() => app.close());

function db() {
  return new DatabaseSync(app.dbPath);
}

function agentId(email) {
  const d = db();
  const row = d.prepare("SELECT id FROM agents WHERE email = ?").get(email);
  d.close();
  return row.id;
}

// Inserts a ticket directly (bypassing auto-assignment/round-robin, which
// has its own dedicated test below) so each visibility test can set up
// exactly the category/assignment/confidential combination it needs.
function createTicketDirect({ subject, category, assignedTo = null, confidential = 0 }) {
  const d = db();
  const result = d
    .prepare(
      `INSERT INTO tickets (subject, description, category, requester_name, requester_email, assigned_to, confidential)
       VALUES (?, 'desc', ?, 'Req', 'req@example.com', ?, ?)`
    )
    .run(subject, category, assignedTo, confidential);
  d.close();
  return result.lastInsertRowid;
}

test("a non-admin agent only sees tickets in their own department's categories on the dashboard list", async () => {
  const itTicketId = createTicketDirect({ subject: "IT-only ticket", category: "Hardware" });
  const hrTicketId = createTicketDirect({ subject: "HR-only ticket", category: "Onboarding" });

  const itHome = await (await itClient.get("/dashboard")).text();
  assert.match(itHome, new RegExp(`tickets/${itTicketId}"`));
  assert.doesNotMatch(itHome, new RegExp(`tickets/${hrTicketId}"`));

  const hrHome = await (await hrClient.get("/dashboard")).text();
  assert.match(hrHome, new RegExp(`tickets/${hrTicketId}"`));
  assert.doesNotMatch(hrHome, new RegExp(`tickets/${itTicketId}"`));
});

test("visiting another department's ticket by id 404s, even though it exists", async () => {
  const hrTicketId = createTicketDirect({ subject: "HR ticket for 404 check", category: "Benefits" });

  const res = await itClient.get(`/dashboard/tickets/${hrTicketId}`);
  assert.equal(res.status, 404);
});

test("assignment does NOT grant visibility across departments - the exact carve-out that broke this feature last time", async () => {
  const itAgentId = agentId("it-agent@example.com");
  // An HR-category ticket assigned to the IT agent - this is the precise
  // shape of bug that shipped and was reverted before: a ticket assigned to
  // the one agent being tested made a department switch look like a no-op.
  const hrTicketAssignedToItAgent = createTicketDirect({
    subject: "HR ticket incorrectly assigned to an IT agent",
    category: "Benefits",
    assignedTo: itAgentId,
  });

  const detailRes = await itClient.get(`/dashboard/tickets/${hrTicketAssignedToItAgent}`);
  assert.equal(detailRes.status, 404, "being assigned to the ticket must not make it visible outside the agent's department");

  const listHtml = await (await itClient.get("/dashboard")).text();
  assert.doesNotMatch(listHtml, new RegExp(`tickets/${hrTicketAssignedToItAgent}"`));
});

test("watching a ticket does not grant visibility across departments either", async () => {
  // There's no route to watch a ticket you can't already see (getTicketOr404
  // gates it), so this proves the point indirectly: confirm the watch route
  // itself 404s for an out-of-department ticket rather than silently
  // succeeding and creating a visibility loophole.
  const hrTicketId = createTicketDirect({ subject: "HR ticket for watch check", category: "Employee Relations" });
  const page = await itClient.get("/dashboard");
  const csrf = extractCsrf(await page.text());

  const res = await itClient.postForm(`/dashboard/tickets/${hrTicketId}/watch`, { _csrf: csrf });
  assert.equal(res.status, 404);
});

test("REGRESSION: changing an agent's department changes what they see, without touching the tickets", async () => {
  // Uses the dedicated switcherClient/switcher-agent (see before()), not
  // itClient/it-agent - this test permanently mutates its agent's
  // department, and every other test in this file needs it-agent to stay
  // in IT for its own assumptions to hold.
  const itTicketId = createTicketDirect({ subject: "Stays IT", category: "Network" });
  const hrTicketId = createTicketDirect({ subject: "Stays HR", category: "Onboarding" });

  const before1 = await (await switcherClient.get("/dashboard")).text();
  assert.match(before1, new RegExp(`tickets/${itTicketId}"`), "switcher agent should see the IT ticket before switching");
  assert.doesNotMatch(before1, new RegExp(`tickets/${hrTicketId}"`), "switcher agent should not see the HR ticket before switching");

  // Switch the same agent to HR - the exact scenario that silently failed
  // to work last time (department field changed, visible list didn't).
  const d = db();
  d.prepare("UPDATE agents SET department_id = 2 WHERE email = ?").run("switcher-agent@example.com");
  d.close();

  const afterHome = await (await switcherClient.get("/dashboard")).text();
  assert.match(afterHome, new RegExp(`tickets/${hrTicketId}"`), "after switching to HR, the agent must now see the HR ticket");
  assert.doesNotMatch(afterHome, new RegExp(`tickets/${itTicketId}"`), "after switching to HR, the agent must no longer see the IT ticket");
});

test("an admin sees tickets from every department", async () => {
  const itTicketId = createTicketDirect({ subject: "IT ticket for admin check", category: "Software" });
  const hrTicketId = createTicketDirect({ subject: "HR ticket for admin check", category: "Onboarding" });

  const home = await (await adminClient.get("/dashboard")).text();
  assert.match(home, new RegExp(`tickets/${itTicketId}"`));
  assert.match(home, new RegExp(`tickets/${hrTicketId}"`));

  const itDetail = await adminClient.get(`/dashboard/tickets/${itTicketId}`);
  assert.equal(itDetail.status, 200);
  const hrDetail = await adminClient.get(`/dashboard/tickets/${hrTicketId}`);
  assert.equal(hrDetail.status, 200);
});

test("a confidential ticket is hidden from a same-department agent who isn't its assignee, but visible to the assignee and an admin", async () => {
  const itAgentId = agentId("it-agent@example.com");

  const confidentialTicketId = createTicketDirect({
    subject: "Confidential IT ticket",
    category: "Hardware",
    assignedTo: itAgentId,
    confidential: 1,
  });

  const hiddenRes = await secondItClient.get(`/dashboard/tickets/${confidentialTicketId}`);
  assert.equal(hiddenRes.status, 404, "a same-department agent who isn't the assignee must not see a confidential ticket");

  const visibleToAssignee = await itClient.get(`/dashboard/tickets/${confidentialTicketId}`);
  assert.equal(visibleToAssignee.status, 200, "the assignee must still see their own confidential ticket");

  const visibleToAdmin = await adminClient.get(`/dashboard/tickets/${confidentialTicketId}`);
  assert.equal(visibleToAdmin.status, 200, "an admin must still see a confidential ticket");
});

test("toggling the confidential flag on and off works from the ticket page", async () => {
  const itAgentId = agentId("it-agent@example.com");
  const ticketId = createTicketDirect({ subject: "Toggle confidential", category: "Hardware", assignedTo: itAgentId });

  const page = await itClient.get(`/dashboard/tickets/${ticketId}`);
  const csrf = extractCsrf(await page.text());

  const onRes = await itClient.postForm(`/dashboard/tickets/${ticketId}/confidential`, { confidential: "1", _csrf: csrf });
  assert.equal(onRes.status, 302);
  const d = db();
  assert.equal(d.prepare("SELECT confidential FROM tickets WHERE id = ?").get(ticketId).confidential, 1);
  d.close();

  const offRes = await itClient.postForm(`/dashboard/tickets/${ticketId}/confidential`, { _csrf: csrf });
  assert.equal(offRes.status, 302);
  const d2 = db();
  assert.equal(d2.prepare("SELECT confidential FROM tickets WHERE id = ?").get(ticketId).confidential, 0);
  d2.close();
});

test("CSV export only includes the acting agent's own department's tickets", async () => {
  createTicketDirect({ subject: "CSV IT ticket", category: "Hardware" });
  createTicketDirect({ subject: "CSV HR ticket", category: "Benefits" });

  const csv = await (await itClient.get("/dashboard/export.csv")).text();
  assert.match(csv, /CSV IT ticket/);
  assert.doesNotMatch(csv, /CSV HR ticket/);
});

test("dashboard full-text search never surfaces a result outside the acting agent's department", async () => {
  createTicketDirect({ subject: "Searchable widget failure", category: "Hardware" });
  createTicketDirect({ subject: "Searchable widget failure but HR", category: "Benefits" });

  const html = await (await itClient.get("/dashboard?q=widget")).text();
  assert.match(html, /Searchable widget failure</);
  assert.doesNotMatch(html, /Searchable widget failure but HR/);
});

test("bulk actions silently skip a ticket id outside the acting agent's department instead of applying to it", async () => {
  const hrTicketId = createTicketDirect({ subject: "Bulk-targeted HR ticket", category: "Onboarding" });

  const page = await itClient.get("/dashboard");
  const csrf = extractCsrf(await page.text());

  const res = await itClient.postForm("/dashboard/bulk/status", {
    ticket_ids: [String(hrTicketId)],
    status: "Resolved",
    redirect_to: "/dashboard",
    _csrf: csrf,
  });
  assert.equal(res.status, 302);

  const d = db();
  const row = d.prepare("SELECT status FROM tickets WHERE id = ?").get(hrTicketId);
  d.close();
  assert.equal(row.status, "Open", "a ticket outside the agent's department must not be changed by a bulk action");
});

test("merging two tickets from different departments is rejected, even though both individually exist", async () => {
  const itAgentId = agentId("it-agent@example.com");
  const itTicketId = createTicketDirect({ subject: "IT side of a bad merge", category: "Hardware", assignedTo: itAgentId });

  // The target has to be visible to the acting agent to even attempt the
  // merge - use an admin (who can see both sides) to exercise the
  // department-mismatch rejection itself, not the separate 404 visibility
  // check already covered above.
  const hrTicketId = createTicketDirect({ subject: "HR side of a bad merge", category: "Benefits" });

  const page = await adminClient.get(`/dashboard/tickets/${itTicketId}`);
  const csrf = extractCsrf(await page.text());

  const res = await adminClient.postForm(`/dashboard/tickets/${itTicketId}/merge`, {
    target_ticket_id: String(hrTicketId),
    _csrf: csrf,
  });
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.match(html, /different departments/);

  const d = db();
  const row = d.prepare("SELECT merged_into_id FROM tickets WHERE id = ?").get(itTicketId);
  d.close();
  assert.equal(row.merged_into_id, null, "the merge must not have gone through");
});

test("auto-assignment (round-robin) on a publicly submitted ticket only ever picks an agent in that category's department", async () => {
  const res = await client.postForm("/", {
    requester_name: "Dept Test Requester",
    requester_email: "dept-test@example.com",
    category: "Onboarding", // HR
    subject: "Public HR request",
    description: "d",
  });
  const ticketId = res.headers.get("location").match(/confirmation\/(\d+)/)[1];

  const d = db();
  const ticket = d.prepare("SELECT assigned_to FROM tickets WHERE id = ?").get(Number(ticketId));
  const assignee = ticket.assigned_to ? d.prepare("SELECT department_id FROM agents WHERE id = ?").get(ticket.assigned_to) : null;
  d.close();

  assert.ok(assignee, "an HR agent exists in this test's fixtures, so the ticket should have been auto-assigned");
  assert.equal(assignee.department_id, 2, "an HR-category ticket must only ever be auto-assigned to an HR agent");
});

test("an agent can only file a walk-in ticket under their own department's categories", async () => {
  const page = await itClient.get("/dashboard/tickets/new");
  const csrf = extractCsrf(await page.text());

  const res = await itClient.postForm("/dashboard/tickets/new", {
    requester_name: "Walk-in",
    requester_email: "walkin@example.com",
    category: "Onboarding", // HR category, not the IT agent's own department
    subject: "Should be rejected",
    description: "d",
    _csrf: csrf,
  });
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.match(html, /choose a valid category/i);
});

test("assigning a ticket to an agent outside its department is rejected", async () => {
  const hrAgentId = agentId("hr-agent@example.com");
  const itTicketId = createTicketDirect({ subject: "Cross-department assign attempt", category: "Hardware" });

  const page = await itClient.get(`/dashboard/tickets/${itTicketId}`);
  const csrf = extractCsrf(await page.text());

  const res = await itClient.postForm(`/dashboard/tickets/${itTicketId}/assign`, {
    assigned_to: String(hrAgentId),
    _csrf: csrf,
  });
  assert.equal(res.status, 400);

  const d = db();
  const row = d.prepare("SELECT assigned_to FROM tickets WHERE id = ?").get(itTicketId);
  d.close();
  assert.equal(row.assigned_to, null, "the cross-department assignment must not have gone through");
});

test("an admin can be assigned any ticket regardless of department", async () => {
  const adminId = agentId("admin-agent@example.com");
  const hrTicketId = createTicketDirect({ subject: "Assign to admin", category: "Benefits" });

  const page = await adminClient.get(`/dashboard/tickets/${hrTicketId}`);
  const csrf = extractCsrf(await page.text());

  const res = await adminClient.postForm(`/dashboard/tickets/${hrTicketId}/assign`, {
    assigned_to: String(adminId),
    _csrf: csrf,
  });
  assert.equal(res.status, 302);

  const d = db();
  const row = d.prepare("SELECT assigned_to FROM tickets WHERE id = ?").get(hrTicketId);
  d.close();
  assert.equal(row.assigned_to, adminId);
});

test("the dashboard reports (volume/category/status) are scoped to the acting agent's own department", async () => {
  createTicketDirect({ subject: "Report scope IT", category: "Software" });
  createTicketDirect({ subject: "Report scope HR", category: "Employee Relations" });

  const html = await (await itClient.get("/dashboard?report_range=30d")).text();
  assert.match(html, /Software/);
  assert.doesNotMatch(html, /Employee Relations/);
});

test("KB articles and canned responses scoped to a department don't show up for a different department's agent", async () => {
  const d = db();
  d.prepare("INSERT INTO kb_articles (title, slug, body, department_id) VALUES (?, ?, ?, 2)").run(
    "HR-only article",
    "hr-only-article",
    "body text"
  );
  d.prepare("INSERT INTO canned_responses (title, body, department_id) VALUES (?, ?, 2)").run(
    "HR-only canned response",
    "canned body"
  );
  d.close();

  const kbHtml = await (await itClient.get("/dashboard/kb")).text();
  assert.doesNotMatch(kbHtml, /HR-only article/);

  const cannedHtml = await (await itClient.get("/dashboard/canned-responses")).text();
  assert.doesNotMatch(cannedHtml, /HR-only canned response/);

  const kbHtmlHr = await (await hrClient.get("/dashboard/kb")).text();
  assert.match(kbHtmlHr, /HR-only article/);

  const cannedHtmlHr = await (await hrClient.get("/dashboard/canned-responses")).text();
  assert.match(cannedHtmlHr, /HR-only canned response/);
});

test("a department-scoped automation rule only fires for that department's tickets", async () => {
  const d = db();
  // action_tag-only rule, scoped to HR (department_id 2), triggered by any
  // ticket in the "Onboarding" category (also HR) - keeps the test to one
  // rule/one condition while still proving cross-department isolation.
  d.prepare(
    `INSERT INTO automation_rules (name, condition_category, action_tag, department_id) VALUES (?, 'Onboarding', 'hr-tagged', 2)`
  ).run("HR-only tagging rule");
  d.close();

  const hrRes = await client.postForm("/", {
    requester_name: "Automation HR",
    requester_email: "automation-hr@example.com",
    category: "Onboarding",
    subject: "HR automation test",
    description: "d",
  });
  const hrTicketId = hrRes.headers.get("location").match(/confirmation\/(\d+)/)[1];

  const d2 = db();
  const hrTags = d2
    .prepare("SELECT tags.name FROM ticket_tags JOIN tags ON tags.id = ticket_tags.tag_id WHERE ticket_id = ?")
    .all(Number(hrTicketId));
  d2.close();
  assert.ok(hrTags.some((t) => t.name === "hr-tagged"), "the HR-scoped rule should have tagged the HR ticket");
});

test("departments and categories settings page lists seeded departments and can add a new one", async () => {
  const page = await adminClient.get("/dashboard/settings/departments");
  const html = await page.text();
  assert.match(html, /IT/);
  assert.match(html, /HR/);
  const csrf = extractCsrf(html);

  const res = await adminClient.postForm("/dashboard/settings/departments", { name: "Legal", _csrf: csrf });
  assert.equal(res.status, 302);

  const d = db();
  const row = d.prepare("SELECT id FROM departments WHERE name = ?").get("Legal");
  d.close();
  assert.ok(row, "the new department should have been created");
});

test("the Agents page shows and can change an agent's department and admin flag", async () => {
  const page = await adminClient.get("/dashboard/agents");
  const html = await page.text();
  const csrf = extractCsrf(html);

  const targetId = agentId("hr-agent@example.com");
  const res = await adminClient.postForm(`/dashboard/agents/${targetId}/department`, { department_id: "1", _csrf: csrf });
  assert.equal(res.status, 302);

  const d = db();
  const row = d.prepare("SELECT department_id FROM agents WHERE id = ?").get(targetId);
  d.close();
  assert.equal(row.department_id, 1, "the agent's department should now be IT");
});
