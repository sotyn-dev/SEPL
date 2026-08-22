// Solar geometry + clear-sky irradiance. Pure functions, no DOM, no globals —
// the same contract as engine.js so the 3D viewer, the shadow analyser and the
// quotation engine all read one source of truth for where the sun is.
//
// Sun position is the NOAA Solar Position Algorithm (the one behind NOAA's
// solar calculator spreadsheet), accurate to ~0.01° for our latitudes — far
// tighter than anything shading analysis needs. Irradiance is the Meinel &
// Meinel clear-sky model over Kasten–Young air mass: we only ever use it as a
// *weight* (which hours of the year matter more), so an absolute-value error of
// a few percent cancels out of the shade-free / performance ratios we report.

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const mod360 = (v) => ((v % 360) + 360) % 360;

// India runs a single fixed offset — no DST anywhere in the country.
export const IST = 5.5;

// ── Julian day at 00:00 UT of a civil Y/M/D (Fliegel–Van Flandern) ──
export function julianDay(y, m, d) {
  let yy = y, mm = m;
  if (mm <= 2) { yy -= 1; mm += 12; }
  const A = Math.floor(yy / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (yy + 4716)) + Math.floor(30.6001 * (mm + 1)) + d + B - 1524.5;
}

// Day-of-year → { month, day } for a non-leap year (analysis uses a mean year).
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export function doyToDate(doy) {
  let d = clamp(Math.round(doy), 1, 365), m = 0;
  while (d > MONTH_DAYS[m]) { d -= MONTH_DAYS[m]; m++; }
  return { month: m + 1, day: d };
}
export function dateToDoy(month, day) {
  let n = day;
  for (let i = 0; i < month - 1; i++) n += MONTH_DAYS[i];
  return n;
}

// ── Earth–sun orbital terms shared by position, declination and equation of
//    time. Split out because the annual integration recomputes position ~700×
//    per run and these terms only change with the date, not the minute. ──
export function solarTerms(year, month, day, minutes, tzHours) {
  const jd = julianDay(year, month, day) + minutes / 1440 - tzHours / 24;
  const T = (jd - 2451545.0) / 36525;

  const L0 = mod360(280.46646 + T * (36000.76983 + T * 0.0003032));
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T))
          + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T)
          + Math.sin(3 * M * RAD) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const meanObliq = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const obliqCorr = meanObliq + 0.00256 * Math.cos(omega * RAD);

  const declination = Math.asin(Math.sin(obliqCorr * RAD) * Math.sin(appLong * RAD)) * DEG;

  const varY = Math.tan(obliqCorr / 2 * RAD) ** 2;
  const eqTime = 4 * DEG * (
    varY * Math.sin(2 * L0 * RAD)
    - 2 * e * Math.sin(M * RAD)
    + 4 * e * varY * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD)
    - 0.5 * varY * varY * Math.sin(4 * L0 * RAD)
    - 1.25 * e * e * Math.sin(2 * M * RAD)
  );

  return { declination, eqTime, jd, T };
}

// Atmospheric refraction (NOAA piecewise fit), arcseconds → degrees. Matters at
// the horizon, where a low winter sun is exactly what casts the long shadows.
function refraction(elevDeg) {
  if (elevDeg > 85) return 0;
  const te = Math.tan(elevDeg * RAD);
  let r;
  if (elevDeg > 5) r = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  else if (elevDeg > -0.575) r = 1735 + elevDeg * (-518.2 + elevDeg * (103.4 + elevDeg * (-12.79 + elevDeg * 0.711)));
  else r = -20.772 / te;
  return r / 3600;
}

/**
 * Sun position for a local civil date/time.
 * @returns {{azimuth:number, elevation:number, zenith:number, declination:number, eqTime:number}}
 *          azimuth in degrees clockwise from true north, elevation above the
 *          horizon (refraction-corrected, so it can be slightly > 0 at sunset).
 */
export function sunPosition({ year, month, day, minutes, lat, lng, tzHours = IST }) {
  const { declination, eqTime } = solarTerms(year, month, day, minutes, tzHours);
  return sunPositionFromTerms(declination, eqTime, minutes, lat, lng, tzHours);
}

