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
// next login attempt. Includes department_id/is_admin/department_name -
// department scoping (src/departments.js) reads currentAgent directly
// rather than re-querying the agent on every route, so this is the one
// place that has to keep them current.
function attachAgent(db) {
  return (req, res, next) => {
    if (req.session && req.session.agentId) {
      const agent = db
        .prepare(
          `SELECT agents.id, agents.name, agents.email, agents.department_id, agents.is_admin,
                  departments.name AS department_name
           FROM agents
           LEFT JOIN departments ON departments.id = agents.department_id
           WHERE agents.id = ? AND agents.active = 1`
        )
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
