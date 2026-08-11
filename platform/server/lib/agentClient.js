'use strict';

const { getDb } = require('./db');

const DEFAULT_HOST_ID = 'host_local';
const ENV_TOKEN = process.env.AGENT_TOKEN || 'dev-agent-token';

function rowToHost(row, { includeToken = false } = {}) {
  if (!row) return null;
  const token = row.agent_token || ENV_TOKEN;
  const out = {
    id: row.id,
    label: row.label,
    agentUrl: (row.agent_url || '').replace(/\/$/, ''),
    status: row.status,
    hasToken: !!(row.agent_token || ENV_TOKEN),
    createdAt: row.created_at,
  };
  if (includeToken) out.agentToken = token;
  return out;
}

/** Public list shape — never returns raw agent tokens. */
function listHosts() {
  return getDb()
    .prepare('SELECT * FROM hosts ORDER BY created_at ASC')
    .all()
    .map((row) => rowToHost(row));
}

function getHostRow(hostId) {
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
  return row;
}

function getHost(hostId) {
  return rowToHost(getHostRow(hostId), { includeToken: true });
}

function getLocalHost() {
  return getHost(DEFAULT_HOST_ID);
}

/**
 * Call a worker agent. Pass hostId to target a specific VPS.
 * Uses that host's agent_token when set; else PLATFORM AGENT_TOKEN env.
 */
async function agentFetch(path, options = {}) {
  const { hostId, ...fetchOpts } = options;
  const host = getHost(hostId);
  const url = `${host.agentUrl}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = {
    Authorization: `Bearer ${host.agentToken}`,
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
  DEFAULT_HOST_ID,
  ENV_TOKEN,
  listHosts,
  getHost,
  getHostRow,
  getLocalHost,
  agentFetch,
  rowToHost,
};
