const express = require("express");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { requireAgent } = require("../middleware/auth");
const { verifyCsrf } = require("../middleware/csrf");
const { CATEGORIES, PRIORITIES, STATUSES, ASSET_CATEGORIES, ASSET_STATUSES, PAGE_SIZE } = require("../constants");
const { isAgingTicket, annotateAging, currentThresholds } = require("../aging");
const { sendStatusChangeEmail, sendResolvedEmail, sendReplyEmail, sendTicketCreatedEmail, sendMentionEmail } = require("../mailer");
const { findMentionedAgents } = require("../mentions");
const { toCsv } = require("../csv");
const { addTagToTicket, removeTagFromTicket, tagsForTicket, allTags } = require("../tags");
const canned = require("../canned-responses");
const assets = require("../assets");
const { exportRequesterData, eraseRequesterData } = require("../privacy");
const { WEBHOOK_EVENTS, generateSecret, triggerWebhooks } = require("../webhooks");
const { WARRANTY_ALERT_DAYS } = require("../warranty");
const kb = require("../kb");
const customFields = require("../custom-fields");
const {
  ATTACHMENTS_DIR,
  SAFE_PREVIEW_TYPES,
  handleUpload,
  saveAttachments,
  deleteUploadedFiles,
  attachmentsForTicket,
  getAttachment,
  formatSize,
  LIMITS_HINT,
} = require("../attachments");

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.use(requireAgent);

function getTicketOr404(res, id) {
  const ticket = db.prepare("SELECT * FROM tickets WHERE id = ?").get(id);
  if (!ticket) {
    res.status(404).render("error", { title: "Not found", message: "That ticket does not exist." });
    return null;
  }
  return ticket;
}

// Turns free-text search input into a safe FTS5 MATCH expression. Each
// whitespace-separated token becomes a quoted-literal prefix search
// ("token"*) - wrapping in quotes means embedded FTS operators/punctuation
// in the user's own input are always treated as literal text, never query
// syntax, and the trailing * gives prefix matching ("keyb" finds
// "keyboard"). Adjacent quoted terms AND together by default, so a
// multi-word search requires every word to appear somewhere in the ticket,
// not just as one exact contiguous phrase like the old LIKE-based search did.
function buildFtsQuery(q) {
  const tokens = q.match(/[\p{L}\p{N}]+/gu) || [];
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t}"*`).join(" ");
}

// Other still-open tickets whose subject shares words with this one - shown
// as a "Possible duplicates" card on the ticket detail page, with a
// one-click way into the existing merge flow. Deliberately scoped to
// Open/In Progress tickets only (merging into something already Resolved/
// Closed isn't the useful case this is for) and excludes anything already
// merged away.
// Shared by the dashboard home stat tiles and /reports, so the two can
// never quietly show different numbers for the same thing.
function ticketTimingStats() {
  // Average time from creation to Resolved, for tickets currently sitting in
  // Resolved or Closed - derived from ticket_activity rather than a stored
  // column, since "when did this last become Resolved" is exactly what the
  // most recent matching status_change row already records. A ticket
  // resolved, reopened, and left open again drops out (no current-Resolved
  // timestamp to measure to), which is the right call for "how long does it
  // take us to actually finish something."
  const resolutionTime = db
    .prepare(
      `SELECT AVG(julianday(resolved_at.happened) - julianday(tickets.created_at)) AS avg_days, COUNT(*) AS count
       FROM tickets
       JOIN (
         SELECT ticket_id, MAX(created_at) AS happened
         FROM ticket_activity
         WHERE type = 'status_change' AND body LIKE '%to "Resolved".'
         GROUP BY ticket_id
       ) resolved_at ON resolved_at.ticket_id = tickets.id
       WHERE tickets.status IN ('Resolved', 'Closed')`
    )
    .get();

  // Time to first response: the first agent-authored activity of any kind
  // (a note, a reply, a status/priority change, a reassignment) on a
  // ticket - not just its first public reply. The auto-assignment-on-
  // creation row has agent_id NULL, so it's already excluded without a
  // special case. Unlike resolution time, this isn't restricted to
  // currently-Resolved/Closed tickets - a ticket that's still open can
  // still have a measured first response.
  const firstResponseTime = db
    .prepare(
      `SELECT AVG(julianday(first_response.happened) - julianday(tickets.created_at)) AS avg_days, COUNT(*) AS count
       FROM tickets
       JOIN (
         SELECT ticket_id, MIN(created_at) AS happened
         FROM ticket_activity
         WHERE agent_id IS NOT NULL
         GROUP BY ticket_id
       ) first_response ON first_response.ticket_id = tickets.id`
    )
    .get();

  return { resolutionTime, firstResponseTime };
}

function findPossibleDuplicates(ticket) {
  // Deliberately NOT buildFtsQuery's AND-every-word semantics (right for a
  // human typing a specific search, wrong here - two people describing the
  // same issue in their own words rarely share every word). ORs the
  // ticket's own subject words together instead, ranked by FTS5's bm25
  // relevance so the closest matches surface first even when the overlap is
  // partial. Short/common words (<3 chars) are dropped to cut noise matches
  // on stuff like "be" or "on".
  const tokens = (ticket.subject.match(/[\p{L}\p{N}]+/gu) || []).filter((t) => t.length >= 3);
  if (!tokens.length) return [];
  const ftsQuery = tokens.map((t) => `"${t}"*`).join(" OR ");
  return db
    .prepare(
      `SELECT tickets.id, tickets.subject, tickets.status, tickets.created_at
       FROM tickets_fts
       JOIN tickets ON tickets.id = tickets_fts.rowid
       WHERE tickets_fts MATCH ? AND tickets.id != ? AND tickets.merged_into_id IS NULL
         AND tickets.status IN ('Open', 'In Progress')
       ORDER BY bm25(tickets_fts)
       LIMIT 3`
    )
    .all(ftsQuery, ticket.id);
}

// Shared by the ticket list, its pagination count, and the CSV export, so the
// three can never quietly drift apart on what "matching these filters" means.
function buildTicketFilter(query, agentId) {
  const { status = "", priority = "", category = "", assigned = "", tag = "", q = "" } = query;
  let where = " WHERE 1 = 1";
  const params = [];

  if (STATUSES.includes(status)) {
    where += " AND tickets.status = ?";
    params.push(status);
  }
  if (PRIORITIES.includes(priority)) {
    where += " AND tickets.priority = ?";
    params.push(priority);
  }
  if (CATEGORIES.includes(category)) {
    where += " AND tickets.category = ?";
    params.push(category);
  }
  if (assigned === "unassigned") {
    where += " AND tickets.assigned_to IS NULL";
  } else if (assigned === "me") {
    where += " AND tickets.assigned_to = ?";
    params.push(agentId);
  }
  if (tag.trim()) {
    where += ` AND EXISTS (
      SELECT 1 FROM ticket_tags JOIN tags ON tags.id = ticket_tags.tag_id
      WHERE ticket_tags.ticket_id = tickets.id AND tags.name = ? COLLATE NOCASE
    )`;
    params.push(tag.trim());
  }
  if (q.trim()) {
    const ftsQuery = buildFtsQuery(q);
    const like = `%${q.trim()}%`;
    if (ftsQuery) {
      where += ` AND (tickets.id IN (SELECT rowid FROM tickets_fts WHERE tickets_fts MATCH ?) OR tickets.requester_name LIKE ? OR tickets.requester_email LIKE ?)`;
      params.push(ftsQuery, like, like);
    } else {
      where += " AND (tickets.requester_name LIKE ? OR tickets.requester_email LIKE ?)";
      params.push(like, like);
    }
  }

  return { where, params, filters: { status, priority, category, assigned, tag, q } };
}

