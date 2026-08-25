// Solar Site Design — location lookup, LiDAR roof import and saved 3D studies.
//
// Three jobs:
//   1. /geocode  — turn what the sales engineer types ("Focal Point, Ludhiana",
//      a pasted Google Maps link, or raw coordinates) into a lat/lng we can pin.
//   2. /lidar    — Google Solar API buildingInsights: aerial-LiDAR-derived roof
//      segments with real pitch, azimuth and height. Optional — it needs a key
//      and India coverage is patchy, so every response says plainly whether it
//      worked, and the client falls back to tracing the roof on satellite
//      imagery when it didn't.
//   3. /studies  — persist the site model + analysis against a solar deal, so
//      the survey stage, the quotation and the customer PDF all read the same
//      shadow study instead of someone's re-measured guess.
const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { ensureSolarSchema } = require('../db/seedSolar');

const router = express.Router();
router.use(authMiddleware);
try { ensureSolarSchema(getDb()); } catch (e) { console.warn('[solar-site] ensureSchema:', e.message); }

const view = requirePermission('solar_quotation', 'view');
const edit = requirePermission('solar_quotation', 'edit');

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const GEO_CACHE = new Map();

// ── 1. Location ────────────────────────────────────────────────────────────
// Accepts, in order: raw "lat, lng"; a Google Maps URL (…/@30.90,75.85,19z or
// ?q=30.90,75.85); otherwise a place-name search.
function parseCoords(q) {
  const s = String(q || '').trim();
  const at = s.match(/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);          // maps /@lat,lng
  const qp = s.match(/[?&]q=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);     // maps ?q=lat,lng
  const raw = s.match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);  // "30.9, 75.85"
  const m = at || qp || raw;
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

// A pasted Google Maps link doesn't always carry raw @lat,lng — two shapes
// that don't:
//   1. A phone "Share → Copy link" link, e.g. https://maps.app.goo.gl/AbC123 —
//      that's a redirector with no coordinates in the URL at all; the real
//      link only exists after following the 302.
//   2. A desktop /maps/place/<Name>/ link with no zoom segment yet, or an
//      old-style search link like /maps?q=<Name> — these carry the PLACE the
//      user meant, as text, not coordinates.
// Previously neither case was handled: parseCoords found nothing, and the
// *entire raw URL string* got sent to the geocoders as the search query —
// which never finds anything, since none of them can geocode a URL. Resolve
// case 1 server-side (the browser can't — it's cross-origin) and pull the
// place text out for case 2, so the search actually runs on something a
// geocoder can use.
function isShortMapsLink(s) {
  try { return new URL(s).hostname.toLowerCase() === 'maps.app.goo.gl'; } catch { return false; }
}

async function resolveShortLink(s) {
  const r = await fetch(s, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(7000) });
  return r.url || null;
}

// A /maps/dir/ (Directions) link's @lat,lng segment is the map's last pan/
// zoom VIEWPORT at the moment the link was generated — NOT the destination's
// real coordinates. Trusting it (as a plain @lat,lng regex match would)
// silently pins the wrong spot: confirmed against a real business address,
// where it landed off the actual building. A /maps/place/ link doesn't have
// this problem — Google always centers that page exactly on the place — so
// only /dir/ needs its destination re-geocoded from text instead.
function isDirectionsLink(s) {
  try { return new URL(s).pathname.includes('/dir/'); } catch { return false; }
}

