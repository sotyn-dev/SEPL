// SOTYN Flow — Trello-style task boards. Uses its OWN database (data/sotynflow.db,
// separate from erp.db AND chat.db) so board load never touches the ERP DB — same
// design rule as the chat DB (see chatDb.js). User names are denormalised into the
// board rows (created_by_name / user_name / sender_name / actor_name) so no
// cross-database joins are needed; the only reach into erp.db is a name lookup in
// the route. Boards → members (with per-board admin role) → columns → cards →
// (card members / comments / activity). Labels + checklist are stored as JSON on
// the row (no separate tables), per the "lightweight, JSON not tables" preference.
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const FLOW_DB_PATH = path.join(DATA_DIR, 'sotynflow.db');
let flowDb = null;

function getBoardDb() {
  if (flowDb) return flowDb;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  flowDb = new Database(FLOW_DB_PATH);
  flowDb.pragma('journal_mode = WAL');
  // Per-connection tuning, same as chat DB — cuts event-loop time per write and
  // keeps hot pages resident. All re-apply on every boot / re-open.
  flowDb.pragma('synchronous = NORMAL');
  flowDb.pragma('cache_size = -16000');
  flowDb.pragma('mmap_size = 268435456');
  flowDb.pragma('temp_store = MEMORY');
  flowDb.pragma('busy_timeout = 5000');
  flowDb.exec(`
    CREATE TABLE IF NOT EXISTS boards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      labels TEXT,                       -- JSON [{id,name,color}] board label palette
      created_by INTEGER, created_by_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS board_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT, board_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      user_name TEXT, role TEXT DEFAULT 'member',   -- 'admin' | 'member' (per-board board-admin)
      added_by INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(board_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_bm_board ON board_members(board_id);
    CREATE INDEX IF NOT EXISTS idx_bm_user ON board_members(user_id);

    CREATE TABLE IF NOT EXISTS board_columns (
      id INTEGER PRIMARY KEY AUTOINCREMENT, board_id INTEGER NOT NULL,
      title TEXT NOT NULL, position REAL NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_bcol_board ON board_columns(board_id);

    CREATE TABLE IF NOT EXISTS board_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT, board_id INTEGER NOT NULL, column_id INTEGER NOT NULL,
      title TEXT NOT NULL, description TEXT, position REAL NOT NULL DEFAULT 0,
      completed INTEGER DEFAULT 0, due_date TEXT,
      checklist TEXT,                    -- JSON [{id,text,done}] simple todo list
      label_ids TEXT,                    -- JSON [id,...] into boards.labels
      created_by INTEGER, created_by_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_bcard_board ON board_cards(board_id);
    CREATE INDEX IF NOT EXISTS idx_bcard_col ON board_cards(column_id, position);

    CREATE TABLE IF NOT EXISTS board_card_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL, user_name TEXT, UNIQUE(card_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_bcm_card ON board_card_members(card_id);

    CREATE TABLE IF NOT EXISTS board_card_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL, board_id INTEGER NOT NULL,
      body TEXT, attachment_url TEXT, attachment_name TEXT,
      sender_id INTEGER, sender_name TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_bcc_card ON board_card_comments(card_id, id);

    CREATE TABLE IF NOT EXISTS board_card_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL, board_id INTEGER NOT NULL,
      actor_id INTEGER, actor_name TEXT,
      type TEXT,                         -- created|moved|renamed|described|assigned|unassigned|attached|completed|reopened
      detail TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_bca_card ON board_card_activity(card_id, id);
  `);
  // archived_at: soft archive — the board drops out of the board list but keeps
  // every column, card, comment and activity row, so it is restorable instantly
  // and still fully readable if opened directly. NULL = active. Deliberately NOT
  // a space-saving feature: nothing is deleted, so the file does not shrink.
  try {
    const bcols = flowDb.prepare("PRAGMA table_info(boards)").all().map(c => c.name);
    if (!bcols.includes('archived_at')) flowDb.exec("ALTER TABLE boards ADD COLUMN archived_at DATETIME");
  } catch (e) { /* ignore */ }
  return flowDb;
}

module.exports = { getBoardDb, FLOW_DB_PATH };
