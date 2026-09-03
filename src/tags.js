const db = require("./db");

const MAX_TAG_LENGTH = 30;

function normalizeTagName(raw) {
  return (raw || "").trim().slice(0, MAX_TAG_LENGTH);
}

// Reuses an existing tag regardless of case ("Billing" and "billing" are the
// same tag - see the UNIQUE COLLATE NOCASE constraint in src/db/index.js),
// creating a new one only if no case-insensitive match exists yet.
function addTagToTicket(ticketId, rawName) {
  const name = normalizeTagName(rawName);
  if (!name) return null;

  db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").run(name);
  const tag = db.prepare("SELECT id, name FROM tags WHERE name = ? COLLATE NOCASE").get(name);
  db.prepare("INSERT OR IGNORE INTO ticket_tags (ticket_id, tag_id) VALUES (?, ?)").run(ticketId, tag.id);
  return tag;
}

// Only unlinks the tag from this ticket - the tag itself stays in the
// catalog (for reuse / the filter dropdown) even if now unused everywhere.
function removeTagFromTicket(ticketId, tagId) {
  db.prepare("DELETE FROM ticket_tags WHERE ticket_id = ? AND tag_id = ?").run(ticketId, tagId);
}

function tagsForTicket(ticketId) {
  return db
    .prepare(
      `SELECT tags.id, tags.name FROM ticket_tags
       JOIN tags ON tags.id = ticket_tags.tag_id
       WHERE ticket_tags.ticket_id = ?
       ORDER BY tags.name`
    )
    .all(ticketId);
}

function allTags() {
  return db.prepare("SELECT id, name FROM tags ORDER BY name").all();
}

module.exports = { MAX_TAG_LENGTH, addTagToTicket, removeTagFromTicket, tagsForTicket, allTags };
