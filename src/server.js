require("dotenv").config();

if (!process.env.SESSION_SECRET) {
  console.error("Missing SESSION_SECRET in the environment. Copy .env.example to .env and set one.");
  process.exit(1);
}

const app = require("./app");
const { checkSlaBreaches, checkFirstResponseBreaches } = require("./sla");
const { checkWarrantyAlerts } = require("./warranty");
const { runDueRecurringTickets } = require("./recurring");
const { sendDueDigests } = require("./digest");
const PORT = process.env.PORT || 3000;
const SLA_CHECK_INTERVAL_MINUTES = parseInt(process.env.SLA_CHECK_INTERVAL_MINUTES, 10) || 15;

app.listen(PORT, () => {
  console.log(`Velv Ticketing Platform listening on http://localhost:${PORT}`);
});

// Runs in-process rather than as a separate cron job (like scripts/backup.js)
// since SLA checks need to run every few minutes, not daily - simplest to
// just keep the same long-lived process ticking. Warranty checks, recurring
// tickets, and the daily digest don't need that frequency, but piggybacking
// on the same interval is cheap and avoids extra timers for no real benefit -
// each of those three is internally guarded to actually act at most once
// whenever its own real-world cadence (a date, a day) says to. All run once
// at startup, then on the interval.
function runPeriodicChecks() {
  checkSlaBreaches();
  checkFirstResponseBreaches();
  checkWarrantyAlerts();
  runDueRecurringTickets();
  sendDueDigests();
}
runPeriodicChecks();
setInterval(runPeriodicChecks, SLA_CHECK_INTERVAL_MINUTES * 60 * 1000);
