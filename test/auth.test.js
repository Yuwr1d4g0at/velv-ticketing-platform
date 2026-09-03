const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const bcrypt = require("bcryptjs");
const { startTestApp, makeClient, extractCsrf } = require("./helpers");

let app, client;

before(async () => {
  app = await startTestApp();
  client = makeClient(app.baseUrl);

  // Seed an agent directly - same shape as src/db/seed.js, without the CLI prompt.
  const db = new DatabaseSync(app.dbPath);
  db.prepare("INSERT INTO agents (name, email, password_hash) VALUES (?, ?, ?)").run(
    "Test Agent",
    "agent@example.com",
    bcrypt.hashSync("correct-password", 4) // low cost factor - speed, not security, in tests
  );
  db.close();
});

after(() => app.close());

test("dashboard routes redirect an unauthenticated visitor to /login", async () => {
  const res = await client.get("/dashboard");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/login");
});

test("login is rejected without a valid CSRF token", async () => {
  const res = await client.postForm("/login", {
    email: "agent@example.com",
    password: "correct-password",
    _csrf: "not-the-real-token",
  });
  assert.equal(res.status, 403);
});

test("login rejects the wrong password with a generic error", async () => {
  const loginPage = await client.get("/login");
  const csrf = extractCsrf(await loginPage.text());

  const res = await client.postForm("/login", { email: "agent@example.com", password: "wrong", _csrf: csrf });
  const html = await res.text();
  assert.equal(res.status, 401);
  assert.match(html, /Incorrect email or password/);
});

test("correct credentials log the agent in and unlock the dashboard", async () => {
  const loginPage = await client.get("/login");
  const csrf = extractCsrf(await loginPage.text());

  const loginRes = await client.postForm("/login", {
    email: "agent@example.com",
    password: "correct-password",
    _csrf: csrf,
  });
  assert.equal(loginRes.status, 302);
  assert.equal(loginRes.headers.get("location"), "/dashboard");

  const dashboardRes = await client.get("/dashboard");
  assert.equal(dashboardRes.status, 200);
  const html = await dashboardRes.text();
  assert.match(html, /Signed in as Test Agent/);
});

test("logging out ends the session", async () => {
  const dashboardPage = await client.get("/dashboard");
  const csrf = extractCsrf(await dashboardPage.text());

  const logoutRes = await client.postForm("/logout", { _csrf: csrf });
  assert.equal(logoutRes.status, 302);

  const afterLogout = await client.get("/dashboard");
  assert.equal(afterLogout.status, 302);
  assert.equal(afterLogout.headers.get("location"), "/login");
});
