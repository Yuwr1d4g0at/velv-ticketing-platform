# node:sqlite (used throughout src/db) needs Node 22.5+ - see package.json's
# engines field. Single-stage: this app has no build step (no bundler, no
# TypeScript), so there's nothing a multi-stage build would usefully discard.
FROM node:22-alpine

WORKDIR /app

# Installed before the rest of the source so this layer only rebuilds when
# package.json/package-lock.json actually change, not on every code edit.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# data/ holds the SQLite database, attachments, and backups - all of it
# needs to survive a container recreate. Mount a Railway Volume at
# /app/data from the service's Settings > Volumes tab (Docker's native
# VOLUME instruction isn't supported by Railway's builder).
RUN mkdir -p data

ENV PORT=3000
EXPOSE 3000

# SESSION_SECRET has no safe default (see src/server.js) - pass it at run
# time (-e or --env-file), never bake a real one into the image.
CMD ["node", "src/server.js"]
