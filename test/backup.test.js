const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const workDir = path.join(os.tmpdir(), `velv-backup-test-${crypto.randomBytes(6).toString("hex")}`);
const dbPath = path.join(workDir, "tickets.sqlite");
const attachmentsDir = path.join(workDir, "attachments");
const backupDir = path.join(workDir, "backups");

before(() => {
  fs.mkdirSync(attachmentsDir, { recursive: true });
  fs.writeFileSync(path.join(attachmentsDir, "sample.txt"), "hello");

  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE tickets (id INTEGER PRIMARY KEY, subject TEXT)");
  db.prepare("INSERT INTO tickets (subject) VALUES (?)").run("Backup test ticket");
  db.close();

  process.env.DB_PATH = dbPath;
  process.env.BACKUP_DIR = backupDir;
  process.env.BACKUP_KEEP = "2";
});

after(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

test("runBackup writes a consistent DB snapshot and copies attachments", () => {
  delete require.cache[require.resolve("../scripts/backup")];
  const { runBackup } = require("../scripts/backup");

  const { backupDir: writtenDir, attachmentCount } = runBackup();

  assert.ok(fs.existsSync(path.join(writtenDir, "tickets.sqlite")));
  assert.equal(attachmentCount, 1);
  assert.ok(fs.existsSync(path.join(writtenDir, "attachments", "sample.txt")));

  const copy = new DatabaseSync(path.join(writtenDir, "tickets.sqlite"));
  const rows = copy.prepare("SELECT subject FROM tickets").all();
  copy.close();
  assert.deepEqual(rows, [{ __proto__: null, subject: "Backup test ticket" }]);
});

test("old backups are pruned beyond BACKUP_KEEP", async () => {
  delete require.cache[require.resolve("../scripts/backup")];
  const { runBackup } = require("../scripts/backup");

  // BACKUP_KEEP=2 from `before`; three more runs (plus the one from the
  // previous test) should leave exactly 2 directories, oldest pruned first.
  for (let i = 0; i < 3; i++) {
    runBackup();
    await new Promise((resolve) => setTimeout(resolve, 5)); // distinct timestamps
  }

  const entries = fs.readdirSync(backupDir).filter((f) => fs.statSync(path.join(backupDir, f)).isDirectory());
  assert.equal(entries.length, 2);
});

test("backup fails clearly if there's no database to back up", () => {
  delete require.cache[require.resolve("../scripts/backup")];
  process.env.DB_PATH = path.join(workDir, "does-not-exist.sqlite");
  const { runBackup } = require("../scripts/backup");
  assert.throws(() => runBackup(), /No database found/);
  process.env.DB_PATH = dbPath; // restore for any test running after this one
});
