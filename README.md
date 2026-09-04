# Velv Ticketing Platform

[![Tests](https://github.com/Yuwr1d4g0at/velv-ticketing-platform/actions/workflows/test.yml/badge.svg)](https://github.com/Yuwr1d4g0at/velv-ticketing-platform/actions/workflows/test.yml)

A basic internal helpdesk ticketing tool: a public request form for people to
submit issues, and a staff dashboard to triage, assign, and resolve them.

## Stack

- **Node.js + Express**, server-rendered with **EJS** templates (no frontend build step)
- **SQLite** via Node's built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) module — no separate database server, no native module compilation
- Session-based auth (**express-session**) with a custom SQLite-backed session store, so logins survive a server restart
- Passwords hashed with **bcryptjs**
- **helmet** for security headers, **express-rate-limit** on the login form, and a hand-rolled CSRF token on every state-changing form

Requires **Node.js 22.5+** (uses the built-in SQLite module).

## Getting started

```bash
npm install
cp .env.example .env
```

Edit `.env`:
- Set `SESSION_SECRET` to a long random string. Generate one with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```
- Leave `PORT`, `DB_PATH`, and `COOKIE_SECURE` as-is for local development.
- Email notifications are optional and off by default — leave `SMTP_HOST` blank
  to skip them entirely. Fill in the `SMTP_*` vars (and optionally `APP_URL`,
  for a clickable link in the emails) to have requesters get an email when
  their ticket is created and whenever its status changes.

Create the first helpdesk agent account:

```bash
npm run seed
```

This prompts for a name, email, and password (min. 8 characters). Run it
again any time to add more agents — or use the "Add an agent" form on the
dashboard's Agents page once you're logged in.

Start the server:

```bash
npm start          # production
npm run dev         # restarts automatically on file changes
```

Visit `http://localhost:3000` for the request form, and
`http://localhost:3000/login` for the staff dashboard.

## How it works

**Public (no login required)**
- `/` — request form (name, email, category, subject, description, optional file attachments, optional related asset). Priority isn't set here — see below. Submitting shows a ticket number and, if email is configured, sends a confirmation. Available in English or Portuguese — the EN/PT toggle in the header sets a `velv_lang` cookie; the dashboard itself stays English-only.
- `/status` — look up a ticket's status by ticket number + the email it was submitted with, including any attachments (download requires that same ticket number + email). Image attachments (PNG/JPEG/GIF/WebP only) get a small inline preview thumbnail; everything else still only ever force-downloads.

Both of the above are rate-limited per IP (like the login form already was) since they're unauthenticated and, for the request form, now touch disk via file uploads. A ticket is auto-assigned on creation to whichever active agent currently has the fewest open tickets, rather than starting Unassigned.

The status page also shows the requester-visible conversation (agent replies + the requester's own past replies — never internal notes) and a reply box. Replying to a Resolved or Closed ticket reopens it. The assigned agent gets a best-effort email when the requester replies, if notifications are configured.

- `/rate/:token` — a one-click satisfaction survey (1–5 stars + optional comment). The link is emailed automatically the moment a ticket is marked Resolved (only if email is configured); the token is a bearer link, not a login, since rating a ticket doesn't expose anything sensitive.

**Dashboard (login required, any active agent account)**
- `/dashboard` — all tickets, paginated, with counts by status, a filter bar (status/priority/category/assignment/tag/**full-text search**), bulk status-change/reassignment (select rows, apply to all of them), and a CSV export of whatever's currently filtered. Search is backed by SQLite FTS5 over subject/description (prefix-matched, multi-word AND), not a plain substring match — requester name/email search is still a plain substring match. Tickets still open past a priority-scaled threshold (Urgent ages fastest, Low slowest) are flagged on the dashboard *and* proactively emailed to whoever they're assigned to (see `SLA_CHECK_INTERVAL_MINUTES` below) — once per breach, not repeatedly. Shows the running average satisfaction rating and average time-to-resolution once there's at least one. Save the current filter combo as a named view (personal to you, not shared) to jump back to it later.
- `/dashboard/tickets/:id` — full ticket detail: set priority, change status (emails the requester if notifications are configured), assign/reassign to any active agent, link/change/unlink the related asset, add/remove freeform tags, and add notes — internal by default, or marked "visible to requester" to reply publicly (emailed to them too). Shows the requester's other tickets, for context. Every change is logged automatically alongside manual notes in the ticket's activity feed. **Merge** folds a duplicate ticket into another one (activity/attachments/tags all move over; the duplicate closes and redirects here from then on). **Requester data** is a GDPR export (JSON bundle of everything on file for that email) or erasure (redacts name/email/description/note-and-reply text across *all* of that requester's tickets, and deletes their attachment files — irreversible, confirmed before it runs).
- `/dashboard/assets` — a small asset-management view: add/edit company equipment or software (name, tag, category, status, who has it, location, serial number, vendor, purchase date, warranty, notes), a CSV export, and see every ticket raised against one *and* a field-level change history (who changed what, and when) from its own page. Never hard-deleted, same philosophy as agents — retire it instead. Retired/Lost assets stop showing up as a pickable option (the request form, the ticket-linking dropdown) but stay reachable and editable.
- `/dashboard/canned-responses` — a shared library of reusable note text any agent can insert into a note in one click.
- `/dashboard/agents` — list of agents (active and deactivated) and a form to add new ones, plus deactivate/reactivate. All agents currently share one role — anyone logged in can manage any ticket and add other agents. Deactivating (never deleting, to keep their activity history intact) revokes login immediately, even for an already-open session, and excludes them from new assignments; you can't deactivate your own account or the last active agent.

`/healthz` (no login) reports `{"status":"ok"}` after a real DB connectivity check — for a host or uptime monitor to poll, not a browser.

## Data

Everything lives in a single SQLite file at `data/tickets.sqlite` (path
configurable via `DB_PATH`). `data/sessions.sqlite`-style session storage is
actually in the same file, in a `sessions` table.

Uploaded attachments live on disk under `data/attachments/`, named with a
random id (never the original filename), with the real filename, size,
uploader, and whether the requester can see it kept in the database.

### Backups

```bash
npm run backup
```

Writes a timestamped, consistent snapshot of the database (via SQLite's
`VACUUM INTO` — safe to run while the app is live, unlike a plain file copy)
plus a copy of `data/attachments/` to `data/backups/<timestamp>/`. A copy of
one without the other leaves either orphaned files or attachment rows with
nothing to download, so the script always takes both together. Keeps the 14
most recent backups by default and prunes older ones — override with
`BACKUP_DIR` / `BACKUP_KEEP` in `.env`.

Not scheduled on its own; add a cron entry to actually run it automatically,
e.g. nightly at 3am:

```
0 3 * * * cd /path/to/app && /usr/bin/npm run backup >> logs/backup.log 2>&1
```

## Deploying

`ecosystem.config.js` is set up for [PM2](https://pm2.keymetrics.io/):

```bash
npm install -g pm2   # if not already installed
pm2 start ecosystem.config.js
```

Put this behind a reverse proxy (nginx, Caddy, etc.) for HTTPS in production,
and once it's served over HTTPS, set `COOKIE_SECURE=true` in `.env` so
session cookies are only sent over encrypted connections.

## Testing

```bash
npm test
```

Runs Node's built-in test runner (`node --test`) — no test framework
dependency. Each test file boots the app against its own throwaway SQLite
database (see `test/helpers.js`), so tests never touch `data/tickets.sqlite`.

Runs automatically on every push and PR to `main` via
[GitHub Actions](.github/workflows/test.yml).

## Known limitations (kept out of scope for this "basic" version)

- Single flat agent role — no admin/agent distinction or per-agent permissions.
- No password reset flow — an existing agent can add a new account via the Agents page, but there's no self-service "forgot password."

These are reasonable next steps if the tool needs to grow beyond "basic."
