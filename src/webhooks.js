// Outbound event notifications: POST a JSON payload to whatever URLs are
// configured at /dashboard/settings/webhooks, when one of WEBHOOK_EVENTS
// happens. Fire-and-forget, same philosophy as email - a slow or broken
// receiving end must never hold up or fail the request that triggered it.
const crypto = require("crypto");
const db = require("./db");

const WEBHOOK_EVENTS = ["ticket.created", "ticket.status_changed", "ticket.assigned"];

function generateSecret() {
  return crypto.randomBytes(24).toString("hex");
}

// HMAC-SHA256 of the raw JSON body, hex-encoded, in an X-Velv-Signature
// header - lets the receiving end verify the payload actually came from
// here (and wasn't tampered with in transit) before acting on it.
function sign(secret, body) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function triggerWebhooks(eventType, payload) {
  const subscribed = db
    .prepare("SELECT * FROM webhooks WHERE active = 1")
    .all()
    .filter((w) => w.events.split(",").includes(eventType));
  if (!subscribed.length) return;

  const body = JSON.stringify({ event: eventType, sent_at: new Date().toISOString(), data: payload });

  for (const webhook of subscribed) {
    fetch(webhook.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Velv-Signature": sign(webhook.secret, body) },
      body,
    }).catch((err) => console.error(`Webhook delivery to ${webhook.url} failed:`, err.message));
  }
}

module.exports = { WEBHOOK_EVENTS, generateSecret, triggerWebhooks };
