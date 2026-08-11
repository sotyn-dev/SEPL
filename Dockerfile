# Sotyn ERP tenant image — UI built inside Docker; data/ + backups/ via bind mounts.
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
# Default off until a host backup volume is mounted (agent sets ERP_BACKUP_DIR + clears this).
ENV ERP_DISABLE_BACKUP_SCHEDULER=1

EXPOSE 5000

# Required mounts (agent does this):
#   -v <host-data>:/app/data
#   -v <host-backups>:/app/backups  +  -e ERP_BACKUP_DIR=/app/backups
CMD ["node", "server/index.js"]
