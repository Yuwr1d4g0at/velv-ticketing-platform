// Proactive SLA breach alerts: periodically (see server.js) check for
// tickets that have crossed their priority-scaled aging threshold and email
// whoever they're assigned to, instead of only showing a passive "Aging"
// badge on the dashboard that nobody's necessarily looking at.
//
// Business-hours-aware aging (see src/aging.js) can't be expressed as a SQL
// predicate, so this fetches every not-yet-alerted open/in-progress
// assigned ticket and filters with isAgingTicket() in JS - fine at the
// scale of one internal team's open queue, not something that needs to
// stay a pure SQL WHERE clause.
//
// Idempotent by design: sla_alerted_at is set the moment an alert goes out,
// so a ticket only ever gets one email per breach - not one every time this
// runs. It's cleared back to NULL whenever a ticket reopens (see
// applyStatusChange in dashboard.js and the requester-reply auto-reopen in
// public.js), so a ticket that breaches, gets fixed, and later reopens can
// alert again rather than staying silenced forever.
const db = require("./db");
const { isAgingTicket } = require("./aging");
const { sendSlaBreachEmail } = require("./mailer");

function checkSlaBreaches() {
  const candidates = db
    .prepare(
      `SELECT tickets.id, tickets.subject, tickets.priority, tickets.status, tickets.created_at, agents.email AS agent_email
       FROM tickets
       JOIN agents ON agents.id = tickets.assigned_to AND agents.active = 1
       WHERE tickets.status IN ('Open', 'In Progress') AND tickets.sla_alerted_at IS NULL`
    )
    .all();
  const breaching = candidates.filter((t) => isAgingTicket(t));

  for (const ticket of breaching) {
    const ageDays = (Date.now() - new Date(`${ticket.created_at.replace(" ", "T")}Z`).getTime()) / (1000 * 60 * 60 * 24);
    sendSlaBreachEmail({
      to: ticket.agent_email,
      ticketId: ticket.id,
      subject: ticket.subject,
      priority: ticket.priority,
      ageDays,
    }).catch((err) => console.error("Could not send SLA breach email:", err.message));
    db.prepare("UPDATE tickets SET sla_alerted_at = datetime('now') WHERE id = ?").run(ticket.id);
  }

  return breaching.length;
}

module.exports = { checkSlaBreaches };
