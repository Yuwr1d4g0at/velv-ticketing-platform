// A visitor's language preference (EN/PT, see src/i18n.js), read from a
// plain cookie - not tied to express-session, since it has to work for
// anonymous requesters on the public pages, not just logged-in agents.
// Hand-rolled cookie parsing rather than the cookie-parser dependency: this
// app only ever needs to read one small, non-sensitive cookie.
const { t, categoryLabel, LANGUAGES } = require("../i18n");

function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    if (key) out[key] = decodeURIComponent((pair.slice(idx + 1) || "").trim());
  });
  return out;
}

function attachLang(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  req.lang = LANGUAGES.includes(cookies.velv_lang) ? cookies.velv_lang : "en";
  res.locals.lang = req.lang;
  res.locals.t = (key) => t(req.lang, key);
  res.locals.categoryLabel = (category) => categoryLabel(req.lang, category);
  next();
}

module.exports = { attachLang, parseCookies };
