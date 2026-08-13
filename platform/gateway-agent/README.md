# Sotyn gateway agent (primary only)

HTTP helper for **nginx route fragments** + **HTTP-01 Certbot**. Not the worker agent (no Docker tenants).

## Local

```bash
cd platform
cp gateway.env.example gateway.env
# optional: GATEWAY_DRY_RUN=1
npm run gateway
# → http://127.0.0.1:7300/v1/health
```

## Compose (profile `gateway`)

From repo root:

```bash
docker compose -f platform/docker-compose.yml --profile gateway up -d --build
curl -s http://127.0.0.1:7300/v1/health
```

## API

- `GET /v1/health`
- `POST /v1/routes/sync` — Bearer — `{ "hostname", "upstream": "host:port" }` or `{ "action":"delete", "hostname" }`
- `POST /v1/certs/ensure` — Bearer — `{ "hostname", "email?" }`

See `docs/GATEWAY-agent-plan.md` and Docs → Gateway in the platform UI.
