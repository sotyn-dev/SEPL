# Gateway agent — locked plan (Aug 2026)

**Status:** v1 scaffold in repo (`platform/gateway-agent/`). Platform → gateway auto-wire after provision is optional (`GATEWAY_URL`).

## Decision

| Item | Choice |
| --- | --- |
| Count | **One** gateway agent — primary only (public `:443`) |
| Role | Nginx route write + **HTTP-01** Certbot + `nginx -t` / reload |
| Not | Docker / tenant data (worker agent stays that) |
| Cert | HTTP-01 webroot (no GoDaddy API). Wildcard DNS-01 optional later |
| Deploy | Docker Compose profile `gateway` (agent + nginx sidecar) **or** host mounts against existing nginx |
| Old VPS | **Dedicated Sotyn VPS:** old nginx untouched. **Together:** shared nginx, agent path-locked to `sotyn.d/` only |

## API (v1)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/health` | Alive + paths / dry-run flags |
| `POST` | `/v1/routes/sync` | Upsert/delete hostname → `ip:port`; rewrite fragments; reload |
| `POST` | `/v1/certs/ensure` | Certbot HTTP-01 for one hostname (skip if cert exists / dry-run) |

Auth: `Authorization: Bearer <GATEWAY_TOKEN>` (same pattern as worker `AGENT_TOKEN`).

## Compose

```bash
docker compose -f platform/docker-compose.yml --profile gateway up -d --build
```

- `gateway` — Node agent `:7300`
- `gateway-nginx` — edge `:80`/`:443`, shared conf + webroot volumes

Without the profile, platform + worker agent behave as before (no public edge).

## Ops notes

- DNS: `*.sotyn.ai` → primary public IP (manual).
- Cert wait: typically ~15–90s per new hostname; treat as follow-on job, not blocking Docker provision forever.
- Together-on-old-VPS: do **not** start `gateway-nginx`; mount host `sotyn.d` + webroot; one manual `include` in host nginx; shared reload risk remains.

## Related

- [GATEWAY-wildcard-companion.md](./GATEWAY-wildcard-companion.md)
- Platform UI: **Docs → Gateway**
