require("dotenv").config();

if (!process.env.SESSION_SECRET) {
  console.error("Missing SESSION_SECRET in the environment. Copy .env.example to .env and set one.");
  process.exit(1);
}

const app = require("./app");
const { checkSlaBreaches } = require("./sla");
const PORT = process.env.PORT || 3000;
const SLA_CHECK_INTERVAL_MINUTES = parseInt(process.env.SLA_CHECK_INTERVAL_MINUTES, 10) || 15;

app.listen(PORT, () => {
  console.log(`Velv Ticketing Platform listening on http://localhost:${PORT}`);
});

// Runs in-process rather than as a separate cron job (like scripts/backup.js)
// since it needs to run every few minutes, not daily - simplest to just keep
// the same long-lived process ticking. Once at startup, then on an interval.
checkSlaBreaches();
setInterval(checkSlaBreaches, SLA_CHECK_INTERVAL_MINUTES * 60 * 1000);
