// Site weather via Open-Meteo (free, keyless) — SPOS (mam 2026-07-31):
// "add google site location weather updates in DPR, also guide engineer
// next 7 days forecast of weather in planning".
//
// - Geocodes the site's address/name once (cached in site_geo table).
// - Current weather auto-fills the DPR weather field; the 7-day forecast
//   strip guides the weekly plan (rain days → plan indoor work).
// - In-memory 30-min cache per site so the DPR/plan screens stay fast and
//   we never hammer the API. All best-effort: failures return null and
//   the UI simply hides the weather strip.

const { getDb } = require('../db/schema');

const CACHE_MS = 30 * 60 * 1000;
const FAIL_CACHE_MS = 10 * 60 * 1000;   // failed lookups back off 10 min —
                                        // never re-stall page loads per site
const cache = new Map();   // site_id -> { at, data|null }

// WMO weather codes → the DPR weather enum + Hinglish label.
function classify(code) {
  if (code === 0) return { key: 'clear', emoji: '☀️', label: 'Saaf' };
  if (code <= 3) return { key: 'cloudy', emoji: '⛅', label: 'Baadal' };
  if (code <= 48) return { key: 'cloudy', emoji: '🌫️', label: 'Dhundh' };
  if (code <= 67 || (code >= 80 && code <= 82)) return { key: 'rainy', emoji: '🌧️', label: 'Barish' };
  if (code <= 77 || code === 85 || code === 86) return { key: 'rainy', emoji: '🌨️', label: 'Barfbari' };
  if (code >= 95) return { key: 'rainy', emoji: '⛈️', label: 'Toofan/Barish' };
  return { key: 'cloudy', emoji: '🌥️', label: 'Baadal' };
}

async function fetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`weather http ${r.status}`);
  return r.json();
}

// Resolve site → lat/lon. Order: cached row → geocode address → geocode
// site name → geocode city fallback (Ludhiana HO region).
async function geoFor(db, site) {
  db.exec(`CREATE TABLE IF NOT EXISTS site_geo (
    site_id INTEGER PRIMARY KEY, lat REAL, lon REAL, place TEXT,
    resolved_from TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  const hit = db.prepare('SELECT * FROM site_geo WHERE site_id = ?').get(site.id);
  if (hit && hit.lat) return hit;
  // Geocoder matches PLACE names — try the site address, then the site
  // name, then the HO city so every site at least gets regional weather.
  const tries = [site.address, site.name, 'Ludhiana'].filter(Boolean);
  for (const q of tries) {
    try {
      const j = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(String(q).slice(0, 80))}&count=1&language=en&format=json`);
      const g = j?.results?.[0];
      if (g) {
        db.prepare(`INSERT INTO site_geo (site_id, lat, lon, place, resolved_from)
                    VALUES (?,?,?,?,?)
                    ON CONFLICT(site_id) DO UPDATE SET lat=excluded.lat, lon=excluded.lon,
                      place=excluded.place, resolved_from=excluded.resolved_from, updated_at=CURRENT_TIMESTAMP`)
          .run(site.id, g.latitude, g.longitude, [g.name, g.admin1].filter(Boolean).join(', '), q);
        return { site_id: site.id, lat: g.latitude, lon: g.longitude, place: [g.name, g.admin1].filter(Boolean).join(', ') };
      }
    } catch (_) { /* try next */ }
  }
  return null;
}

// { place, current: {key,emoji,label,temp}, days: [{date, key, emoji, label, tmax, tmin, rain_prob}] }
// Never allowed to stall the app: hard 8s overall deadline, and failures
// are negative-cached so the next page load returns instantly instead of
// re-waiting on a dead network (mam 2026-08-03: "erp will not hang").
async function weatherForSite(siteId) {
  const hit = cache.get(+siteId);
  if (hit && Date.now() - hit.at < (hit.data ? CACHE_MS : FAIL_CACHE_MS)) return hit.data;
  try {
    const data = await Promise.race([
      fetchWeather(+siteId),
      new Promise((_, rej) => setTimeout(() => rej(new Error('weather deadline (8s)')), 8000)),
    ]);
    cache.set(+siteId, { at: Date.now(), data });
    return data;
  } catch (e) {
    cache.set(+siteId, { at: Date.now(), data: null });   // back off 10 min
    return null;
  }
}

async function fetchWeather(siteId) {
  const db = getDb();
  const site = db.prepare('SELECT id, name, address FROM sites WHERE id = ?').get(siteId);
  if (!site) return null;
  const geo = await geoFor(db, site);
  if (!geo) return null;
  const j = await fetchJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}` +
    `&current_weather=true&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&timezone=Asia%2FKolkata&forecast_days=7`);
  return {
    place: geo.place || site.name,
    current: j.current_weather ? {
      ...classify(j.current_weather.weathercode),
      temp: Math.round(j.current_weather.temperature),
    } : null,
    days: (j.daily?.time || []).map((date, i) => ({
      date,
      ...classify(j.daily.weathercode[i]),
      tmax: Math.round(j.daily.temperature_2m_max[i]),
      tmin: Math.round(j.daily.temperature_2m_min[i]),
      rain_prob: j.daily.precipitation_probability_max ? (j.daily.precipitation_probability_max[i] ?? null) : null,
    })),
  };
}

module.exports = { weatherForSite };
