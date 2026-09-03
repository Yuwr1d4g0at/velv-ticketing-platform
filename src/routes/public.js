const express = require("express");
const path = require("path");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { CATEGORIES } = require("../constants");
const { sendTicketCreatedEmail } = require("../mailer");
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
  } = req.body;

  const values = { requester_name, requester_email, category, subject, description };
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
  if (req.uploadError) errors.push(req.uploadError);

  if (errors.length) {
    deleteUploadedFiles(req.files);
    return res.status(400).render("public/request-form", {
      title: "Submit a request",
      categories: CATEGORIES,
      errors,
      values,
      uploadHint: LIMITS_HINT,
    });
  }

  // Priority isn't the requester's call - it's triaged by the helpdesk team
  // (see the Priority card on the dashboard ticket page). Every new ticket
  // starts at the tickets.priority column's default ('Medium') until an
  // agent changes it.
  const result = db
    .prepare(
      `INSERT INTO tickets (subject, description, category, requester_name, requester_email)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      subject.trim(),
      description.trim(),
      category,
      requester_name.trim(),
      requester_email.trim().toLowerCase()
    );

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
  const attachments = attachmentsForTicket(ticket.id);
  res.render("public/confirmation", { title: "Request submitted", ticket, attachments });
});

router.get("/status", (req, res) => {
  res.render("public/status-check", { title: "Check ticket status", ticket: null, attachments: [], error: null });
});

router.post("/status", statusLimiter, (req, res) => {
  const { ticket_id = "", requester_email = "" } = req.body;
  const id = parseInt(ticket_id, 10);

  if (!id || !requester_email.trim()) {
    return res.render("public/status-check", {
      title: "Check ticket status",
      ticket: null,
      attachments: [],
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
      error: "No matching ticket found. Check the ticket number and email address.",
    });
  }

  res.render("public/status-check", {
    title: "Check ticket status",
    ticket,
    attachments: attachmentsForTicket(ticket.id).map((a) => ({ ...a, size_label: formatSize(a.size_bytes) })),
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

  const attachment = getAttachment(ticket.id, req.params.attachmentId);
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
