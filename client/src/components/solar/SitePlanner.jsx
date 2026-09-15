// Satellite tracing surface: click out the roof outline and every obstruction
// that will throw a shadow on it. Pure Leaflet (no react-leaflet) to match
// TeamMap/RouteMap and stay React-19 safe.
//
// Everything is stored in local ENU metres relative to the site pin — the same
// frame the analyser and the 3D view use — so lat/lng only ever exists at this
// boundary.
import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { FiCrosshair, FiTrash2, FiCornerUpLeft, FiCheck } from 'react-icons/fi';
import { BASEMAPS } from '../../lib/solar/basemap';
import { makeProjection, polyArea, polyCentroid } from '../../lib/solar/shadow';

const SURFACE_STYLE = { color: '#f8fafc', weight: 2, fillColor: '#38bdf8', fillOpacity: 0.28 };
const SURFACE_OFF = { color: '#94a3b8', weight: 1.5, dashArray: '5,5', fillColor: '#64748b', fillOpacity: 0.15 };
const OBS_STYLE = { color: '#fbbf24', weight: 2, fillColor: '#f59e0b', fillOpacity: 0.38 };
const DRAFT_STYLE = { color: '#22d3ee', weight: 2, dashArray: '6,4', fillColor: '#22d3ee', fillOpacity: 0.18 };