// Same, but reusing already-computed daily terms (hot path of the annual sweep).
export function sunPositionFromTerms(declination, eqTime, minutes, lat, lng, tzHours) {
  const tst = ((minutes + eqTime + 4 * lng - 60 * tzHours) % 1440 + 1440) % 1440;
  const ha = tst / 4 < 0 ? tst / 4 + 180 : tst / 4 - 180;

  const latR = lat * RAD, decR = declination * RAD, haR = ha * RAD;
  const cosZ = clamp(Math.sin(latR) * Math.sin(decR) + Math.cos(latR) * Math.cos(decR) * Math.cos(haR), -1, 1);
  const zenith = Math.acos(cosZ) * DEG;
  const elevRaw = 90 - zenith;
  const elevation = elevRaw + refraction(elevRaw);

  const sinZ = Math.sin(zenith * RAD);
  let azimuth;
  if (Math.abs(sinZ) < 1e-9 || Math.abs(Math.cos(latR)) < 1e-9) {
    azimuth = declination > lat ? 0 : 180;          // sun overhead / at a pole
  } else {
    const cosAz = clamp((Math.sin(latR) * cosZ - Math.sin(decR)) / (Math.cos(latR) * sinZ), -1, 1);
    const az = Math.acos(cosAz) * DEG;
    azimuth = ha > 0 ? mod360(az + 180) : mod360(540 - az);
  }
  return { azimuth, elevation, zenith, declination, eqTime, hourAngle: ha };
}

/** Sunrise / solar noon / sunset in local minutes past midnight. */
export function sunTimes({ year, month, day, lat, lng, tzHours = IST }) {
  const { declination, eqTime } = solarTerms(year, month, day, 720, tzHours);
  const latR = lat * RAD, decR = declination * RAD;
  const noon = 720 - 4 * lng - eqTime + tzHours * 60;
  // 90.833° = geometric zenith + refraction + solar semi-diameter.
  const cosHa = Math.cos(90.833 * RAD) / (Math.cos(latR) * Math.cos(decR)) - Math.tan(latR) * Math.tan(decR);
  if (cosHa > 1) return { noon, sunrise: null, sunset: null, polar: 'night', declination };
  if (cosHa < -1) return { noon, sunrise: 0, sunset: 1440, polar: 'day', declination };
  const ha = Math.acos(cosHa) * DEG;
  return { noon, sunrise: noon - ha * 4, sunset: noon + ha * 4, polar: null, declination };
}

/**
 * Unit vector to the sun in local ENU metres — the same frame the site model
 * uses: +x East, +y North, +z up.
 */
export function sunVector(azimuthDeg, elevationDeg) {
  const el = elevationDeg * RAD, az = azimuthDeg * RAD;
  const c = Math.cos(el);
  return { x: c * Math.sin(az), y: c * Math.cos(az), z: Math.sin(el) };
}

/**
 * Clear-sky beam / diffuse / global on the horizontal, W/m².
 * Meinel & Meinel over Kasten–Young air mass, with a site-elevation correction.
 * Returns zeros below the horizon.
 */
export function clearSky(elevationDeg, siteAltitudeM = 0) {
  if (elevationDeg <= 0) return { dni: 0, dhi: 0, ghi: 0, airMass: Infinity };
  const z = 90 - elevationDeg;
  const airMass = 1 / (Math.cos(z * RAD) + 0.50572 * Math.pow(96.07995 - z, -1.6364));
  // Pressure-corrected air mass — thinner column at Himachal / Ladakh altitudes.
  const amCorr = airMass * Math.exp(-siteAltitudeM / 8434);
  const dni = 1353 * Math.pow(0.7, Math.pow(amCorr, 0.678));
  const cosZ = Math.cos(z * RAD);
  const dhi = 0.10 * dni * cosZ;         // Meinel diffuse fraction
  return { dni, dhi, ghi: dni * cosZ + dhi, airMass };
}

/**
 * Cosine of the angle of incidence between the sun and a tilted plane.
 * @param tiltDeg    plane tilt from horizontal (0 = flat)
 * @param aziDeg     plane azimuth, degrees clockwise from true north (180 = due south)
 */
