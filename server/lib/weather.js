// Live site weather for DPR auto-fill (director ask, 2026-07-25:
// "use google weather updates in dpr automatically").
//
// Provider: Open-Meteo (https://open-meteo.com) — free, no API key, no
// billing setup, which is why it's the default instead of Google's Weather
// API (part of the paid Google Maps Platform). The provider call is
// isolated in fetchCurrentWeather() below so a Google key can be swapped
// in later without touching the rest of the flow.
//
// Location resolution order for a site:
//   1. geofence_settings lat/lng (already maintained for attendance punch)
//   2. Geocode business_book district/state via Open-Meteo's free geocoder
//   3. Geocode the site's own address text
// Geocode results are cached in-process per query string; weather results
// are cached per site for 30 minutes so the DPR form doesn't hammer the
// API when engineers flip between sites.

const GEOCODE_CACHE = new Map();   // query → { lat, lon } | null
const WEATHER_CACHE = new Map();   // siteId → { at: ms, result }
const WEATHER_TTL_MS = 30 * 60 * 1000;

// Map Open-Meteo's WMO weather code + temp + wind onto the DPR's five
// allowed values: clear / rainy / cloudy / hot / windy.
// Precedence: rain beats everything (work stops), then wind, then heat,
// then cloud cover, else clear.
function classify({ weathercode, temperature, windspeed }) {
  const code = +weathercode || 0;
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 99) || (code >= 71 && code <= 77)) return 'rainy';
  if ((+windspeed || 0) >= 30) return 'windy';                 // km/h — enough to matter at height
  if ((+temperature || 0) >= 38) return 'hot';                 // °C — Indian site-work threshold
  if (code === 2 || code === 3 || code === 45 || code === 48) return 'cloudy';
  return 'clear';
}

async function geocode(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  if (GEOCODE_CACHE.has(q)) return GEOCODE_CACHE.get(q);
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=en&format=json`;
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    const hit = j?.results?.[0];
    const out = hit ? { lat: hit.latitude, lon: hit.longitude, resolved: [hit.name, hit.admin1].filter(Boolean).join(', ') } : null;
    GEOCODE_CACHE.set(q, out);
    return out;
  } catch (e) {
    return null; // network failure — caller falls back / returns null
  }
}

async function fetchCurrentWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`;
  const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
  const j = await r.json();
  return j?.current_weather || null; // { temperature, windspeed, weathercode, ... }
}

// Resolve a site's coordinates using the order documented above.
// Returns { lat, lon, source } or null.
async function resolveSiteLocation(db, siteId) {
  const gf = db.prepare(
    `SELECT latitude, longitude FROM geofence_settings WHERE site_id=? AND active=1 LIMIT 1`
  ).get(siteId);
  if (gf?.latitude && gf?.longitude) return { lat: gf.latitude, lon: gf.longitude, source: 'geofence' };

  const site = db.prepare('SELECT name, address, business_book_id FROM sites WHERE id=?').get(siteId);
  if (!site) return null;

  const bb = site.business_book_id
    ? db.prepare('SELECT district, state FROM business_book WHERE id=?').get(site.business_book_id)
    : null;
  if (bb?.district) {
    const g = await geocode([bb.district, bb.state, 'India'].filter(Boolean).join(', '));
    if (g) return { lat: g.lat, lon: g.lon, source: `district:${g.resolved}` };
  }
  if (site.address) {
    const g = await geocode(site.address);
    if (g) return { lat: g.lat, lon: g.lon, source: `address:${g.resolved}` };
  }
  return null;
}

// Main entry: current weather for a site, classified for the DPR form.
// Returns { weather, temperature, windspeed, source } or null when the
// site can't be located / the API is unreachable — caller treats null as
// "leave the field at its manual default".
async function getSiteWeather(db, siteId) {
  const cached = WEATHER_CACHE.get(+siteId);
  if (cached && Date.now() - cached.at < WEATHER_TTL_MS) return cached.result;

  const loc = await resolveSiteLocation(db, siteId);
  if (!loc) return null;
  const cw = await fetchCurrentWeather(loc.lat, loc.lon).catch(() => null);
  if (!cw) return null;

  const result = {
    weather: classify(cw),
    temperature: cw.temperature,
    windspeed: cw.windspeed,
    weathercode: cw.weathercode,
    source: loc.source,
  };
  WEATHER_CACHE.set(+siteId, { at: Date.now(), result });
  return result;
}

module.exports = { getSiteWeather, classify };
