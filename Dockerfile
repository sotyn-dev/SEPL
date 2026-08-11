# Sotyn ERP tenant image — UI built inside Docker; data/ only via bind mount.
# Build: docker build -t sotyn-erp:local .
# Host client/dist is NOT used (isolated image build).

# ── Stage 1: Vite production build ──────────────────────────────────────────
FROM node:20-bookworm-slim AS client-build
WORKDIR /client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ── Stage 2: ERP runtime ────────────────────────────────────────────────────
FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./

# Skip root postinstall (would rebuild client on host layout). Native module here.
RUN npm ci --ignore-scripts \
  && npm rebuild better-sqlite3

COPY server ./server
COPY --from=client-build /client/dist ./client/dist

ENV NODE_ENV=production
ENV PORT=5000
# Avoid host-side backup cron side effects inside every tenant box by default.
ENV ERP_DISABLE_BACKUP_SCHEDULER=1

EXPOSE 5000

# data/ must be supplied: -v <host-data>:/app/data
CMD ["node", "server/index.js"]
