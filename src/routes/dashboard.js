const express = require("express");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { requireAgent } = require("../middleware/auth");
const { verifyCsrf } = require("../middleware/csrf");
const { CATEGORIES, PRIORITIES, STATUSES, AGING_DAYS, PAGE_SIZE } = require("../constants");
const { sendStatusChangeEmail, sendResolvedEmail } = require("../mailer");
const { toCsv } = require("../csv");
const { addTagToTicket, removeTagFromTicket, tagsForTicket, allTags } = require("../tags");
const canned = require("../canned-responses");
const {
  ATTACHMENTS_DIR,
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

// Mirrors the AGING_EXPR SQL predicate used on the list/CSV queries below,
// for the one place (the ticket detail header) that already has a plain
// ticket row in hand and doesn't need a whole extra query for it.
function isAgingTicket(ticket) {
  if (!["Open", "In Progress"].includes(ticket.status)) return false;
  const created = new Date(`${ticket.created_at.replace(" ", "T")}Z`);
  const ageDays = (Date.now() - created.getTime()) / (1000 * 60 * 60 * 24);
  return ageDays > AGING_DAYS;
}

function getTicketOr404(res, id) {
  const ticket = db.prepare("SELECT * FROM tickets WHERE id = ?").get(id);
  if (!ticket) {
    res.status(404).render("error", { title: "Not found", message: "That ticket does not exist." });
    return null;
  }
  return ticket;
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
    where += " AND (tickets.subject LIKE ? OR tickets.requester_name LIKE ? OR tickets.requester_email LIKE ?)";
    const like = `%${q.trim()}%`;
    params.push(like, like, like);
  }

  return { where, params, filters: { status, priority, category, assigned, tag, q } };
}

// AGING_DAYS is a fixed constant (never user input), so inlining it is safe -
// same as the fixed status/priority labels already inlined in ORDER BY below.
const AGING_EXPR = `(tickets.status IN ('Open', 'In Progress') AND (julianday('now') - julianday(tickets.created_at)) > ${AGING_DAYS})`;

router.get("/", (req, res) => {
  const { where, params, filters } = buildTicketFilter(req.query, req.session.agentId);

  const totalCount = db
    .prepare(`SELECT COUNT(*) AS count FROM tickets${where}`)
    .get(...params).count;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), totalPages);
  const offset = (page - 1) * PAGE_SIZE;

  const sql = `
    SELECT tickets.*, agents.name AS assigned_name, ${AGING_EXPR} AS is_aging
    FROM tickets
    LEFT JOIN agents ON agents.id = tickets.assigned_to
    ${where}
    ORDER BY
      CASE tickets.status WHEN 'Open' THEN 0 WHEN 'In Progress' THEN 1 WHEN 'Resolved' THEN 2 ELSE 3 END,
      CASE tickets.priority WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,
      tickets.created_at DESC
    LIMIT ? OFFSET ?
  `;
  const tickets = db.prepare(sql).all(...params, PAGE_SIZE, offset);

  const counts = db
    .prepare(`SELECT status, COUNT(*) AS count FROM tickets GROUP BY status`)
    .all()
    .reduce((acc, row) => ({ ...acc, [row.status]: row.count }), {});

  const satisfaction = db
    .prepare(`SELECT AVG(rating) AS avg_rating, COUNT(*) AS count FROM ticket_ratings`)
    .get();

  res.render("dashboard/home", {
    title: "Dashboard",
    tickets,
    counts,
    satisfaction,
    statuses: STATUSES,
    priorities: PRIORITIES,
    categories: CATEGORIES,
    allTags: allTags(),
    filters,
    page,
    totalPages,
    totalCount,
    exportQuery: new URLSearchParams(
      Object.fromEntries(Object.entries(filters).filter(([, v]) => v))
    ).toString(),
  });
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

router.get("/tickets/:id", (req, res) => {
  const ticket = getTicketOr404(res, req.params.id);
  if (!ticket) return;

  const activity = db
    .prepare(
      `SELECT ticket_activity.*, agents.name AS agent_name
       FROM ticket_activity
       JOIN agents ON agents.id = ticket_activity.agent_id
       WHERE ticket_id = ?
       ORDER BY created_at ASC`
    )
    .all(ticket.id);

  const agents = db.prepare("SELECT id, name FROM agents ORDER BY name").all();
  const attachments = attachmentsForTicket(ticket.id).map((a) => ({ ...a, size_label: formatSize(a.size_bytes) }));
  const rating = db.prepare("SELECT rating, comment FROM ticket_ratings WHERE ticket_id = ?").get(ticket.id);

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
    statuses: STATUSES,
    priorities: PRIORITIES,
    uploadHint: LIMITS_HINT,
    noteError: null,
  });
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

router.post("/tickets/:id/status", verifyCsrf, (req, res) => {
  const ticket = getTicketOr404(res, req.params.id);
  if (!ticket) return;

  const { status } = req.body;
  if (!STATUSES.includes(status)) {
    return res.status(400).render("error", { title: "Invalid status", message: "That status is not valid." });
  }

  if (status !== ticket.status) {
    db.prepare("UPDATE tickets SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, ticket.id);
    db.prepare(
      `INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, 'status_change', ?)`
    ).run(ticket.id, req.session.agentId, `Status changed from "${ticket.status}" to "${status}".`);

    if (status === "Resolved") {
      // Generated lazily, once, the first time a ticket actually resolves -
      // most tickets never need one. A bearer token, not tied to a login:
      // see the ticket_ratings comment in src/db/index.js for why that's
      // the right amount of friction here.
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
  }

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

router.post("/tickets/:id/assign", verifyCsrf, (req, res) => {
  const ticket = getTicketOr404(res, req.params.id);
  if (!ticket) return;

  const raw = req.body.assigned_to;
  const newAssigneeId = raw ? parseInt(raw, 10) : null;

  if (newAssigneeId) {
    const exists = db.prepare("SELECT id, name FROM agents WHERE id = ?").get(newAssigneeId);
    if (!exists) {
      return res.status(400).render("error", { title: "Invalid agent", message: "That agent does not exist." });
    }
  }

  if (newAssigneeId !== ticket.assigned_to) {
    db.prepare("UPDATE tickets SET assigned_to = ?, updated_at = datetime('now') WHERE id = ?").run(
      newAssigneeId,
      ticket.id
    );
    const label = newAssigneeId
      ? db.prepare("SELECT name FROM agents WHERE id = ?").get(newAssigneeId).name
      : "Unassigned";
    db.prepare(
      `INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, 'assignment', ?)`
    ).run(ticket.id, req.session.agentId, `Assigned to ${label}.`);
  }

  res.redirect(`/dashboard/tickets/${ticket.id}`);
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

  if (body) {
    db.prepare(
      `INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, 'note', ?)`
    ).run(ticket.id, req.session.agentId, body);
  }
  if (hasFiles) {
    saveAttachments({ ticketId: ticket.id, files: req.files, uploadedBy: "agent", agentId: req.session.agentId });
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

router.get("/agents", (req, res) => {
  const agents = db
    .prepare(
      `SELECT agents.id, agents.name, agents.email, agents.created_at,
              (SELECT COUNT(*) FROM tickets WHERE assigned_to = agents.id AND status IN ('Open', 'In Progress')) AS open_count
       FROM agents ORDER BY agents.name`
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
        `SELECT agents.id, agents.name, agents.email, agents.created_at,
                (SELECT COUNT(*) FROM tickets WHERE assigned_to = agents.id AND status IN ('Open', 'In Progress')) AS open_count
         FROM agents ORDER BY agents.name`
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

module.exports = router;
