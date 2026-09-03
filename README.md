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
- `/` — request form (name, email, category, subject, description, optional file attachments). Priority isn't set here — see below. Submitting shows a ticket number and, if email is configured, sends a confirmation.
- `/status` — look up a ticket's status by ticket number + the email it was submitted with, including any attachments (download requires that same ticket number + email).

Both of the above are rate-limited per IP (like the login form already was) since they're unauthenticated and, for the request form, now touch disk via file uploads.

- `/rate/:token` — a one-click satisfaction survey (1–5 stars + optional comment). The link is emailed automatically the moment a ticket is marked Resolved (only if email is configured); the token is a bearer link, not a login, since rating a ticket doesn't expose anything sensitive.

**Dashboard (login required, any agent account)**
- `/dashboard` — all tickets, paginated, with counts by status, a filter bar (status/priority/category/assignment/tag/search), and a CSV export of whatever's currently filtered. Tickets still open past a few days are flagged so nothing quietly ages out of sight. Shows the running average satisfaction rating once there's at least one.
- `/dashboard/tickets/:id` — full ticket detail: set priority, change status (emails the requester if notifications are configured), assign/reassign to any agent, add/remove freeform tags, and add internal notes (optionally with their own attachments, or inserted from a canned response). Every change is logged automatically alongside manual notes in the ticket's activity feed.
- `/dashboard/canned-responses` — a shared library of reusable note text any agent can insert into a note in one click.
- `/dashboard/agents` — list of agents and a form to add new ones. All agents currently share one role — anyone logged in can manage any ticket and add other agents.

## Data

Everything lives in a single SQLite file at `data/tickets.sqlite` (path
configurable via `DB_PATH`). Back it up by copying that one file — take the
copy while the app isn't writing to it, or use SQLite's `.backup` command for
a safe live copy. `data/sessions.sqlite`-style session storage is actually in
the same file, in a `sessions` table.

Uploaded attachments live on disk under `data/attachments/`, named with a
random id (never the original filename), with the real filename, size, and
uploader kept in the database. Back that folder up alongside the database
file — a copy of one without the other leaves either orphaned files or
attachment rows with nothing to download. Limits (file types, size, count
per upload) are constants in `src/attachments.js`.

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
