// Shadow analysis + panel placement over a LiDAR-style surface model.
//
// The site is a digital surface model (DSM): a height raster in local ENU
// metres (+x East, +y North, +z up, origin at the site pin). Heights come from
// whatever we can get, in order of preference:
//   1. Google Solar API dataLayers — real aerial-LiDAR DSM at 0.1–0.25 m/px.
//   2. Roof planes + obstruction volumes traced by the surveyor on satellite
//      imagery, with measured heights. This is the fallback that always works,
//      including everywhere the LiDAR layers don't cover.
// Both end up as the same raster, so everything downstream is identical.
//
// Shading itself is a horizon profile per cell — for each of `azBins` compass
// directions we ray-march the DSM once and record the highest elevation angle
// that is blocked. After that the annual sweep is a table lookup per sun
// position instead of a fresh raycast, which is what makes a full 8760-style
// integration run in the browser in well under a second. Same method PVsyst
// and Helioscope use for far/near shading.

import {
  IST, sunTimes, solarTerms, sunPositionFromTerms, sunVector, clearSky,
  poaIrradiance, planeNormal, optimalTilt, optimalAzimuth, rowPitch, doyToDate,
} from './sun';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ─────────────────────────── geodesy ───────────────────────────
// Local tangent-plane projection about the site pin. Over a few hundred metres
// the error is millimetres — far below anything a site survey resolves.
const EARTH_R = 6378137;
export function makeProjection(lat0, lng0) {
  const mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * lat0 * RAD) + 1.175 * Math.cos(4 * lat0 * RAD);
  const mPerDegLng = (Math.PI / 180) * EARTH_R * Math.cos(lat0 * RAD);
  return {
    lat0, lng0, mPerDegLat, mPerDegLng,
    toLocal: (lat, lng) => [(lng - lng0) * mPerDegLng, (lat - lat0) * mPerDegLat],
    toLatLng: (x, y) => [lat0 + y / mPerDegLat, lng0 + x / mPerDegLng],
  };
}

// ─────────────────────────── polygon utils ───────────────────────────
export function polyArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return Math.abs(a) / 2;
}
export function polyCentroid(pts) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const f = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    a += f; cx += (pts[j][0] + pts[i][0]) * f; cy += (pts[j][1] + pts[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) {                       // degenerate — fall back to mean
    return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  }
  return [cx / (3 * a), cy / (3 * a)];
}
export function polyBounds(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  return { minX, minY, maxX, maxY };
}
export function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Signed distance from a point to the polygon edge — negative outside. Used for setbacks. */
export function distToEdge(x, y, pts) {
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    const dx = xj - xi, dy = yj - yi;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? clamp(((x - xi) * dx + (y - yi) * dy) / len2, 0, 1) : 0;
    const px = xi + t * dx, py = yi + t * dy;
    best = Math.min(best, Math.hypot(x - px, y - py));
  }
  return pointInPoly(x, y, pts) ? best : -best;
}

// ─────────────────────────── surfaces ───────────────────────────
/**
 * Height of a (possibly pitched) mounting surface at a plan position.
 * The plane passes through the polygon centroid at `baseHeight`, dipping in the
 * surface's azimuth direction at its tilt.
 */
export function surfaceZ(surface, x, y) {
  const tilt = surface.tiltDeg || 0;
  if (tilt < 0.01) return surface.baseHeight || 0;
  const n = planeNormal(tilt, surface.aziDeg ?? 180);
  const [cx, cy] = surface._centroid || polyCentroid(surface.polygon);
  return (surface.baseHeight || 0) - (n.x * (x - cx) + n.y * (y - cy)) / n.z;
}

/** True (sloped) area of a surface — plan area divided by cos(tilt). */
export const surfaceArea = (s) => polyArea(s.polygon) / Math.cos((s.tiltDeg || 0) * RAD);

// ─────────────────────────── DSM raster ───────────────────────────
/**
 * Rasterise surfaces + obstructions into a height grid.
 * Porous blockers (trees) go into a second, "soft" grid carrying their canopy
 * transmissivity, so a neem tree dims a panel rather than killing it.
 *
 * @returns {{w,h,cell,x0,y0,solid:Float32Array,soft:Float32Array,softT:Float32Array}}
 */
