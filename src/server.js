require("dotenv").config();

if (!process.env.SESSION_SECRET) {
  console.error("Missing SESSION_SECRET in the environment. Copy .env.example to .env and set one.");
  process.exit(1);
}

const app = require("./app");
const { checkSlaBreaches } = require("./sla");
const { checkWarrantyAlerts } = require("./warranty");
const PORT = process.env.PORT || 3000;
const SLA_CHECK_INTERVAL_MINUTES = parseInt(process.env.SLA_CHECK_INTERVAL_MINUTES, 10) || 15;

app.listen(PORT, () => {
  console.log(`Velv Ticketing Platform listening on http://localhost:${PORT}`);
});

// Runs in-process rather than as a separate cron job (like scripts/backup.js)
// since SLA checks need to run every few minutes, not daily - simplest to
// just keep the same long-lived process ticking. Warranty checks don't need
// that frequency (a warranty date barely ever changes minute to minute), but
// piggybacking on the same interval is cheap and avoids a second timer for
// no real benefit. Both run once at startup, then on the interval.
function runPeriodicChecks() {
  checkSlaBreaches();
  checkWarrantyAlerts();
}
runPeriodicChecks();
setInterval(runPeriodicChecks, SLA_CHECK_INTERVAL_MINUTES * 60 * 1000);
