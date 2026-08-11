'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.PLATFORM_DATA_DIR
  || path.join(__dirname, '..', '..', 'data');
const DB_PATH = process.env.PLATFORM_DB_PATH
  || path.join(DATA_DIR, 'platform.db');
const SEED_ROOT = path.join(__dirname, '..', '..', 'seed', 'tenants');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function openDb() {
  ensureDir(DATA_DIR);
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS platform_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS platform_users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'platform_admin',
      email TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS platform_user_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS hosts (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      agent_url TEXT NOT NULL,
      agent_token TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      host_id TEXT REFERENCES hosts(id),
      data_path TEXT,
      s3_key_prefix TEXT,
      tenant_class TEXT NOT NULL DEFAULT 'mepf_erp',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tenant_branding (
      tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      display_name TEXT,
      short_name TEXT,
      legal_name TEXT,
      product_mark TEXT,
      show_powered_by INTEGER NOT NULL DEFAULT 1,
      login_tagline TEXT,
      pwa_json TEXT,
      assets_json TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tenant_entitlements (
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      pack_key TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, pack_key)
    );
  `);
  // Soft migrate older DBs created before email / tokens / host agent_token
  try {
    const cols = db.prepare('PRAGMA table_info(platform_users)').all().map((c) => c.name);
    if (!cols.includes('email')) {
      db.exec('ALTER TABLE platform_users ADD COLUMN email TEXT');
    }
  } catch (_) {
    /* ignore */
  }
  try {
    const hostCols = db.prepare('PRAGMA table_info(hosts)').all().map((c) => c.name);
    if (!hostCols.includes('agent_token')) {
      db.exec('ALTER TABLE hosts ADD COLUMN agent_token TEXT');
    }
  } catch (_) {
    /* ignore */
  }
  return db;
}

/** Ensure day‑1 host_local exists; fill agent_token from env when missing. */
function ensureHostLocal(db) {
  const agentUrl = process.env.AGENT_URL || 'http://127.0.0.1:7200';
  const token = process.env.AGENT_TOKEN || 'dev-agent-token';
  const existing = db.prepare('SELECT * FROM hosts WHERE id = ?').get('host_local');
  if (!existing) {
    db.prepare(`
      INSERT INTO hosts (id, label, agent_url, agent_token, status)
      VALUES (?, ?, ?, ?, ?)
    `).run('host_local', 'Local / VPS-1', agentUrl, token, 'local');
    return;
  }
  if (!existing.agent_token) {
    db.prepare('UPDATE hosts SET agent_token = ? WHERE id = ?').run(token, 'host_local');
  }
}

function seedAdmin(db) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM platform_users').get().n;
  if (count > 0) return;

  const username = process.env.PLATFORM_ADMIN_USER || 'admin';
  const password = process.env.PLATFORM_ADMIN_PASSWORD || 'sotyn-dev';
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(`
    INSERT INTO platform_users (id, username, password_hash, role, active)
    VALUES (?, ?, ?, 'platform_admin', 1)
  `).run('user_admin', username, hash);

  console.log(`[platform] seeded operator "${username}" (change PLATFORM_ADMIN_PASSWORD in prod)`);
}

function seedSecured(db) {
  const existing = db.prepare('SELECT id FROM tenants WHERE slug = ?').get('secured');
  if (existing) return existing.id;

  const brandingPath = path.join(SEED_ROOT, 'secured', 'branding.json');
  if (!fs.existsSync(brandingPath)) {
    console.warn('[platform] secured seed branding.json missing — skip seed');
    return null;
  }
  const b = JSON.parse(fs.readFileSync(brandingPath, 'utf8'));
  const id = 'tenant_secured';
  const hostId = 'host_local';

  const insertHost = db.prepare(`
    INSERT OR IGNORE INTO hosts (id, label, agent_url, agent_token, status)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertHost.run(
    hostId,
    'Local / VPS-1',
    process.env.AGENT_URL || 'http://127.0.0.1:7200',
    process.env.AGENT_TOKEN || 'dev-agent-token',
    'local'
  );

  db.prepare(`
    INSERT INTO tenants (id, slug, display_name, status, host_id, data_path, s3_key_prefix, tenant_class)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    'secured',
    b.displayName || 'Secured Engineers',
    'live',
    hostId,
    process.env.SECURED_DATA_PATH || '/root/erp/data',
    'secured',
    'mepf_erp'
  );

  db.prepare(`
    INSERT INTO tenant_branding (
      tenant_id, display_name, short_name, legal_name, product_mark,
      show_powered_by, login_tagline, pwa_json, assets_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    b.displayName,
    b.shortName || null,
    b.legalName || null,
    b.productMark || null,
    b.showPoweredBy ? 1 : 0,
    b.loginTagline || null,
    JSON.stringify(b.pwa || {}),
    JSON.stringify(b.assets || {})
  );

  console.log('[platform] seeded tenant secured (white-label from seed/)');
  return id;
}

let _db;
function getDb() {
  if (!_db) {
    _db = openDb();
    ensureHostLocal(_db);
    seedAdmin(_db);
    seedSecured(_db);
  }
  return _db;
}

module.exports = { getDb, DATA_DIR, DB_PATH, SEED_ROOT };
