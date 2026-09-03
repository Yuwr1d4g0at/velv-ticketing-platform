const db = require("./db");

const MAX_TITLE_LENGTH = 80;
const MAX_BODY_LENGTH = 5000;

function all() {
  return db.prepare("SELECT id, title, body FROM canned_responses ORDER BY title").all();
}

function get(id) {
  return db.prepare("SELECT id, title, body FROM canned_responses WHERE id = ?").get(id);
}

function create(title, body) {
  return db
    .prepare("INSERT INTO canned_responses (title, body) VALUES (?, ?)")
    .run(title.trim().slice(0, MAX_TITLE_LENGTH), body.trim().slice(0, MAX_BODY_LENGTH));
}

function remove(id) {
  return db.prepare("DELETE FROM canned_responses WHERE id = ?").run(id);
}

module.exports = { MAX_TITLE_LENGTH, MAX_BODY_LENGTH, all, get, create, remove };