router.get("/", (req, res) => {
  const { where, params, filters } = buildTicketFilter(req.query, req.session.agentId);

  const totalCount = db
    .prepare(`SELECT COUNT(*) AS count FROM tickets${where}`)
    .get(...params).count;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), totalPages);
  const offset = (page - 1) * PAGE_SIZE;

  const sql = `
    SELECT tickets.*, agents.name AS assigned_name
    FROM tickets
    LEFT JOIN agents ON agents.id = tickets.assigned_to
    ${where}
    ORDER BY
      CASE tickets.status WHEN 'Open' THEN 0 WHEN 'In Progress' THEN 1 WHEN 'Resolved' THEN 2 ELSE 3 END,
      CASE tickets.priority WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,
      tickets.created_at DESC
    LIMIT ? OFFSET ?
  `;
  // is_aging can no longer be a SQL predicate (business-hours math isn't
  // expressible in plain SQLite - see src/aging.js) - annotated on the
  // already-paginated page of rows instead, not the whole table.
  const tickets = annotateAging(db.prepare(sql).all(...params, PAGE_SIZE, offset));

  const counts = db
    .prepare(`SELECT status, COUNT(*) AS count FROM tickets GROUP BY status`)
    .all()
    .reduce((acc, row) => ({ ...acc, [row.status]: row.count }), {});

  const satisfaction = db
    .prepare(`SELECT AVG(rating) AS avg_rating, COUNT(*) AS count FROM ticket_ratings`)
    .get();

  const { resolutionTime, firstResponseTime } = ticketTimingStats();

  const exportQuery = new URLSearchParams(
    Object.fromEntries(Object.entries(filters).filter(([, v]) => v))
  ).toString();

  res.render("dashboard/home", {
    title: "Dashboard",
    tickets,
    counts,
    satisfaction,
    resolutionTime,
    firstResponseTime,
    statuses: STATUSES,
    priorities: PRIORITIES,
    categories: CATEGORIES,
    allTags: allTags(),
    agents: db.prepare("SELECT id, name FROM agents WHERE active = 1 ORDER BY name").all(),
    filters,
    page,
    totalPages,
    totalCount,
    exportQuery,
    savedViews: db.prepare("SELECT * FROM saved_views WHERE agent_id = ? ORDER BY created_at DESC").all(req.session.agentId),
  });
});

// A saved view is just the current filter combo (not the page number - that
// wouldn't make sense to replay) under a name, scoped to whoever saved it.
router.post("/views", verifyCsrf, (req, res) => {
  const name = (req.body.name || "").trim().slice(0, 100);
  const queryString = (req.body.query_string || "").slice(0, 1000);
  if (name) {
    db.prepare("INSERT INTO saved_views (agent_id, name, query_string) VALUES (?, ?, ?)").run(
      req.session.agentId,
      name,
      queryString
    );
  }
  res.redirect(queryString ? `/dashboard?${queryString}` : "/dashboard");
});

// Scoped to the requesting agent - unlike tickets/assets, a saved view is a
// personal convenience, not a shared team resource, so one agent shouldn't
// be able to delete another's.
router.post("/views/:id/delete", verifyCsrf, (req, res) => {
  db.prepare("DELETE FROM saved_views WHERE id = ? AND agent_id = ?").run(req.params.id, req.session.agentId);
  res.redirect("/dashboard");
});

