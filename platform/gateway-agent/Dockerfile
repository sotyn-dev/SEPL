# Sotyn gateway agent — nginx fragment writer + HTTP-01 certbot helper.
# Build: docker build -f platform/gateway-agent/Dockerfile -t sotyn-gateway:local .

FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl certbot \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
    > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY platform/gateway-agent/ ./

ENV NODE_ENV=production
ENV GATEWAY_PORT=7300
ENV GATEWAY_BIND=0.0.0.0
ENV GATEWAY_SOTYN_DIR=/etc/nginx/sotyn.d
ENV GATEWAY_WEBROOT=/var/www/certbot
ENV GATEWAY_STATE_FILE=/var/lib/sotyn/gateway/routes.json
ENV GATEWAY_CERT_LIVE_ROOT=/etc/letsencrypt/live

EXPOSE 7300
CMD ["node", "index.js"]