export function buildDSM(site, { cell = 0.5, margin = 25, maxCells = 900_000 } = {}) {
  const all = [
    ...(site.surfaces || []).map((s) => s.polygon),
    ...(site.obstructions || []).map((o) => o.polygon),
  ].filter((p) => p && p.length >= 3);
  if (!all.length) return null;

  const b = polyBounds(all.flat());
  const x0 = b.minX - margin, y0 = b.minY - margin;
  const spanX = b.maxX - b.minX + 2 * margin, spanY = b.maxY - b.minY + 2 * margin;

  // Coarsen rather than blow up memory on a big ground-mount site.
  let c = cell;
  while ((spanX / c) * (spanY / c) > maxCells) c *= 1.5;

  const w = Math.max(1, Math.ceil(spanX / c)), h = Math.max(1, Math.ceil(spanY / c));
  const solid = new Float32Array(w * h);
  const soft = new Float32Array(w * h);
  const softT = new Float32Array(w * h).fill(1);

  const stamp = (poly, heightAt, opacity) => {
    const pb = polyBounds(poly);
    const i0 = clamp(Math.floor((pb.minX - x0) / c), 0, w - 1), i1 = clamp(Math.ceil((pb.maxX - x0) / c), 0, w - 1);
    const j0 = clamp(Math.floor((pb.minY - y0) / c), 0, h - 1), j1 = clamp(Math.ceil((pb.maxY - y0) / c), 0, h - 1);
    for (let j = j0; j <= j1; j++) {
      const y = y0 + (j + 0.5) * c;
      for (let i = i0; i <= i1; i++) {
        const x = x0 + (i + 0.5) * c;
        if (!pointInPoly(x, y, poly)) continue;
        const z = heightAt(x, y);
        const k = j * w + i;
        if (opacity >= 0.999) { if (z > solid[k]) solid[k] = z; }
        else if (z > soft[k]) { soft[k] = z; softT[k] = 1 - opacity; }
      }
    }
  };

  for (const s of site.surfaces || []) {
    if (!s.polygon || s.polygon.length < 3) continue;
    s._centroid = polyCentroid(s.polygon);
    stamp(s.polygon, (x, y) => surfaceZ(s, x, y), 1);
  }
  for (const o of site.obstructions || []) {
    if (!o.polygon || o.polygon.length < 3) continue;
    const top = (o.base || 0) + (o.height || 0);
    stamp(o.polygon, () => top, o.opacity ?? 1);
  }
  return { w, h, cell: c, x0, y0, solid, soft, softT };
}

const sampleGrid = (g, arr, x, y, fallback = 0) => {
  const i = Math.floor((x - g.x0) / g.cell), j = Math.floor((y - g.y0) / g.cell);
  if (i < 0 || j < 0 || i >= g.w || j >= g.h) return fallback;
  return arr[j * g.w + i];
};

// ─────────────────────────── horizon profiles ───────────────────────────
/**
 * For every analysis point, the highest blocked sun elevation in each compass
 * bin. Marching steps grow geometrically — a parapet 1 m away matters far more
 * than a chimney 80 m away, and this puts the samples where the detail is.
 */
export function buildHorizons(dsm, points, { azBins = 72, maxDist = 150, growth = 1.14 } = {}) {
  const nP = points.length;
  const solidH = new Float32Array(nP * azBins);
  const softH = new Float32Array(nP * azBins);
  const softT = new Float32Array(nP * azBins).fill(1);

  // Precompute the march schedule and the per-bin unit direction once.
  const steps = [];
  for (let d = dsm.cell; d <= maxDist; d *= growth) steps.push(d);
  const dirs = new Float64Array(azBins * 2);
  for (let b = 0; b < azBins; b++) {
    const az = (b + 0.5) * (360 / azBins) * RAD;
    dirs[b * 2] = Math.sin(az); dirs[b * 2 + 1] = Math.cos(az);
  }

  for (let p = 0; p < nP; p++) {
    const { x, y, z } = points[p];
    for (let b = 0; b < azBins; b++) {
      const dx = dirs[b * 2], dy = dirs[b * 2 + 1];
      let maxSolid = 0, maxSoft = 0, tSoft = 1;
      for (let s = 0; s < steps.length; s++) {
        const d = steps[s];
        const sx = x + dx * d, sy = y + dy * d;
        const hs = sampleGrid(dsm, dsm.solid, sx, sy);
        if (hs > z) {
          const a = Math.atan2(hs - z, d);
          if (a > maxSolid) maxSolid = a;
        }
        const hf = sampleGrid(dsm, dsm.soft, sx, sy);
        if (hf > z) {
          const a = Math.atan2(hf - z, d);
          if (a > maxSoft) { maxSoft = a; tSoft = sampleGrid(dsm, dsm.softT, sx, sy, 1); }
        }
      }
      solidH[p * azBins + b] = maxSolid * DEG;
      softH[p * azBins + b] = maxSoft * DEG;
      softT[p * azBins + b] = tSoft;
    }
  }
  return { azBins, nP, solid: solidH, soft: softH, softT };
}