router.get("/export.csv", (req, res) => {
  const { where, params } = buildTicketFilter(req.query, req.session.agentId);

  const tickets = db
    .prepare(
      `SELECT tickets.*, agents.name AS assigned_name
       FROM tickets
       LEFT JOIN agents ON agents.id = tickets.assigned_to
       ${where}
       ORDER BY tickets.created_at DESC`
    )
    .all(...params);

  const csv = toCsv(tickets, [
    { key: "id", header: "ID" },
    { key: "subject", header: "Subject" },
    { key: "requester_name", header: "Requester name" },
    { key: "requester_email", header: "Requester email" },
    { key: "category", header: "Category" },
    { key: "priority", header: "Priority" },
    { key: "status", header: "Status" },
    { key: "assigned_name", header: "Assigned to" },
    { key: "created_at", header: "Created" },
    { key: "updated_at", header: "Updated" },
  ]);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="tickets-${Date.now()}.csv"`);
  res.send(csv);
});

// Agent-initiated creation - for a phone call or a walk-in, where the
// requester isn't the one filling out the public form. Defined before
// /tickets/:id so Express doesn't match "new" as an :id first. Unlike the
// public form, priority can be set immediately and the agent can assign it
// (or leave it unassigned) rather than always going through round-robin.
router.get("/tickets/new", (req, res) => {
  // ?template=<id> pre-fills category/subject/description from a saved
  // template (see /dashboard/templates) - a real navigation with a query
  // param, not a client-side field-sync script, since it's three fields at
  // once and a GET link is simpler and more robust than keeping three
  // separate inputs in sync via JS.
  let values = {};
  if (req.query.template) {
    const template = db.prepare("SELECT * FROM ticket_templates WHERE id = ?").get(req.query.template);
    if (template) values = { category: template.category, subject: template.subject, description: template.description };
  }
  res.render("dashboard/new-ticket", {
    title: "New ticket",
    categories: CATEGORIES,
    priorities: PRIORITIES,
    assets: assets.assignable(),
    agents: db.prepare("SELECT id, name FROM agents WHERE active = 1 ORDER BY name").all(),
    templates: db.prepare("SELECT id, name FROM ticket_templates ORDER BY name").all(),
    customFieldsByCategory: customFields.byCategory(),
    errors: [],
    values,
    uploadHint: LIMITS_HINT,
  });
});

router.post("/tickets/new", handleUpload("attachments"), verifyCsrf, (req, res) => {
  const {
    requester_name = "",
    requester_email = "",
    category = "",
    subject = "",
    description = "",
    priority = "Medium",
    asset_id = "",
    assigned_to = "",
  } = req.body;

  const values = { requester_name, requester_email, category, subject, description, priority, asset_id, assigned_to };
  const errors = [];
  const rerender = () => {
    deleteUploadedFiles(req.files);
    return res.status(400).render("dashboard/new-ticket", {
      title: "New ticket",
      categories: CATEGORIES,
      priorities: PRIORITIES,
      assets: assets.assignable(),
      agents: db.prepare("SELECT id, name FROM agents WHERE active = 1 ORDER BY name").all(),
      templates: db.prepare("SELECT id, name FROM ticket_templates ORDER BY name").all(),
      customFieldsByCategory: customFields.byCategory(),
      errors,
      values,
      uploadHint: LIMITS_HINT,
    });
  };

  if (!requester_name.trim()) errors.push("The requester's name is required.");
  if (!requester_email.trim() || !EMAIL_RE.test(requester_email.trim())) errors.push("A valid requester email is required.");
  if (!CATEGORIES.includes(category)) errors.push("Please choose a valid category.");
  if (!PRIORITIES.includes(priority)) errors.push("Please choose a valid priority.");
  if (!subject.trim()) errors.push("A subject is required.");
  if (!description.trim()) errors.push("A description is required.");
  const assetId = asset_id ? parseInt(asset_id, 10) : null;
  if (assetId && !assets.get(assetId)) errors.push("Please choose a valid asset.");
  const assignedTo = assigned_to ? parseInt(assigned_to, 10) : null;
  if (assignedTo && !db.prepare("SELECT id FROM agents WHERE id = ? AND active = 1").get(assignedTo)) {
    errors.push("Please choose a valid, active agent.");
  }
  if (req.uploadError) errors.push(req.uploadError);
  if (errors.length) return rerender();

  const result = db
    .prepare(
      `INSERT INTO tickets (subject, description, category, priority, requester_name, requester_email, assigned_to, asset_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      subject.trim(),
      description.trim(),
      category,
      priority,
      requester_name.trim(),
      requester_email.trim().toLowerCase(),
      assignedTo,
      assetId
    );

  const creatingAgent = db.prepare("SELECT name FROM agents WHERE id = ?").get(req.session.agentId);
  db.prepare(`INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, 'note', ?)`).run(
    result.lastInsertRowid,
    req.session.agentId,
    `Created by ${creatingAgent.name} on behalf of ${requester_name.trim()}.`
  );
  customFields.saveSubmittedCustomFields(result.lastInsertRowid, category, req.body);
  if (assignedTo) {
    const label = db.prepare("SELECT name FROM agents WHERE id = ?").get(assignedTo).name;
    db.prepare(`INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, 'assignment', ?)`).run(
      result.lastInsertRowid,
      req.session.agentId,
      `Assigned to ${label}.`
    );
  }
  if (req.files && req.files.length) {
    saveAttachments({ ticketId: result.lastInsertRowid, files: req.files, uploadedBy: "agent", agentId: req.session.agentId });
  }

  sendTicketCreatedEmail({
    to: requester_email.trim().toLowerCase(),
    ticketId: result.lastInsertRowid,
    subject: subject.trim(),
  }).catch((err) => console.error("Could not send ticket-created email:", err.message));
  triggerWebhooks("ticket.created", {
    ticket_id: result.lastInsertRowid,
    subject: subject.trim(),
    category,
    requester_email: requester_email.trim().toLowerCase(),
  });

  res.redirect(`/dashboard/tickets/${result.lastInsertRowid}`);
});

router.get("/tickets/:id", (req, res) => {
  const ticket = getTicketOr404(res, req.params.id);
  if (!ticket) return;

  // A merged-away ticket has nothing left to show on its own page - all of
  // its activity/attachments/tags moved to the target when it was merged
  // (see /tickets/:id/merge below). Land the agent on the actually-active
  // ticket instead of a dead end, with a one-time banner naming where they
  // came from.
  if (ticket.merged_into_id) {
    return res.redirect(`/dashboard/tickets/${ticket.merged_into_id}?merged_from=${ticket.id}`);
  }

  // LEFT JOIN, not JOIN: a 'requester_reply' row has no agent_id at all (the
  // requester isn't an agent), and an INNER JOIN would silently drop those
  // rows from the feed entirely instead of just showing no agent name.
  const activity = db
    .prepare(
      `SELECT ticket_activity.*, agents.name AS agent_name
       FROM ticket_activity
       LEFT JOIN agents ON agents.id = ticket_activity.agent_id
       WHERE ticket_id = ?
       ORDER BY created_at ASC`
    )
    .all(ticket.id);

  // Active agents, plus whoever this ticket is currently assigned to even if
  // they've since been deactivated - otherwise the dropdown would silently
  // reassign the ticket the moment anyone loads this page and re-submits the
  // form without touching the select.
  const agents = db
    .prepare("SELECT id, name FROM agents WHERE active = 1 OR id = ? ORDER BY name")
    .all(ticket.assigned_to);
  const attachments = attachmentsForTicket(ticket.id).map((a) => ({
    ...a,
    size_label: formatSize(a.size_bytes),
    is_previewable: SAFE_PREVIEW_TYPES.has(a.mime_type),
  }));
  const rating = db.prepare("SELECT rating, comment FROM ticket_ratings WHERE ticket_id = ?").get(ticket.id);
  // Skipped once this ticket's own data has been erased - its requester_email
  // is now the same shared redaction placeholder every erased ticket gets,
  // so matching on it would incorrectly group unrelated erased requesters
  // together under "from this requester".
  const otherTickets = ticket.data_erased_at
    ? []
    : db
        .prepare(
          `SELECT id, subject, status, created_at FROM tickets
           WHERE requester_email = ? AND id != ?
           ORDER BY created_at DESC`
        )
        .all(ticket.requester_email, ticket.id);

  res.render("dashboard/ticket", {
    title: `Ticket #${ticket.id}`,
    ticket,
    activity,
    agents,
    attachments,
    aging: isAgingTicket(ticket),
    tags: tagsForTicket(ticket.id),
    allTags: allTags(),
    cannedResponses: canned.all(),
    rating,
    otherTickets,
    asset: ticket.asset_id ? assets.get(ticket.asset_id) : null,
    assignableAssets: assets.assignable(),
    statuses: STATUSES,
    priorities: PRIORITIES,
    uploadHint: LIMITS_HINT,
    noteError: null,
    mergedFrom: req.query.merged_from ? parseInt(req.query.merged_from, 10) : null,
    possibleDuplicates: ["Open", "In Progress"].includes(ticket.status) ? findPossibleDuplicates(ticket) : [],
    kbArticles: kb.publishedList().map((a) => ({ ...a, url: `${req.protocol}://${req.get("host")}/kb/${a.slug}` })),
    customFieldValues: customFields.valuesForTicket(ticket.id),
    watchers: db
      .prepare(
        `SELECT agents.id, agents.name FROM ticket_watchers
         JOIN agents ON agents.id = ticket_watchers.agent_id
         WHERE ticket_watchers.ticket_id = ? ORDER BY agents.name`
      )
      .all(ticket.id),
    isWatching: Boolean(
      db.prepare("SELECT 1 FROM ticket_watchers WHERE ticket_id = ? AND agent_id = ?").get(ticket.id, req.session.agentId)
    ),
  });
});

