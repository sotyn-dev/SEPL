# Sotyn platform — API + built UI.
# Build from repo root:
#   docker build -f platform/Dockerfile -t sotyn-platform:local .

# ── Stage 1: Vite UI ────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS client-build
WORKDIR /client
COPY platform/client/package.json platform/client/package-lock.json ./
RUN npm ci
COPY platform/client/ ./
RUN npm run build

# ── Stage 2: API runtime (keep platform/ layout for seed + static paths) ───
FROM node:20-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY platform/server/package.json platform/server/package-lock.json ./platform/server/
WORKDIR /app/platform/server
RUN npm ci --ignore-scripts \
  && npm rebuild better-sqlite3

COPY platform/server/ ./
COPY platform/seed /app/platform/seed
COPY --from=client-build /client/dist /app/platform/client/dist

ENV NODE_ENV=production
ENV PLATFORM_PORT=7100
ENV PLATFORM_BIND=0.0.0.0
ENV PLATFORM_SERVE_STATIC=1
ENV PLATFORM_DATA_DIR=/var/lib/sotyn/platform

EXPOSE 7100
CMD ["node", "index.js"]
