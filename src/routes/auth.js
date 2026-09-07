const express = require("express");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { verifyCsrf } = require("../middleware/csrf");
const msSso = require("../msSso");

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
  res.render("auth/login", { title: "Log in", error: null, ssoEnabled: msSso.isEnabled() });
});

// Records every attempt, success or failure - not just what the rate
// limiter blocked in the moment - so a compromised account or a slow
// brute-force run is visible after the fact from /dashboard/settings/login-log.
function logLoginAttempt(req, { email, agentId = null, success }) {
  db.prepare(
    `INSERT INTO login_log (email, agent_id, success, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)`
  ).run(email, agentId, success ? 1 : 0, req.ip, (req.get("user-agent") || "").slice(0, 300));
}

router.post("/login", loginLimiter, verifyCsrf, (req, res) => {
  const { email = "", password = "" } = req.body;
  const normalizedEmail = email.trim().toLowerCase();
  const agent = db
    .prepare("SELECT id, name, email, password_hash FROM agents WHERE email = ? AND active = 1")
    .get(normalizedEmail);

  const genericError = "Incorrect email or password.";

  if (!agent || !bcrypt.compareSync(password, agent.password_hash)) {
    logLoginAttempt(req, { email: normalizedEmail, success: false });
    return res.status(401).render("auth/login", { title: "Log in", error: genericError, ssoEnabled: msSso.isEnabled() });
  }

  logLoginAttempt(req, { email: normalizedEmail, agentId: agent.id, success: true });

  req.session.regenerate((err) => {
    if (err) return res.status(500).render("error", { title: "Error", message: "Could not log in. Please try again." });
    req.session.agentId = agent.id;
    const redirectTo = req.session.redirectTo || "/dashboard";
    delete req.session.redirectTo;
    res.redirect(redirectTo);
  });
});

// "Sign in with Microsoft" (see src/msSso.js) - a second door in alongside
// the password form above, off entirely (404) unless MS_TENANT_ID/
// MS_CLIENT_ID/MS_CLIENT_SECRET are configured. Not rate-limited the same
// way POST /login is - Microsoft's own sign-in page is what actually
// prompts for a credential, and handles brute-force protection on that side.
router.get("/auth/microsoft", async (req, res, next) => {
  if (!msSso.isEnabled()) return res.status(404).render("error", { title: "Not found", message: "Not found." });
  try {
    res.redirect(await msSso.buildAuthUrl(req));
  } catch (err) {
    next(err);
  }
});

router.get("/auth/microsoft/callback", async (req, res) => {
  if (!msSso.isEnabled()) return res.status(404).render("error", { title: "Not found", message: "Not found." });

  let account;
  try {
    account = await msSso.handleCallback(req);
  } catch (err) {
    // A stray retry, an expired state, or the agent clicking back/refresh
    // on this page - not worth a 500, just send them back to try again.
    logLoginAttempt(req, { email: "(microsoft sso)", success: false });
    return res
      .status(401)
      .render("auth/login", { title: "Log in", error: "Could not sign in with Microsoft. Please try again.", ssoEnabled: true });
  }

  // Explicit allow-list, not auto-provisioning: authenticating with
  // Microsoft only ever logs someone in if their email already matches an
  // existing, active agent - it never creates one. Same account-creation
  // path (the Agents page, or `npm run seed`) as password-based agents.
  const agent = db.prepare("SELECT id, name, email FROM agents WHERE email = ? AND active = 1").get(account.email);

  if (!agent) {
    logLoginAttempt(req, { email: account.email, success: false });
    return res.status(401).render("auth/login", {
      title: "Log in",
      error: `Signed in as ${account.email} with Microsoft, but that isn't set up as an agent here yet. Ask an existing agent to add you from the Agents page first.`,
      ssoEnabled: true,
    });
  }

  logLoginAttempt(req, { email: account.email, agentId: agent.id, success: true });

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
