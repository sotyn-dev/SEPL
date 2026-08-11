'use strict';

const fs = require('fs');
const path = require('path');
const { TENANTS_ROOT } = require('./paths');

function statePath() {
  return path.join(TENANTS_ROOT, '.agent', 'runtimes.json');
}

function ensureStateDir() {
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
}

function load() {
  const p = statePath();
  if (!fs.existsSync(p)) return { tenants: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!raw || typeof raw !== 'object') return { tenants: {} };
    if (!raw.tenants || typeof raw.tenants !== 'object') raw.tenants = {};
    return raw;
  } catch {
    return { tenants: {} };
  }
}

function save(state) {
  ensureStateDir();
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

function upsert(slug, patch) {
  const state = load();
  const prev = state.tenants[slug] || {};
  state.tenants[slug] = { ...prev, ...patch, slug, updatedAt: new Date().toISOString() };
  save(state);
  return state.tenants[slug];
}

function remove(slug) {
  const state = load();
  delete state.tenants[slug];
  save(state);
}

function get(slug) {
  return load().tenants[slug] || null;
}

function list() {
  return Object.values(load().tenants);
}

module.exports = { load, save, upsert, remove, get, list, statePath };
