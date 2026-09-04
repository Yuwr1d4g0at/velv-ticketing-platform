// Public knowledge-base articles - agents write and publish them, requesters
// browse/search them without logging in. The single biggest lever this app
// has for cutting ticket volume, and something it had zero of before this.
const db = require("./db");

function slugify(title) {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining accents (café -> cafe)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// Appends -2, -3, ... if the plain slug's taken - titles collide more than
// you'd think ("How to reset your password" twice, a year apart).
function uniqueSlug(title, excludeId = null) {
  const base = slugify(title) || "article";
  let candidate = base;
  let n = 2;
  while (true) {
    const existing = db.prepare("SELECT id FROM kb_articles WHERE slug = ? AND id != ?").get(candidate, excludeId || -1);
    if (!existing) return candidate;
    candidate = `${base}-${n++}`;
  }
}

function publishedList({ category = "", q = "" } = {}) {
  let sql = "SELECT * FROM kb_articles WHERE published = 1";
  const params = [];
  if (category) {
    sql += " AND category = ?";
    params.push(category);
  }
  if (q.trim()) {
    sql += " AND (title LIKE ? OR body LIKE ?)";
    const like = `%${q.trim()}%`;
    params.push(like, like);
  }
  sql += " ORDER BY title";
  return db.prepare(sql).all(...params);
}

function allForDashboard() {
  return db.prepare("SELECT * FROM kb_articles ORDER BY published DESC, title").all();
}

function getBySlug(slug) {
  return db.prepare("SELECT * FROM kb_articles WHERE slug = ? AND published = 1").get(slug);
}

function get(id) {
  return db.prepare("SELECT * FROM kb_articles WHERE id = ?").get(id);
}

function create(fields, agentId) {
  const title = (fields.title || "").trim().slice(0, 200);
  const body = (fields.body || "").trim().slice(0, 20000);
  const category = (fields.category || "").trim().slice(0, 100) || null;
  if (!title) return { error: "Title is required." };
  if (!body) return { error: "Body is required." };

  const slug = uniqueSlug(title);
  const result = db
    .prepare("INSERT INTO kb_articles (title, slug, body, category, agent_id) VALUES (?, ?, ?, ?, ?)")
    .run(title, slug, body, category, agentId);
  return { id: result.lastInsertRowid };
}

function update(id, fields) {
  const title = (fields.title || "").trim().slice(0, 200);
  const body = (fields.body || "").trim().slice(0, 20000);
  const category = (fields.category || "").trim().slice(0, 100) || null;
  const published = fields.published ? 1 : 0;
  if (!title) return { error: "Title is required." };
  if (!body) return { error: "Body is required." };

  const current = get(id);
  if (!current) return { error: "That article does not exist." };
  // The slug is part of the article's public URL - keep it stable across
  // edits (retitling shouldn't break a link someone already shared) unless
  // there's never been a title at all, which can't actually happen here.
  db.prepare(
    "UPDATE kb_articles SET title = ?, body = ?, category = ?, published = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(title, body, category, published, id);
  return { id };
}

module.exports = { publishedList, allForDashboard, getBySlug, get, create, update, uniqueSlug };
