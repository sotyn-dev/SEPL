# Platform ↔ Worker Agent WSS control plane

Outbound authenticated WebSocket from each worker agent to the Platform. Tenant/Gateway traffic is separate.

## Local (priority)

No Cloudflare, no public nginx.

```bash
# terminal 1 — platform (from repo)
cd platform && npm run install:all
npm run server
# WSS: ws://127.0.0.1:7100/api/agent/v1/ws

# terminal 2 — worker agent
# platform/agent.env:
#   AGENT_TOKEN=dev-agent-token
#   HOST_ID=host_local
#   PLATFORM_WS_URL=ws://127.0.0.1:7100/api/agent/v1/ws
npm run platform:agent
```

Expect platform log: `agentHub] online host=host_local`  
Agent still listens on `:7200` for HTTP fallback.

Handshake headers (not query string):

- `Authorization: Bearer <agent-token>`
- `X-Sotyn-Host-Id: <host_id>`

## Deploy — `agents.sotyn.ai`

Human UI stays on `platform.sotyn.ai` (Cloudflare Access). Agents use a **separate** hostname with **no** Access OTP.

DNS: `agents.sotyn.ai` → Platform VPS IP.

Nginx example:

```nginx
server {
  listen 443 ssl http2;
  server_name agents.sotyn.ai;

  # ssl_certificate … (certbot)

  location /api/agent/v1/ws {
    proxy_pass http://127.0.0.1:7100;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }

  # optional: reject everything else on this host
  location / {
    return 404;
  }
}
```

Worker `agent.env` on each VPS:

```bash
HOST_ID=host_vps_b
AGENT_TOKEN=<same as Hosts UI>
PLATFORM_WS_URL=wss://agents.sotyn.ai/api/agent/v1/ws
```

## Behaviour

- Commands are written to `agent_commands` in `platform.db` **before** WSS send.
- If the agent is connected, Platform pushes the command; agent ACK → execute → result.
- If offline, command stays `queued`; on reconnect Platform reconciles.
- If the agent is not on WSS, Platform falls back to HTTP `AGENT_URL` (`:7200`).

## Related

- Platform UI Docs → Env / Multi‑VPS
- [`PLATFORM-VPS-deploy.md`](./PLATFORM-VPS-deploy.md)
- [`PLATFORM-Cloudflare-Access.md`](./PLATFORM-Cloudflare-Access.md) — Access on **platform** host only, not `agents.`
