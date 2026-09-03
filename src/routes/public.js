const express = require("express");
const path = require("path");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { CATEGORIES } = require("../constants");
const { sendTicketCreatedEmail, sendAgentNotifiedOfReply } = require("../mailer");
const assets = require("../assets");
const {
  ATTACHMENTS_DIR,
  handleUpload,
  saveAttachments,
  deleteUploadedFiles,
  attachmentsForTicket,
  getPublicAttachment,
  formatSize,
  LIMITS_HINT,
} = require("../attachments");

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Both of these are unauthenticated and now touch either disk (file uploads)
// or a brute-forceable ticket_id + email pair, so both get the same kind of
// per-IP limiter the login form already has.
const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests submitted from this network. Please wait a few minutes and try again.",
});

const statusLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many status checks from this network. Please wait a few minutes and try again.",
});

router.get("/", (req, res) => {
  res.render("public/request-form", {
    title: "Submit a request",
    categories: CATEGORIES,
    assets: assets.assignable(),
    errors: [],
    values: {},
    uploadHint: LIMITS_HINT,
  });
});

router.post("/", submitLimiter, handleUpload("attachments"), (req, res) => {
  const {
    requester_name = "",
    requester_email = "",
    category = "",
    subject = "",
    description = "",
    asset_id = "",
  } = req.body;

  const values = { requester_name, requester_email, category, subject, description, asset_id };
  const errors = [];

  if (!requester_name.trim()) errors.push("Your name is required.");
  if (!requester_email.trim() || !EMAIL_RE.test(requester_email.trim())) {
    errors.push("A valid email address is required.");
  }
  if (!CATEGORIES.includes(category)) errors.push("Please choose a valid category.");
  if (!subject.trim()) errors.push("A subject is required.");
  if (!description.trim()) errors.push("A description is required.");
  if (subject.length > 200) errors.push("Subject must be under 200 characters.");
  if (description.length > 5000) errors.push("Description must be under 5000 characters.");
  // Asset is optional, but if one was picked it has to be real - not just
  // any parseable integer, since this is the one field on this form a
  // client could otherwise use to link a ticket to an arbitrary asset id.
  const assetId = asset_id ? parseInt(asset_id, 10) : null;
  if (assetId && !assets.get(assetId)) errors.push("Please choose a valid asset.");
  if (req.uploadError) errors.push(req.uploadError);

  if (errors.length) {
    deleteUploadedFiles(req.files);
    return res.status(400).render("public/request-form", {
      title: "Submit a request",
      categories: CATEGORIES,
      assets: assets.assignable(),
      errors,
      values,
      uploadHint: LIMITS_HINT,
    });
  }

  // Priority isn't the requester's call - it's triaged by the helpdesk team
  // (see the Priority card on the dashboard ticket page). Every new ticket
  // starts at the tickets.priority column's default ('Medium') until an
  // agent changes it.
  //
  // Auto-assigned to whichever active agent currently has the fewest open
  // (Open/In Progress) tickets, rather than left Unassigned - a simple
  // self-balancing rotation rather than a strict round-robin counter (no
  // extra state to keep in sync, and it self-corrects if someone's away).
  // Falls back to Unassigned if there are no active agents at all.
  const nextAssignee = db
    .prepare(
      `SELECT agents.id FROM agents
       LEFT JOIN tickets ON tickets.assigned_to = agents.id AND tickets.status IN ('Open', 'In Progress')
       WHERE agents.active = 1
       GROUP BY agents.id
       ORDER BY COUNT(tickets.id) ASC, agents.id ASC
       LIMIT 1`
    )
    .get();

  const result = db
    .prepare(
      `INSERT INTO tickets (subject, description, category, requester_name, requester_email, assigned_to, asset_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      subject.trim(),
      description.trim(),
      category,
      requester_name.trim(),
      requester_email.trim().toLowerCase(),
      nextAssignee ? nextAssignee.id : null,
      assetId
    );

  if (nextAssignee) {
    db.prepare(
      `INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, NULL, 'assignment', ?)`
    ).run(result.lastInsertRowid, "Auto-assigned on creation.");
  }

  saveAttachments({ ticketId: result.lastInsertRowid, files: req.files, uploadedBy: "requester" });

  // Fire-and-forget: email delivery (or a missing/misconfigured SMTP setup)
  // must never hold up or fail the requester's redirect to their confirmation.
  sendTicketCreatedEmail({
    to: requester_email.trim().toLowerCase(),
    ticketId: result.lastInsertRowid,
    subject: subject.trim(),
  }).catch((err) => console.error("Could not send ticket-created email:", err.message));

  res.redirect(`/confirmation/${result.lastInsertRowid}`);
});

router.get("/confirmation/:id", (req, res) => {
  const ticket = db
    .prepare("SELECT id, subject, status, created_at FROM tickets WHERE id = ?")
    .get(req.params.id);
  if (!ticket) return res.redirect("/");
  // Attachment names only, no download links: unlike /status, this page has no
  // ownership check (it's a plain post-submit redirect target), so it must not
  // hand out a way to fetch file contents to anyone who can guess a ticket id.
  const attachments = attachmentsForTicket(ticket.id, { requesterVisibleOnly: true });
  res.render("public/confirmation", { title: "Request submitted", ticket, attachments });
});

// The requester-visible half of a ticket's conversation: agent replies
// (type 'reply') and the requester's own past replies - never internal
// notes or system events, which is the whole reason 'reply' exists as its
// own type separate from 'note' (see src/db/index.js).
function conversationForTicket(ticketId) {
  return db
    .prepare(
      `SELECT ticket_activity.*, agents.name AS agent_name
       FROM ticket_activity
       LEFT JOIN agents ON agents.id = ticket_activity.agent_id
       WHERE ticket_id = ? AND type IN ('reply', 'requester_reply')
       ORDER BY created_at ASC`
    )
    .all(ticketId);
}

router.get("/status", (req, res) => {
  res.render("public/status-check", {
    title: "Check ticket status",
    ticket: null,
    attachments: [],
    conversation: [],
    error: null,
  });
});

router.post("/status", statusLimiter, (req, res) => {
  const { ticket_id = "", requester_email = "" } = req.body;
  const id = parseInt(ticket_id, 10);

  if (!id || !requester_email.trim()) {
    return res.render("public/status-check", {
      title: "Check ticket status",
      ticket: null,
      attachments: [],
      conversation: [],
      error: "Enter both your ticket number and the email you used to submit it.",
    });
  }

  const ticket = db
    .prepare(
      `SELECT id, subject, description, category, priority, status, created_at, updated_at, requester_email
       FROM tickets WHERE id = ? AND requester_email = ?`
    )
    .get(id, requester_email.trim().toLowerCase());

  if (!ticket) {
    return res.render("public/status-check", {
      title: "Check ticket status",
      ticket: null,
      attachments: [],
      conversation: [],
      error: "No matching ticket found. Check the ticket number and email address.",
    });
  }

  res.render("public/status-check", {
    title: "Check ticket status",
    ticket,
    attachments: attachmentsForTicket(ticket.id, { requesterVisibleOnly: true }).map((a) => ({ ...a, size_label: formatSize(a.size_bytes) })),
    conversation: conversationForTicket(ticket.id),
    error: null,
  });
});

// Same ownership check as everything else on /status (ticket id + the exact
// requester email on file). If the ticket was Resolved or Closed, a reply
// reopens it - the requester replying at all is a pretty strong signal it
// isn't actually done, same as every major helpdesk tool does.
router.post("/status/reply", statusLimiter, (req, res) => {
  const { ticket_id = "", requester_email = "", message = "" } = req.body;
  const id = parseInt(ticket_id, 10);
  const email = requester_email.trim().toLowerCase();

  const ticket = db.prepare("SELECT * FROM tickets WHERE id = ? AND requester_email = ?").get(id, email);
  if (!ticket) {
    return res.status(404).render("error", { title: "Not found", message: "That ticket does not exist." });
  }

  const body = message.trim().slice(0, 5000);
  if (!body) {
    return res.render("public/status-check", {
      title: "Check ticket status",
      ticket,
      attachments: attachmentsForTicket(ticket.id, { requesterVisibleOnly: true }).map((a) => ({ ...a, size_label: formatSize(a.size_bytes) })),
      conversation: conversationForTicket(ticket.id),
      error: "Enter a message before sending.",
    });
  }

  db.prepare(
    `INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, NULL, 'requester_reply', ?)`
  ).run(ticket.id, body);

  if (["Resolved", "Closed"].includes(ticket.status)) {
    db.prepare("UPDATE tickets SET status = 'Open', updated_at = datetime('now') WHERE id = ?").run(ticket.id);
    db.prepare(
      `INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, NULL, 'status_change', ?)`
    ).run(ticket.id, `Status changed from "${ticket.status}" to "Open" (reopened by requester reply).`);
  } else {
    db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(ticket.id);
  }

  if (ticket.assigned_to) {
    const agent = db.prepare("SELECT email FROM agents WHERE id = ?").get(ticket.assigned_to);
    sendAgentNotifiedOfReply({
      to: agent && agent.email,
      ticketId: ticket.id,
      subject: ticket.subject,
      message: body,
    }).catch((err) => console.error("Could not send agent-notified-of-reply email:", err.message));
  }

  const updated = db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticket.id);
  res.render("public/status-check", {
    title: "Check ticket status",
    ticket: updated,
    attachments: attachmentsForTicket(ticket.id, { requesterVisibleOnly: true }).map((a) => ({ ...a, size_label: formatSize(a.size_bytes) })),
    conversation: conversationForTicket(ticket.id),
    error: null,
  });
});

// Downloading a file requires the same proof of ownership as looking the ticket
// up in the first place: the exact requester email on file. Same trust model
// /status already uses, just extended to cover the attachment's bytes too.
router.post("/status/attachments/:attachmentId/download", statusLimiter, (req, res) => {
  const { ticket_id = "", requester_email = "" } = req.body;
  const id = parseInt(ticket_id, 10);

  const ticket = db
    .prepare("SELECT id FROM tickets WHERE id = ? AND requester_email = ?")
    .get(id, (requester_email || "").trim().toLowerCase());
  if (!ticket) {
    return res.status(404).render("error", { title: "Not found", message: "That attachment does not exist." });
  }

  const attachment = getPublicAttachment(ticket.id, req.params.attachmentId);
  if (!attachment) {
    return res.status(404).render("error", { title: "Not found", message: "That attachment does not exist." });
  }

  res.download(path.join(ATTACHMENTS_DIR, attachment.stored_name), attachment.original_name);
});

// Reached via the link in the "ticket resolved" email, not a login - see the
// ticket_ratings comment in src/db/index.js for the trust model this token
// represents (a bearer capability to rate this one ticket, nothing more).
function getTicketByRatingToken(token) {
  return db.prepare("SELECT id, subject FROM tickets WHERE rating_token = ?").get(token);
}

router.get("/rate/:token", statusLimiter, (req, res) => {
  const ticket = getTicketByRatingToken(req.params.token);
  if (!ticket) {
    return res.status(404).render("error", { title: "Not found", message: "That rating link isn't valid." });
  }
  const existing = db.prepare("SELECT rating FROM ticket_ratings WHERE ticket_id = ?").get(ticket.id);
  res.render("public/rate", {
    title: "Rate your experience",
    ticket,
    token: req.params.token,
    alreadyRated: Boolean(existing),
    error: null,
  });
});

router.post("/rate/:token", statusLimiter, (req, res) => {
  const ticket = getTicketByRatingToken(req.params.token);
  if (!ticket) {
    return res.status(404).render("error", { title: "Not found", message: "That rating link isn't valid." });
  }

  const existing = db.prepare("SELECT rating FROM ticket_ratings WHERE ticket_id = ?").get(ticket.id);
  if (existing) {
    return res.render("public/rate", {
      title: "Rate your experience",
      ticket,
      token: req.params.token,
      alreadyRated: true,
      error: null,
    });
  }

  const rating = parseInt(req.body.rating, 10);
  if (!(rating >= 1 && rating <= 5)) {
    return res.status(400).render("public/rate", {
      title: "Rate your experience",
      ticket,
      token: req.params.token,
      alreadyRated: false,
      error: "Choose a rating from 1 to 5 stars.",
    });
  }

  const comment = (req.body.comment || "").trim().slice(0, 2000);
  db.prepare("INSERT INTO ticket_ratings (ticket_id, rating, comment) VALUES (?, ?, ?)").run(
    ticket.id,
    rating,
    comment || null
  );

  res.render("public/rate", { title: "Rate your experience", ticket, alreadyRated: true, error: null });
});

module.exports = router;
