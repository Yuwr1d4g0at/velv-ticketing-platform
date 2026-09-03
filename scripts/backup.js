// Creates a timestamped, consistent snapshot of the database + a copy of the
// attachments folder. Safe to run while the app is live: `VACUUM INTO`
// writes a transactionally-consistent copy even with concurrent writers
// (that's the whole point of the command - unlike a plain file copy, which
// could grab the SQLite file mid-write in WAL mode and copy something
// inconsistent).
//
// Run manually:      npm run backup
// Run on a schedule:  add a cron entry, e.g. a nightly one:
//   0 3 * * * cd /path/to/app && /usr/bin/npm run backup >> logs/backup.log 2>&1
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "tickets.sqlite");
const DATA_DIR = path.dirname(DB_PATH);
const ATTACHMENTS_DIR = path.join(DATA_DIR, "attachments");
const BACKUP_ROOT = process.env.BACKUP_DIR || path.join(DATA_DIR, "backups");
const KEEP = parseInt(process.env.BACKUP_KEEP, 10) || 14; // backups to retain; oldest pruned first

function runBackup() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`No database found at ${DB_PATH} - nothing to back up.`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(BACKUP_ROOT, stamp);
  fs.mkdirSync(backupDir, { recursive: true });

  const dbBackupPath = path.join(backupDir, "tickets.sqlite");
  const db = new DatabaseSync(DB_PATH);
  try {
    // Path is server-derived (from DB_PATH/BACKUP_DIR env config, never
    // request input), so inlining it is safe - VACUUM INTO doesn't support
    // parameter binding for its destination anyway. Single-quote-escaped in
    // case a configured path happens to contain one.
    db.exec(`VACUUM INTO '${dbBackupPath.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }

  let attachmentCount = 0;
  if (fs.existsSync(ATTACHMENTS_DIR)) {
    const dest = path.join(backupDir, "attachments");
    fs.cpSync(ATTACHMENTS_DIR, dest, { recursive: true });
    attachmentCount = fs.readdirSync(dest).length;
  }

  const pruned = pruneOldBackups();

  return { backupDir, attachmentCount, pruned };
}

function pruneOldBackups() {
  if (!fs.existsSync(BACKUP_ROOT)) return [];
  const entries = fs
    .readdirSync(BACKUP_ROOT)
    .filter((f) => fs.statSync(path.join(BACKUP_ROOT, f)).isDirectory())
    .sort(); // ISO timestamp names sort chronologically

  const pruned = [];
  while (entries.length > KEEP) {
    const oldest = entries.shift();
    fs.rmSync(path.join(BACKUP_ROOT, oldest), { recursive: true, force: true });
    pruned.push(oldest);
  }
  return pruned;
}

if (require.main === module) {
  try {
    const { backupDir, attachmentCount, pruned } = runBackup();
    console.log(`Backup written to ${backupDir} (${attachmentCount} attachment file(s)).`);
    if (pruned.length) console.log(`Pruned ${pruned.length} old backup(s): ${pruned.join(", ")}`);
  } catch (err) {
    console.error("Backup failed:", err.message);
    process.exit(1);
  }
}

module.exports = { runBackup, BACKUP_ROOT, KEEP };
