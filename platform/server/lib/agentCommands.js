'use strict';

const crypto = require('crypto');
const { getDb } = require('./db');

function createCommand({ hostId, type, method = 'GET', path, body = null }) {
  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO agent_commands (id, host_id, type, method, path, body_json, status)
    VALUES (?, ?, ?, ?, ?, ?, 'queued')
  `).run(
    id,
    hostId,
    type || 'http',
    String(method || 'GET').toUpperCase(),
    path,
    body == null ? null : JSON.stringify(body),
  );
  return getCommand(id);
}

function getCommand(id) {
  return getDb().prepare('SELECT * FROM agent_commands WHERE id = ?').get(id) || null;
}

function listPendingForHost(hostId) {
  return getDb().prepare(`
    SELECT * FROM agent_commands
    WHERE host_id = ?
      AND status IN ('queued', 'leased')
    ORDER BY created_at ASC
  `).all(hostId);
}

function markLeased(id) {
  const db = getDb();
  db.prepare(`
    UPDATE agent_commands
    SET status = 'leased',
        attempts = attempts + 1,
        leased_at = datetime('now')
    WHERE id = ? AND status IN ('queued', 'leased')
  `).run(id);
  return getCommand(id);
}

function markRunning(id) {
  getDb().prepare(`
    UPDATE agent_commands SET status = 'running' WHERE id = ? AND status IN ('leased', 'queued', 'running')
  `).run(id);
  return getCommand(id);
}

function markResult(id, { ok, statusCode, data, error }) {
  const db = getDb();
  db.prepare(`
    UPDATE agent_commands
    SET status = ?,
        finished_at = datetime('now'),
        result_status = ?,
        result_json = ?,
        error_text = ?
    WHERE id = ?
  `).run(
    ok ? 'succeeded' : 'failed',
    statusCode == null ? null : Number(statusCode),
    data == null ? null : JSON.stringify(data),
    error ? String(error).slice(0, 2000) : null,
    id,
  );
  return getCommand(id);
}

function requeueStale(id) {
  getDb().prepare(`
    UPDATE agent_commands
    SET status = 'queued', leased_at = NULL
    WHERE id = ? AND status IN ('leased', 'running')
  `).run(id);
  return getCommand(id);
}

function rowToWire(row) {
  if (!row) return null;
  let body = null;
  if (row.body_json) {
    try {
      body = JSON.parse(row.body_json);
    } catch {
      body = null;
    }
  }
  return {
    command_id: row.id,
    type: 'command',
    op: row.type,
    method: row.method,
    path: row.path,
    body,
    attempts: row.attempts,
  };
}

function parseResultJson(row) {
  if (!row || !row.result_json) return {};
  try {
    return JSON.parse(row.result_json);
  } catch {
    return { raw: row.result_json };
  }
}

module.exports = {
  createCommand,
  getCommand,
  listPendingForHost,
  markLeased,
  markRunning,
  markResult,
  requeueStale,
  rowToWire,
  parseResultJson,
};
