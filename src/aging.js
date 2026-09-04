// Shared "is this ticket aging past its priority-scaled threshold" logic -
// used by the dashboard list/CSV export (SQL) and the SLA breach checker
// (SQL), plus a plain-JS version for the one place that already has a row in
// hand (the ticket detail header). Kept in one place so the three can never
// quietly drift apart on what "aging" means.
const { AGING_DAYS_BY_PRIORITY } = require("./constants");

// AGING_DAYS_BY_PRIORITY is a fixed constant (never user input), so inlining
// its values into SQL text is safe.
const AGING_THRESHOLD_CASE = `CASE tickets.priority ${Object.entries(AGING_DAYS_BY_PRIORITY)
  .map(([priority, days]) => `WHEN '${priority}' THEN ${days}`)
  .join(" ")} ELSE ${AGING_DAYS_BY_PRIORITY.Low} END`;

const AGING_EXPR = `(tickets.status IN ('Open', 'In Progress') AND (julianday('now') - julianday(tickets.created_at)) > ${AGING_THRESHOLD_CASE})`;

function isAgingTicket(ticket) {
  if (!["Open", "In Progress"].includes(ticket.status)) return false;
  const created = new Date(`${ticket.created_at.replace(" ", "T")}Z`);
  const ageDays = (Date.now() - created.getTime()) / (1000 * 60 * 60 * 24);
  const threshold = AGING_DAYS_BY_PRIORITY[ticket.priority] ?? AGING_DAYS_BY_PRIORITY.Low;
  return ageDays > threshold;
}

module.exports = { AGING_EXPR, isAgingTicket };
