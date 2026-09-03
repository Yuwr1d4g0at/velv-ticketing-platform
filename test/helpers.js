// Test scaffolding: boots the real app (src/app.js) against a throwaway
// SQLite file and an ephemeral port, with a tiny cookie-jar fetch client on
// top since node's built-in fetch doesn't carry cookies between requests on
// its own. No test framework dependency - just node:test + node:assert.
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

function tempDbPath() {
  return path.join(os.tmpdir(), `velv-test-${crypto.randomBytes(8).toString("hex")}.sqlite`);
}

// Call once per test file (in a top-level `before`), not once per test case:
// src/app.js and src/db/index.js are cached by node's require() the first
// time they're loaded in this process, so a second call here would silently
// reuse the first call's database rather than getting a fresh one.
async function startTestApp() {
  const dbPath = tempDbPath();
  process.env.DB_PATH = dbPath;
  process.env.SESSION_SECRET = "test-secret-not-for-production";
  process.env.COOKIE_SECURE = "false";
  delete process.env.SMTP_HOST; // keep email notifications a no-op in tests

  const app = require("../src/app");

  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address();

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  }

  return { baseUrl: `http://127.0.0.1:${port}`, close, dbPath };
}

function makeClient(baseUrl) {
  const cookies = {};

  function cookieHeader() {
    return Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  function captureCookies(res) {
    const setCookie =
      typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const raw of setCookie) {
      const pair = raw.split(";")[0];
      const idx = pair.indexOf("=");
      if (idx === -1) continue;
      cookies[pair.slice(0, idx)] = pair.slice(idx + 1);
    }
  }

  async function request(method, urlPath, { body, headers = {}, redirect = "manual" } = {}) {
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method,
      redirect,
      headers: { ...headers, cookie: cookieHeader() },
      body,
    });
    captureCookies(res);
    return res;
  }

  return {
    get: (urlPath, opts) => request("GET", urlPath, opts),
    post: (urlPath, opts) => request("POST", urlPath, opts),
    postForm: (urlPath, fields) =>
      request("POST", urlPath, {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
      }),
    cookies: () => ({ ...cookies }),
  };
}

function extractCsrf(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  return match ? match[1] : null;
}

module.exports = { startTestApp, makeClient, extractCsrf };
