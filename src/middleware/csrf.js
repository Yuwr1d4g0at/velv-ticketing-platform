const crypto = require("crypto");

// Minimal synchronizer-token CSRF protection. Each session gets one token,
// which every state-changing form must echo back as a hidden field.
function csrfToken(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

function verifyCsrf(req, res, next) {
  const submitted = req.body && req.body._csrf;
  const expected = req.session && req.session.csrfToken;
  if (
    typeof submitted === "string" &&
    typeof expected === "string" &&
    submitted.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(expected))
  ) {
    return next();
  }
  return res.status(403).render("error", {
    title: "Form expired",
    message: "This form has expired or was submitted incorrectly. Please go back and try again.",
  });
}

module.exports = { csrfToken, verifyCsrf };