// Moves all activity/attachments/tags onto the target ticket, closes this
// one, and points it at the target via merged_into_id - see the redirect at
// the top of GET /tickets/:id above for what happens when anyone visits a
// merged ticket's own URL afterward. All-or-nothing in one transaction.
// A print-friendly view of one ticket (details + full activity feed) - the
// "PDF export" is just the browser's own Print / Save as PDF on this page,
// rather than a rendering dependency in the app itself.
router.get("/tickets/:id/print", (req, res) => {
  const ticket = getTicketOr404(res, req.params.id);
  if (!ticket) return;

  const activity = db
    .prepare(
      `SELECT ticket_activity.*, agents.name AS agent_name
       FROM ticket_activity
       LEFT JOIN agents ON agents.id = ticket_activity.agent_id
       WHERE ticket_id = ?
       ORDER BY created_at ASC`
    )
    .all(ticket.id);

  res.render("dashboard/ticket-print", {
    title: `Ticket #${ticket.id}`,
    ticket,
    activity,
    asset: ticket.asset_id ? assets.get(ticket.asset_id) : null,
  });
});

router.post("/tickets/:id/merge", verifyCsrf, (req, res) => {
  const ticket = getTicketOr404(res, req.params.id);
  if (!ticket) return;

  const targetId = parseInt(req.body.target_ticket_id, 10);
  if (!targetId || targetId === ticket.id) {
    return res.status(400).render("error", { title: "Invalid merge", message: "Enter a different, valid ticket number to merge into." });
  }
  if (ticket.merged_into_id) {
    return res.status(400).render("error", { title: "Invalid merge", message: "This ticket has already been merged." });
  }
  const target = db.prepare("SELECT * FROM tickets WHERE id = ?").get(targetId);
  if (!target) {
    return res.status(400).render("error", { title: "Invalid merge", message: "That target ticket does not exist." });
  }
  if (target.merged_into_id) {
    return res.status(400).render("error", {
      title: "Invalid merge",
      message: "That target ticket has itself been merged elsewhere - merge into its final destination instead.",
    });
  }

  db.exec("BEGIN");
  try {
    db.prepare("UPDATE ticket_activity SET ticket_id = ? WHERE ticket_id = ?").run(target.id, ticket.id);
    db.prepare("UPDATE attachments SET ticket_id = ? WHERE ticket_id = ?").run(target.id, ticket.id);
    db.prepare(
      "INSERT OR IGNORE INTO ticket_tags (ticket_id, tag_id) SELECT ?, tag_id FROM ticket_tags WHERE ticket_id = ?"
    ).run(target.id, ticket.id);
    db.prepare("DELETE FROM ticket_tags WHERE ticket_id = ?").run(ticket.id);
    db.prepare(`INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, 'note', ?)`).run(
      target.id,
      req.session.agentId,
      `Merged ticket #${ticket.id} ("${ticket.subject}") into this one.`
    );
    db.prepare(
      "UPDATE tickets SET merged_into_id = ?, status = 'Closed', updated_at = datetime('now') WHERE id = ?"
    ).run(target.id, ticket.id);
    db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(target.id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  res.redirect(`/dashboard/tickets/${target.id}`);
});

// Agent-side inline preview for a safe image attachment - never PDF/TXT/CSV,
// see SAFE_PREVIEW_TYPES. Everything else still only ever force-downloads.
router.get("/tickets/:id/attachments/:attachmentId/preview", (req, res) => {
  const ticket = getTicketOr404(res, req.params.id);
  if (!ticket) return;

  const attachment = getAttachment(ticket.id, req.params.attachmentId);
  if (!attachment || !SAFE_PREVIEW_TYPES.has(attachment.mime_type)) {
    return res.status(404).render("error", { title: "Not found", message: "No preview is available for that attachment." });
  }
  res.setHeader("Content-Type", attachment.mime_type);
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(path.join(ATTACHMENTS_DIR, attachment.stored_name));
});

// GDPR export/erasure, scoped to this ticket's requester email and reachable
// from the ticket detail page's "Requester data" card - there's no requester
// login system in this app, so both are agent-initiated, not self-service.
router.get("/tickets/:id/privacy/export.json", (req, res) => {
  const ticket = getTicketOr404(res, req.params.id);
  if (!ticket) return;

  const bundle = exportRequesterData(ticket.requester_email);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="requester-data-${ticket.id}-${Date.now()}.json"`);
  res.send(JSON.stringify(bundle, null, 2));
});

router.post("/tickets/:id/privacy/erase", verifyCsrf, (req, res) => {
  const ticket = getTicketOr404(res, req.params.id);
  if (!ticket) return;

  const result = eraseRequesterData(ticket.requester_email);
  if (result.error) {
    return res.status(400).render("error", { title: "Erasure failed", message: result.error });
  }
  res.redirect(`/dashboard/tickets/${ticket.id}`);
});

router.post("/tickets/:id/asset", verifyCsrf, (req, res) => {
  const ticket = getTicketOr404(res, req.params.id);
  if (!ticket) return;

  const raw = req.body.asset_id;
  const newAssetId = raw ? parseInt(raw, 10) : null;
  if (newAssetId && !assets.get(newAssetId)) {
    return res.status(400).render("error", { title: "Invalid asset", message: "That asset does not exist." });
  }

  db.prepare("UPDATE tickets SET asset_id = ?, updated_at = datetime('now') WHERE id = ?").run(newAssetId, ticket.id);
  res.redirect(`/dashboard/tickets/${ticket.id}`);
});

// A watcher gets notified alongside the assignee (see sendAgentNotifiedOfReply
// in public.js's /status/reply) without being the assignee themselves -
// "keep me posted" without reassigning it away from whoever's actually
// working it.
router.post("/tickets/:id/watch", verifyCsrf, (req, res) => {
  const ticket = getTicketOr404(res, req.params.id);
  if (!ticket) return;
  db.prepare("INSERT OR IGNORE INTO ticket_watchers (ticket_id, agent_id) VALUES (?, ?)").run(ticket.id, req.session.agentId);
  res.redirect(`/dashboard/tickets/${ticket.id}`);
});

router.post("/tickets/:id/unwatch", verifyCsrf, (req, res) => {
  const ticket = getTicketOr404(res, req.params.id);
  if (!ticket) return;
  db.prepare("DELETE FROM ticket_watchers WHERE ticket_id = ? AND agent_id = ?").run(ticket.id, req.session.agentId);
  res.redirect(`/dashboard/tickets/${ticket.id}`);
});

router.post("/tickets/:id/tags", verifyCsrf, (req, res) => {
  const ticket = getTicketOr404(res, req.params.id);
  if (!ticket) return;

  if ((req.body.tag || "").trim()) {
    addTagToTicket(ticket.id, req.body.tag);
    db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(ticket.id);
  }
  res.redirect(`/dashboard/tickets/${ticket.id}`);
});

router.post("/tickets/:id/tags/:tagId/remove", verifyCsrf, (req, res) => {
  const ticket = getTicketOr404(res, req.params.id);
  if (!ticket) return;

  removeTagFromTicket(ticket.id, req.params.tagId);
  db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(ticket.id);
  res.redirect(`/dashboard/tickets/${ticket.id}`);
});

// Shared by the single-ticket status route and the bulk-status route below,
// so the two can never quietly diverge on what "changing status" means
// (activity logging, the rating-token/email side effects on Resolved, etc).
function applyStatusChange(ticket, status, agentId) {
  if (!STATUSES.includes(status) || status === ticket.status) return;

  // Reopening clears any past SLA alert - a ticket that breaches, gets
  // fixed, and later reopens should be able to alert again rather than
  // staying silenced forever because it alerted once in a previous life.
  const reopening = ["Open", "In Progress"].includes(status) && ["Resolved", "Closed"].includes(ticket.status);
  db.prepare(
    `UPDATE tickets SET status = ?, updated_at = datetime('now')${reopening ? ", sla_alerted_at = NULL" : ""} WHERE id = ?`
  ).run(status, ticket.id);
  db.prepare(
    `INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, 'status_change', ?)`
  ).run(ticket.id, agentId, `Status changed from "${ticket.status}" to "${status}".`);

  if (status === "Resolved") {
    // Generated lazily, once, the first time a ticket actually resolves -
    // most tickets never need one. A bearer token, not tied to a login: see
    // the ticket_ratings comment in src/db/index.js for why that's the
    // right amount of friction here.
    let ratingToken = ticket.rating_token;
    if (!ratingToken) {
      ratingToken = crypto.randomBytes(24).toString("hex");
      db.prepare("UPDATE tickets SET rating_token = ? WHERE id = ?").run(ratingToken, ticket.id);
    }
    sendResolvedEmail({
      to: ticket.requester_email,
      ticketId: ticket.id,
      subject: ticket.subject,
      oldStatus: ticket.status,
      ratingToken,
    }).catch((err) => console.error("Could not send resolved email:", err.message));
  } else {
    sendStatusChangeEmail({
      to: ticket.requester_email,
      ticketId: ticket.id,
      subject: ticket.subject,
      oldStatus: ticket.status,
      newStatus: status,
    }).catch((err) => console.error("Could not send status-change email:", err.message));
  }

  triggerWebhooks("ticket.status_changed", {
    ticket_id: ticket.id,
    subject: ticket.subject,
    old_status: ticket.status,
    new_status: status,
  });
}

router.post("/tickets/:id/status", verifyCsrf, (req, res) => {
  const ticket = getTicketOr404(res, req.params.id);
  if (!ticket) return;

  if (!STATUSES.includes(req.body.status)) {
    return res.status(400).render("error", { title: "Invalid status", message: "That status is not valid." });
  }
  applyStatusChange(ticket, req.body.status, req.session.agentId);
  res.redirect(`/dashboard/tickets/${ticket.id}`);
});

// Priority is set by the helpdesk team, not the requester - the public
// request form has no priority field at all (see src/routes/public.js).
router.post("/tickets/:id/priority", verifyCsrf, (req, res) => {
  const ticket = getTicketOr404(res, req.params.id);
  if (!ticket) return;

  const { priority } = req.body;
  if (!PRIORITIES.includes(priority)) {
    return res.status(400).render("error", { title: "Invalid priority", message: "That priority is not valid." });
  }

  if (priority !== ticket.priority) {
    db.prepare("UPDATE tickets SET priority = ?, updated_at = datetime('now') WHERE id = ?").run(priority, ticket.id);
    db.prepare(
      `INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, 'priority_change', ?)`
    ).run(ticket.id, req.session.agentId, `Priority changed from "${ticket.priority}" to "${priority}".`);
  }

  res.redirect(`/dashboard/tickets/${ticket.id}`);
});

// Shared by the single-ticket assign route and the bulk-assign route below.
function applyAssignment(ticket, newAssigneeId, agentId) {
  if (newAssigneeId === ticket.assigned_to) return true;
  if (newAssigneeId) {
    const exists = db.prepare("SELECT id, name FROM agents WHERE id = ? AND active = 1").get(newAssigneeId);
    if (!exists) return false;
  }

  db.prepare("UPDATE tickets SET assigned_to = ?, updated_at = datetime('now') WHERE id = ?").run(
    newAssigneeId,
    ticket.id
  );
  const label = newAssigneeId ? db.prepare("SELECT name FROM agents WHERE id = ?").get(newAssigneeId).name : "Unassigned";
  db.prepare(
    `INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, 'assignment', ?)`
  ).run(ticket.id, agentId, `Assigned to ${label}.`);
  triggerWebhooks("ticket.assigned", { ticket_id: ticket.id, subject: ticket.subject, assigned_to: label });
  return true;
}

router.post("/tickets/:id/assign", verifyCsrf, (req, res) => {
  const ticket = getTicketOr404(res, req.params.id);
  if (!ticket) return;

  const raw = req.body.assigned_to;
  const newAssigneeId = raw ? parseInt(raw, 10) : null;
  const ok = applyAssignment(ticket, newAssigneeId, req.session.agentId);
  if (!ok) {
    return res.status(400).render("error", { title: "Invalid agent", message: "That agent does not exist or is not active." });
  }

  res.redirect(`/dashboard/tickets/${ticket.id}`);
});

// Bulk actions: same underlying logic as the single-ticket routes above
// (applyStatusChange / applyAssignment), just looped over a list of ids from
// checkboxes on the dashboard table. redirect_to carries the current
// filters/page back so applying a bulk action doesn't dump you back to an
// unfiltered page 1.
function bulkRedirect(req, res) {
  const back = (req.body.redirect_to || "/dashboard").startsWith("/dashboard") ? req.body.redirect_to : "/dashboard";
  res.redirect(back);
}

function parseTicketIds(body) {
  const raw = Array.isArray(body.ticket_ids) ? body.ticket_ids : body.ticket_ids ? [body.ticket_ids] : [];
  return raw.map((v) => parseInt(v, 10)).filter((n) => Number.isInteger(n));
}

router.post("/bulk/status", verifyCsrf, (req, res) => {
  const ids = parseTicketIds(req.body);
  if (ids.length && STATUSES.includes(req.body.status)) {
    for (const id of ids) {
      const ticket = db.prepare("SELECT * FROM tickets WHERE id = ?").get(id);
      if (ticket) applyStatusChange(ticket, req.body.status, req.session.agentId);
    }
  }
  bulkRedirect(req, res);
});

router.post("/bulk/assign", verifyCsrf, (req, res) => {
  const ids = parseTicketIds(req.body);
  const raw = req.body.assigned_to;
  const newAssigneeId = raw ? parseInt(raw, 10) : null;
  if (ids.length) {
    for (const id of ids) {
      const ticket = db.prepare("SELECT * FROM tickets WHERE id = ?").get(id);
      if (ticket) applyAssignment(ticket, newAssigneeId, req.session.agentId);
    }
  }
  bulkRedirect(req, res);
});

router.post("/tickets/:id/note", handleUpload("attachments"), verifyCsrf, (req, res) => {
  const ticket = getTicketOr404(res, req.params.id);
  if (!ticket) return;

  const body = (req.body.body || "").trim();
  const hasFiles = req.files && req.files.length;

  if (req.uploadError) {
    deleteUploadedFiles(req.files);
    return res.status(400).render("error", { title: "Upload failed", message: req.uploadError });
  }
  if (!body && !hasFiles) {
    return res.status(400).render("error", { title: "Empty note", message: "Add note text, an attachment, or both." });
  }
  if (body.length > 5000) {
    deleteUploadedFiles(req.files);
    return res.status(400).render("error", { title: "Note too long", message: "Notes must be under 5000 characters." });
  }

  const isPublicReply = req.body.visibility === "reply";

  if (body) {
    db.prepare(
      `INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, ?, ?)`
    ).run(ticket.id, req.session.agentId, isPublicReply ? "reply" : "note", body);

    if (isPublicReply) {
      sendReplyEmail({ to: ticket.requester_email, ticketId: ticket.id, subject: ticket.subject, message: body }).catch(
        (err) => console.error("Could not send reply email:", err.message)
      );
    }

    const author = db.prepare("SELECT name FROM agents WHERE id = ?").get(req.session.agentId);
    for (const mentioned of findMentionedAgents(body, req.session.agentId)) {
      sendMentionEmail({
        to: mentioned.email,
        ticketId: ticket.id,
        subject: ticket.subject,
        mentionedBy: author ? author.name : "Someone",
        message: body,
      }).catch((err) => console.error("Could not send mention email:", err.message));
    }
  }
  if (hasFiles) {
    saveAttachments({
      ticketId: ticket.id,
      files: req.files,
      uploadedBy: "agent",
      agentId: req.session.agentId,
      visibleToRequester: isPublicReply,
    });
    const names = req.files.map((f) => f.originalname).join(", ");
    db.prepare(
      `INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, 'note', ?)`
    ).run(ticket.id, req.session.agentId, `Added attachment${req.files.length > 1 ? "s" : ""}: ${names}`);
  }
  db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(ticket.id);

  res.redirect(`/dashboard/tickets/${ticket.id}`);
});

// Gated by the router.use(requireAgent) above - any logged-in agent can pull
// any ticket's attachments, same access level they already have to everything
// else on the ticket.
router.get("/tickets/:id/attachments/:attachmentId/download", (req, res) => {
  const ticket = getTicketOr404(res, req.params.id);
  if (!ticket) return;

  const attachment = getAttachment(ticket.id, req.params.attachmentId);
  if (!attachment) {
    return res.status(404).render("error", { title: "Not found", message: "That attachment does not exist." });
  }

  res.download(path.join(ATTACHMENTS_DIR, attachment.stored_name), attachment.original_name);
});

router.get("/templates", (req, res) => {
  res.render("dashboard/templates", {
    title: "Ticket templates",
    templates: db.prepare("SELECT * FROM ticket_templates ORDER BY name").all(),
    categories: CATEGORIES,
    error: null,
  });
});

router.post("/templates", verifyCsrf, (req, res) => {
  const { name = "", category = "", subject = "", description = "" } = req.body;
  if (!name.trim() || !CATEGORIES.includes(category) || !subject.trim() || !description.trim()) {
    return res.status(400).render("dashboard/templates", {
      title: "Ticket templates",
      templates: db.prepare("SELECT * FROM ticket_templates ORDER BY name").all(),
      categories: CATEGORIES,
      error: "Name, category, subject, and description are all required.",
    });
  }
  db.prepare("INSERT INTO ticket_templates (name, category, subject, description) VALUES (?, ?, ?, ?)").run(
    name.trim().slice(0, 100),
    category,
    subject.trim().slice(0, 200),
    description.trim().slice(0, 5000)
  );
  res.redirect("/dashboard/templates");
});

router.post("/templates/:id/delete", verifyCsrf, (req, res) => {
  db.prepare("DELETE FROM ticket_templates WHERE id = ?").run(req.params.id);
  res.redirect("/dashboard/templates");
});

router.get("/kb", (req, res) => {
  res.render("dashboard/kb", { title: "Knowledge base", articles: kb.allForDashboard() });
});

router.get("/kb/new", (req, res) => {
  res.render("dashboard/kb-edit", { title: "New article", article: null, categories: CATEGORIES, error: null });
});

router.post("/kb/new", verifyCsrf, (req, res) => {
  const result = kb.create(req.body, req.session.agentId);
  if (result.error) {
    return res.status(400).render("dashboard/kb-edit", {
      title: "New article",
      article: req.body,
      categories: CATEGORIES,
      error: result.error,
    });
  }
  res.redirect(`/dashboard/kb/${result.id}/edit`);
});

router.get("/kb/:id/edit", (req, res) => {
  const article = kb.get(req.params.id);
  if (!article) return res.status(404).render("error", { title: "Not found", message: "That article does not exist." });
  res.render("dashboard/kb-edit", { title: article.title, article, categories: CATEGORIES, error: null });
});

router.post("/kb/:id/edit", verifyCsrf, (req, res) => {
  const article = kb.get(req.params.id);
  if (!article) return res.status(404).render("error", { title: "Not found", message: "That article does not exist." });
  const result = kb.update(article.id, req.body);
  if (result.error) {
    return res.status(400).render("dashboard/kb-edit", {
      title: article.title,
      article: { ...article, ...req.body },
      categories: CATEGORIES,
      error: result.error,
    });
  }
  res.redirect(`/dashboard/kb/${article.id}/edit`);
});

router.get("/canned-responses", (req, res) => {
  res.render("dashboard/canned-responses", { title: "Canned responses", responses: canned.all(), error: null });
});

router.post("/canned-responses", verifyCsrf, (req, res) => {
  const { title = "", body = "" } = req.body;
  if (!title.trim() || !body.trim()) {
    return res
      .status(400)
      .render("dashboard/canned-responses", {
        title: "Canned responses",
        responses: canned.all(),
        error: "Both a title and body are required.",
      });
  }
  canned.create(title, body);
  res.redirect("/dashboard/canned-responses");
});

router.post("/canned-responses/:id/delete", verifyCsrf, (req, res) => {
  canned.remove(req.params.id);
  res.redirect("/dashboard/canned-responses");
});

router.get("/assets", (req, res) => {
  const { status = "", category = "", q = "" } = req.query;
  const filters = { status, category, q };
  const cutoff = new Date(Date.now() + WARRANTY_ALERT_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const items = assets.all(filters).map((a) => ({
    ...a,
    warranty_expired: Boolean(a.warranty_expires && a.warranty_expires < today),
    warranty_expiring_soon: Boolean(a.warranty_expires && a.warranty_expires >= today && a.warranty_expires <= cutoff),
  }));
  res.render("dashboard/assets", {
    title: "Assets",
    items,
    filters,
    categories: ASSET_CATEGORIES,
    statuses: ASSET_STATUSES,
    values: {},
    error: null,
    exportQuery: new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([, v]) => v))).toString(),
  });
});

router.post("/assets", verifyCsrf, (req, res) => {
  const result = assets.create(req.body, req.session.agentId);
  if (result.error) {
    return res.status(400).render("dashboard/assets", {
      title: "Assets",
      items: assets.all({}),
      filters: { status: "", category: "", q: "" },
      categories: ASSET_CATEGORIES,
      statuses: ASSET_STATUSES,
      values: req.body,
      error: result.error,
      exportQuery: "",
    });
  }
  res.redirect(`/dashboard/assets/${result.id}`);
});

// Mirrors /dashboard/export.csv for tickets. Defined before /assets/:id so
// Express doesn't match "export.csv" as an :id first.
router.get("/assets/export.csv", (req, res) => {
  const { status = "", category = "", q = "" } = req.query;
  const csv = toCsv(assets.all({ status, category, q }), [
    { key: "id", header: "ID" },
    { key: "name", header: "Name" },
    { key: "asset_tag", header: "Asset tag" },
    { key: "category", header: "Category" },
    { key: "status", header: "Status" },
    { key: "assigned_to_name", header: "Assigned to" },
    { key: "location", header: "Location" },
    { key: "serial_number", header: "Serial number" },
    { key: "vendor", header: "Vendor" },
    { key: "purchase_date", header: "Purchase date" },
    { key: "warranty_expires", header: "Warranty expiry" },
  ]);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="assets-${Date.now()}.csv"`);
  res.send(csv);
});

