// Optional email notifications for requesters. Entirely off by default - if
// SMTP_HOST isn't set in .env, every send function below silently resolves
// without doing anything, so the app works exactly as before for anyone who
// hasn't configured it. See .env.example for the full list of SMTP_* vars.
const nodemailer = require("nodemailer");

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10) || 587;
const SMTP_SECURE = process.env.SMTP_SECURE === "true";
const SMTP_FROM = process.env.SMTP_FROM || "Velv Ticketing <no-reply@localhost>";
// Optional. If set, emails link straight to the status page instead of just
// naming it (e.g. "https://helpdesk.example.com"). No trailing slash.
const APP_URL = (process.env.APP_URL || "").replace(/\/+$/, "");

const enabled = Boolean(SMTP_HOST);

let transporter = null;
if (enabled) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
} else {
  console.log("Email notifications are disabled (SMTP_HOST not set in .env). See .env.example.");
}

function statusPageInstructions(ticketId) {
  const where = APP_URL ? `${APP_URL}/status` : "the status page";
  return `Check on it anytime at ${where} with ticket number #${ticketId} and this email address.`;
}

function send(to, subject, text) {
  if (!enabled) return Promise.resolve({ skipped: true });
  return transporter.sendMail({ from: SMTP_FROM, to, subject, text });
}

function sendTicketCreatedEmail({ to, ticketId, subject }) {
  return send(
    to,
    `We've got your request - ticket #${ticketId}`,
    `Thanks for reaching out. Your request "${subject}" is now ticket #${ticketId}.\n\n` +
      `${statusPageInstructions(ticketId)}\n\n` +
      `Our Team. Remotely Yours.\nVelv`
  );
}

function sendStatusChangeEmail({ to, ticketId, subject, oldStatus, newStatus }) {
  return send(
    to,
    `Ticket #${ticketId} is now ${newStatus}`,
    `Your ticket #${ticketId} ("${subject}") changed from ${oldStatus} to ${newStatus}.\n\n` +
      `${statusPageInstructions(ticketId)}\n\n` +
      `Our Team. Remotely Yours.\nVelv`
  );
}

// Sent instead of sendStatusChangeEmail specifically for the -> Resolved
// transition, so it can fold in a one-click satisfaction survey link. The
// link needs an absolute URL to be worth anything in an email, so it's only
// included when APP_URL is configured - without it this just falls back to
// a plain resolved notice.
function sendResolvedEmail({ to, ticketId, subject, oldStatus, ratingToken }) {
  const ask = APP_URL
    ? `\nHow did we do? Rate this ticket: ${APP_URL}/rate/${ratingToken}\n`
    : "";
  return send(
    to,
    `Ticket #${ticketId} is now Resolved`,
    `Your ticket #${ticketId} ("${subject}") changed from ${oldStatus} to Resolved.\n` +
      ask +
      `\n${statusPageInstructions(ticketId)}\n\n` +
      `Our Team. Remotely Yours.\nVelv`
  );
}

// An agent's note marked "visible to requester" (see the visibility field on
// the note form) - the one way, besides a status change, that a message
// actually reaches the requester's inbox.
function sendReplyEmail({ to, ticketId, subject, message }) {
  return send(
    to,
    `New reply on ticket #${ticketId}`,
    `${message}\n\n---\nRe: ticket #${ticketId} ("${subject}")\n${statusPageInstructions(ticketId)}\n\n` +
      `Our Team. Remotely Yours.\nVelv`
  );
}

// Best-effort nudge to whoever the ticket is assigned to when the requester
// replies - agents otherwise have no way to know without opening every
// ticket. Silently skipped if the ticket is unassigned (nothing to notify).
function sendAgentNotifiedOfReply({ to, ticketId, subject, message }) {
  if (!to) return Promise.resolve({ skipped: true });
  return send(
    to,
    `New reply from the requester on ticket #${ticketId}`,
    `The requester replied on ticket #${ticketId} ("${subject}"):\n\n${message}`
  );
}

module.exports = {
  enabled,
  sendTicketCreatedEmail,
  sendStatusChangeEmail,
  sendResolvedEmail,
  sendReplyEmail,
  sendAgentNotifiedOfReply,
};
