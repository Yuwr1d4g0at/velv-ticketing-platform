const express = require("express");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { verifyCsrf } = require("../middleware/csrf");

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many login attempts. Please wait a few minutes and try again.",
});

router.get("/login", (req, res) => {
  if (req.session.agentId) return res.redirect("/dashboard");
  res.render("auth/login", { title: "Log in", error: null });
});

router.post("/login", loginLimiter, verifyCsrf, (req, res) => {
  const { email = "", password = "" } = req.body;
  const agent = db
    .prepare("SELECT id, name, email, password_hash FROM agents WHERE email = ?")
    .get(email.trim().toLowerCase());

  const genericError = "Incorrect email or password.";

  if (!agent || !bcrypt.compareSync(password, agent.password_hash)) {
    return res.status(401).render("auth/login", { title: "Log in", error: genericError });
  }

  req.session.regenerate((err) => {
    if (err) return res.status(500).render("error", { title: "Error", message: "Could not log in. Please try again." });
    req.session.agentId = agent.id;
    const redirectTo = req.session.redirectTo || "/dashboard";
    delete req.session.redirectTo;
    res.redirect(redirectTo);
  });
});

router.post("/logout", verifyCsrf, (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

module.exports = router;
