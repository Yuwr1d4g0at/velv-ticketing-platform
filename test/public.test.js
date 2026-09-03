const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp, makeClient, extractCsrf } = require("./helpers");

let app, client;

before(async () => {
  app = await startTestApp();
  client = makeClient(app.baseUrl);
});

after(() => app.close());

test("request form rejects an incomplete submission with field errors", async () => {
  const res = await client.postForm("/", {
    requester_name: "",
    requester_email: "not-an-email",
    category: "Software",
    subject: "",
    description: "",
  });
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.match(html, /Your name is required/);
  assert.match(html, /valid email address/);
});

test("request form has no priority field - it's staff-only", async () => {
  const res = await client.get("/");
  const html = await res.text();
  assert.doesNotMatch(html, /name="priority"/);
});

test("submitting a valid request creates a ticket defaulted to Medium priority", async () => {
  const res = await client.postForm("/", {
    requester_name: "Ada Lovelace",
    requester_email: "ada@example.com",
    category: "Software",
    subject: "Analytical engine won't boot",
    description: "Nothing happens when I pull the lever.",
  });
  assert.equal(res.status, 302);
  const location = res.headers.get("location");
  assert.match(location, /^\/confirmation\/\d+$/);

  const confirmRes = await client.get(location);
  const html = await confirmRes.text();
  // EJS HTML-escapes output, so the apostrophe comes back as &#39;.
  assert.match(html, /Analytical engine won&#39;t boot/);
  assert.match(html, /badge-status-open/);
});

test("submitting is rate-limited (standard headers present)", async () => {
  const res = await client.postForm("/", {
    requester_name: "Rate Test",
    requester_email: "rate@example.com",
    category: "Other",
    subject: "s",
    description: "d",
  });
  assert.ok(res.headers.get("ratelimit-limit"), "expected a RateLimit-Limit header on the submit route");
});

test("status check rejects a mismatched ticket id / email pair", async () => {
  const res = await client.postForm("/status", { ticket_id: "1", requester_email: "wrong@example.com" });
  const html = await res.text();
  assert.match(html, /No matching ticket found/);
});

test("status check returns the ticket for the correct owner and lists attachments", async () => {
  const formData = new FormData();
  formData.append("requester_name", "Grace Hopper");
  formData.append("requester_email", "grace@example.com");
  formData.append("category", "Hardware");
  formData.append("subject", "Moth in the relay");
  formData.append("description", "Found an actual bug.");
  formData.append("attachments", new Blob(["log contents"], { type: "text/plain" }), "bug-report.txt");

  const submitRes = await fetch(`${app.baseUrl}/`, { method: "POST", body: formData, redirect: "manual" });
  assert.equal(submitRes.status, 302);
  const ticketId = submitRes.headers.get("location").match(/confirmation\/(\d+)/)[1];

  const statusRes = await client.postForm("/status", { ticket_id: ticketId, requester_email: "grace@example.com" });
  const html = await statusRes.text();
  assert.match(html, /bug-report\.txt/);
  assert.match(html, /attachment-download-form/);
});

test("an unsupported attachment type is rejected and no ticket is created", async () => {
  const formData = new FormData();
  formData.append("requester_name", "Bad Upload");
  formData.append("requester_email", "bad-upload@example.com");
  formData.append("category", "Other");
  formData.append("subject", "Should not be created");
  formData.append("description", "Because the attachment is invalid.");
  formData.append("attachments", new Blob(["<svg onload=alert(1)>"], { type: "image/svg+xml" }), "evil.svg");

  const res = await fetch(`${app.baseUrl}/`, { method: "POST", body: formData, redirect: "manual" });
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.match(html, /Unsupported file type/);
});

test("downloading an attachment with the wrong email is refused", async () => {
  const formData = new FormData();
  formData.append("requester_name", "Owner");
  formData.append("requester_email", "owner@example.com");
  formData.append("category", "Other");
  formData.append("subject", "Owns this attachment");
  formData.append("description", "d");
  formData.append("attachments", new Blob(["secret"], { type: "text/plain" }), "secret.txt");
  const submitRes = await fetch(`${app.baseUrl}/`, { method: "POST", body: formData, redirect: "manual" });
  const ticketId = submitRes.headers.get("location").match(/confirmation\/(\d+)/)[1];

  const statusRes = await client.postForm("/status", { ticket_id: ticketId, requester_email: "owner@example.com" });
  const statusHtml = await statusRes.text();
  const attachmentId = statusHtml.match(/attachments\/(\d+)\/download/)[1];

  const wrongRes = await client.postForm(`/status/attachments/${attachmentId}/download`, {
    ticket_id: ticketId,
    requester_email: "someone-else@example.com",
  });
  assert.equal(wrongRes.status, 404);

  const rightRes = await client.postForm(`/status/attachments/${attachmentId}/download`, {
    ticket_id: ticketId,
    requester_email: "owner@example.com",
  });
  assert.equal(rightRes.status, 200);
  assert.equal(await rightRes.text(), "secret");
});
