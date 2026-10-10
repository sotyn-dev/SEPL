// Energy Desk config — the website's published /energy-desk/config.json,
// fetched hourly, validated, and kept as the last good copy.
//
// Every number the solar savings report uses (state rules, roof per kW, the
// approved price band) lives in the WEBSITE repo, where a build gate refuses
// any figure without a source. The ERP only reads the published JSON. So a
// number changes with a site deploy and never needs an ERP deploy, and the ERP
// never fetches or runs code from the site — the engine is vendored (vendor/).
//
// A fetch that fails, or returns something that does not validate, keeps the
// last good copy; the copy is also written next to the database so a restart
// does not start empty. With no copy at all the report routes answer 503 and
// the website falls back to its own in-browser report.

const fs = require('fs');
const path = require('path');
const engine = require('./vendor/sepl-energy-engine.cjs');

const DEFAULT_URL = 'https://www.securedengineers.com/energy-desk/config.json';
const HOUR = 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (compatible; SEPL-ERP/1.0; +https://securederp.in)';

let current = null;
let timer = null;

function cachePath() {
  const db = process.env.ERP_DB_PATH || path.join(__dirname, '..', '..', 'data', 'erp.db');
  return path.join(path.dirname(db), 'energy-desk-config.json');
}

const todayIst = () => new Date(Date.now() + 5.5 * HOUR).toISOString().slice(0, 10);

// Returns null when the config is usable, or the reason it is not.
function problemWith(raw) {
  if (!raw || typeof raw !== 'object') return 'not a JSON object';
  if (typeof raw.version !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.version)) return 'version is not YYYY-MM-DD';
  if (!raw.states || typeof raw.states !== 'object') return 'states missing';
  const p = raw.capex && raw.capex.price;
  if (!p || !(Number(p.low) > 0) || !(Number(p.high) >= Number(p.low)) || typeof p.version !== 'string') return 'capex.price missing or malformed';
  return null;
}

function load(raw, source) {
  const problem = problemWith(raw);
  if (problem) throw new Error(`config rejected: ${problem}`);
  const p = raw.capex.price;
  // The website refuses to build once a price passes its review date; a copy
  // fetched before that must not keep quoting it either.
  const expired = typeof p.reviewBy === 'string' && p.reviewBy < todayIst();
  current = {
    raw,
    resolved: engine.resolveConfig(raw),
    price: expired ? null : { id: p.id, version: p.version, low: Number(p.low), high: Number(p.high), unit: p.unit, taxBasis: p.taxBasis },
    version: raw.version,
    loadedAt: new Date().toISOString(),
    source,
  };
  return current;
}

async function refresh() {
  const url = process.env.ENERGY_DESK_CONFIG_URL || DEFAULT_URL;
  const res = await fetch(`${url}?t=${Date.now()}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  load(await res.json(), 'fetch');
  try {
    fs.writeFileSync(cachePath(), JSON.stringify(current.raw));
  } catch (e) {
    console.warn('[energy-desk] could not keep a copy of the config on disk:', e.message);
  }
  return current;
}

function loadFromDisk() {
  try {
    load(JSON.parse(fs.readFileSync(cachePath(), 'utf8')), 'disk');
  } catch (_) {
    // No copy yet, or an unreadable one — the first fetch fills it.
  }
}

// Hourly, on the same self-rescheduling setTimeout the ERP's other jobs use.
function start() {
  if (timer) return;
  loadFromDisk();
  const tick = async () => {
    try {
      await refresh();
      console.log(`[energy-desk] config ${current.version} loaded (price ${current.price ? current.price.version : 'expired'})`);
    } catch (e) {
      console.warn(`[energy-desk] config refresh failed — ${current ? 'keeping ' + current.version : 'no config yet'}:`, e.message);
    }
    timer = setTimeout(tick, HOUR);
    if (timer.unref) timer.unref();
  };
  tick();
}

function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = {
  start,
  stop,
  refresh,
  getConfig: () => current,
  // Tests load a config directly instead of fetching one.
  loadForTests: (raw) => load(raw, 'test'),
  resetForTests: () => { current = null; },
  engine,
};
