// Shared "is this ticket aging past its priority-scaled threshold" logic -
// used by the dashboard list, the SLA breach checker, and the ticket detail
// header. Kept in one place so the three can never quietly drift apart on
// what "aging" means.
//
// Counts business hours only (Mon-Fri, 09:00-18:00, in the server process's
// own local timezone - not UTC, not a per-agent setting), not raw calendar
// time - a ticket filed Friday evening shouldn't visibly "age" all weekend
// the way it would under a flat elapsed-time clock. Business hours are a
// fixed constant for now, not yet an editable setting like the thresholds
// themselves.
//
// This can no longer be expressed as a single SQL predicate (there's no
// reasonable way to do business-hours arithmetic in plain SQLite), so
// consumers fetch candidate rows in SQL (open/in-progress, etc.) and filter
// or annotate them with isAgingTicket() in JS instead of a WHERE clause.
//
// Thresholds live in the sla_thresholds table (editable from
// /dashboard/settings), not a hardcoded constant - read fresh on every call
// rather than cached, since a settings change should take effect
// immediately without a restart.
const db = require("./db");

const FALLBACK_DAYS = 7; // used only if a priority somehow has no row at all
const BUSINESS_HOURS_START = 9; // 09:00
const BUSINESS_HOURS_END = 18; // 18:00
const BUSINESS_HOURS_PER_DAY = BUSINESS_HOURS_END - BUSINESS_HOURS_START;

function currentThresholds() {
  const rows = db.prepare("SELECT priority, days FROM sla_thresholds").all();
  return Object.fromEntries(rows.map((r) => [r.priority, r.days]));
}

function isBusinessDay(date) {
  const day = date.getDay();
  return day !== 0 && day !== 6;
}

// Business hours between two Dates, restricted to one calendar day (`day`,
// only its date part is used) - 0 outside Mon-Fri, otherwise the overlap
// between that day's 09:00-18:00 window and [rangeStart, rangeEnd].
function businessHoursOnDay(day, rangeStart, rangeEnd) {
  if (!isBusinessDay(day)) return 0;
  const dayStart = new Date(day);
  dayStart.setHours(BUSINESS_HOURS_START, 0, 0, 0);
  const dayEnd = new Date(day);
  dayEnd.setHours(BUSINESS_HOURS_END, 0, 0, 0);
  const start = Math.max(dayStart.getTime(), rangeStart.getTime());
  const end = Math.min(dayEnd.getTime(), rangeEnd.getTime());
  return end > start ? (end - start) / (1000 * 60 * 60) : 0;
}

function businessHoursElapsed(startDate, endDate) {
  if (endDate <= startDate) return 0;
  let total = 0;
  const cursor = new Date(startDate);
  cursor.setHours(0, 0, 0, 0);
  while (cursor <= endDate) {
    total += businessHoursOnDay(cursor, startDate, endDate);
    cursor.setDate(cursor.getDate() + 1);
  }
  return total;
}

// `now` defaults to the real clock in production use; tests pass a fixed
// Date instead so a boundary case (crossing one priority's threshold but
// not another's) is exact and deterministic rather than depending on which
// weekday the test suite happens to run on.
function isAgingTicket(ticket, thresholds = currentThresholds(), now = new Date()) {
  if (!["Open", "In Progress"].includes(ticket.status)) return false;
  const created = new Date(`${ticket.created_at.replace(" ", "T")}Z`);
  const thresholdDays = thresholds[ticket.priority] ?? FALLBACK_DAYS;
  return businessHoursElapsed(created, now) > thresholdDays * BUSINESS_HOURS_PER_DAY;
}

// Annotates a batch of already-fetched ticket rows with is_aging, reading
// thresholds once for the whole batch rather than once per row.
function annotateAging(tickets) {
  const thresholds = currentThresholds();
  return tickets.map((t) => ({ ...t, is_aging: isAgingTicket(t, thresholds) }));
}

module.exports = { isAgingTicket, annotateAging, currentThresholds, businessHoursElapsed };
