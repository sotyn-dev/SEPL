'use strict';

/**
 * Outbound WSS client → Platform /api/agent/v1/ws
 * Local:  PLATFORM_WS_URL=ws://127.0.0.1:7100/api/agent/v1/ws
 * Deploy: PLATFORM_WS_URL=wss://agents.sotyn.ai/api/agent/v1/ws
 */
const { handleV1 } = require('./httpApi');

const AGENT_VERSION = '0.2.0-wss';

function startPlatformWs({
  url,
  hostId,
  token,
  WebSocketImpl,
} = {}) {
  const WS = WebSocketImpl || require('ws');
  const PLATFORM_WS_URL = url || process.env.PLATFORM_WS_URL || '';
  if (!PLATFORM_WS_URL) {
    console.log('[platformWs] PLATFORM_WS_URL unset — outbound WSS disabled (HTTP :7200 only)');
    return { stop() {} };
  }

  const HOST_ID = hostId || process.env.HOST_ID || 'host_local';
  const TOKEN = token || process.env.AGENT_TOKEN || 'dev-agent-token';

  let ws = null;
  let stopped = false;
  let heartbeatTimer = null;
  let reconnectDelay = 1000;
  const MAX_DELAY = 30000;

  function send(obj) {
    if (!ws || ws.readyState !== WS.OPEN) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {
      console.warn('[platformWs] send failed:', e.message || e);
    }
  }

  async function onCommand(msg) {
    const commandId = msg.command_id;
    send({ type: 'ack', command_id: commandId });
    try {
      const pathOnly = (msg.path || '').split('?')[0];
      const q = {};
      try {
        const u = new URL(msg.path || '', 'http://agent.local');
        u.searchParams.forEach((v, k) => { q[k] = v; });
      } catch (_) {
        /* ignore */
      }
      const result = await handleV1({
        method: msg.method || 'GET',
        path: pathOnly,
        body: msg.body || {},
        query: q,
      });
      const ok = result.status < 400;
      send({
        type: 'result',
        command_id: commandId,
        ok,
        status: result.status,
        data: result.data,
        error: ok ? undefined : (result.data && result.data.error) || 'command failed',
      });
    } catch (e) {
      send({
        type: 'result',
        command_id: commandId,
        ok: false,
        status: e.status || 500,
        error: e.message || String(e),
        data: e.detail || undefined,
      });
    }
  }

  function scheduleReconnect() {
    if (stopped) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(MAX_DELAY, Math.floor(reconnectDelay * 1.5));
    console.log(`[platformWs] reconnect in ${delay}ms`);
    setTimeout(connect, delay);
  }

  function connect() {
    if (stopped) return;
    console.log(`[platformWs] connecting ${PLATFORM_WS_URL} as ${HOST_ID}`);
    try {
      ws = new WS(PLATFORM_WS_URL, {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'X-Sotyn-Host-Id': HOST_ID,
        },
      });
    } catch (e) {
      console.warn('[platformWs] construct failed:', e.message || e);
      scheduleReconnect();
      return;
    }

    ws.on('open', () => {
      reconnectDelay = 1000;
      console.log(`[platformWs] connected host=${HOST_ID}`);
      send({
        type: 'hello',
        host_id: HOST_ID,
        agentVersion: AGENT_VERSION,
        version: AGENT_VERSION,
      });
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        send({
          type: 'heartbeat',
          host_id: HOST_ID,
          agentVersion: AGENT_VERSION,
          at: new Date().toISOString(),
        });
      }, 30000);
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === 'command') {
        onCommand(msg).catch((e) => {
          console.warn('[platformWs] command error:', e.message || e);
        });
      }
    });

    ws.on('close', () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      console.warn('[platformWs] disconnected');
      scheduleReconnect();
    });

    ws.on('error', (err) => {
      console.warn('[platformWs] error:', err.message || err);
    });
  }

  connect();

  return {
    stop() {
      stopped = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      try {
        if (ws) ws.close();
      } catch (_) {
        /* ignore */
      }
    },
  };
}

module.exports = { startPlatformWs, AGENT_VERSION };
