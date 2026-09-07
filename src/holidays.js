// Company-wide non-working days (see company_holidays in src/db/index.js) -
// business-hours aging/SLA math (src/aging.js) treats each of these as a
// zero-business-hour day, same as a weekend.
const db = require("./db");

// One query, returned as a Set for O(1) per-day lookups inside the
// day-by-day loop in aging.js's businessHoursElapsed() - fetched fresh each
// call (not cached at module load) so an edit here takes effect
// immediately, same "always read live" convention as sla_thresholds.
function holidaySet() {
  const rows = db.prepare("SELECT date FROM company_holidays").all();
  return new Set(rows.map((r) => r.date));
}

function listHolidays() {
  return db.prepare("SELECT * FROM company_holidays ORDER BY date").all();
}

function addHoliday(date, name) {
  db.prepare("INSERT OR IGNORE INTO company_holidays (date, name) VALUES (?, ?)").run(date, name);
}

function deleteHoliday(id) {
  db.prepare("DELETE FROM company_holidays WHERE id = ?").run(id);
}

module.exports = { holidaySet, listHolidays, addHoliday, deleteHoliday };
