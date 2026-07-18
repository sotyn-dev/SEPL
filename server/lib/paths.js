// Single source of truth for on-disk data locations.
//
// TENANT is empty for now, so DATA_ROOT resolves to the current `data/` dir and
// nothing moves. The (deferred) tenant phase flips TENANT to 'tenant_sepl' and
// does a one-time file move — every consumer that imports from here follows
// automatically, with no further code change.
const path = require('path');
const fs = require('fs');

const TENANT = process.env.TENANT_ID || '';
const DATA_ROOT = path.join(__dirname, '..', '..', 'data', TENANT); // TENANT='' → <repo>/data
const UPLOADS_ROOT = path.join(DATA_ROOT, 'uploads');
const QUARANTINE_ROOT = path.join(DATA_ROOT, 'quarantine');
const DB_PATH = path.join(DATA_ROOT, 'erp.db');
const CHAT_DB_PATH = path.join(DATA_ROOT, 'chat.db');

// Modules whose NEW uploads go into their own subfolder, so the orphan sweep can
// target ONLY these folders and never touch the flat root or other features.
const SWEEP_FOLDERS = ['site-chat', 'help-tickets'];

const uploadsSub = (...p) => path.join(UPLOADS_ROOT, ...p);
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); return d; }

module.exports = {
  TENANT, DATA_ROOT, UPLOADS_ROOT, QUARANTINE_ROOT, DB_PATH, CHAT_DB_PATH, SWEEP_FOLDERS,
  uploadsSub, ensureDir,
};
