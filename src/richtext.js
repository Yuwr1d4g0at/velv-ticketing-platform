// A deliberately narrow markdown-like subset for ticket descriptions and
// note/reply bodies - NOT a general markdown parser, and specifically not
// one that ever passes raw user HTML through. The one safety property that
// matters: user input is HTML-escaped FIRST, and every substitution below
// only ever wraps already-escaped text in a fixed, hardcoded safe tag
// (<strong>, <em>, or a scheme-checked <a href>) - so no combination of
// input can ever introduce a new tag or attribute boundary of its own.
// Getting this wrong is the one place in this app that would reopen the
// exact XSS risk everywhere else avoids by leaning on EJS's own auto-
// escaping (<%= %>) - this module's output is meant for <%- %> (raw)
// instead, so it has to do that escaping itself, correctly, every time.
function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&#34;")
    .replace(/'/g, "&#39;");
}

// http(s) only - rejects javascript:, data:, vbscript:, a bare "not a url"
// with no scheme, everything else. A rejected link renders as its
// original escaped literal text (still safe, just not a clickable link),
// never as an href.
const SAFE_URL_RE = /^https?:\/\//i;

function renderRichText(raw) {
  let html = escapeHtml(raw);

  // Bold before italic - **x** would otherwise leave two stray single
  // asterisks for the italic pass to (harmlessly, but confusingly) also
  // match. No newlines inside a span, and non-greedy so "**a** and **b**"
  // makes two spans, not one covering "a** and **b".
  html = html.replace(/\*\*([^\n*]+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^\n*]+?)\*/g, "<em>$1</em>");

  // [text](url) - both text and url are already-escaped at this point, so
  // an ampersand or quote inside either one is already the safe entity
  // form, not a live character that could break out of the href attribute.
  html = html.replace(/\[([^\n\]]+?)\]\(([^\s()]+?)\)/g, (whole, text, url) =>
    SAFE_URL_RE.test(url) ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>` : whole
  );

  return html;
}

module.exports = { renderRichText };
