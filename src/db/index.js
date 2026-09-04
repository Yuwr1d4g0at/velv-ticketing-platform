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
  -- active: agents are deactivated, never deleted - a hard delete would
  -- cascade-orphan or wipe their ticket_activity history (who said what),
  -- which is exactly the audit trail you want to keep once someone leaves.
  CREATE TABLE IF NOT EXISTS agents (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1,
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

  -- agent_id is nullable: 'requester_reply' rows have no agent at all (the
  -- requester isn't in the agents table), and ON DELETE SET NULL (not
  -- CASCADE) so a deactivated-and-later-removed agent never takes their
  -- history down with them. 'note' = internal, staff-only. 'reply' = an
  -- agent's message the requester can actually see (and gets emailed, if
  -- notifications are configured).
  CREATE TABLE IF NOT EXISTS ticket_activity (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    agent_id   INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    type       TEXT NOT NULL DEFAULT 'note' CHECK (type IN ('note', 'status_change', 'assignment', 'priority_change', 'reply', 'requester_reply')),
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
    -- A requester's own upload is always visible to them; an agent's upload
    -- defaults to internal-only unless attached to a reply explicitly marked
    -- visible - otherwise it'd leak via /status regardless of that flag.
    visible_to_requester INTEGER NOT NULL DEFAULT 1,
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

  -- Company equipment/software a ticket can be raised against. Never hard
  -- deleted - same philosophy as agents (see above): retire it (status)
  -- instead, so any ticket that references it keeps meaning something.
  -- asset_tag is UNIQUE but nullable - SQLite treats multiple NULLs as
  -- distinct, so plenty of assets can go untagged without conflicting.
  CREATE TABLE IF NOT EXISTS assets (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL,
    asset_tag         TEXT UNIQUE,
    category          TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'In Use',
    assigned_to_name  TEXT,
    location          TEXT,
    serial_number     TEXT,
    vendor            TEXT,
    purchase_date     TEXT,
    warranty_expires  TEXT,
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_assets_status ON assets(status);

  -- Field-level audit trail for assets, same idea as ticket_activity. Logged
  -- by diffing old vs. new values in src/assets.js's update(), not by
  -- recording every raw form submit - a save that changes nothing produces
  -- no entry, and a save that changes three fields produces three readable
  -- lines instead of one opaque "updated" blob.
  CREATE TABLE IF NOT EXISTS asset_activity (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id   INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    agent_id   INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_asset_activity_asset_id ON asset_activity(asset_id);

  -- A saved dashboard filter combo. Personal, not shared (unlike everything
  -- else in this app's flat permission model) - ON DELETE CASCADE is fine
  -- here even though agents are never hard-deleted in practice, since a
  -- saved view is pure convenience, nothing worth preserving on its own.
  CREATE TABLE IF NOT EXISTS saved_views (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id     INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    query_string TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_saved_views_agent_id ON saved_views(agent_id);

  -- Backs the custom express-session store in src/session-store.js
  CREATE TABLE IF NOT EXISTS sessions (
    sid     TEXT PRIMARY KEY,
    data    TEXT NOT NULL,
    expires INTEGER NOT NULL
  );

  -- Full-text search over subject/description. External-content FTS5 table
  -- (content='tickets') so the indexed text isn't duplicated in the FTS
  -- table itself - the three triggers below are what's actually needed for
  -- SQLite's docs example.
  CREATE VIRTUAL TABLE IF NOT EXISTS tickets_fts USING fts5(
    subject, description, content='tickets', content_rowid='id'
  );
  CREATE TRIGGER IF NOT EXISTS tickets_fts_ai AFTER INSERT ON tickets BEGIN
    INSERT INTO tickets_fts(rowid, subject, description) VALUES (new.id, new.subject, new.description);
  END;
  CREATE TRIGGER IF NOT EXISTS tickets_fts_ad AFTER DELETE ON tickets BEGIN
    INSERT INTO tickets_fts(tickets_fts, rowid, subject, description) VALUES ('delete', old.id, old.subject, old.description);
  END;
  CREATE TRIGGER IF NOT EXISTS tickets_fts_au AFTER UPDATE ON tickets BEGIN
    INSERT INTO tickets_fts(tickets_fts, rowid, subject, description) VALUES ('delete', old.id, old.subject, old.description);
    INSERT INTO tickets_fts(rowid, subject, description) VALUES (new.id, new.subject, new.description);
  END;
`);

// The triggers above only cover tickets created/edited from here on - a
// database that already had tickets before FTS5 search was added needs a
// one-time backfill, guarded so it only ever runs once (an empty index with
// existing tickets is exactly and only that first-boot state).
const ftsCount = db.prepare("SELECT COUNT(*) AS c FROM tickets_fts").get().c;
const ticketsCount = db.prepare("SELECT COUNT(*) AS c FROM tickets").get().c;
if (ftsCount === 0 && ticketsCount > 0) {
  db.exec(`INSERT INTO tickets_fts(rowid, subject, description) SELECT id, subject, description FROM tickets`);
}

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

// Third migration: same idea as the rating_token one above - a guarded ALTER
// TABLE for the agents.active column.
const agentColumns = db.prepare("PRAGMA table_info(agents)").all();
if (!agentColumns.some((c) => c.name === "active")) {
  db.exec("ALTER TABLE agents ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
}

// Fourth migration: same rebuild as the priority_change one above, this time
// to (a) add the 'reply' / 'requester_reply' types and (b) make agent_id
// nullable with ON DELETE SET NULL instead of NOT NULL + CASCADE - both
// needed for a requester's own reply (no agent_id at all) to be storable,
// and so it stops taking an agent's whole history with it if they're ever
// removed. 'requester_reply' is checked for specifically since it's the
// more distinctive of the two new values.
const activityTable2 = db
  .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ticket_activity'")
  .get();
if (activityTable2 && !activityTable2.sql.includes("requester_reply")) {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    ALTER TABLE ticket_activity RENAME TO ticket_activity_pre_reply;
    CREATE TABLE ticket_activity (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      agent_id   INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      type       TEXT NOT NULL DEFAULT 'note' CHECK (type IN ('note', 'status_change', 'assignment', 'priority_change', 'reply', 'requester_reply')),
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO ticket_activity SELECT * FROM ticket_activity_pre_reply;
    DROP TABLE ticket_activity_pre_reply;
    CREATE INDEX IF NOT EXISTS idx_activity_ticket_id ON ticket_activity(ticket_id);
  `);
  db.exec("PRAGMA foreign_keys = ON");
}

// Fifth migration: guarded ALTER TABLE for attachments.visible_to_requester,
// same pattern as the two nullable-column additions above. Defaults existing
// rows to 1 (visible) - preserves current behavior for anything already
// uploaded; only new agent uploads get the opt-in internal-by-default gate.
const attachmentColumns = db.prepare("PRAGMA table_info(attachments)").all();
if (!attachmentColumns.some((c) => c.name === "visible_to_requester")) {
  db.exec("ALTER TABLE attachments ADD COLUMN visible_to_requester INTEGER NOT NULL DEFAULT 1");
}

// Sixth migration: guarded ALTER TABLE for tickets.asset_id. Optional - most
// tickets aren't about a specific piece of equipment - so it's nullable with
// ON DELETE SET NULL, though in practice an asset is retired, never deleted,
// so that branch mainly exists for consistency with the rest of the schema.
const ticketColumns2 = db.prepare("PRAGMA table_info(tickets)").all();
if (!ticketColumns2.some((c) => c.name === "asset_id")) {
  db.exec("ALTER TABLE tickets ADD COLUMN asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL");
}

// Seventh migration: guarded ALTER TABLE for tickets.sla_alerted_at. NULL
// means "never alerted"; set the moment a breach email goes out (see
// scripts/check-sla.js) and cleared again whenever the ticket reopens (see
// applyStatusChange / the requester-reply auto-reopen in src/routes/public.js)
// so a ticket that breaches, gets fixed, and later reopens can alert again.
const ticketColumns3 = db.prepare("PRAGMA table_info(tickets)").all();
if (!ticketColumns3.some((c) => c.name === "sla_alerted_at")) {
  db.exec("ALTER TABLE tickets ADD COLUMN sla_alerted_at TEXT");
}

// Eighth migration: guarded ALTER TABLE for tickets.merged_into_id. A merged
// ticket keeps its own row (and id) but points at the ticket its activity/
// attachments/tags were moved onto - see the /merge route in dashboard.js.
const ticketColumns4 = db.prepare("PRAGMA table_info(tickets)").all();
if (!ticketColumns4.some((c) => c.name === "merged_into_id")) {
  db.exec("ALTER TABLE tickets ADD COLUMN merged_into_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL");
}

// Ninth migration: guarded ALTER TABLE for tickets.data_erased_at. Set by the
// GDPR erasure action (dashboard.js) so the ticket detail page can show an
// honest "this requester's data was erased on <date>" notice instead of
// silently presenting redacted placeholders as if they were the original data.
const ticketColumns5 = db.prepare("PRAGMA table_info(tickets)").all();
if (!ticketColumns5.some((c) => c.name === "data_erased_at")) {
  db.exec("ALTER TABLE tickets ADD COLUMN data_erased_at TEXT");
}

module.exports = db;