router.get("/assets/:id", (req, res) => {
  const asset = assets.get(req.params.id);
  if (!asset) {
    return res.status(404).render("error", { title: "Not found", message: "That asset does not exist." });
  }
  res.render("dashboard/asset", {
    title: asset.name,
    asset,
    tickets: assets.ticketsForAsset(asset.id),
    activity: assets.activityForAsset(asset.id),
    categories: ASSET_CATEGORIES,
    statuses: ASSET_STATUSES,
    error: null,
  });
});

router.post("/assets/:id", verifyCsrf, (req, res) => {
  const asset = assets.get(req.params.id);
  if (!asset) {
    return res.status(404).render("error", { title: "Not found", message: "That asset does not exist." });
  }
  const result = assets.update(asset.id, req.body, req.session.agentId);
  if (result.error) {
    return res.status(400).render("dashboard/asset", {
      title: asset.name,
      asset: { ...asset, ...req.body },
      tickets: assets.ticketsForAsset(asset.id),
      activity: assets.activityForAsset(asset.id),
      categories: ASSET_CATEGORIES,
      statuses: ASSET_STATUSES,
      error: result.error,
    });
  }
  res.redirect(`/dashboard/assets/${asset.id}`);
});

// The CSP here has no 'unsafe-inline' for styles, so a bar's size can't be
// an inline `style="width: X%"` - it has to be one of a fixed set of CSS
// classes (bar-w-0, bar-w-5, ... bar-w-100) defined in style.css. Rounding
// to the nearest 5% is plenty of precision for a simple bar chart.
function barClass(prefix, value, max) {
  const pct = max > 0 ? Math.round((value / max) * 20) * 5 : 0;
  return `${prefix}-${Math.min(100, Math.max(0, pct))}`;
}

