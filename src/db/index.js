const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "..", "data", "tickets.sqlite");

// Make sure the folder holding the database file exists.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    subject         TEXT NOT NULL,
    description     TEXT NOT NULL,
    category        TEXT NOT NULL,
    priority        TEXT NOT NULL DEFAULT 'Medium',
    status          TEXT NOT NULL DEFAULT 'Open',
    requester_name  TEXT NOT NULL,
    requester_email TEXT NOT NULL,
    assigned_to     INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
  CREATE INDEX IF NOT EXISTS idx_tickets_assigned_to ON tickets(assigned_to);

  CREATE TABLE IF NOT EXISTS ticket_activity (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    agent_id   INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    type       TEXT NOT NULL DEFAULT 'note' CHECK (type IN ('note', 'status_change', 'assignment', 'priority_change')),
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_activity_ticket_id ON ticket_activity(ticket_id);

  -- Files live on disk under data/attachments/<stored_name> (see src/attachments.js).
  -- stored_name is always server-generated (random hex + an extension from a fixed
  -- allowlist), never derived from the uploaded filename, so it can't be used for
  -- path traversal or to disguise an executable as something else.
  CREATE TABLE IF NOT EXISTS attachments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id     INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    stored_name   TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL,
    uploaded_by   TEXT NOT NULL CHECK (uploaded_by IN ('requester', 'agent')),
    agent_id      INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_attachments_ticket_id ON attachments(ticket_id);

  -- Freeform tags. Normalized (rather than a comma-separated column on
  -- tickets) so "Billing" and "billing" collapse to one canonical row
  -- (COLLATE NOCASE) instead of fragmenting into near-duplicate tags, and so
  -- the dashboard can offer a real "filter by tag" dropdown.
  CREATE TABLE IF NOT EXISTS tags (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );
  CREATE TABLE IF NOT EXISTS ticket_tags (
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    tag_id    INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (ticket_id, tag_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ticket_tags_tag_id ON ticket_tags(tag_id);

  -- One rating per ticket (the requester's CSAT response after it's Resolved).
  -- Reached via tickets.rating_token (see the migration below), not a login -
  -- a bearer link is the right amount of friction for "click a star in an
  -- email", and a rating on its own reveals nothing sensitive if guessed.
  CREATE TABLE IF NOT EXISTS ticket_ratings (
    ticket_id  INTEGER PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
    rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Shared library of reusable note text any agent can drop into a ticket
  -- note. One flat pool, not per-agent - this app has no per-agent
  -- permissions to hang a "mine vs. theirs" distinction on anyway.
  CREATE TABLE IF NOT EXISTS canned_responses (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Backs the custom express-session store in src/session-store.js
  CREATE TABLE IF NOT EXISTS sessions (
    sid     TEXT PRIMARY KEY,
    data    TEXT NOT NULL,
    expires INTEGER NOT NULL
  );
`);

// One-off migration: CREATE TABLE IF NOT EXISTS above doesn't touch a table
// that already exists, so a database created before 'priority_change' was
// added to ticket_activity's CHECK constraint would reject that type forever.
// SQLite can't ALTER a CHECK constraint directly, so this rebuilds the table
// in place, once, the first time the app boots against an older database.
const activityTable = db
  .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ticket_activity'")
  .get();
if (activityTable && !activityTable.sql.includes("priority_change")) {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    ALTER TABLE ticket_activity RENAME TO ticket_activity_pre_priority;
    CREATE TABLE ticket_activity (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      agent_id   INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      type       TEXT NOT NULL DEFAULT 'note' CHECK (type IN ('note', 'status_change', 'assignment', 'priority_change')),
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO ticket_activity SELECT * FROM ticket_activity_pre_priority;
    DROP TABLE ticket_activity_pre_priority;
    CREATE INDEX IF NOT EXISTS idx_activity_ticket_id ON ticket_activity(ticket_id);
  `);
  db.exec("PRAGMA foreign_keys = ON");
}

// Second migration: adding a nullable column is something SQLite can do
// directly (unlike the CHECK-constraint rebuild above), so this one's just a
// guarded ALTER TABLE. Generated lazily (see src/routes/dashboard.js) the
// first time a ticket is marked Resolved, not for every ticket up front.
const ticketColumns = db.prepare("PRAGMA table_info(tickets)").all();
if (!ticketColumns.some((c) => c.name === "rating_token")) {
  db.exec("ALTER TABLE tickets ADD COLUMN rating_token TEXT");
}

module.exports = db;
