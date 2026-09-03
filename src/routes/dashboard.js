const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { requireAgent } = require("../middleware/auth");
const { verifyCsrf } = require("../middleware/csrf");
const { CATEGORIES, PRIORITIES, STATUSES } = require("../constants");

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

router.get("/", (req, res) => {
  const { status = "", priority = "", category = "", assigned = "", q = "" } = req.query;

  let sql = `
    SELECT tickets.*, agents.name AS assigned_name
    FROM tickets
    LEFT JOIN agents ON agents.id = tickets.assigned_to
    WHERE 1 = 1
  `;
  const params = [];

  if (STATUSES.includes(status)) {
    sql += " AND tickets.status = ?";
    params.push(status);
  }
  if (PRIORITIES.includes(priority)) {
    sql += " AND tickets.priority = ?";
    params.push(priority);
  }
  if (CATEGORIES.includes(category)) {
    sql += " AND tickets.category = ?";
    params.push(category);
  }
  if (assigned === "unassigned") {
    sql += " AND tickets.assigned_to IS NULL";
  } else if (assigned === "me") {
    sql += " AND tickets.assigned_to = ?";
    params.push(req.session.agentId);
  }
  if (q.trim()) {
    sql += " AND (tickets.subject LIKE ? OR tickets.requester_name LIKE ? OR tickets.requester_email LIKE ?)";
    const like = `%${q.trim()}%`;
    params.push(like, like, like);
  }

  sql += ` ORDER BY
    CASE tickets.status WHEN 'Open' THEN 0 WHEN 'In Progress' THEN 1 WHEN 'Resolved' THEN 2 ELSE 3 END,
    CASE tickets.priority WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,
    tickets.created_at DESC
  `;

  const tickets = db.prepare(sql).all(...params);

  const counts = db
    .prepare(
      `SELECT status, COUNT(*) AS count FROM tickets GROUP BY status`
    )
    .all()
    .reduce((acc, row) => ({ ...acc, [row.status]: row.count }), {});

  res.render("dashboard/home", {
    title: "Dashboard",
    tickets,
    counts,
    statuses: STATUSES,
    priorities: PRIORITIES,
    categories: CATEGORIES,
    filters: { status, priority, category, assigned, q },
  });
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

  res.render("dashboard/ticket", {
    title: `Ticket #${ticket.id}`,
    ticket,
    activity,
    agents,
    statuses: STATUSES,
    priorities: PRIORITIES,
  });
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

router.post("/tickets/:id/note", verifyCsrf, (req, res) => {
  const ticket = getTicketOr404(res, req.params.id);
  if (!ticket) return;

  const body = (req.body.body || "").trim();
  if (!body) {
    return res.status(400).render("error", { title: "Empty note", message: "Note text cannot be empty." });
  }
  if (body.length > 5000) {
    return res.status(400).render("error", { title: "Note too long", message: "Notes must be under 5000 characters." });
  }

  db.prepare(
    `INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, 'note', ?)`
  ).run(ticket.id, req.session.agentId, body);
  db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(ticket.id);

  res.redirect(`/dashboard/tickets/${ticket.id}`);
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
