'use strict';

const { getDb } = require('./db');
const commands = require('./agentCommands');

/** @type {Map<string, import('ws').WebSocket>} */
const sockets = new Map();

/** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
const waiters = new Map();

const DEFAULT_WAIT_MS = Number(process.env.AGENT_COMMAND_TIMEOUT_MS || 120000);

function isOnline(hostId) {
  const ws = sockets.get(hostId);
  return !!(ws && ws.readyState === 1);
}

function sendJson(hostId, obj) {
  const ws = sockets.get(hostId);
  if (!ws || ws.readyState !== 1) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch (e) {
    console.warn(`[agentHub] send failed host=${hostId}:`, e.message || e);
    return false;
  }
}

function registerSocket(hostId, ws, meta = {}) {
  const prev = sockets.get(hostId);
  if (prev && prev !== ws) {
    try {
      prev.close(4000, 'replaced');
    } catch (_) {
      /* ignore */
    }
  }
  sockets.set(hostId, ws);
  const db = getDb();
  db.prepare(`
    UPDATE hosts
    SET last_seen_at = datetime('now'),
        status = CASE WHEN status = 'local' THEN status ELSE 'online' END,
        agent_version = COALESCE(?, agent_version)
    WHERE id = ?
  `).run(meta.agentVersion || null, hostId);
  console.log(`[agentHub] online host=${hostId}`);
}

function unregisterSocket(hostId, ws) {
  const cur = sockets.get(hostId);
  if (cur === ws) {
    sockets.delete(hostId);
    try {
      getDb().prepare(`
        UPDATE hosts
        SET status = CASE WHEN status = 'local' THEN status ELSE 'offline' END
        WHERE id = ?
      `).run(hostId);
    } catch (_) {
      /* ignore */
    }
    console.log(`[agentHub] offline host=${hostId}`);
  }
}

function touchHeartbeat(hostId, payload = {}) {
  getDb().prepare(`
    UPDATE hosts
    SET last_heartbeat_at = datetime('now'),
        last_seen_at = datetime('now'),
        agent_version = COALESCE(?, agent_version),
        status = CASE WHEN status = 'local' THEN status ELSE 'online' END
    WHERE id = ?
  `).run(payload.agentVersion || payload.version || null, hostId);
}

function pushCommand(row) {
  const wire = commands.rowToWire(row);
  if (!wire) return false;
  commands.markLeased(row.id);
  return sendJson(row.host_id, wire);
}

function reconcileHost(hostId) {
  const pending = commands.listPendingForHost(hostId);
  let n = 0;
  for (const row of pending) {
    if (row.status === 'leased' || row.status === 'running') {
      commands.requeueStale(row.id);
    }
    const fresh = commands.getCommand(row.id);
    if (fresh && fresh.status === 'queued') {
      if (pushCommand(fresh)) n += 1;
    }
  }
  if (n) console.log(`[agentHub] reconciled ${n} command(s) host=${hostId}`);
  return n;
}

function resolveWaiter(commandId, result) {
  const w = waiters.get(commandId);
  if (!w) return;
  clearTimeout(w.timer);
  waiters.delete(commandId);
  w.resolve(result);
}

function rejectWaiter(commandId, err) {
  const w = waiters.get(commandId);
  if (!w) return;
  clearTimeout(w.timer);
  waiters.delete(commandId);
  w.reject(err);
}

/**
 * Persist + push (if online). Optionally wait for result.
 */
async function enqueueAndDispatch({
  hostId,
  type,
  method,
  path,
  body,
  wait = true,
  timeoutMs = DEFAULT_WAIT_MS,
}) {
  const row = commands.createCommand({ hostId, type, method, path, body });
  if (isOnline(hostId)) {
    pushCommand(row);
  } else {
    console.log(`[agentHub] queued offline host=${hostId} cmd=${row.id}`);
  }

  if (!wait) return { command: row, via: 'wss', pending: true };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(row.id);
      const err = new Error(`Agent command timeout (${timeoutMs}ms) cmd=${row.id}`);
      err.status = 504;
      reject(err);
    }, timeoutMs);
    waiters.set(row.id, { resolve, reject, timer });

    // Already finished? (race)
    const cur = commands.getCommand(row.id);
    if (cur && (cur.status === 'succeeded' || cur.status === 'failed')) {
      clearTimeout(timer);
      waiters.delete(row.id);
      if (cur.status === 'failed') {
        const err = new Error(cur.error_text || 'Agent command failed');
        err.status = cur.result_status || 502;
        err.detail = commands.parseResultJson(cur);
        reject(err);
        return;
      }
      resolve({
        command: cur,
        via: 'wss',
        data: commands.parseResultJson(cur),
        status: cur.result_status || 200,
      });
    }
  });
}

function handleAgentMessage(hostId, msg) {
  const type = msg && msg.type;
  if (type === 'hello') {
    touchHeartbeat(hostId, msg);
    reconcileHost(hostId);
    return;
  }
  if (type === 'heartbeat') {
    touchHeartbeat(hostId, msg);
    return;
  }
  if (type === 'ack') {
    const id = msg.command_id;
    if (id) commands.markRunning(id);
    return;
  }
  if (type === 'result') {
    const id = msg.command_id;
    if (!id) return;
    const ok = msg.ok !== false && !(msg.status >= 400);
    const row = commands.markResult(id, {
      ok,
      statusCode: msg.status,
      data: msg.data,
      error: msg.error,
    });
    if (!ok) {
      const err = new Error(msg.error || 'Agent command failed');
      err.status = msg.status || 502;
      err.detail = msg.data;
      rejectWaiter(id, err);
      return;
    }
    resolveWaiter(id, {
      command: row,
      via: 'wss',
      data: msg.data || {},
      status: msg.status || 200,
    });
  }
}

module.exports = {
  isOnline,
  registerSocket,
  unregisterSocket,
  sendJson,
  pushCommand,
  reconcileHost,
  enqueueAndDispatch,
  handleAgentMessage,
  touchHeartbeat,
};