router.get("/reports", (req, res) => {
  // Ticket volume per day for the last 30 days, zero-filled so a quiet day
  // shows as an actual zero-height bar, not a gap that's easy to misread as
  // missing data.
  const volumeRows = db
    .prepare(
      `SELECT date(created_at) AS day, COUNT(*) AS count
       FROM tickets
       WHERE created_at >= date('now', '-29 days')
       GROUP BY day`
    )
    .all();
  const volumeByDay = Object.fromEntries(volumeRows.map((r) => [r.day, r.count]));
  const volume = [];
  for (let i = 29; i >= 0; i--) {
    const day = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    volume.push({ day, count: volumeByDay[day] || 0 });
  }

  const byCategory = db
    .prepare("SELECT category AS label, COUNT(*) AS count FROM tickets GROUP BY category ORDER BY count DESC")
    .all();
  const byStatus = db
    .prepare("SELECT status AS label, COUNT(*) AS count FROM tickets GROUP BY status ORDER BY count DESC")
    .all();
  const byAgent = db
    .prepare(
      `SELECT COALESCE(agents.name, 'Unassigned') AS label, COUNT(*) AS count
       FROM tickets
       LEFT JOIN agents ON agents.id = tickets.assigned_to
       WHERE tickets.status IN ('Open', 'In Progress')
       GROUP BY tickets.assigned_to
       ORDER BY count DESC`
    )
    .all();

  const volumeMax = Math.max(1, ...volume.map((v) => v.count));
  const withBarClass = (rows, prefix) => {
    const max = Math.max(1, ...rows.map((r) => r.count));
    return rows.map((r) => ({ ...r, barClass: barClass(prefix, r.count, max) }));
  };

  const { resolutionTime, firstResponseTime } = ticketTimingStats();

  res.render("dashboard/reports", {
    title: "Reports",
    volume: volume.map((v) => ({ ...v, barClass: barClass("bar-h", v.count, volumeMax) })),
    byCategory: withBarClass(byCategory, "bar-w"),
    byStatus: withBarClass(byStatus, "bar-w"),
    byAgent: withBarClass(byAgent, "bar-w"),
    resolutionTime,
    firstResponseTime,
  });
});

