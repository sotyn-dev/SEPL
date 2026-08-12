# Sotyn worker agent — Docker CLI + socket mount to drive tenant containers.
# Build from repo: docker build -f platform/worker-agent/Dockerfile -t sotyn-agent:local .

FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
    > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY platform/worker-agent/ ./

ENV NODE_ENV=production
ENV AGENT_PORT=7200
ENV AGENT_BIND=0.0.0.0
ENV TENANTS_ROOT=/var/lib/sotyn/tenants

EXPOSE 7200
CMD ["node", "index.js"]
