// Proactive warranty-expiry alerts, mirroring src/sla.js's pattern for
// tickets: periodically (see server.js) check for assets whose warranty is
// about to expire and email every active agent a digest, once per asset
// (warranty_alerted_at, same idempotent-alert idea as tickets.sla_alerted_at).
// There's no single "owner" agent for an asset the way a ticket has an
// assignee, so this goes to the whole active team rather than guessing a
// recipient - assigned_to_name is free text, not necessarily even a system
// user.
const db = require("./db");
const { sendWarrantyExpiryDigest } = require("./mailer");

const WARRANTY_ALERT_DAYS = parseInt(process.env.WARRANTY_ALERT_DAYS, 10) || 30;

function checkWarrantyAlerts() {
  const expiringSoon = db
    .prepare(
      `SELECT id, name, asset_tag, warranty_expires
       FROM assets
       WHERE warranty_expires IS NOT NULL
         AND warranty_alerted_at IS NULL
         AND status NOT IN ('Retired', 'Lost')
         AND date(warranty_expires) <= date('now', '+' || ? || ' days')`
    )
    .all(WARRANTY_ALERT_DAYS);

  if (!expiringSoon.length) return 0;

  const activeAgents = db.prepare("SELECT email FROM agents WHERE active = 1").all();
  for (const agent of activeAgents) {
    sendWarrantyExpiryDigest({ to: agent.email, assets: expiringSoon }).catch((err) =>
      console.error("Could not send warranty expiry digest:", err.message)
    );
  }

  const markAlerted = db.prepare("UPDATE assets SET warranty_alerted_at = datetime('now') WHERE id = ?");
  for (const asset of expiringSoon) markAlerted.run(asset.id);

  return expiringSoon.length;
}

module.exports = { checkWarrantyAlerts, WARRANTY_ALERT_DAYS };
