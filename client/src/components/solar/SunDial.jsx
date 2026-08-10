// Sun dial — the primary "move the sun around" control.
//
// A polar sky chart looking straight up: centre = zenith, rim = horizon, north
// at the top. Drag the sun anywhere on it and the shadows follow.
//
// Why this and not just the sun in the 3D scene: OrbitControls always aims the
// camera AT the site, so the sun spends most of the day outside the frustum —
// often directly behind the viewer. A dial is on screen at every camera angle
// and on a phone. (The 3D sun stays grabbable when it does happen to be in
// view; this is the control that always works.)
//
// Dragging can only ever land on a sun position the site actually gets: the
// pointer is snapped to the nearest entry in a precomputed table of real
// (day, minute) → (azimuth, elevation) samples. You cannot drag the sun
// somewhere it never goes — which matters, because the whole point is to show
// the client a shadow that will really happen.
import { useMemo, useRef, useCallback } from 'react';
import { solarTerms, sunPositionFromTerms, doyToDate, fmtClock, IST } from '../../lib/solar/sun';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** Polar projection: elevation → radius (equidistant), azimuth → bearing. */
const project = (az, el, cx, cy, R) => {
  const r = R * (1 - Math.max(el, 0) / 90);
  return [cx + r * Math.sin(az * RAD), cy - r * Math.cos(az * RAD)];
};

function buildArc(lat, lng, month, day, stepMin = 8) {
  const { declination, eqTime } = solarTerms(2001, month, day, 720, IST);
  const out = [];
  for (let m = 0; m <= 1440; m += stepMin) {
    const p = sunPositionFromTerms(declination, eqTime, m, lat, lng, IST);
    if (p.elevation > 0) out.push(p);
  }
  return out;
}

