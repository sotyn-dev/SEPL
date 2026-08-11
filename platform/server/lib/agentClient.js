'use strict';

const { getDb } = require('./db');

const AGENT_TOKEN = process.env.AGENT_TOKEN || 'dev-agent-token';
const DEFAULT_HOST_ID = 'host_local';

function getLocalHost() {
  const row = getDb().prepare('SELECT * FROM hosts WHERE id = ?').get(DEFAULT_HOST_ID)
    || getDb().prepare('SELECT * FROM hosts ORDER BY created_at ASC LIMIT 1').get();
  if (!row) {
    const err = new Error('No worker host registered');
    err.status = 503;
    throw err;
  }
  return {
    id: row.id,
    label: row.label,
    agentUrl: (row.agent_url || '').replace(/\/$/, ''),
    status: row.status,
  };
}

async function agentFetch(path, options = {}) {
  const host = getLocalHost();
  const url = `${host.agentUrl}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = {
    Authorization: `Bearer ${AGENT_TOKEN}`,
    ...(options.headers || {}),
  };
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  let res;
  try {
    res = await fetch(url, { ...options, headers });
  } catch (e) {
    const err = new Error(`Agent unreachable at ${host.agentUrl}: ${e.message}`);
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
  getLocalHost,
  agentFetch,
};
