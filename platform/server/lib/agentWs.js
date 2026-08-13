'use strict';

const { WebSocketServer } = require('ws');
const { getDb } = require('./db');
const hub = require('./agentHub');

const WS_PATH = '/api/agent/v1/ws';
const ENV_TOKEN = process.env.AGENT_TOKEN || 'dev-agent-token';

function extractBearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : '';
}

function authenticateUpgrade(req) {
  const hostId = String(req.headers['x-sotyn-host-id'] || '').trim();
  const token = extractBearer(req);
  if (!hostId || !token) {
    return { ok: false, status: 401, error: 'Missing Authorization Bearer and/or X-Sotyn-Host-Id' };
  }
  const row = getDb().prepare('SELECT * FROM hosts WHERE id = ?').get(hostId);
  if (!row) {
    return { ok: false, status: 401, error: 'Unknown host_id' };
  }
  const expected = row.agent_token || ENV_TOKEN;
  if (!expected || token !== expected) {
    return { ok: false, status: 401, error: 'Invalid agent token for host' };
  }
  return { ok: true, hostId, row };
}

/**
 * Attach WebSocket server to an existing http.Server (Express).
 */
function attachAgentWs(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = (req.url || '').split('?')[0];
    if (url !== WS_PATH) {
      return;
    }
    const auth = authenticateUpgrade(req);
    if (!auth.ok) {
      socket.write(
        `HTTP/1.1 ${auth.status} Unauthorized\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${auth.error}`
      );
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, auth);
    });
  });

  wss.on('connection', (ws, _req, auth) => {
    const hostId = auth.hostId;
    hub.registerSocket(hostId, ws, {});
    ws.send(JSON.stringify({ type: 'welcome', host_id: hostId }));

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        console.warn(`[agentWs] bad json host=${hostId}`);
        return;
      }
      try {
        hub.handleAgentMessage(hostId, msg);
      } catch (e) {
        console.warn(`[agentWs] handler error host=${hostId}:`, e.message || e);
      }
    });

    ws.on('close', () => {
      hub.unregisterSocket(hostId, ws);
    });

    ws.on('error', (err) => {
      console.warn(`[agentWs] socket error host=${hostId}:`, err.message || err);
      hub.unregisterSocket(hostId, ws);
    });
  });

  console.log(`[agentWs] listening for upgrades on ${WS_PATH}`);
  return wss;
}

module.exports = { attachAgentWs, WS_PATH };
