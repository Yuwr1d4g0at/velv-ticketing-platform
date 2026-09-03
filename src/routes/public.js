const express = require("express");
const db = require("../db");
const { CATEGORIES, PRIORITIES } = require("../constants");

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.get("/", (req, res) => {
  res.render("public/request-form", {
    title: "Submit a request",
    categories: CATEGORIES,
    priorities: PRIORITIES,
    errors: [],
    values: {},
  });
});

router.post("/", (req, res) => {
  const {
    requester_name = "",
    requester_email = "",
    category = "",
    priority = "",
    subject = "",
    description = "",
  } = req.body;

  const values = { requester_name, requester_email, category, priority, subject, description };
  const errors = [];

  if (!requester_name.trim()) errors.push("Your name is required.");
  if (!requester_email.trim() || !EMAIL_RE.test(requester_email.trim())) {
    errors.push("A valid email address is required.");
  }
  if (!CATEGORIES.includes(category)) errors.push("Please choose a valid category.");
  if (!PRIORITIES.includes(priority)) errors.push("Please choose a valid priority.");
  if (!subject.trim()) errors.push("A subject is required.");
  if (!description.trim()) errors.push("A description is required.");
  if (subject.length > 200) errors.push("Subject must be under 200 characters.");
  if (description.length > 5000) errors.push("Description must be under 5000 characters.");

  if (errors.length) {
    return res.status(400).render("public/request-form", {
      title: "Submit a request",
      categories: CATEGORIES,
      priorities: PRIORITIES,
      errors,
      values,
    });
  }

  const result = db
    .prepare(
      `INSERT INTO tickets (subject, description, category, priority, requester_name, requester_email)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      subject.trim(),
      description.trim(),
      category,
      priority,
      requester_name.trim(),
      requester_email.trim().toLowerCase()
    );

  res.redirect(`/confirmation/${result.lastInsertRowid}`);
});

router.get("/confirmation/:id", (req, res) => {
  const ticket = db
    .prepare("SELECT id, subject, status, created_at FROM tickets WHERE id = ?")
    .get(req.params.id);
  if (!ticket) return res.redirect("/");
  res.render("public/confirmation", { title: "Request submitted", ticket });
});

router.get("/status", (req, res) => {
  res.render("public/status-check", { title: "Check ticket status", ticket: null, error: null });
});

router.post("/status", (req, res) => {
  const { ticket_id = "", requester_email = "" } = req.body;
  const id = parseInt(ticket_id, 10);

  if (!id || !requester_email.trim()) {
    return res.render("public/status-check", {
      title: "Check ticket status",
      ticket: null,
      error: "Enter both your ticket number and the email you used to submit it.",
    });
  }

  const ticket = db
    .prepare(
      `SELECT id, subject, description, category, priority, status, created_at, updated_at
       FROM tickets WHERE id = ? AND requester_email = ?`
    )
    .get(id, requester_email.trim().toLowerCase());

  if (!ticket) {
    return res.render("public/status-check", {
      title: "Check ticket status",
      ticket: null,
      error: "No matching ticket found. Check the ticket number and email address.",
    });
  }

  res.render("public/status-check", { title: "Check ticket status", ticket, error: null });
});

module.exports = router;
