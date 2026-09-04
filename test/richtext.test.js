// This module is the one place in the app that deliberately outputs raw,
// unescaped HTML (<%- %>) instead of relying on EJS's own auto-escaping -
// so it gets adversarial testing, not just happy-path formatting checks.
// The core invariant under test: no input, however crafted, ever produces
// a new tag or attribute boundary that wasn't one of this module's own
// hardcoded templates.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { renderRichText } = require("../src/richtext");

test("plain text with no markup passes through escaped, unchanged otherwise", () => {
  assert.equal(renderRichText("just plain text"), "just plain text");
});

test("bold and italic render as the expected safe tags", () => {
  assert.equal(renderRichText("**bold**"), "<strong>bold</strong>");
  assert.equal(renderRichText("*italic*"), "<em>italic</em>");
  assert.equal(renderRichText("**bold** and *italic*"), "<strong>bold</strong> and <em>italic</em>");
});

test("a safe http(s) link renders as an anchor with a locked-down rel/target", () => {
  const out = renderRichText("[the docs](https://example.com/docs)");
  assert.equal(out, '<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">the docs</a>');
});

test("a javascript: link is rejected - rendered as plain escaped text, never an href", () => {
  // Note: a literal paren in the URL (as in plain "javascript:alert(1)")
  // already fails the link regex's own syntax (it excludes parens, to stay
  // unambiguous about where the URL ends) - that's a happy accident, not
  // the real protection. The case below is paren-free specifically so it's
  // the scheme allowlist doing the rejecting, not regex syntax luck.
  const out = renderRichText("[click me](javascript:alert%281%29)");
  assert.doesNotMatch(out, /<a /);
  assert.equal(out, "[click me](javascript:alert%281%29)"); // left as literal, safe text
});

test("a data: link is rejected the same way", () => {
  const out = renderRichText("[x](data:text/html,<script>alert(1)</script>)");
  assert.doesNotMatch(out, /<a /);
  assert.doesNotMatch(out, /<script>/);
});

test("raw <script> tags are always escaped, with or without markup nearby", () => {
  assert.equal(renderRichText("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.doesNotMatch(renderRichText("**<script>alert(1)</script>**"), /<script>/);
});

test("an onerror/onload-style img payload is fully escaped, not rendered as a live tag", () => {
  const out = renderRichText('<img src=x onerror=alert(1)>');
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /&lt;img/);
});

test("markup syntax embedded inside an attack payload can't smuggle a real tag through", () => {
  // If bold/link substitution ever ran BEFORE escaping (the actual bug this
  // module is designed to avoid), this exact input could reintroduce a live
  // <script> tag. Escaping-first means it can't, regardless of add-on markup.
  const out = renderRichText("**<script>alert(1)</script>** and [x](javascript:alert%282%29)");
  assert.doesNotMatch(out, /<script>/);
  assert.doesNotMatch(out, /<a /); // the javascript: link must not have become a real anchor
  assert.match(out, /<strong>/); // the safe bold wrapper still applies around the escaped payload
});

test("a quote inside the URL can't break out of the generated href attribute", () => {
  // Paren-free, so the link regex actually matches this one (unlike the
  // javascript: cases above) - this is the real test of the escape-before-
  // substitute ordering: the quote has to already be &#34; by the time it's
  // placed inside href="...", or it would terminate the attribute early and
  // let onmouseover become a second, live, executable attribute.
  const out = renderRichText('[x](https://example.com/"onmouseover="alert1)');
  assert.match(out, /<a href="https:\/\/example\.com\/&#34;onmouseover=&#34;alert1"/);
  // Exactly the two quotes this module itself added (opening and closing
  // the href attribute) - none from the payload survived as literal '"'.
  const hrefValue = out.match(/href="([^"]*)"/)[1];
  assert.doesNotMatch(hrefValue, /"/);
  assert.doesNotMatch(out, /onmouseover="[a-z]/i); // never a live, separately-parsed attribute
});

test("malformed/unmatched markup is left as safe literal text, not a broken tag", () => {
  assert.equal(renderRichText("a lone ** asterisk pair with no close"), "a lone ** asterisk pair with no close");
  assert.equal(renderRichText("[unclosed link(https://example.com)"), "[unclosed link(https://example.com)");
});

test("a bare domain with no scheme is not treated as a link", () => {
  const out = renderRichText("[click here](example.com)");
  assert.doesNotMatch(out, /<a /);
});

test("newlines are preserved (relying on the existing preserve-newlines CSS class, not <br> tags)", () => {
  assert.equal(renderRichText("line one\nline two"), "line one\nline two");
});