function extractPlaceFromMapsUrl(s) {
  let u;
  try { u = new URL(s); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (!host.includes('google.') && host !== 'maps.app.goo.gl') return null;

  const parts = u.pathname.split('/').filter(Boolean);
  const placeIdx = parts.indexOf('place');
  if (placeIdx !== -1 && parts[placeIdx + 1]) return decodeURIComponent(parts[placeIdx + 1].replace(/\+/g, ' '));

  // /maps/dir/<origin>/<destination>/@viewport,z/data=... — origin is often
  // empty (a bare "directions to X" link). Take the last segment that isn't
  // the viewport or the data blob; that's the destination as typed/resolved.
  const dirIdx = parts.indexOf('dir');
  if (dirIdx !== -1) {
    const rest = parts.slice(dirIdx + 1).filter((p) => p && !p.startsWith('@') && !p.startsWith('data='));
    const dest = rest[rest.length - 1];
    if (dest && !/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(dest)) return decodeURIComponent(dest.replace(/\+/g, ' '));
  }

  const qParam = u.searchParams.get('q');
  if (qParam && !/^-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?$/.test(qParam.trim())) return qParam;
  return null;
}

// Three geocoders, tried in order, cheapest-configured first:
//   1. Google Geocoding API — real street/building-level accuracy for India,
//      IF a Maps Platform key is set (same GOOGLE_SOLAR_API_KEY as the LiDAR
//      lookup below — Solar API and Geocoding API sit under the same Google
//      Cloud project, so one key commonly covers both once both APIs are
//      enabled on it).
//   2. Nominatim (OpenStreetMap) — free, no key, and unlike #3 it indexes
//      streets, roads and localities, not just towns — this is what actually
//      finds "B.K. Towers, Gill Road, Janta Nagar" rather than just "Ludhiana".
//   3. Open-Meteo — the original fallback. Only ever finds town/city-level
//      matches, kept as a last resort for when neither of the above answers.
// Each tier is skipped/fails silently on to the next; only report an error to
// the user if every tier that actually ran came back with nothing useful.
async function geocodeGoogle(q) {
  const key = process.env.GOOGLE_SOLAR_API_KEY;
  if (!key) return null;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&region=in&key=${encodeURIComponent(key)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(7000) });
  const j = await r.json();
  if (j.status === 'REQUEST_DENIED' || j.status === 'INVALID_REQUEST') {
    // Key exists but isn't enabled for Geocoding API (or is otherwise
    // rejected) — not a "no results", a configuration gap. Let the caller
    // fall through to Nominatim rather than surfacing Google's error text.
    console.warn('[solar-site] Google geocode:', j.status, j.error_message || '');
    return null;
  }
  return (j.results || []).map((x) => ({
    lat: x.geometry.location.lat, lng: x.geometry.location.lng, altitude: 0,
    name: x.formatted_address, country: (x.address_components || []).find((c) => c.types.includes('country'))?.short_name,
    source: 'google',
  }));
}

// Business names ("Secured Engineers Pvt Ltd") are a different problem from
// addresses: the Geocoding API and both free tiers index PLACES, not
// businesses, so a company name draws a blank everywhere (confirmed live —
// the user typed exactly that and got "No match"). Places Text Search is the
// Google API built for name lookups, and it runs off the same key. It sits
// after the Geocoding tier so it only spends a (pricier) Places call when the
// query isn't a resolvable address.
async function geocodeGooglePlaces(q) {
  const key = process.env.GOOGLE_SOLAR_API_KEY;
  if (!key) return null;
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    signal: AbortSignal.timeout(7000),
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.location,places.formattedAddress,places.displayName',
    },
    body: JSON.stringify({ textQuery: q, regionCode: 'IN', pageSize: 5 }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // Key not enabled for Places API — a configuration gap, not "no results";
    // fall through to the free tiers like the Geocoding tier does.
    console.warn('[solar-site] Google Places search:', r.status, j.error?.message || '');
    return null;
  }
  return (j.places || []).map((p) => ({
    lat: p.location.latitude, lng: p.location.longitude, altitude: 0,
    name: [p.displayName?.text, p.formattedAddress].filter(Boolean).join(', '),
    country: 'IN', source: 'google-places',
  }));
}

