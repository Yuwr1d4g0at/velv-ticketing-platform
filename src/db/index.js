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

  -- Editable aging thresholds (was a hardcoded constant - see src/aging.js).
  -- One row per priority; seeded below if empty, never left without a row
  -- for a known priority.
  CREATE TABLE IF NOT EXISTS sla_thresholds (
    priority TEXT PRIMARY KEY,
    days     INTEGER NOT NULL
  );

  -- Outbound event notifications. events is a comma-separated list of the
  -- fixed WEBHOOK_EVENTS (src/webhooks.js) this URL is subscribed to.
  -- secret signs each payload (HMAC-SHA256, in an X-Velv-Signature header)
  -- so the receiving end can verify it actually came from here.
  CREATE TABLE IF NOT EXISTS webhooks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    url        TEXT NOT NULL,
    events     TEXT NOT NULL,
    secret     TEXT NOT NULL,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Every login attempt, successful or not - for noticing a compromised
  -- account or a brute-force run, not just the rate limiter blocking it in
  -- the moment. agent_id is nullable (a failed attempt with a bogus email
  -- has no agent to point at) and ON DELETE SET NULL for the same reason as
  -- everywhere else an agent is referenced - the log entry outlives the
  -- account either way.
  CREATE TABLE IF NOT EXISTS login_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT NOT NULL,
    agent_id   INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    success    INTEGER NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_login_log_created_at ON login_log(created_at);

  -- Public, published-by-default help articles. Never hard-deleted in the
  -- UI's normal path (see src/kb.js) - same "retire, don't destroy"
  -- philosophy as agents/assets, though there's no history/audit reason
  -- here, just consistency of habit.
  CREATE TABLE IF NOT EXISTS kb_articles (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    slug       TEXT NOT NULL UNIQUE,
    body       TEXT NOT NULL,
    category   TEXT,
    published  INTEGER NOT NULL DEFAULT 1,
    agent_id   INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Reusable starting points for agent-initiated tickets (src/routes/
  -- dashboard.js's /tickets/new) - not the public form, which is one
  -- person's own words about their own problem.
  CREATE TABLE IF NOT EXISTS ticket_templates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    category    TEXT NOT NULL,
    subject     TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- An agent who wants updates on a ticket without being its assignee.
  CREATE TABLE IF NOT EXISTS ticket_watchers (
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    agent_id  INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    PRIMARY KEY (ticket_id, agent_id)
  );

  -- Field definitions scoped to one category (e.g. a "System name" field
  -- that only makes sense on Account & Access tickets). Text-only for now -
  -- see src/custom-fields.js for why. Never surfaced for tickets created
  -- before a field existed, which is exactly what a plain LEFT JOIN against
  -- ticket_custom_values already gives for free.
  CREATE TABLE IF NOT EXISTS custom_field_definitions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    category   TEXT NOT NULL,
    field_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS ticket_custom_values (
    ticket_id             INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    field_definition_id   INTEGER NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
    value                 TEXT,
    PRIMARY KEY (ticket_id, field_definition_id)
  );

  -- Manually-linked related tickets (genuinely separate issues that are
  -- still connected somehow), as opposed to /merge which is for actual
  -- duplicates. Stored symmetrically - creating a link inserts both
  -- (a, b) and (b, a) - so either ticket's own page can find it with a
  -- plain "WHERE ticket_id = ?" instead of an OR across both columns.
  CREATE TABLE IF NOT EXISTS ticket_links (
    ticket_id        INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    linked_ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (ticket_id, linked_ticket_id)
  );

  -- Simple condition/action automation, evaluated once at ticket creation
  -- (public form and agent-initiated alike) - see src/automation.js. Plain
  -- columns rather than a JSON blob, matching this schema's style
  -- elsewhere and keeping rules readable straight out of the table.
  -- Conditions are AND'ed together when both are set; every non-null
  -- action is applied when a rule matches.
  CREATE TABLE IF NOT EXISTS automation_rules (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT NOT NULL,
    condition_category TEXT,
    condition_keyword  TEXT,
    action_tag         TEXT,
    action_priority    TEXT,
    action_assigned_to INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    active             INTEGER NOT NULL DEFAULT 1,
    created_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Templates that spawn a new ticket on a fixed cadence (e.g. "monthly
  -- server check") instead of someone remembering to file it by hand - see
  -- src/recurring.js. next_run_at advances by interval_days each time it fires.
  CREATE TABLE IF NOT EXISTS recurring_tickets (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    category      TEXT NOT NULL,
    subject       TEXT NOT NULL,
    description   TEXT NOT NULL,
    priority      TEXT NOT NULL DEFAULT 'Medium',
    interval_days INTEGER NOT NULL,
    next_run_at   TEXT NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- In-app notifications (header bell), a lighter-weight alternative to
  -- email for the same events (mention, assignment, reply, low rating) -
  -- see src/notifications.js. read_at NULL means unread.
  CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id   INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    ticket_id  INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
    type       TEXT NOT NULL,
    message    TEXT NOT NULL,
    read_at    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_agent_id ON notifications(agent_id);

  -- Same editable-threshold pattern as sla_thresholds, but for time-to-
  -- first-response instead of overall resolution - a distinct, usually much
  -- tighter, expectation ("acknowledge within 4 hours" vs "resolve within
  -- 2 days"). Hours, not days, since first response is a shorter time scale.
  CREATE TABLE IF NOT EXISTS first_response_thresholds (
    priority TEXT PRIMARY KEY,
    hours    INTEGER NOT NULL
  );

  -- Company-wide non-working days (public holidays, office closures) - the
  -- business-hours aging/SLA math in src/aging.js treats these exactly like
  -- a weekend (0 business hours that day), on top of the fixed Mon-Fri
  -- 09:00-18:00 window. date is the unique key (one entry per calendar day),
  -- not an id-per-year recurrence rule - simplest thing that works for one
  -- team's own holiday list, re-entered yearly from /dashboard/settings/holidays.
  CREATE TABLE IF NOT EXISTS company_holidays (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    date       TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Cached Microsoft Graph directory lookups (department/job title/phone,
  -- and a photo if one's on file) for both agents and requesters, keyed by
  -- email - see src/directory.js. A cache, not a live lookup on every page
  -- view: Graph app-only calls add real latency, so a ticket/agent page
  -- reads this table first and only re-fetches once fetched_at is stale
  -- (CACHE_TTL_HOURS in src/directory.js).
  CREATE TABLE IF NOT EXISTS directory_cache (
    email             TEXT PRIMARY KEY,
    display_name      TEXT,
    department        TEXT,
    job_title         TEXT,
    phone             TEXT,
    photo_blob        BLOB,
    photo_content_type TEXT,
    found             INTEGER NOT NULL DEFAULT 1,
    fetched_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Manual time-tracking entries against a ticket (a start/stop timer is a
  -- nice-to-have, not required for a first version - see src/time-entries.js
  -- and the /tickets/:id/time routes in src/routes/dashboard.js). agent_id is
  -- nullable with ON DELETE SET NULL, same reasoning as everywhere else an
  -- agent is referenced - removing an agent should never take a ticket's
  -- logged-time history down with them. logged_on is the date the WORK
  -- happened (agent-editable, defaults to today), kept separate from
  -- created_at (when the entry was actually typed in) so an agent logging
  -- Monday's work on Friday afternoon still lands in Monday's report bucket.
  CREATE TABLE IF NOT EXISTS time_entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    agent_id   INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    minutes    INTEGER NOT NULL CHECK (minutes > 0),
    note       TEXT,
    logged_on  TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_time_entries_ticket_id ON time_entries(ticket_id);
  CREATE INDEX IF NOT EXISTS idx_time_entries_logged_on ON time_entries(logged_on);

  -- History of the SharePoint asset inventory sync (see src/assetSync.js) -
  -- both so /dashboard/settings/asset-sync has something to show, and so
  -- the periodic checker (src/server.js) can tell whether a sync is
  -- actually due yet without keeping that state only in memory (which
  -- would forget on every restart and re-sync more often than intended).
  CREATE TABLE IF NOT EXISTS asset_sync_runs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at     TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at    TEXT,
    created_count  INTEGER,
    updated_count  INTEGER,
    failed_count   INTEGER,
    error          TEXT
  );

  -- Departments: IT/HR/Legal/Marketing to start, but agent-configurable
  -- from /dashboard/settings/departments (see src/departments.js) rather
  -- than a hardcoded constant - a team's own structure is exactly the kind
  -- of thing that changes over time. Never hard-deleted (retire via the
  -- active column, same philosophy as agents/assets) so a department that
  -- already has agents/categories pointing at it can't be yanked out from
  -- under them.
  CREATE TABLE IF NOT EXISTS departments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Ticket categories, now department-scoped (each belongs to exactly one
  -- department) - replaces the flat CATEGORIES constant this app used to
  -- have. ON DELETE RESTRICT: a department that still has categories
  -- pointing at it can't be deleted out from under them (deactivate the
  -- department instead, same pattern as everywhere else).
  CREATE TABLE IF NOT EXISTS categories (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE,
    department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_categories_department_id ON categories(department_id);
`);

// sla_thresholds starts empty on a fresh database (CREATE TABLE doesn't seed
// rows) - fill in the historical defaults the very first time, so aging.js
// always finds a row for every known priority.
const DEFAULT_SLA_DAYS = { Urgent: 1, High: 2, Medium: 5, Low: 7 };
const slaThresholdCount = db.prepare("SELECT COUNT(*) AS c FROM sla_thresholds").get().c;
if (slaThresholdCount === 0) {
  const insertThreshold = db.prepare("INSERT INTO sla_thresholds (priority, days) VALUES (?, ?)");
  for (const [priority, days] of Object.entries(DEFAULT_SLA_DAYS)) {
    insertThreshold.run(priority, days);
  }
}

// Same seed-if-empty pattern as sla_thresholds above, for first_response_thresholds.
const DEFAULT_FIRST_RESPONSE_HOURS = { Urgent: 1, High: 4, Medium: 8, Low: 24 };
const firstResponseThresholdCount = db.prepare("SELECT COUNT(*) AS c FROM first_response_thresholds").get().c;
if (firstResponseThresholdCount === 0) {
  const insertFrThreshold = db.prepare("INSERT INTO first_response_thresholds (priority, hours) VALUES (?, ?)");
  for (const [priority, hours] of Object.entries(DEFAULT_FIRST_RESPONSE_HOURS)) {
    insertFrThreshold.run(priority, hours);
  }
}

// Seed departments + their categories the very first time (empty tables) -
// see src/departments.js. IT is inserted first so it lands on id 1: every
// migration below that back-fills a department for existing rows
// (agents.department_id in particular) points at IT by default, because
// every category that existed before this feature (Hardware/Software/
// Network/Account & Access/Other) is seeded as an IT category right below -
// an agent or ticket that predates departments entirely only ever touched
// IT-flavored categories anyway, so defaulting to IT is consistent, not
// arbitrary, and it's exactly what keeps every pre-existing test/fixture
// (all of which use only those five original categories) working unchanged.
const DEFAULT_DEPARTMENTS = ["IT", "HR", "Legal", "Marketing"];
const departmentCount = db.prepare("SELECT COUNT(*) AS c FROM departments").get().c;
if (departmentCount === 0) {
  const insertDept = db.prepare("INSERT INTO departments (name) VALUES (?)");
  for (const name of DEFAULT_DEPARTMENTS) insertDept.run(name);
}

const DEFAULT_CATEGORIES = {
  IT: ["Hardware", "Software", "Network", "Account & Access", "Other"],
  HR: ["Onboarding", "Benefits", "Employee Relations"],
  Legal: ["Contract Review", "Compliance", "NDA / Confidentiality", "Litigation & Disputes"],
  Marketing: ["Campaign Request", "Content & Design", "Brand Assets", "Event Support"],
};
const categoryCount = db.prepare("SELECT COUNT(*) AS c FROM categories").get().c;
if (categoryCount === 0) {
  const departmentIdByName = Object.fromEntries(
    db.prepare("SELECT id, name FROM departments").all().map((d) => [d.name, d.id])
  );
  const insertCategory = db.prepare("INSERT INTO categories (name, department_id) VALUES (?, ?)");
  for (const [deptName, names] of Object.entries(DEFAULT_CATEGORIES)) {
    for (const name of names) insertCategory.run(name, departmentIdByName[deptName]);
  }
}

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

// Tenth migration: guarded ALTER TABLE for assets.warranty_alerted_at, same
// idempotent-alert pattern as tickets.sla_alerted_at above.
const assetColumns = db.prepare("PRAGMA table_info(assets)").all();
if (!assetColumns.some((c) => c.name === "warranty_alerted_at")) {
  db.exec("ALTER TABLE assets ADD COLUMN warranty_alerted_at TEXT");
}

// Eleventh migration: guarded ALTER TABLE for tickets.subcategory - an
// optional, freeform second-level category (e.g. Hardware > Printer),
// nullable so every ticket created before this still reads fine with none.
const ticketColumns6 = db.prepare("PRAGMA table_info(tickets)").all();
if (!ticketColumns6.some((c) => c.name === "subcategory")) {
  db.exec("ALTER TABLE tickets ADD COLUMN subcategory TEXT");
}

// Twelfth migration: guarded ALTER TABLE for the "Waiting on Customer"
// status's aging-pause bookkeeping (see src/aging.js). waiting_since is set
// the moment a ticket enters that status and cleared the moment it leaves;
// paused_hours accumulates the business hours spent waiting across however
// many times a ticket has been paused, so time spent waiting on the
// requester never counts against the team's own aging/SLA clock.
const ticketColumns7 = db.prepare("PRAGMA table_info(tickets)").all();
if (!ticketColumns7.some((c) => c.name === "waiting_since")) {
  db.exec("ALTER TABLE tickets ADD COLUMN waiting_since TEXT");
}
const ticketColumns8 = db.prepare("PRAGMA table_info(tickets)").all();
if (!ticketColumns8.some((c) => c.name === "paused_hours")) {
  db.exec("ALTER TABLE tickets ADD COLUMN paused_hours REAL NOT NULL DEFAULT 0");
}

// Thirteenth migration: guarded ALTER TABLE for tickets.first_response_alerted_at,
// the same idempotent-alert pattern as sla_alerted_at, but for the separate
// first-response threshold (see first_response_thresholds above and
// src/sla.js). Cleared on reopen alongside sla_alerted_at.
const ticketColumns9 = db.prepare("PRAGMA table_info(tickets)").all();
if (!ticketColumns9.some((c) => c.name === "first_response_alerted_at")) {
  db.exec("ALTER TABLE tickets ADD COLUMN first_response_alerted_at TEXT");
}

// Fourteenth migration: guarded ALTER TABLE for agents.last_digest_at - the
// daily digest email (src/digest.js) checks this to send at most once per
// calendar day per agent, regardless of how often the periodic check runs.
const agentColumns2 = db.prepare("PRAGMA table_info(agents)").all();
if (!agentColumns2.some((c) => c.name === "last_digest_at")) {
  db.exec("ALTER TABLE agents ADD COLUMN last_digest_at TEXT");
}

// Fifteenth migration: adds agents.department_id and agents.is_admin - see
// src/departments.js. This one can't be a plain guarded ALTER TABLE ADD
// COLUMN like every migration above it: SQLite refuses to ADD COLUMN with
// a REFERENCES clause AND a non-NULL default on a table that already has
// rows ("Cannot add a REFERENCES column with non-NULL default value") -
// there'd be no way to validate that eagerly-backfilled default against the
// parent table. And a non-NULL default is exactly what's needed here:
// department_id defaults every existing/new agent to IT (id 1, guaranteed
// to exist by the seeding above) instead of NULL - an agent with no
// department would see nothing at all once ticket visibility is scoped by
// department, which is a worse default for a database that predates this
// feature than "assume IT" (every category that predates this feature is
// itself seeded as an IT category, so this is the same call, applied
// consistently). is_admin defaults to 0 (no REFERENCES clause, so it could
// have been a plain ALTER TABLE, but it's rolled into the same rebuild
// since both are landing together): admin is a real, visible, opt-in role
// (see the Agents page), never something an agent quietly ends up with.
//
// This can't use the same rename-old-table-out-of-the-way shape as the
// priority_change/requester_reply rebuilds above, because agents.id is a
// foreign key TARGET for a dozen other tables (tickets, ticket_activity,
// login_log, ...) and SQLite's ALTER TABLE RENAME rewrites every OTHER
// table's REFERENCES clause to follow the renamed table to its new name -
// so "RENAME agents TO agents_pre_department" would leave every one of
// those tables' schemas pointing at "agents_pre_department", and dropping
// that table afterward would leave them all referencing a table that no
// longer exists. Instead: build the new table under its own name, drop the
// OLD "agents" (every other table's REFERENCES agents(...) clause is
// untouched text at this point, just briefly dangling since "agents"
// doesn't exist), then rename the new table INTO "agents" - nothing else
// in the database references "agents_new", so that rename touches no other
// table's schema, and the moment it completes, every pre-existing
// REFERENCES agents(...) clause resolves again, now against the new table.
const agentColumns3 = db.prepare("PRAGMA table_info(agents)").all();
if (!agentColumns3.some((c) => c.name === "department_id")) {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    CREATE TABLE agents_new (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      email          TEXT NOT NULL UNIQUE,
      password_hash  TEXT NOT NULL,
      active         INTEGER NOT NULL DEFAULT 1,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      last_digest_at TEXT,
      department_id  INTEGER REFERENCES departments(id) ON DELETE SET NULL DEFAULT 1,
      is_admin       INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO agents_new (id, name, email, password_hash, active, created_at, last_digest_at)
      SELECT id, name, email, password_hash, active, created_at, last_digest_at FROM agents;
    DROP TABLE agents;
    ALTER TABLE agents_new RENAME TO agents;
  `);
  db.exec("PRAGMA foreign_keys = ON");
}

// Sixteenth migration: guarded ALTER TABLE for tickets.confidential - see
// the visibility check in src/departments.js. Even a same-department agent
// can't see a confidential ticket unless they're its assignee or an admin;
// department scoping still applies underneath this unchanged - a
// confidential ticket outside an agent's department is exactly as invisible
// as a non-confidential one.
const ticketColumns10 = db.prepare("PRAGMA table_info(tickets)").all();
if (!ticketColumns10.some((c) => c.name === "confidential")) {
  db.exec("ALTER TABLE tickets ADD COLUMN confidential INTEGER NOT NULL DEFAULT 0");
}

// Seventeenth/eighteenth/nineteenth migrations: guarded ALTER TABLE for a
// nullable department_id on kb_articles, canned_responses, automation_rules,
// and webhooks - NULL means "shared/platform-wide" (today's behavior,
// unchanged for anything created before this migration), a real id scopes
// it to one department. See src/departments.js.
const kbColumns = db.prepare("PRAGMA table_info(kb_articles)").all();
if (!kbColumns.some((c) => c.name === "department_id")) {
  db.exec("ALTER TABLE kb_articles ADD COLUMN department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL");
}
const cannedColumns = db.prepare("PRAGMA table_info(canned_responses)").all();
if (!cannedColumns.some((c) => c.name === "department_id")) {
  db.exec("ALTER TABLE canned_responses ADD COLUMN department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL");
}
const automationColumns = db.prepare("PRAGMA table_info(automation_rules)").all();
if (!automationColumns.some((c) => c.name === "department_id")) {
  db.exec("ALTER TABLE automation_rules ADD COLUMN department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL");
}
const webhookColumns = db.prepare("PRAGMA table_info(webhooks)").all();
if (!webhookColumns.some((c) => c.name === "department_id")) {
  db.exec("ALTER TABLE webhooks ADD COLUMN department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL");
}

// Twentieth migration: guarded ALTER TABLE for categories.requires_approval -
// see src/departments.js's approval-gate helpers and the /tickets/:id/status
// route in src/routes/dashboard.js. Defaults every existing category to 0
// (no change in behavior - closing still works exactly as it did before this
// feature existed) except for a one-time backfill, right below, of the two
// Marketing categories this is being built for.
const categoryColumns = db.prepare("PRAGMA table_info(categories)").all();
if (!categoryColumns.some((c) => c.name === "requires_approval")) {
  db.exec("ALTER TABLE categories ADD COLUMN requires_approval INTEGER NOT NULL DEFAULT 0");
  // Content & Design and Campaign Request are the two Marketing categories a
  // content-review pipeline actually needs a sign-off gate on - flipped on
  // by default so this ships configured, not just capable. Tied to the
  // ALTER above running (guarded the same way, so this only ever fires
  // once): after this, it's a normal per-category setting anyone can toggle
  // from /dashboard/settings/departments, on any department's category.
  db.exec(
    `UPDATE categories SET requires_approval = 1 WHERE name IN ('Content & Design', 'Campaign Request')`
  );
}

// Twenty-first migration: guarded ALTER TABLE for tickets.approval_status and
// tickets.approval_note - the per-ticket half of the approval gate above.
// approval_status is NULL for the overwhelming majority of tickets (any
// category that doesn't require approval, plus one that does but has never
// been through a close attempt); 'pending' while awaiting a decision,
// 'approved' once closed off the back of one, 'rejected' when sent back.
// approval_note is the optional reviewer note shown back to the assignee on
// rejection (see the /tickets/:id/approval/reject route) - generic, not
// Marketing-specific, even though Marketing's content-review flow is the
// reason it exists. Neither has a CHECK constraint, same as the pre-existing
// tickets.status/priority columns - validated in application code instead
// (see APPROVAL_STATUSES in src/routes/dashboard.js) rather than at the DB
// level.
const ticketColumns11 = db.prepare("PRAGMA table_info(tickets)").all();
if (!ticketColumns11.some((c) => c.name === "approval_status")) {
  db.exec("ALTER TABLE tickets ADD COLUMN approval_status TEXT");
}
const ticketColumns12 = db.prepare("PRAGMA table_info(tickets)").all();
if (!ticketColumns12.some((c) => c.name === "approval_note")) {
  db.exec("ALTER TABLE tickets ADD COLUMN approval_note TEXT");
}

// Twenty-second migration: same rebuild-in-place shape as the
// priority_change/requester_reply migrations above, this time to add the
// 'approval_change' type - submitted-for-approval/approved/rejected are all
// logged under it (see applyStatusChange and the /tickets/:id/approval/*
// routes in src/routes/dashboard.js).
const activityTable3 = db
  .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ticket_activity'")
  .get();
if (activityTable3 && !activityTable3.sql.includes("approval_change")) {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    ALTER TABLE ticket_activity RENAME TO ticket_activity_pre_approval;
    CREATE TABLE ticket_activity (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      agent_id   INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      type       TEXT NOT NULL DEFAULT 'note' CHECK (type IN ('note', 'status_change', 'assignment', 'priority_change', 'reply', 'requester_reply', 'approval_change')),
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO ticket_activity SELECT * FROM ticket_activity_pre_approval;
    DROP TABLE ticket_activity_pre_approval;
    CREATE INDEX IF NOT EXISTS idx_activity_ticket_id ON ticket_activity(ticket_id);
  `);
  db.exec("PRAGMA foreign_keys = ON");
}

module.exports = db;