/** Sky-view factor from a horizon profile — the share of the sky dome a point can see. */
export function skyViewFactor(hz, p) {
  let s = 0;
  for (let b = 0; b < hz.azBins; b++) {
    const e = Math.max(hz.solid[p * hz.azBins + b], 0) * RAD;
    s += Math.cos(e) ** 2;                     // ∫ over a uniform (isotropic) sky
  }
  return s / hz.azBins;
}

/** Beam transmission 0..1 at a point for a given sun position. */
export function beamFactorAt(hz, p, sunAz, sunEl) {
  if (sunEl <= 0) return 0;
  const b = Math.floor((((sunAz % 360) + 360) % 360) / (360 / hz.azBins)) % hz.azBins;
  const k = p * hz.azBins + b;
  if (sunEl <= hz.solid[k]) return 0;
  if (sunEl <= hz.soft[k]) return hz.softT[k];
  return 1;
}

// ─────────────────────────── annual sweep ───────────────────────────
/**
 * Integrate clear-sky plane-of-array irradiance over a whole year at every
 * analysis point, once with shading and once without, and against an unshaded
 * reference panel at the site's optimal tilt/azimuth.
 *
 * @returns per-point annual kWh/m², shade-free % and performance-vs-optimal %.
 */
export function annualSweep({ hz, points, lat, lng, tzHours = IST, altitude = 0, dayStep = 8, minStep = 15, albedo = 0.2 }) {
  const nP = points.length;
  const poa = new Float64Array(nP);            // with shading
  const poaClear = new Float64Array(nP);       // same geometry, shading removed
  const beam = new Float64Array(nP);
  const beamClear = new Float64Array(nP);
  const svf = new Float64Array(nP);
  for (let p = 0; p < nP; p++) svf[p] = skyViewFactor(hz, p);

  // Cache each point's plane normal — tilt/azimuth are fixed per point.
  const nrm = points.map((pt) => planeNormal(pt.tilt ?? 0, pt.azi ?? 180));

  const refTilt = optimalTilt(lat), refAzi = optimalAzimuth(lat);
  const refN = planeNormal(refTilt, refAzi);
  let refPoa = 0;

  const dt = minStep / 60;                     // hours per step
  const year = 2001;                           // mean (non-leap) year
  let sampledDays = 0;

  for (let doy = 1; doy <= 365; doy += dayStep) {
    sampledDays++;
    const { month, day } = doyToDate(doy);
    const { declination, eqTime } = solarTerms(year, month, day, 720, tzHours);
    const t = sunTimes({ year, month, day, lat, lng, tzHours });
    if (t.sunrise == null) continue;           // polar night — not in India, but be safe
    const from = Math.floor(t.sunrise / minStep) * minStep;
    const to = Math.ceil(t.sunset / minStep) * minStep;

    for (let m = from; m <= to; m += minStep) {
      const s = sunPositionFromTerms(declination, eqTime, m, lat, lng, tzHours);
      if (s.elevation <= 0) continue;
      const sky = clearSky(s.elevation, altitude);
      const v = sunVector(s.azimuth, s.elevation);
      const bin = Math.floor((((s.azimuth % 360) + 360) % 360) / (360 / hz.azBins)) % hz.azBins;

      refPoa += poaIrradiance(sky, Math.max(0, v.x * refN.x + v.y * refN.y + v.z * refN.z), refTilt, { albedo }) * dt;

      for (let p = 0; p < nP; p++) {
        const n = nrm[p];
        const cosI = v.x * n.x + v.y * n.y + v.z * n.z;
        const k = p * hz.azBins + bin;
        const bf = s.elevation <= hz.solid[k] ? 0 : (s.elevation <= hz.soft[k] ? hz.softT[k] : 1);
        const tilt = points[p].tilt ?? 0;
        poa[p] += poaIrradiance(sky, cosI, tilt, { beamFactor: bf, skyViewFactor: svf[p], albedo }) * dt;
        poaClear[p] += poaIrradiance(sky, cosI, tilt, { beamFactor: 1, skyViewFactor: 1, albedo }) * dt;
        if (cosI > 0) { const e = sky.dni * cosI * dt; beam[p] += e * bf; beamClear[p] += e; }
      }
    }
  }

  // We integrated Wh/m² on `sampledDays` representative days spread evenly
  // through the year; scale that to all 365 and convert Wh → kWh.
  const k = (365 / sampledDays) / 1000;

  const out = { poa: new Float64Array(nP), poaClear: new Float64Array(nP), shadeFree: new Float64Array(nP), perf: new Float64Array(nP), svf };
  const refAnnual = refPoa * k;
  for (let p = 0; p < nP; p++) {
    out.poa[p] = poa[p] * k;
    out.poaClear[p] = poaClear[p] * k;
    out.shadeFree[p] = beamClear[p] > 0 ? (beam[p] / beamClear[p]) * 100 : 100;
    out.perf[p] = refAnnual > 0 ? (out.poa[p] / refAnnual) * 100 : 0;
  }
  out.refAnnualPOA = refAnnual;
  out.refTilt = refTilt;
  out.refAzi = refAzi;
  return out;
}