async function geocodeNominatim(q) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&countrycodes=in&format=jsonv2&addressdetails=1&limit=6`;
  // Nominatim's usage policy requires an identifying User-Agent — a generic
  // browser UA gets silently rate-limited/blocked.
  const r = await fetch(url, { signal: AbortSignal.timeout(7000), headers: { 'User-Agent': 'SEPL-SOTYN-Solar/1.0 (internal solar design tool)' } });
  // A rate-limit/block (e.g. 429/403 during a burst) still resolves fetch()
  // normally — without this check it fails downstream as an opaque "j.map is
  // not a function" (the error body is an object, not the expected array),
  // which reads no differently from "found nothing" once geocodeAllTiers'
  // try/catch swallows it. Surface it explicitly instead.
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return (j || []).map((x) => ({
    lat: +x.lat, lng: +x.lon, altitude: 0,
    name: x.display_name, country: x.address?.country_code?.toUpperCase(),
    source: 'osm',
  }));
}

async function geocodeOpenMeteo(q) {
  // Matches a PLACE NAME only, so send the first comma-segment and use the
  // rest to disambiguate between same-named towns.
  const place = q.split(',')[0].trim();
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=8&language=en&format=json`;
  const r = await fetch(url, { signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const rest = q.slice(place.length).toLowerCase();
  return (j?.results || [])
    .map((x) => ({
      lat: x.latitude, lng: x.longitude, altitude: x.elevation ?? 0,
      name: [x.name, x.admin2, x.admin1, x.country].filter(Boolean).join(', '),
      country: x.country_code, source: 'open-meteo',
      _score: (x.country_code === 'IN' ? 2 : 0) + (rest && rest.includes(String(x.admin1 || '').toLowerCase()) ? 3 : 0),
    }))
    .sort((a, b) => b._score - a._score)
    .map(({ _score, ...x }) => x);
}

// Run every tier against one query string; returns [] if none find anything,
// throws only if EVERY tier hard-errored (vs. genuinely found nothing).
async function geocodeAllTiers(q) {
  const tiers = [geocodeGoogle, geocodeGooglePlaces, geocodeNominatim, geocodeOpenMeteo];
  const errors = [];
  // Count tiers that actually ANSWERED (returned a real, possibly-empty
  // result set). A keyless/misconfigured Google tier returns null — it never
  // ran, so it must not dilute the all-failed check: with the old
  // errors===tiers test, "no key + both free tiers down" read as a calm
  // "No match" instead of the 502 that tells someone to check the server's
  // internet access (reproduced locally under a blocked-network sandbox).
  let answered = 0;
  for (const tier of tiers) {
    try {
      const results = await tier(q);
      if (results === null) continue;
      answered++;
      if (results.length) return results;
    } catch (e) {
      // A tier failing here used to be completely invisible — the caller only
      // ever sees "No match", identical to a genuine not-found, whether one
      // tier silently errored (a rate-limit, a timeout) or the place really
      // doesn't exist. Log it so a real degradation shows up in `pm2 logs`
      // instead of reading as a geocoder gap (confirmed cause of a live
      // "Ludhiana gives no match" report that was actually a transient tier
      // failure — direct curl calls right after found it instantly).
      console.warn(`[solar-site] geocode tier ${tier.name} failed for "${q}":`, e.message);
      errors.push(`${tier.name}: ${e.message}`);
    }
  }
  if (errors.length && !answered) { const err = new Error(errors.join('; ')); err.allFailed = true; throw err; }
  return [];
}

router.get('/geocode', view, async (req, res) => {
  let q = String(req.query.q || '').trim();
  // The state dropdown next to the Find button. It used to drive ONLY the
  // specific-yield calibration, which reads as broken to anyone who selects
  // "Punjab" and then watches the search ignore it — so it now also scopes
  // the lookup when the typed query finds nothing on its own.
  const state = String(req.query.state || '').trim();
  if (!q) return res.status(400).json({ error: 'Nothing to look up' });

  // A short share link (maps.app.goo.gl/…) carries nothing usable until
  // resolved to its real URL — do that first so everything below sees it.
  if (isShortMapsLink(q)) {
    const resolved = await resolveShortLink(q).catch(() => null);
    if (resolved) q = resolved;
  }

  const isUrl = /^https?:\/\//i.test(q);
  // See isDirectionsLink's comment — a /dir/ link's @lat,lng is a viewport,
  // not the destination, so it's never trustworthy as a direct coordinate.
  let direct = isUrl && isDirectionsLink(q) ? null : parseCoords(q);

  // Pull a human-readable place/address out of the URL either way: it's the
  // ONLY way to find the real spot on a /dir/ link, and even when the raw
  // coordinate IS trustworthy (a /place/ link, a bare pin drop) it replaces
  // "just show the numbers" with the actual address as the name.
  const extractedName = isUrl ? extractPlaceFromMapsUrl(q) : null;
  if (!direct && extractedName) q = extractedName;

  if (direct) {
    return res.json({ results: [{ ...direct, name: extractedName || `${direct.lat.toFixed(6)}, ${direct.lng.toFixed(6)}`, source: 'coordinates' }] });
  }

  // Cache the full payload (results + any broadenedFrom/note), not just the
  // bare array — a repeat of the same broadened query must still explain
  // itself on a cache hit, not silently drop the "this is approximate" note.
  // Keyed on state too: the same words can resolve differently once the
  // state-scoped retry below participates.
  const cacheKey = state ? `${q} @@ ${state}` : q;
  if (GEO_CACHE.has(cacheKey)) return res.json({ ...GEO_CACHE.get(cacheKey), cached: true });

  try {
    let results = await geocodeAllTiers(q);
    let broadenedFrom = null;

    // Nothing as typed — retry with the selected state appended ("Secured
    // Engineers Pvt Ltd" → "Secured Engineers Pvt Ltd, Punjab"). Geocoders do
    // materially better with a region anchor, and it costs nothing when the
    // user already typed one (skipped if the state is in the query).
    let searched = q;
    if (!results.length && state && !q.toLowerCase().includes(state.toLowerCase())) {
      searched = `${q}, ${state}`;
      results = await geocodeAllTiers(searched).catch(() => []);
    }

    // Nothing found for the query as typed — no geocoder, free or paid, has
    // every small commercial building by name (confirmed against this exact
    // case: "B.K. Towers" genuinely isn't in OpenStreetMap's India dataset).
    // Retry with progressively more of the leading segments dropped —
    // "B.K. Towers, Gill Road, Janta Nagar" → "Gill Road, Janta Nagar" → "Janta
    // Nagar" — stopping at the first one that finds anything, the same
    // recovery a person would do by hand. A single drop wasn't always enough
    // (confirmed: a real "<Business>, <house>, <road>, near <Landmark>, <city>,
    // <state>" address needed THREE segments gone before it matched). Also
    // strip a leading landmark-reference word from every segment — "near X" /
    // "opp X" phrasing, extremely common in Indian addresses, defeats
    // Nominatim's matching completely even when X alone resolves fine
    // (confirmed: "near Grewal Hospital, Ludhiana" → nothing, but "Grewal
    // Hospital, Ludhiana" → resolves immediately).
    // Broadening runs over the state-carrying variant so a bare single-segment
    // business name (no commas as typed) still has somewhere to fall: "Secured
    // Engineers Pvt Ltd, Punjab" → "Punjab" lands an area pin with the honest
    // approximate-note instead of a dead "No match".
    const stripLandmarkPrefix = (s) => s.replace(/^(near|opp\.?|opposite|behind|beside|next to|backside of|adjacent to)\s+/i, '').trim();
    const segments = searched.split(',').map((s) => s.trim()).filter(Boolean);
    if (!results.length && segments.length > 1) {
      // Capped so a long address can't chain into an unbounded run of
      // sequential network round-trips — each failed attempt still costs a
      // real request per tier.
      const maxDrops = Math.min(segments.length - 1, 4);
      for (let drop = 0; drop < maxDrops && !results.length; drop++) {
        const broader = segments.slice(drop).map(stripLandmarkPrefix).filter(Boolean).join(', ');
        if (!broader || broader === q || broader === searched) continue;
        const retry = await geocodeAllTiers(broader).catch(() => []);
        if (retry.length) { results = retry; broadenedFrom = q; }
      }
    }

    if (results.length) {
      const payload = { results, ...(broadenedFrom ? { broadenedFrom, note: `No exact match for "${broadenedFrom}" — showing results for the area instead. Zoom in and click the map to pin the precise spot.` } : {}) };
      GEO_CACHE.set(cacheKey, payload);
      return res.json(payload);
    }
  } catch (e) {
    if (e.allFailed) return res.status(502).json({ error: "Location lookup failed — check the server's internet access", detail: e.message });
    throw e;
  }
  res.json({ results: [] });
});

// ── 2. LiDAR roof import (Google Solar API) ────────────────────────────────
// Set GOOGLE_SOLAR_API_KEY (Google Cloud → Solar API) to enable. Without it the
// client just uses manual roof tracing — the module is fully usable either way.
router.get('/lidar', view, async (req, res) => {
  const lat = num(req.query.lat), lng = num(req.query.lng);
  if (lat === null || lng === null) return res.status(400).json({ error: 'lat and lng are required' });

  const key = process.env.GOOGLE_SOLAR_API_KEY;
  if (!key) {
    return res.json({
      available: false, reason: 'no_key',
      message: 'Google Solar API key not configured — trace the roof on satellite imagery instead. Set GOOGLE_SOLAR_API_KEY on the server to auto-import LiDAR roof planes.',
    });
  }
  try {
    const url = 'https://solar.googleapis.com/v1/buildingInsights:findClosest'
      + `?location.latitude=${lat}&location.longitude=${lng}&requiredQuality=LOW&key=${encodeURIComponent(key)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const j = await r.json();

    if (!r.ok) {
      // 404 here means "no LiDAR for this building", which is normal across much
      // of India and is not an error the user needs to act on.
      const notCovered = r.status === 404;
      return res.json({
        available: false, reason: notCovered ? 'no_coverage' : 'api_error',
        message: notCovered
          ? 'No LiDAR coverage for this building yet — trace the roof on satellite imagery instead.'
          : `Solar API said: ${j?.error?.message || r.statusText}`,
      });
    }

    const sp = j.solarPotential || {};
    const segments = (sp.roofSegmentStats || []).map((s, i) => ({
      id: `lidar-${i}`,
      name: `Roof plane ${i + 1}`,
      pitchDeg: s.pitchDegrees ?? 0,
      azimuthDeg: s.azimuthDegrees ?? 180,
      areaSqm: s.stats?.areaMeters2 ?? 0,
      groundAreaSqm: s.stats?.groundAreaMeters2 ?? 0,
      // Height of this plane above the DSM datum, as reported by the LiDAR.
      planeHeightM: s.planeHeightAtCenterMeters ?? null,
      center: s.center ? { lat: s.center.latitude, lng: s.center.longitude } : null,
      bounds: s.boundingBox ? {
        sw: { lat: s.boundingBox.sw.latitude, lng: s.boundingBox.sw.longitude },
        ne: { lat: s.boundingBox.ne.latitude, lng: s.boundingBox.ne.longitude },
      } : null,
    }));

    res.json({
      available: true,
      source: 'google-solar-api',
      imageryDate: j.imageryDate, imageryQuality: j.imageryQuality,
      center: j.center ? { lat: j.center.latitude, lng: j.center.longitude } : null,
      // Google's own estimate — a useful cross-check against our shadow model,
      // never a replacement for it (it assumes their panel and their layout).
      googleEstimate: {
        maxPanels: sp.maxArrayPanelsCount ?? null,
        maxAreaSqm: sp.maxArrayAreaMeters2 ?? null,
        maxSunshineHoursPerYear: sp.maxSunshineHoursPerYear ?? null,
        panelWattp: sp.panelCapacityWatts ?? null,
        panelHeightM: sp.panelHeightMeters ?? null,
        panelWidthM: sp.panelWidthMeters ?? null,
        carbonOffsetKgPerMwh: sp.carbonOffsetFactorKgPerMwh ?? null,
      },
      segments,
    });
  } catch (e) {
    res.json({ available: false, reason: 'network', message: `Could not reach the Solar API: ${e.message}` });
  }
});

// ── 3. Saved studies ───────────────────────────────────────────────────────
router.get('/studies', view, (req, res) => {
  const db = getDb();
  const { deal_id } = req.query;
  const rows = deal_id
    ? db.prepare('SELECT * FROM solar_site_studies WHERE deal_id=? ORDER BY updated_at DESC').all(deal_id)
    : db.prepare('SELECT * FROM solar_site_studies ORDER BY updated_at DESC LIMIT 200').all();
  res.json(rows.map(shape));
});

router.get('/studies/:id', view, (req, res) => {
  const row = getDb().prepare('SELECT * FROM solar_site_studies WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Study not found' });
  res.json(shape(row, true));
});

router.post('/studies', edit, (req, res) => {
  const b = req.body || {};
  const r = getDb().prepare(`INSERT INTO solar_site_studies
    (deal_id, name, address, lat, lng, altitude, site_json, result_json,
     panel_count, capacity_kwp, annual_kwh, mean_perf_pct, shade_loss_pct, lidar_source, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    num(b.deal_id), b.name || 'Untitled site', b.address || null,
    num(b.lat), num(b.lng), num(b.altitude) ?? 0,
    JSON.stringify(b.site || {}), JSON.stringify(b.result || {}),
    num(b.panel_count) ?? 0, num(b.capacity_kwp) ?? 0, num(b.annual_kwh) ?? 0,
    num(b.mean_perf_pct) ?? 0, num(b.shade_loss_pct) ?? 0,
    b.lidar_source || 'manual', req.user?.id ?? null,
  );
  res.json({ id: r.lastInsertRowid });
});

router.put('/studies/:id', edit, (req, res) => {
  const b = req.body || {};
  const cols = {
    name: b.name, address: b.address, lat: num(b.lat), lng: num(b.lng), altitude: num(b.altitude),
    deal_id: num(b.deal_id), lidar_source: b.lidar_source,
    site_json: b.site ? JSON.stringify(b.site) : undefined,
    result_json: b.result ? JSON.stringify(b.result) : undefined,
    panel_count: num(b.panel_count), capacity_kwp: num(b.capacity_kwp), annual_kwh: num(b.annual_kwh),
    mean_perf_pct: num(b.mean_perf_pct), shade_loss_pct: num(b.shade_loss_pct),
  };
  const set = Object.keys(cols).filter((k) => cols[k] !== undefined);
  if (!set.length) return res.json({ ok: true });
  getDb().prepare(`UPDATE solar_site_studies SET ${set.map((c) => `${c}=?`).join(',')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(...set.map((c) => cols[c]), req.params.id);
  res.json({ ok: true });
});

router.delete('/studies/:id', edit, (req, res) => {
  getDb().prepare('DELETE FROM solar_site_studies WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

/**
 * Push a finished study back onto the deal: it fills the survey stage's
 * shadow-free area (which is otherwise typed in by hand) and sets the capacity
 * the design stage needs, so the funnel gate opens off measured geometry.
 */
router.post('/studies/:id/apply-to-deal', edit, (req, res) => {
  const db = getDb();
  const st = db.prepare('SELECT * FROM solar_site_studies WHERE id=?').get(req.params.id);
  if (!st) return res.status(404).json({ error: 'Study not found' });
  const dealId = num(req.body?.deal_id) ?? st.deal_id;
  if (!dealId) return res.status(400).json({ error: 'No deal to apply this study to' });
  const deal = db.prepare('SELECT * FROM solar_deals WHERE id=?').get(dealId);
  if (!deal) return res.status(404).json({ error: 'Deal not found' });

  const result = JSON.parse(st.result_json || '{}');
  const s = result.summary || {};
  const sd = JSON.parse(deal.stage_data_json || '{}');
  sd.survey = {
    ...(sd.survey || {}),
    completed: true,
    area_sqft: Math.round(s.usableAreaSqft || 0),
    roof_type: (JSON.parse(st.site_json || '{}').surfaces || [])[0]?.name || 'As per 3D study',
    shadow: `${(s.shadeLossPct ?? 0).toFixed(1)}% annual shading loss (3D study #${st.id})`,
    notes: `${s.panelCount || 0} panels · ${(s.kWp || 0).toFixed(1)} kWp · ${Math.round(s.kwhYear || 0)} kWh/yr · mean panel performance ${(s.meanPerfPct ?? 0).toFixed(0)}% of optimal`,
    site_study_id: st.id,
  };
  db.prepare(`UPDATE solar_deals SET stage_data_json=?, lat=COALESCE(?,lat), lng=COALESCE(?,lng),
              capacity_kw=COALESCE(?,capacity_kw), updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(JSON.stringify(sd), st.lat, st.lng, st.capacity_kwp || null, dealId);
  db.prepare('UPDATE solar_site_studies SET deal_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(dealId, st.id);
  res.json({ ok: true, deal_id: dealId, area_sqft: sd.survey.area_sqft, capacity_kwp: st.capacity_kwp });
});

function shape(row, full = false) {
  const out = {
    id: row.id, deal_id: row.deal_id, name: row.name, address: row.address,
    lat: row.lat, lng: row.lng, altitude: row.altitude,
    panel_count: row.panel_count, capacity_kwp: row.capacity_kwp, annual_kwh: row.annual_kwh,
    mean_perf_pct: row.mean_perf_pct, shade_loss_pct: row.shade_loss_pct,
    lidar_source: row.lidar_source, created_at: row.created_at, updated_at: row.updated_at,
  };
  if (full) {
    try { out.site = JSON.parse(row.site_json || '{}'); } catch { out.site = {}; }
    try { out.result = JSON.parse(row.result_json || '{}'); } catch { out.result = {}; }
  }
  return out;
}

module.exports = router;
