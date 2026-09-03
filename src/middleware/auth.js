function requireAgent(req, res, next) {
  if (req.session && req.session.agentId) {
    return next();
  }
  req.session.redirectTo = req.originalUrl;
  return res.redirect("/login");
}

// Makes the logged-in agent (if any) available to every view as `currentAgent`.
// Re-checks `active` on every request (not just at login) - deactivating an
// agent should end their existing session immediately, not just block their
// next login attempt.
function attachAgent(db) {
  return (req, res, next) => {
    if (req.session && req.session.agentId) {
      const agent = db
        .prepare("SELECT id, name, email FROM agents WHERE id = ? AND active = 1")
        .get(req.session.agentId);
      res.locals.currentAgent = agent || null;
      if (!agent) {
        req.session.agentId = null;
      }
    } else {
      res.locals.currentAgent = null;
    }
    next();
  };
}

module.exports = { requireAgent, attachAgent };
