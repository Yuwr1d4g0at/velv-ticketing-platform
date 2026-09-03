// A minimal express-session store backed by our existing SQLite database
// (via node:sqlite), so sessions survive process restarts without pulling
// in an extra native dependency.
const session = require("express-session");
const db = require("./db");

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours, matches the cookie maxAge in server.js

class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    this.getStmt = db.prepare("SELECT data, expires FROM sessions WHERE sid = ?");
    this.upsertStmt = db.prepare(
      `INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires`
    );
    this.destroyStmt = db.prepare("DELETE FROM sessions WHERE sid = ?");
    this.pruneStmt = db.prepare("DELETE FROM sessions WHERE expires < ?");

    // Periodically clear out expired sessions.
    this.pruneInterval = setInterval(() => {
      try {
        this.pruneStmt.run(Date.now());
      } catch (err) {
        // Non-fatal: worst case, a few stale rows linger until the next sweep.
      }
    }, 60 * 60 * 1000);
    this.pruneInterval.unref();
  }

  get(sid, callback) {
    try {
      const row = this.getStmt.get(sid);
      if (!row || row.expires < Date.now()) return callback(null, null);
      callback(null, JSON.parse(row.data));
    } catch (err) {
      callback(err);
    }
  }

  set(sid, sessionData, callback) {
    try {
      const ttl = sessionData.cookie && sessionData.cookie.maxAge ? sessionData.cookie.maxAge : DEFAULT_TTL_MS;
      const expires = Date.now() + ttl;
      this.upsertStmt.run(sid, JSON.stringify(sessionData), expires);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      this.destroyStmt.run(sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  touch(sid, sessionData, callback) {
    this.set(sid, sessionData, callback || (() => {}));
  }
}

module.exports = SqliteSessionStore;