export default function SunDial({ lat, lng, doy, minutes, onChange, size = 176, className = '' }) {
  const svgRef = useRef(null);
  const dragging = useRef(false);
  const R = size / 2 - 16;
  const cx = size / 2, cy = size / 2;

  // Every sun position this site actually sees, on a 3-day × 10-minute grid.
  // ~10k rows, built once per location — a drag is then a plain nearest search.
  const table = useMemo(() => {
    const rows = [];
    for (let d = 1; d <= 365; d += 3) {
      const { month, day } = doyToDate(d);
      const { declination, eqTime } = solarTerms(2001, month, day, 720, IST);
      for (let m = 0; m < 1440; m += 10) {
        const p = sunPositionFromTerms(declination, eqTime, m, lat, lng, IST);
        if (p.elevation > 0.5) rows.push([d, m, p.azimuth, p.elevation]);
      }
    }
    return rows;
  }, [lat, lng]);

  const arcs = useMemo(() => ([
    { pts: buildArc(lat, lng, 6, 21), color: '#f59e0b', label: '21 Jun' },
    { pts: buildArc(lat, lng, 3, 21), color: '#60a5fa', label: '21 Mar / 23 Sep' },
    { pts: buildArc(lat, lng, 12, 21), color: '#ef4444', label: '21 Dec' },
  ]), [lat, lng]);

  const { month, day } = doyToDate(doy);
  const today = useMemo(() => buildArc(lat, lng, month, day, 6), [lat, lng, month, day]);
  const now = useMemo(() => {
    const { declination, eqTime } = solarTerms(2001, month, day, 720, IST);
    return sunPositionFromTerms(declination, eqTime, minutes, lat, lng, IST);
  }, [month, day, minutes, lat, lng]);

  const pick = useCallback((clientX, clientY) => {
    const r = svgRef.current.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * size;
    const py = ((clientY - r.top) / r.height) * size;
    const dx = px - cx, dy = py - cy;
    const rad = Math.min(Math.hypot(dx, dy), R);
    const el = 90 * (1 - rad / R);
    const az = (Math.atan2(dx, -dy) * DEG + 360) % 360;

    // Nearest real sun position. Azimuth error is scaled by cos(elevation):
    // near the zenith a huge azimuth swing is a tiny move on the dial.
    let best = null, bestD = Infinity;
    const k = Math.cos(Math.min(el, 89) * RAD);
    for (let i = 0; i < table.length; i++) {
      const t = table[i];
      let da = Math.abs(t[2] - az); if (da > 180) da = 360 - da;
      const de = t[3] - el;
      const d = (da * k) ** 2 + de * de;
      if (d < bestD) { bestD = d; best = t; }
    }
    if (best) onChange?.({ doy: best[0], minutes: best[1] });
  }, [table, onChange, cx, cy, R, size]);

  const onDown = (e) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pick(e.clientX, e.clientY);
  };
  const onMove = (e) => { if (dragging.current) pick(e.clientX, e.clientY); };
  const onUp = (e) => { dragging.current = false; e.currentTarget.releasePointerCapture?.(e.pointerId); };

  const path = (pts) => pts.map((p, i) => {
    const [x, y] = project(p.azimuth, p.elevation, cx, cy, R);
    return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');

  const [sx, sy] = project(now.azimuth, now.elevation, cx, cy, R);
  const up = now.elevation > 0;

  return (
    <div className={className}>
      <svg
        ref={svgRef} width={size} height={size} viewBox={`0 0 ${size} ${size}`}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        style={{ touchAction: 'none', cursor: 'crosshair' }}
        role="slider" aria-label="Sun position — drag to change time of day and date"
        aria-valuetext={`${fmtClock(minutes)} on ${day}/${month}, sun ${now.elevation.toFixed(0)} degrees above the horizon`}
      >
        <defs>
          <radialGradient id="skyfill">
            <stop offset="0%" stopColor="#1e40af" stopOpacity="0.30" />
            <stop offset="100%" stopColor="#93c5fd" stopOpacity="0.22" />
          </radialGradient>
        </defs>

        <circle cx={cx} cy={cy} r={R} fill="url(#skyfill)" stroke="#94a3b8" strokeWidth="1" />
        {/* Elevation rings every 30° */}
        {[30, 60].map((el) => (
          <circle key={el} cx={cx} cy={cy} r={R * (1 - el / 90)} fill="none" stroke="#94a3b8" strokeWidth="0.5" strokeDasharray="2 3" />
        ))}
        {/* Compass spokes */}
        {[0, 90, 180, 270].map((az) => {
          const [x, y] = project(az, 0, cx, cy, R);
          return <line key={az} x1={cx} y1={cy} x2={x} y2={y} stroke="#94a3b8" strokeWidth="0.5" strokeDasharray="2 3" />;
        })}
        {[['N', 0], ['E', 90], ['S', 180], ['W', 270]].map(([t, az]) => {
          const [x, y] = project(az, -9, cx, cy, R);
          return (
            <text key={t} x={x} y={y} textAnchor="middle" dominantBaseline="middle"
              fontSize="10" fontWeight="700" fill={t === 'S' ? '#dc2626' : '#475569'}>{t}</text>
          );
        })}

        {/* Solstice + equinox arcs, then today's path on top */}
        {arcs.map((a) => (
          <path key={a.label} d={path(a.pts)} fill="none" stroke={a.color} strokeWidth="1.4" opacity="0.75">
            <title>{a.label}</title>
          </path>
        ))}
        <path d={path(today)} fill="none" stroke="#0f172a" strokeWidth="2" strokeDasharray="3 2" opacity="0.85" />

        {/* The sun */}
        {up && <circle cx={sx} cy={sy} r="11" fill="#fbbf24" opacity="0.3" />}
        <circle cx={sx} cy={sy} r="6" fill={up ? '#f59e0b' : '#64748b'} stroke="#fff" strokeWidth="1.8" />
        <circle cx={cx} cy={cy} r="1.6" fill="#475569" />
      </svg>
      <div className="text-[9px] text-gray-500 text-center leading-tight mt-0.5">
        Drag the sun · centre = overhead, rim = horizon
      </div>
    </div>
  );
}