router.get("/settings", (req, res) => {
  res.render("dashboard/settings", {
    title: "Settings",
    thresholds: currentThresholds(),
    priorities: PRIORITIES,
    error: null,
  });
});

router.post("/settings", verifyCsrf, (req, res) => {
  const errors = [];
  const parsed = {};
  for (const priority of PRIORITIES) {
    const days = parseInt(req.body[`days_${priority}`], 10);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      errors.push(`${priority} must be a whole number of days between 1 and 365.`);
      continue;
    }
    parsed[priority] = days;
  }

  if (errors.length) {
    return res.status(400).render("dashboard/settings", {
      title: "Settings",
      thresholds: currentThresholds(),
      priorities: PRIORITIES,
      error: errors.join(" "),
    });
  }

  const update = db.prepare("UPDATE sla_thresholds SET days = ? WHERE priority = ?");
  for (const [priority, days] of Object.entries(parsed)) update.run(days, priority);
  res.redirect("/dashboard/settings");
});

router.get("/settings/custom-fields", (req, res) => {
  res.render("dashboard/custom-fields", {
    title: "Custom fields",
    definitions: customFields.allDefinitions(),
    categories: CATEGORIES,
    error: null,
  });
});

router.post("/settings/custom-fields", verifyCsrf, (req, res) => {
  const { category, field_name } = req.body;
  if (!CATEGORIES.includes(category)) {
    return res.status(400).render("dashboard/custom-fields", {
      title: "Custom fields",
      definitions: customFields.allDefinitions(),
      categories: CATEGORIES,
      error: "Choose a valid category.",
    });
  }
  const result = customFields.create(category, field_name);
  if (result.error) {
    return res.status(400).render("dashboard/custom-fields", {
      title: "Custom fields",
      definitions: customFields.allDefinitions(),
      categories: CATEGORIES,
      error: result.error,
    });
  }
  res.redirect("/dashboard/settings/custom-fields");
});