export function cosAOI(sunAzDeg, sunElDeg, tiltDeg, aziDeg) {
  const s = sunVector(sunAzDeg, sunElDeg);
  const n = planeNormal(tiltDeg, aziDeg);
  return s.x * n.x + s.y * n.y + s.z * n.z;
}

/** Outward normal of a tilted plane in the same ENU frame. */
export function planeNormal(tiltDeg, aziDeg) {
  const t = tiltDeg * RAD, a = aziDeg * RAD;
  const st = Math.sin(t);
  return { x: st * Math.sin(a), y: st * Math.cos(a), z: Math.cos(t) };
}

/**
 * Plane-of-array irradiance, W/m². `beamFactor` is 0 when the point is shaded
 * and 1 when it sees the sun — that single switch is what shading analysis
 * ultimately turns into money.
 */
export function poaIrradiance({ dni, dhi, ghi }, cosInc, tiltDeg, { beamFactor = 1, skyViewFactor = 1, albedo = 0.2 } = {}) {
  const t = tiltDeg * RAD;
  const beam = cosInc > 0 ? dni * cosInc * beamFactor : 0;
  const sky = dhi * ((1 + Math.cos(t)) / 2) * skyViewFactor;
  const ground = ghi * albedo * ((1 - Math.cos(t)) / 2);
  return beam + sky + ground;
}

/**
 * Optimal fixed tilt for a site — the classic latitude rule, damped at high
 * latitude and floored so panels still self-clean in the monsoon. Azimuth is
 * true south in the northern hemisphere.
 */
export function optimalTilt(lat) {
  const a = Math.abs(lat);
  const t = a < 25 ? a * 0.87 : a < 50 ? a * 0.76 + 3.1 : a * 0.5 + 16.3;
  return Math.round(clamp(t, 10, 40));
}
export const optimalAzimuth = (lat) => (lat >= 0 ? 180 : 0);

/**
 * Minimum row-to-row pitch so a row never shades the one behind it between
 * 09:00 and 15:00 on the winter solstice — the design rule every Indian EPC
 * quotes. Returns metres, centre-of-row to centre-of-row.
 */
export function rowPitch({ lat, lng, tiltDeg, panelDepthM, tzHours = IST, aziDeg = 180 }) {
  const { month, day } = doyToDate(dateToDoy(12, 21));
  const year = 2001;                                   // any non-leap year
  const { declination, eqTime } = solarTerms(year, month, day, 540, tzHours);
  const { noon } = sunTimes({ year, month, day, lat, lng, tzHours });
  // Worst case of the 09:00–15:00 window is its edges; take 3 h from solar noon.
  const s = sunPositionFromTerms(declination, eqTime, noon - 180, lat, lng, tzHours);
  const el = Math.max(s.elevation, 8) * RAD;           // floor: don't design to infinity
  const t = tiltDeg * RAD;
  const h = panelDepthM * Math.sin(t);                 // vertical rise of the row
  // Shadow length projected onto the row-normal direction.
  const azDiff = Math.abs(((s.azimuth - aziDeg + 540) % 360) - 180) * RAD;
  const shadow = (h / Math.tan(el)) * Math.abs(Math.cos(azDiff));
  return panelDepthM * Math.cos(t) + shadow;
}

/**
 * Sun-path arc for one day — for drawing the analemma ribbons on the sky dome.
 * @returns array of { minutes, azimuth, elevation } at `stepMin` resolution,
 *          daylight only.
 */
export function sunPath({ month, day, lat, lng, tzHours = IST, stepMin = 10, year = 2001 }) {
  const { declination, eqTime } = solarTerms(year, month, day, 720, tzHours);
  const out = [];
  for (let m = 0; m <= 1440; m += stepMin) {
    const p = sunPositionFromTerms(declination, eqTime, m, lat, lng, tzHours);
    if (p.elevation > -0.5) out.push({ minutes: m, azimuth: p.azimuth, elevation: p.elevation });
  }
  return out;
}

export const fmtClock = (minutes) => {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

export const COMPASS = (az) => {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round(mod360(az) / 22.5) % 16];
};