// ─────────────────────────── panel placement ───────────────────────────
export const PANEL_PRESETS = {
  '550': { w: 1.134, h: 2.278, wp: 550, label: '550 Wp bifacial mono PERC (2278×1134)' },
  '585': { w: 1.134, h: 2.382, wp: 585, label: '585 Wp TOPCon (2382×1134)' },
  '450': { w: 1.134, h: 2.094, wp: 450, label: '450 Wp mono PERC (2094×1134)' },
  '335': { w: 0.992, h: 1.956, wp: 335, label: '335 Wp poly (1956×992)' },
};

/**
 * Fill a surface with panels.
 *
 * Flat surfaces get tilt frames facing the equator, with the row pitch set by
 * the 09:00–15:00 winter-solstice rule. Pitched surfaces get flush-mounted
 * panels sharing the roof's own tilt and azimuth, laid out along the ridge.
 */
export function layoutPanels(surface, opts = {}) {
  const {
    panel = PANEL_PRESETS['550'], orientation = 'portrait', setback = 0.6,
    gapX = 0.02, gapY = 0.02, lat = 25, lng = 77, tzHours = IST,
    tiltDeg = null, frameHeight = 0.35, maxPanels = 4000,
  } = opts;

  const poly = surface.polygon;
  if (!poly || poly.length < 3) return [];
  const isFlat = (surface.tiltDeg || 0) < 5;

  // Panel footprint in the array's own frame: `across` runs along a row,
  // `slope` is the panel's dimension up the tilt.
  const across = orientation === 'portrait' ? panel.w : panel.h;
  const slope = orientation === 'portrait' ? panel.h : panel.w;

  const tilt = tiltDeg != null ? tiltDeg : (isFlat ? optimalTilt(lat) : surface.tiltDeg);
  const azi = isFlat ? optimalAzimuth(lat) : (surface.aziDeg ?? 180);

  // Plan-view spacing. A tilted panel occupies slope·cos(tilt) in plan; on a
  // flat roof the rows must additionally clear each other's winter shadow.
  const planDepth = isFlat ? slope * Math.cos(tilt * RAD) : slope;
  const pitch = isFlat
    ? Math.max(rowPitch({ lat, lng, tiltDeg: tilt, panelDepthM: slope, tzHours, aziDeg: azi }), planDepth + 0.3)
    : planDepth + gapY;

  // Row direction (across) and column direction (down-slope), in plan.
  const a = azi * RAD;
  const ux = Math.cos(a), uy = -Math.sin(a);       // along the row
  const vx = Math.sin(a), vy = Math.cos(a);        // down-slope / away from the sun

  const [cx, cy] = surface._centroid || polyCentroid(poly);
  const b = polyBounds(poly);
  const reach = Math.hypot(b.maxX - b.minX, b.maxY - b.minY);
  const nU = Math.ceil(reach / (across + gapX)) + 2;
  const nV = Math.ceil(reach / pitch) + 2;

  const panels = [];
  for (let iv = -nV; iv <= nV && panels.length < maxPanels; iv++) {
    for (let iu = -nU; iu <= nU && panels.length < maxPanels; iu++) {
      const du = iu * (across + gapX), dv = iv * pitch;
      const px = cx + ux * du + vx * dv, py = cy + uy * du + vy * dv;

      // Every corner of the plan footprint must clear the setback line.
      const hu = across / 2, hv = planDepth / 2;
      let ok = true;
      for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const qx = px + ux * hu * su + vx * hv * sv;
        const qy = py + uy * hu * su + vy * hv * sv;
        if (distToEdge(qx, qy, poly) < setback) { ok = false; break; }
      }
      if (!ok) continue;

      const zBase = surfaceZ(surface, px, py) + (isFlat ? frameHeight : 0.12);
      panels.push({
        id: `${surface.id}-${iu}_${iv}`, surfaceId: surface.id,
        x: px, y: py, z: zBase, row: iv, col: iu,
        tilt, azi, w: across, d: slope, planDepth, wp: panel.wp,
      });
    }
  }
  // Stable, human order: rows front (south) to back, left to right.
  panels.sort((p, q) => p.row - q.row || p.col - q.col);
  return panels.map((p, i) => ({ ...p, index: i + 1 }));
}