router.post("/settings/custom-fields/:id/delete", verifyCsrf, (req, res) => {
  customFields.remove(req.params.id);
  res.redirect("/dashboard/settings/custom-fields");
});

router.get("/settings/webhooks", (req, res) => {
  res.render("dashboard/webhooks", {
    title: "Webhooks",
    webhooks: db.prepare("SELECT * FROM webhooks ORDER BY created_at DESC").all(),
    events: WEBHOOK_EVENTS,
    error: null,
  });
});

router.post("/settings/webhooks", verifyCsrf, (req, res) => {
  const url = (req.body.url || "").trim();
  const events = Array.isArray(req.body.events) ? req.body.events : req.body.events ? [req.body.events] : [];
  const validEvents = events.filter((e) => WEBHOOK_EVENTS.includes(e));

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    parsedUrl = null;
  }

  if (!parsedUrl || !["http:", "https:"].includes(parsedUrl.protocol) || !validEvents.length) {
    return res.status(400).render("dashboard/webhooks", {
      title: "Webhooks",
      webhooks: db.prepare("SELECT * FROM webhooks ORDER BY created_at DESC").all(),
      events: WEBHOOK_EVENTS,
      error: "Enter a valid http(s) URL and choose at least one event.",
    });
  }

  db.prepare("INSERT INTO webhooks (url, events, secret) VALUES (?, ?, ?)").run(
    url,
    validEvents.join(","),
    generateSecret()
  );
  res.redirect("/dashboard/settings/webhooks");
});

router.post("/settings/webhooks/:id/toggle", verifyCsrf, (req, res) => {
  db.prepare("UPDATE webhooks SET active = 1 - active WHERE id = ?").run(req.params.id);
  res.redirect("/dashboard/settings/webhooks");
});

router.post("/settings/webhooks/:id/delete", verifyCsrf, (req, res) => {
  db.prepare("DELETE FROM webhooks WHERE id = ?").run(req.params.id);
  res.redirect("/dashboard/settings/webhooks");
});

router.get("/settings/login-log", (req, res) => {
  const entries = db
    .prepare(
      `SELECT login_log.*, agents.name AS agent_name
       FROM login_log
       LEFT JOIN agents ON agents.id = login_log.agent_id
       ORDER BY login_log.created_at DESC
       LIMIT 200`
    )
    .all();
  res.render("dashboard/login-log", { title: "Login activity", entries });
});

router.get("/agents", (req, res) => {
  const agents = db
    .prepare(
      `SELECT agents.id, agents.name, agents.email, agents.active, agents.created_at,
              (SELECT COUNT(*) FROM tickets WHERE assigned_to = agents.id AND status IN ('Open', 'In Progress')) AS open_count
       FROM agents ORDER BY agents.active DESC, agents.name`
    )
    .all();
  res.render("dashboard/agents", { title: "Agents", agents, error: null });
});

router.post("/agents", verifyCsrf, (req, res) => {
  const { name = "", email = "", password = "" } = req.body;
  const normalizedEmail = email.trim().toLowerCase();

  const rerender = (error) => {
    const agents = db
      .prepare(
        `SELECT agents.id, agents.name, agents.email, agents.active, agents.created_at,
                (SELECT COUNT(*) FROM tickets WHERE assigned_to = agents.id AND status IN ('Open', 'In Progress')) AS open_count
         FROM agents ORDER BY agents.active DESC, agents.name`
      )
      .all();
    res.status(400).render("dashboard/agents", { title: "Agents", agents, error });
  };

  if (!name.trim() || !normalizedEmail || !password) {
    return rerender("Name, email, and password are all required.");
  }
  if (!EMAIL_RE.test(normalizedEmail)) {
    return rerender("Enter a valid email address.");
  }
  if (password.length < 8) {
    return rerender("Password must be at least 8 characters.");
  }
  const existing = db.prepare("SELECT id FROM agents WHERE email = ?").get(normalizedEmail);
  if (existing) {
    return rerender("An agent with that email already exists.");
  }

  const passwordHash = bcrypt.hashSync(password, 12);
  db.prepare("INSERT INTO agents (name, email, password_hash) VALUES (?, ?, ?)").run(
    name.trim(),
    normalizedEmail,
    passwordHash
  );

  res.redirect("/dashboard/agents");
});

function agentsForList() {
  return db
    .prepare(
      `SELECT agents.id, agents.name, agents.email, agents.active, agents.created_at,
              (SELECT COUNT(*) FROM tickets WHERE assigned_to = agents.id AND status IN ('Open', 'In Progress')) AS open_count
       FROM agents ORDER BY agents.active DESC, agents.name`
    )
    .all();
}

// Deactivated, never deleted (see the comment on the agents table in
// src/db/index.js) - this revokes login and eligibility for new assignments
// and auto-assignment, but keeps their name on everything they've already
// done. Guards against locking the dashboard out entirely: can't deactivate
// yourself, and can't deactivate the last remaining active agent.
router.post("/agents/:id/deactivate", verifyCsrf, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.session.agentId) {
    return res.status(400).render("dashboard/agents", {
      title: "Agents",
      agents: agentsForList(),
      error: "You can't deactivate your own account.",
    });
  }

  const activeCount = db.prepare("SELECT COUNT(*) AS c FROM agents WHERE active = 1").get().c;
  const target = db.prepare("SELECT active FROM agents WHERE id = ?").get(id);
  if (target && target.active && activeCount <= 1) {
    return res.status(400).render("dashboard/agents", {
      title: "Agents",
      agents: agentsForList(),
      error: "Can't deactivate the last active agent - nobody would be able to log in.",
    });
  }

  db.prepare("UPDATE agents SET active = 0 WHERE id = ?").run(id);
  res.redirect("/dashboard/agents");
});

router.post("/agents/:id/activate", verifyCsrf, (req, res) => {
  db.prepare("UPDATE agents SET active = 1 WHERE id = ?").run(req.params.id);
  res.redirect("/dashboard/agents");
});

module.exports = router;