export default function SitePlanner({
  lat, lng, site, drawMode, onFinishPolygon, onCancelDraw,
  onSelect, selectedId, onMoveCenter,
}) {
  const hostRef = useRef(null);
  const M = useRef({});
  const [draft, setDraft] = useState([]);          // lat/lng vertices in progress
  // Leaflet's handlers are bound once at map creation, so the live draft, the
  // current draw mode and the callbacks all reach them through refs.
  const draftRef = useRef(draft);
  const modeRef = useRef(drawMode);
  const cbRef = useRef({ onFinishPolygon, onSelect, onMoveCenter });
  useEffect(() => {
    draftRef.current = draft;
    modeRef.current = drawMode;
    cbRef.current = { onFinishPolygon, onSelect, onMoveCenter };
  });

  // ── map setup ────────────────────────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host || M.current.map) return undefined;

    const map = L.map(host, { center: [lat, lng], zoom: 19, maxZoom: 22, zoomControl: true, attributionControl: true });
    L.tileLayer(BASEMAPS.esri.url, { maxZoom: 22, maxNativeZoom: 19, attribution: BASEMAPS.esri.attribution }).addTo(map);
    L.tileLayer(BASEMAPS.esriLabels.url, { maxZoom: 22, maxNativeZoom: 19, opacity: 0.85 }).addTo(map);

    const pin = L.circleMarker([lat, lng], { radius: 6, color: '#fff', weight: 2, fillColor: '#ef4444', fillOpacity: 1 })
      .addTo(map).bindTooltip('Site origin — all heights are measured from here', { direction: 'top' });

    const shapes = L.layerGroup().addTo(map);
    const drawing = L.layerGroup().addTo(map);

    map.on('click', (e) => {
      if (modeRef.current) { setDraft((p) => [...p, [e.latlng.lat, e.latlng.lng]]); return; }
      cbRef.current.onMoveCenter?.(e.latlng.lat, e.latlng.lng);   // plain click re-pins the site outside tracing
    });
    map.on('contextmenu', (e) => {
      L.DomEvent.preventDefault(e);
      if (modeRef.current) { setDraft((p) => p.slice(0, -1)); return; }
      cbRef.current.onMoveCenter?.(e.latlng.lat, e.latlng.lng);   // right-click also re-pins (kept for muscle memory)
    });
    map.on('dblclick', (e) => {
      if (!modeRef.current) return;
      L.DomEvent.preventDefault(e);
      finish();
    });

    const finish = () => {
      const pts = draftRef.current;
      if (pts.length < 3) return;
      const proj = makeProjection(M.current.lat, M.current.lng);
      cbRef.current.onFinishPolygon?.(pts.map(([a, b]) => proj.toLocal(a, b)));
      setDraft([]);
    };

    M.current = { map, shapes, drawing, pin, lat, lng, finish };
    // Cleared on unmount — React StrictMode's dev-only mount→cleanup→mount
    // double-invoke otherwise lets this fire 60ms later on a map instance
    // the cleanup already called .remove() on, throwing deep inside Leaflet
    // (reading '_leaflet_pos' on a DOM node that no longer exists).
    const invalidateTimer = setTimeout(() => map.invalidateSize(), 60);

    return () => { clearTimeout(invalidateTimer); map.remove(); M.current = {}; };
  }, []);          // eslint-disable-line react-hooks/exhaustive-deps

  // Re-centre when the site pin moves. Guarded against no-op calls (the
  // mount render fires this with the exact same [lat,lng] the map was just
  // created with) and forced to skip Leaflet's animated pan/zoom — calling
  // setView this early (before the deferred invalidateSize() above has run,
  // so the container's measured size is still stale) sends the animated path
  // into `_leaflet_pos` on an element that isn't positioned yet, crashing on
  // every pin move including the very first page load.
  useEffect(() => {
    const { map, pin } = M.current;
    if (!map || lat == null) return;
    if (M.current.lat === lat && M.current.lng === lng) return;
    M.current.lat = lat; M.current.lng = lng;
    pin.setLatLng([lat, lng]);
    map.setView([lat, lng], Math.max(map.getZoom(), 18), { animate: false });
  }, [lat, lng]);

  // ── committed shapes ─────────────────────────────────────────────────────
  useEffect(() => {
    const { map, shapes } = M.current;
    if (!map || !shapes) return;
    shapes.clearLayers();
    const proj = makeProjection(lat, lng);
    const toLL = (poly) => poly.map(([x, y]) => proj.toLatLng(x, y));

    for (const s of site.surfaces || []) {
      if (!s.polygon || s.polygon.length < 3) continue;
      const style = s.enabled === false ? SURFACE_OFF : SURFACE_STYLE;
      const layer = L.polygon(toLL(s.polygon), { ...style, ...(selectedId === s.id ? { color: '#facc15', weight: 4 } : {}) })
        .addTo(shapes)
        .on('click', (e) => { L.DomEvent.stopPropagation(e); if (!modeRef.current) cbRef.current.onSelect?.(s.id); });
      layer.bindTooltip(
        `<b>${s.name}</b><br>${Math.round(polyArea(s.polygon))} m² plan · ${s.tiltDeg || 0}° tilt · ${s.baseHeight || 0} m high`,
        { direction: 'top', sticky: true },
      );
    }
    for (const o of site.obstructions || []) {
      if (!o.polygon || o.polygon.length < 3) continue;
      const layer = L.polygon(toLL(o.polygon), { ...OBS_STYLE, ...(selectedId === o.id ? { color: '#facc15', weight: 4 } : {}) })
        .addTo(shapes)
        .on('click', (e) => { L.DomEvent.stopPropagation(e); if (!modeRef.current) cbRef.current.onSelect?.(o.id); });
      layer.bindTooltip(`<b>${o.name}</b><br>${o.height} m tall${o.opacity < 1 ? ` · ${Math.round((1 - o.opacity) * 100)}% light through` : ''}`, { direction: 'top', sticky: true });
      const [cx, cy] = polyCentroid(o.polygon);
      const [clat, clng] = proj.toLatLng(cx, cy);
      L.marker([clat, clng], {
        icon: L.divIcon({
          className: '', iconSize: [24, 18], iconAnchor: [12, 9],
          html: `<div style="background:#111827cc;color:#fde68a;font:600 10px system-ui;border-radius:4px;text-align:center;line-height:18px">${o.height}m</div>`,
        }),
      }).addTo(shapes);
    }
  }, [site, lat, lng, selectedId]);

  // ── in-progress polygon ──────────────────────────────────────────────────
  useEffect(() => {
    const { drawing } = M.current;
    if (!drawing) return;
    drawing.clearLayers();
    if (!draft.length) return;
    draft.forEach(([a, b], i) => {
      L.circleMarker([a, b], { radius: 4, color: '#0f172a', weight: 1.5, fillColor: '#22d3ee', fillOpacity: 1 })
        .addTo(drawing).bindTooltip(String(i + 1), { direction: 'top' });
    });
    if (draft.length >= 2) L.polyline(draft, { color: '#22d3ee', weight: 2, dashArray: '6,4' }).addTo(drawing);
    if (draft.length >= 3) L.polygon(draft, DRAFT_STYLE).addTo(drawing);
  }, [draft]);

  // Any change of draw mode abandons a half-drawn shape — cancelling out of it,
  // or switching from surface to obstruction mid-trace. React's documented
  // "adjust state when a prop changes" pattern, not an effect.
  const [prevMode, setPrevMode] = useState(drawMode);
  if (prevMode !== drawMode) { setPrevMode(drawMode); setDraft([]); }

  const proj = makeProjection(lat, lng);
  const draftArea = draft.length >= 3 ? polyArea(draft.map(([a, b]) => proj.toLocal(a, b))) : 0;

  return (
    <div className="relative w-full h-full">
      <div ref={hostRef} className="w-full h-full rounded-lg overflow-hidden z-0" />

      {drawMode && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-[1000] bg-slate-900/92 text-white rounded-lg shadow-lg px-3 py-2 text-xs max-w-[92%]">
          <div className="font-semibold mb-0.5">
            Tracing: {drawMode === 'surface' ? 'mounting surface (roof / ground)' : 'shadow obstruction'}
          </div>
          <div className="text-slate-300">
            Click each corner · right-click undoes the last · double-click or <b>Done</b> closes it
            {draft.length > 0 && <> — <b>{draft.length}</b> point{draft.length > 1 ? 's' : ''}{draftArea > 0 && <>, <b>{Math.round(draftArea)} m²</b></>}</>}
          </div>
          <div className="flex gap-2 mt-1.5">
            <button onClick={() => M.current.finish?.()} disabled={draft.length < 3}
              className="btn btn-primary text-[11px] py-0.5 px-2 flex items-center gap-1 disabled:opacity-40">
              <FiCheck size={12} /> Done
            </button>
            <button onClick={() => setDraft((p) => p.slice(0, -1))} disabled={!draft.length}
              className="btn btn-secondary text-[11px] py-0.5 px-2 flex items-center gap-1 disabled:opacity-40">
              <FiCornerUpLeft size={12} /> Undo
            </button>
            <button onClick={() => { setDraft([]); onCancelDraw?.(); }}
              className="btn btn-secondary text-[11px] py-0.5 px-2 flex items-center gap-1">
              <FiTrash2 size={12} /> Cancel
            </button>
          </div>
        </div>
      )}

      {!drawMode && (
        <div className="absolute bottom-2 left-2 z-[1000] bg-slate-900/85 text-slate-200 rounded px-2 py-1 text-[10px] flex items-center gap-1">
          <FiCrosshair size={11} /> Click the map to move the site pin here
        </div>
      )}
    </div>
  );
}
