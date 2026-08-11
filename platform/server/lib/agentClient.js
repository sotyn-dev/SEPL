'use strict';

const { getDb } = require('./db');

const AGENT_TOKEN = process.env.AGENT_TOKEN || 'dev-agent-token';
const DEFAULT_HOST_ID = 'host_local';

function rowToHost(row) {
  return {
    id: row.id,
    label: row.label,
    agentUrl: (row.agent_url || '').replace(/\/$/, ''),
    status: row.status,
  };
}

/** All registered worker hosts (day‑1: host_local; later: VPS‑2+). */
function listHosts() {
  return getDb()
    .prepare('SELECT * FROM hosts ORDER BY created_at ASC')
    .all()
    .map(rowToHost);
}

function getHost(hostId) {
  const id = hostId || DEFAULT_HOST_ID;
  let row = getDb().prepare('SELECT * FROM hosts WHERE id = ?').get(id);
  if (!row && (!hostId || hostId === DEFAULT_HOST_ID)) {
    row = getDb().prepare('SELECT * FROM hosts ORDER BY created_at ASC LIMIT 1').get();
  }
  if (!row) {
    const err = new Error(hostId ? `Host not found: ${hostId}` : 'No worker host registered');
    err.status = hostId ? 404 : 503;
    throw err;
  }
  return rowToHost(row);
}

function getLocalHost() {
  return getHost(DEFAULT_HOST_ID);
}

/**
 * Call a worker agent. Pass hostId to target a specific VPS (multi-host ready).
 * Omitting hostId uses host_local / first registered host.
 */
async function agentFetch(path, options = {}) {
  const { hostId, ...fetchOpts } = options;
  const host = getHost(hostId);
  const url = `${host.agentUrl}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = {
    Authorization: `Bearer ${AGENT_TOKEN}`,
    ...(fetchOpts.headers || {}),
  };
  if (fetchOpts.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  let res;
  try {
    res = await fetch(url, { ...fetchOpts, headers });
  } catch (e) {
    const err = new Error(`Agent unreachable at ${host.agentUrl} (${host.id}): ${e.message}`);
    err.status = 502;
    throw err;
  }

  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(data.error || `Agent ${res.status}`);
    err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
    err.detail = data.detail || data;
    throw err;
  }

  return { host, data, status: res.status };
}

module.exports = {
  AGENT_TOKEN,
  DEFAULT_HOST_ID,
  listHosts,
  getHost,
  getLocalHost,
  agentFetch,
};