/** The four 3D corners of a panel, for rendering and for footprint sampling. */
export function panelCorners(p) {
  const a = p.azi * RAD, t = p.tilt * RAD;
  const ux = Math.cos(a), uy = -Math.sin(a);
  const vx = Math.sin(a) * Math.cos(t), vy = Math.cos(a) * Math.cos(t), vz = -Math.sin(t);
  const hu = p.w / 2, hv = p.d / 2;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sv]) => [
    p.x + ux * hu * su + vx * hv * sv,
    p.y + uy * hu * su + vy * hv * sv,
    p.z + vz * hv * sv,
  ]);
}

/**
 * Analysis points for a panel: its centre plus the four quadrant centres, so a
 * shadow creeping across one corner is caught instead of averaged away — which
 * matters, because a single shaded cell drags a whole series string down.
 */
export function panelSamplePoints(p) {
  const a = p.azi * RAD, t = p.tilt * RAD;
  const ux = Math.cos(a), uy = -Math.sin(a);
  const vx = Math.sin(a) * Math.cos(t), vy = Math.cos(a) * Math.cos(t), vz = -Math.sin(t);
  const offs = [[0, 0], [-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
  return offs.map(([su, sv]) => ({
    x: p.x + ux * p.w * su + vx * p.d * sv,
    y: p.y + uy * p.w * su + vy * p.d * sv,
    z: p.z + vz * p.d * sv,
    tilt: p.tilt, azi: p.azi,
  }));
}

// ─────────────────────────── full run ───────────────────────────
/**
 * End-to-end: build the DSM, lay out panels, profile every panel's horizon,
 * sweep the year, and hand back per-panel yield and efficiency plus a roof
 * heat-map grid for the 3D view.
 */
export function analyseSite(site, opts = {}) {
  const {
    cell = 0.5, azBins = 72, maxDist = 150, dayStep = 8, minStep = 15,
    performanceRatio = 0.80, albedo = 0.2, heatmapMaxCells = 2600,
    panel = PANEL_PRESETS['550'], orientation = 'portrait', setback = 0.6,
    tiltDeg = null, frameHeight = 0.35, tzHours = IST,
    // Optional: the state's specific yield (kWh/kWp/yr) from the solar rate
    // book. The clear-sky model has no clouds, aerosol or soiling in it, so on
    // its own it overstates absolute output. Passing the rate-book figure
    // rescales every energy number so this module and the quotation engine
    // agree, while the shading *ratios* — which is what the model is actually
    // good at — come through untouched.
    //
    // Note the convention: engine.js computes annual kWh as
    // `kWp × specific_yield × PR`, so the rate book's specific_yield is the
    // figure BEFORE the performance ratio. The delivered yield we calibrate to
    // is therefore specificYieldRef × performanceRatio, not specificYieldRef.
    specificYieldRef = null,
  } = opts;

  const lat = site.lat, lng = site.lng, altitude = site.altitude || 0;
  const dsm = buildDSM(site, { cell });
  if (!dsm) return null;

  for (const s of site.surfaces || []) s._centroid = polyCentroid(s.polygon);

  // 1. Lay panels out on every enabled surface.
  const panels = [];
  for (const s of site.surfaces || []) {
    if (s.enabled === false || !s.polygon || s.polygon.length < 3) continue;
    panels.push(...layoutPanels(s, { panel, orientation, setback, lat, lng, tzHours, tiltDeg, frameHeight }));
  }

  // 2. Heat-map grid over the surfaces (coarsened to keep the sweep snappy).
  const surfArea = (site.surfaces || []).reduce((a, s) => a + polyArea(s.polygon || []), 0);
  const gridCell = Math.max(cell, Math.sqrt(Math.max(surfArea, 1) / heatmapMaxCells));
  const gridPts = [];
  for (const s of site.surfaces || []) {
    if (!s.polygon || s.polygon.length < 3) continue;
    const b = polyBounds(s.polygon);
    for (let y = b.minY + gridCell / 2; y <= b.maxY; y += gridCell) {
      for (let x = b.minX + gridCell / 2; x <= b.maxX; x += gridCell) {
        if (!pointInPoly(x, y, s.polygon)) continue;
        const isFlat = (s.tiltDeg || 0) < 5;
        gridPts.push({
          x, y, z: surfaceZ(s, x, y) + (isFlat ? frameHeight : 0.12),
          tilt: tiltDeg != null ? tiltDeg : (isFlat ? optimalTilt(lat) : s.tiltDeg),
          azi: isFlat ? optimalAzimuth(lat) : (s.aziDeg ?? 180),
          surfaceId: s.id,
        });
      }
    }
  }

  // 3. One horizon profile per analysis point — panels first, then the grid, so
  //    both share a single ray-march pass over the DSM.
  const panelPts = panels.flatMap(panelSamplePoints);
  const allPts = [...panelPts, ...gridPts];
  const hz = buildHorizons(dsm, allPts, { azBins, maxDist });

  // 4. Sweep the year.
  const res = annualSweep({ hz, points: allPts, lat, lng, tzHours, altitude, dayStep, minStep, albedo });

  // 5. Fold the 5 samples per panel back into one number each.
  //    Calibration: pin the model's unshaded-optimal delivered yield to the one
  //    the quotation engine would report for the same kWp in this state.
  const modelSpecific = res.refAnnualPOA * performanceRatio;                    // kWh/kWp/yr delivered
  const targetSpecific = specificYieldRef > 0 ? specificYieldRef * performanceRatio : 0;
  const calib = targetSpecific > 0 && modelSpecific > 0 ? targetSpecific / modelSpecific : 1;

  const SPP = 5;
  const panelOut = panels.map((p, i) => {
    let poa = 0, shade = 0, perf = 0, worst = 100;
    for (let k = 0; k < SPP; k++) {
      const idx = i * SPP + k;
      poa += res.poa[idx]; shade += res.shadeFree[idx]; perf += res.perf[idx];
      worst = Math.min(worst, res.shadeFree[idx]);
    }
    poa /= SPP; shade /= SPP; perf /= SPP;
    const kwh = (p.wp / 1000) * poa * performanceRatio * calib;
    return { ...p, poa, shadeFreePct: shade, worstCellShadeFreePct: worst, perfPct: perf, kwhYear: kwh };
  });

  const heat = gridPts.map((g, i) => {
    const idx = panelPts.length + i;
    return { x: g.x, y: g.y, z: g.z, shadeFreePct: res.shadeFree[idx], perfPct: res.perf[idx], poa: res.poa[idx] };
  });

  // 6. Roll up.
  const kWp = panelOut.reduce((a, p) => a + p.wp, 0) / 1000;
  const kwhYear = panelOut.reduce((a, p) => a + p.kwhYear, 0);
  const meanPerf = panelOut.length ? panelOut.reduce((a, p) => a + p.perfPct, 0) / panelOut.length : 0;
  const meanShade = panelOut.length ? panelOut.reduce((a, p) => a + p.shadeFreePct, 0) / panelOut.length : 0;
  // What this same array would make if nothing shaded it and every panel sat at
  // the site's optimal tilt/azimuth — the yardstick perfPct is measured against.
  const refKwh = kWp * modelSpecific * calib;

  return {
    dsm, panels: panelOut, heat, grid: { cell: gridCell },
    reference: {
      annualPOA: res.refAnnualPOA, tilt: res.refTilt, azimuth: res.refAzi,
      kwhYear: refKwh, specificYield: modelSpecific * calib, calibrated: calib !== 1,
    },
    summary: {
      panelCount: panelOut.length, kWp, kwhYear,
      specificYield: kWp > 0 ? kwhYear / kWp : 0,
      meanPerfPct: meanPerf, meanShadeFreePct: meanShade,
      shadeLossPct: refKwh > 0 ? Math.max(0, (1 - kwhYear / refKwh) * 100) : 0,
      usableAreaSqm: panelOut.reduce((a, p) => a + p.w * p.d, 0),
      usableAreaSqft: panelOut.reduce((a, p) => a + p.w * p.d, 0) * 10.7639,
      roofAreaSqm: (site.surfaces || []).reduce((a, s) => a + surfaceArea({ ...s, _centroid: s._centroid }), 0),
      performanceRatio,
    },
  };
}

/** Instantaneous shaded-fraction of the array — drives the live 3D readout. */
export function shadingNow(analysis, sunAz, sunEl) {
  if (!analysis?.panels?.length) return { shadedPct: 0, litPct: 100, litPanels: 0 };
  const { dsm } = analysis;
  let lit = 0;
  for (const p of analysis.panels) {
    if (sunEl <= 0) continue;
    if (!isPointShaded(dsm, p.x, p.y, p.z, sunAz, sunEl)) lit++;
  }
  const n = analysis.panels.length;
  return { shadedPct: ((n - lit) / n) * 100, litPct: (lit / n) * 100, litPanels: lit, total: n };
}

/** Single ray-march against the DSM — used for the live "shaded right now" check. */
export function isPointShaded(dsm, x, y, z, sunAz, sunEl, maxDist = 150) {
  if (sunEl <= 0) return true;
  const a = sunAz * RAD, tanEl = Math.tan(sunEl * RAD);
  const dx = Math.sin(a), dy = Math.cos(a);
  for (let d = dsm.cell; d <= maxDist; d *= 1.14) {
    const hs = sampleGrid(dsm, dsm.solid, x + dx * d, y + dy * d);
    if (hs > z + d * tanEl) return true;
  }
  return false;
}

/** Green → amber → red ramp for an efficiency percentage. */
export function perfColor(pct) {
  const p = clamp(pct, 0, 100);
  if (p >= 95) return '#15803d';
  if (p >= 90) return '#22c55e';
  if (p >= 82) return '#84cc16';
  if (p >= 72) return '#eab308';
  if (p >= 60) return '#f97316';
  if (p >= 45) return '#ef4444';
  return '#991b1b';
}

export const OBSTRUCTION_KINDS = [
  { v: 'parapet', label: 'Parapet wall', h: 1.0, opacity: 1 },
  { v: 'tank', label: 'Water tank', h: 2.5, opacity: 1 },
  { v: 'stair', label: 'Stair / lift room', h: 3.0, opacity: 1 },
  { v: 'chimney', label: 'Chimney / vent', h: 2.0, opacity: 1 },
  { v: 'ac', label: 'AC / DX unit', h: 1.2, opacity: 1 },
  { v: 'pole', label: 'Pole / mast / DG stack', h: 6.0, opacity: 1 },
  { v: 'tree', label: 'Tree (porous canopy)', h: 8.0, opacity: 0.75 },
  { v: 'building', label: 'Adjacent building', h: 12.0, opacity: 1 },
];
