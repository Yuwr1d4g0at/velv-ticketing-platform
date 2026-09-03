# Velv Ticketing Platform

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
- `/` — request form (name, email, category, priority, subject, description). Submitting shows a ticket number.
- `/status` — look up a ticket's status by ticket number + the email it was submitted with.

**Dashboard (login required, any agent account)**
- `/dashboard` — all tickets, with counts by status and filters for status/priority/category/assignment, plus a search box.
- `/dashboard/tickets/:id` — full ticket detail: change status, assign/reassign to any agent, and add internal notes. Every status change and assignment is logged automatically alongside manual notes in the ticket's activity feed.
- `/dashboard/agents` — list of agents and a form to add new ones. All agents currently share one role — anyone logged in can manage any ticket and add other agents.

## Data

Everything lives in a single SQLite file at `data/tickets.sqlite` (path
configurable via `DB_PATH`). Back it up by copying that one file — take the
copy while the app isn't writing to it, or use SQLite's `.backup` command for
a safe live copy. `data/sessions.sqlite`-style session storage is actually in
the same file, in a `sessions` table.

## Deploying

`ecosystem.config.js` is set up for [PM2](https://pm2.keymetrics.io/):

```bash
npm install -g pm2   # if not already installed
pm2 start ecosystem.config.js
```

Put this behind a reverse proxy (nginx, Caddy, etc.) for HTTPS in production,
and once it's served over HTTPS, set `COOKIE_SECURE=true` in `.env` so
session cookies are only sent over encrypted connections.

## Known limitations (kept out of scope for this "basic" version)

- No email notifications — requesters check status manually via `/status` using their ticket number and email.
- Single flat agent role — no admin/agent distinction or per-agent permissions.
- No file attachments on tickets.
- No password reset flow — an existing agent can add a new account via the Agents page, but there's no self-service "forgot password."

These are all reasonable next steps if the tool needs to grow beyond "basic."
