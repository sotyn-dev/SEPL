// Solar 3D Site Design & Shadow Analysis.
//
// The flow the sales engineer actually walks: find the site → get the roof
// (LiDAR if Google has it, traced on satellite imagery if not) → mark what
// throws shadows → drag the sun around and watch them move → get the panel
// layout with each module's efficiency, and push the result onto the deal so
// the survey and quotation stages stop running on guessed numbers.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  FiSun, FiSearch, FiPlus, FiTrash2, FiSave, FiPlay, FiPause, FiLayers, FiGrid,
  FiMapPin, FiRotateCw, FiDownload, FiCheckCircle, FiAlertTriangle, FiEye, FiEyeOff, FiZap,
} from 'react-icons/fi';
import api from '../api';
import SitePlanner from '../components/solar/SitePlanner';
import SunScene3D from '../components/solar/SunScene3D';
import SunDial from '../components/solar/SunDial';
import { fetchGroundTexture } from '../lib/solar/basemap';
import {
  sunPosition, sunTimes, fmtClock, doyToDate, dateToDoy, optimalTilt, COMPASS, IST,
} from '../lib/solar/sun';
import {
  analyseSite, PANEL_PRESETS, OBSTRUCTION_KINDS, polyArea, polyBounds,
  makeProjection, perfColor, shadingNow,
} from '../lib/solar/shadow';
import { STATES } from '../data/indiaLocations';
import { num as fmt } from '../lib/solar/format';

const DEFAULT_LOC = { lat: 30.9010, lng: 75.8573, altitude: 247, name: 'Ludhiana, Punjab' };
const VIEW_TABS = [
  { k: 'plan', label: 'Satellite plan', icon: FiMapPin },
  { k: '3d', label: '3D + shadows', icon: FiLayers },
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const uid = () => Math.random().toString(36).slice(2, 9);
const wrapDoy = (d) => ((Math.round(d) - 1) % 365 + 365) % 365 + 1;

export default function SolarSiteDesign() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const dealId = params.get('deal');
  const studyId = params.get('study');

  const [loc, setLoc] = useState(DEFAULT_LOC);
  const [state, setStateName] = useState('Punjab');
  const [site, setSite] = useState({ surfaces: [], obstructions: [] });
  const [studyName, setStudyName] = useState('New site study');
  const [savedId, setSavedId] = useState(studyId ? Number(studyId) : null);
  const [deal, setDeal] = useState(null);

  // Search / LiDAR
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  // A toast alone is easy to miss — this is the sticky, always-visible record
  // of what the last search actually did, so "did it even run?" never comes up.
  const [searchStatus, setSearchStatus] = useState(null); // {type:'empty'|'error', query, message}
  const [lidar, setLidar] = useState(null);

  // Editing
  const [drawMode, setDrawMode] = useState(null);      // 'surface' | 'obstruction' | null
  const [newKind, setNewKind] = useState('tank');
  const [selectedId, setSelectedId] = useState(null);
  const [tab, setTab] = useState('plan');              // 'plan' | '3d'

  // Sun state — kept as floats so dragging feels continuous.
  const [sunT, setSunT] = useState({ doy: dateToDoy(6, 21), minutes: 12 * 60 });
  const [playing, setPlaying] = useState(false);

  // Analysis config
  const [cfg, setCfg] = useState({
    panelKey: '550', orientation: 'portrait', setback: 0.6, tiltDeg: '',
    frameHeight: 0.35, pr: 0.80, dayStep: 8, minStep: 15, cell: 0.5,
  });
  const [analysis, setAnalysis] = useState(null);
  const [busy, setBusy] = useState(false);
  const [rateBook, setRateBook] = useState(null);

  // View
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [showPanels, setShowPanels] = useState(true);
  const [showSunPaths, setShowSunPaths] = useState(true);
  const [colorMode, setColorMode] = useState('perf');
  const [cameraPreset, setCameraPreset] = useState(null);
  const [groundTex, setGroundTex] = useState(null);
  const [pickedPanel, setPickedPanel] = useState(null);
  // SunScene3D unmounts on the 'plan' tab, so this is only live while '3d' is
  // active — payload() checks before using it, no snapshot if it's null.
  const sceneRef = useRef(null);

  // ── load rate book (for the state's measured specific yield) ─────────────
  useEffect(() => {
    api.get('/solar/rate-book').then((r) => setRateBook(r.data)).catch(() => {});
  }, []);

  // ── deal / saved study ───────────────────────────────────────────────────
  useEffect(() => {
    if (!dealId) return;
    api.get(`/solar/deals/${dealId}`).then(({ data }) => {
      setDeal(data);
      setStudyName(`${data.client_name || 'Site'} — shadow study`);
      if (data.state) setStateName(data.state);
      if (data.lat && data.lng) setLoc((p) => ({ ...p, lat: +data.lat, lng: +data.lng, name: data.location || data.client_name }));
      else if (data.district || data.state) setQuery([data.location, data.district, data.state].filter(Boolean).join(', '));
    }).catch(() => toast.error('Could not load that deal'));
  }, [dealId]);

  useEffect(() => {
    if (!studyId) return;
    api.get(`/solar-site/studies/${studyId}`).then(({ data }) => {
      setSavedId(data.id);
      setStudyName(data.name || 'Site study');
      setLoc({ lat: data.lat, lng: data.lng, altitude: data.altitude || 0, name: data.address || '' });
      if (data.site?.surfaces) setSite({ surfaces: data.site.surfaces || [], obstructions: data.site.obstructions || [] });
      toast.success('Study loaded');
    }).catch(() => toast.error('Could not load that study'));
  }, [studyId]);

  // ── ground texture for the 3D view ───────────────────────────────────────
  // Rounded to 20 m so nudging a parapet's height doesn't re-fetch tiles.
  const texSpan = useMemo(() => {
    const all = [...(site.surfaces || []), ...(site.obstructions || [])].flatMap((s) => s.polygon || []);
    if (!all.length) return 110;
    const b = polyBounds(all);
    const reach = Math.max(Math.abs(b.minX), Math.abs(b.maxX), Math.abs(b.minY), Math.abs(b.maxY));
    return Math.min(260, Math.max(60, Math.ceil((reach * 1.8) / 20) * 20));
  }, [site]);

  useEffect(() => {
    let dead = false;
    fetchGroundTexture(loc.lat, loc.lng, texSpan).then((t) => { if (!dead) setGroundTex(t); });
    return () => { dead = true; };
  }, [loc.lat, loc.lng, texSpan]);

  // ── sun position ─────────────────────────────────────────────────────────
  const { month, day } = doyToDate(sunT.doy);
  const sun = useMemo(() => {
    const p = sunPosition({ year: 2025, month, day, minutes: sunT.minutes, lat: loc.lat, lng: loc.lng, tzHours: IST });
    return { ...p, minutes: sunT.minutes, month, day, doy: sunT.doy };
  }, [sunT.doy, sunT.minutes, month, day, loc.lat, loc.lng]);

  const times = useMemo(
    () => sunTimes({ year: 2025, month, day, lat: loc.lat, lng: loc.lng, tzHours: IST }),
    [month, day, loc.lat, loc.lng],
  );

  // Day animation.
  useEffect(() => {
    if (!playing) return undefined;
    const from = times.sunrise ?? 360, to = times.sunset ?? 1080;
    const id = setInterval(() => {
      setSunT((s) => {
        const next = s.minutes + 6;
        return { ...s, minutes: next > to ? from : next };
      });
    }, 45);
    return () => clearInterval(id);
  }, [playing, times.sunrise, times.sunset]);

  const onSunDrag = useCallback(({ dMinutes, dDays }) => {
    setPlaying(false);
    setSunT((s) => ({
      doy: wrapDoy(s.doy + dDays),
      minutes: Math.max(0, Math.min(1439, s.minutes + dMinutes)),
    }));
  }, []);

  // ── analysis (debounced; the sweep is ~0.3 s so it can just re-run) ──────
  const runRef = useRef(0);
  useEffect(() => {
    if (!site.surfaces.length) { setAnalysis(null); return undefined; }
    const token = ++runRef.current;
    setBusy(true);
    const t = setTimeout(() => {
      try {
        const specificYieldRef = rateBook?.factors?.state?.[state]?.specific_yield ?? null;
        const res = analyseSite(
          { lat: loc.lat, lng: loc.lng, altitude: loc.altitude || 0, surfaces: site.surfaces, obstructions: site.obstructions },
          {
            panel: PANEL_PRESETS[cfg.panelKey], orientation: cfg.orientation,
            setback: +cfg.setback || 0, frameHeight: +cfg.frameHeight || 0.35,
            tiltDeg: cfg.tiltDeg === '' ? null : +cfg.tiltDeg,
            performanceRatio: +cfg.pr || 0.8, dayStep: +cfg.dayStep, minStep: +cfg.minStep,
            cell: +cfg.cell, specificYieldRef,
          },
        );
        if (token === runRef.current) setAnalysis(res);
      } catch (e) {
        if (token === runRef.current) { setAnalysis(null); toast.error(`Analysis failed: ${e.message}`); }
      } finally {
        if (token === runRef.current) setBusy(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [site, loc.lat, loc.lng, loc.altitude, cfg, rateBook, state]);

  const live = useMemo(
    () => (analysis ? shadingNow(analysis, sun.azimuth, sun.elevation) : null),
    [analysis, sun.azimuth, sun.elevation],
  );

  // ── location search ──────────────────────────────────────────────────────
  const search = async (e) => {
    e?.preventDefault();
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setSearchStatus(null);
    try {
      // The state dropdown scopes the lookup too (server appends it when the
      // query alone finds nothing), not just the yield calibration.
      const { data } = await api.get('/solar-site/geocode', { params: { q, state } });
      const hits = data.results || [];
      setResults(hits);
      if (!hits.length) {
        const msg = `No match for "${q}" — add the city after a business name (e.g. "${q}, Ludhiana"), or try an area/landmark name, a pasted Google Maps link, or "lat, lng".`;
        setSearchStatus({ type: 'empty', message: msg });
        toast.error('No location match — see the note below the search box');
      } else if (data.broadenedFrom) {
        // The exact query drew a blank (a specific building most geocoders
        // simply don't have) and this is the nearest area match instead —
        // always surface the results list here, even if there's only one,
        // rather than silently auto-pinning something the user didn't
        // actually type and may not realise is approximate.
        setSearchStatus({ type: 'broadened', message: data.note || `Showing the area for "${data.broadenedFrom}" — zoom in and click the map to pin the exact spot.` });
      } else if (hits.length === 1) {
        pick(hits[0]);
      } else {
        setSearchStatus(null);
      }
    } catch (err) {
      // Network failure, timeout, or the server couldn't reach the geocoder —
      // distinguished from "no results" so the user knows whether to retry
      // the same search or try different words.
      const msg = err.response
        ? (err.response.data?.error || `Search failed (server said: ${err.response.status}).`)
        : 'Could not reach the server — check your connection and try again.';
      setSearchStatus({ type: 'error', message: msg });
      toast.error(msg);
    } finally { setSearching(false); }
  };

  const pick = (r) => {
    setLoc({ lat: r.lat, lng: r.lng, altitude: r.altitude || 0, name: r.name });
    setResults([]);
    setSearchStatus(null);
    setLidar(null);
    setTab('plan');
    toast.success(`Pinned ${r.name}`);
    tryLidar(r.lat, r.lng);
  };

  const tryLidar = async (la, ln) => {
    try {
      const { data } = await api.get('/solar-site/lidar', { params: { lat: la, lng: ln } });
      setLidar(data);
    } catch { setLidar({ available: false, reason: 'network', message: 'LiDAR check failed — trace the roof manually.' }); }
  };

  /**
   * Import Google's LiDAR roof planes. Their bounding box is axis-aligned, so
   * we lay a rectangle of the reported area on it at the reported pitch and
   * azimuth — a real starting shape the surveyor then nudges, not a guess.
   */
  const importLidar = () => {
    if (!lidar?.segments?.length) return;
    const proj = makeProjection(loc.lat, loc.lng);
    const surfaces = lidar.segments
      .filter((s) => s.areaSqm > 4)
      .map((s, i) => {
        const c = s.center ? proj.toLocal(s.center.lat, s.center.lng) : [0, 0];
        let poly;
        if (s.bounds) {
          const sw = proj.toLocal(s.bounds.sw.lat, s.bounds.sw.lng);
          const ne = proj.toLocal(s.bounds.ne.lat, s.bounds.ne.lng);
          poly = [[sw[0], sw[1]], [ne[0], sw[1]], [ne[0], ne[1]], [sw[0], ne[1]]];
          // The bounding box overstates a non-rectangular plane — shrink it to
          // the reported ground area so capacity isn't inflated.
          const boxArea = polyArea(poly);
          const target = s.groundAreaSqm || s.areaSqm * Math.cos((s.pitchDeg || 0) * Math.PI / 180);
          if (boxArea > target && target > 0) {
            const k = Math.sqrt(target / boxArea);
            poly = poly.map(([x, y]) => [c[0] + (x - c[0]) * k, c[1] + (y - c[1]) * k]);
          }
        } else {
          const half = Math.sqrt(Math.max(s.groundAreaSqm || s.areaSqm, 4)) / 2;
          poly = [[c[0] - half, c[1] - half], [c[0] + half, c[1] - half], [c[0] + half, c[1] + half], [c[0] - half, c[1] + half]];
        }
        return {
          id: uid(), name: s.name || `Roof plane ${i + 1}`, polygon: poly,
          baseHeight: Math.max(3, Math.round((s.planeHeightM ?? 6) * 10) / 10),
          groundHeight: 0, tiltDeg: Math.round(s.pitchDeg || 0), aziDeg: Math.round(s.azimuthDeg ?? 180),
          enabled: true, source: 'lidar',
        };
      });
    if (!surfaces.length) return toast.error('No usable roof planes in the LiDAR response');
    setSite((p) => ({ ...p, surfaces: [...p.surfaces, ...surfaces] }));
    toast.success(`Imported ${surfaces.length} LiDAR roof plane${surfaces.length > 1 ? 's' : ''}`);
  };

  // ── shape editing ────────────────────────────────────────────────────────
  const finishPolygon = (polygon) => {
    if (drawMode === 'surface') {
      const n = site.surfaces.length + 1;
      setSite((p) => ({
        ...p,
        surfaces: [...p.surfaces, {
          id: uid(), name: `Surface ${n}`, polygon,
          baseHeight: 6, groundHeight: 0, tiltDeg: 0, aziDeg: 180, enabled: true, source: 'traced',
        }],
      }));
      toast.success(`Surface added — ${Math.round(polyArea(polygon))} m²`);
    } else {
      const k = OBSTRUCTION_KINDS.find((o) => o.v === newKind);
      setSite((p) => ({
        ...p,
        obstructions: [...p.obstructions, {
          id: uid(), name: k.label, kind: newKind, polygon,
          base: newKind === 'building' || newKind === 'tree' || newKind === 'pole' ? 0 : (site.surfaces[0]?.baseHeight || 6),
          height: k.h, opacity: k.opacity,
        }],
      }));
      toast.success(`${k.label} added at ${k.h} m`);
    }
    setDrawMode(null);
  };

  const patchSurface = (id, patch) => setSite((p) => ({ ...p, surfaces: p.surfaces.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
  const patchObs = (id, patch) => setSite((p) => ({ ...p, obstructions: p.obstructions.map((o) => (o.id === id ? { ...o, ...patch } : o)) }));
  const removeShape = (id) => setSite((p) => ({
    surfaces: p.surfaces.filter((s) => s.id !== id),
    obstructions: p.obstructions.filter((o) => o.id !== id),
  }));

  // ── save / apply ─────────────────────────────────────────────────────────
  const payload = () => ({
    deal_id: dealId ? Number(dealId) : null,
    name: studyName, address: loc.name,
    lat: loc.lat, lng: loc.lng, altitude: loc.altitude || 0,
    site, result: analysis ? {
      summary: analysis.summary, reference: analysis.reference, panels: analysis.panels.map(slimPanel),
      snapshot: sceneRef.current?.captureSnapshot() || undefined,
    } : {},
    panel_count: analysis?.summary.panelCount || 0,
    capacity_kwp: analysis?.summary.kWp || 0,
    annual_kwh: analysis?.summary.kwhYear || 0,
    mean_perf_pct: analysis?.summary.meanPerfPct || 0,
    shade_loss_pct: analysis?.summary.shadeLossPct || 0,
    lidar_source: site.surfaces.some((s) => s.source === 'lidar') ? 'google-solar-api' : 'manual',
  });

  const save = async () => {
    if (!site.surfaces.length) return toast.error('Add at least one mounting surface first');
    try {
      if (savedId) { await api.put(`/solar-site/studies/${savedId}`, payload()); toast.success('Study updated'); }
      else { const { data } = await api.post('/solar-site/studies', payload()); setSavedId(data.id); toast.success('Study saved'); }
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
  };

  const applyToDeal = async () => {
    if (!analysis) return toast.error('Run the analysis first');
    let id = savedId;
    if (!id) {
      try { const { data } = await api.post('/solar-site/studies', payload()); id = data.id; setSavedId(id); }
      catch (e) { return toast.error(e.response?.data?.error || 'Save failed'); }
    } else {
      try { await api.put(`/solar-site/studies/${id}`, payload()); } catch { /* keep going — apply still works off the stored row */ }
    }
    try {
      const { data } = await api.post(`/solar-site/studies/${id}/apply-to-deal`, { deal_id: dealId });
      toast.success(`Survey updated on the deal — ${fmt(data.area_sqft, 0)} sq ft shadow-free`);
      navigate('/solar-funnel');
    } catch (e) { toast.error(e.response?.data?.error || 'Could not update the deal'); }
  };

  const exportCsv = () => {
    if (!analysis) return;
    const head = ['#', 'Surface', 'Row', 'Col', 'East (m)', 'North (m)', 'Height (m)', 'Tilt', 'Azimuth', 'Wp', 'Shade-free %', 'Worst corner %', 'Performance % of optimal', 'POA kWh/m²/yr', 'kWh/yr'];
    const rows = analysis.panels.map((p) => [
      p.index, p.surfaceId, p.row, p.col, p.x.toFixed(2), p.y.toFixed(2), p.z.toFixed(2),
      p.tilt.toFixed(1), p.azi.toFixed(1), p.wp,
      p.shadeFreePct.toFixed(1), p.worstCellShadeFreePct.toFixed(1), p.perfPct.toFixed(1),
      p.poa.toFixed(0), p.kwhYear.toFixed(0),
    ]);
    const csv = [head, ...rows].map((r) => r.map((c) => `"${c}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = `${studyName.replace(/[^a-z0-9]+/gi, '_')}_panels.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const s = analysis?.summary;
  const selected = [...site.surfaces, ...site.obstructions].find((x) => x.id === selectedId);
  const panelInfo = pickedPanel != null ? analysis?.panels?.[pickedPanel] : null;
  const worst = useMemo(
    () => (analysis ? [...analysis.panels].sort((a, b) => a.perfPct - b.perfPct).slice(0, 8) : []),
    [analysis],
  );

  return (
    <div className="p-3 md:p-4 space-y-3">
      {/* ── header ── */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FiSun className="text-amber-500" size={22} />
          <div>
            <h1 className="text-lg font-bold leading-tight">3D Site Design & Shadow Analysis</h1>
            <p className="text-[11px] text-gray-500">
              {loc.name || 'Unpinned'} · {loc.lat.toFixed(5)}, {loc.lng.toFixed(5)}
              {deal && <> · deal <b>{deal.deal_no}</b> — {deal.client_name}</>}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <input className="input-compact w-52" value={studyName} onChange={(e) => setStudyName(e.target.value)} placeholder="Study name" />
          <button onClick={save} className="btn btn-secondary text-xs flex items-center gap-1"><FiSave size={13} /> {savedId ? 'Update' : 'Save'}</button>
          <button onClick={exportCsv} disabled={!analysis} className="btn btn-secondary text-xs flex items-center gap-1 disabled:opacity-40"><FiDownload size={13} /> Panel CSV</button>
          {dealId && <button onClick={applyToDeal} disabled={!analysis} className="btn btn-primary text-xs flex items-center gap-1 disabled:opacity-40"><FiCheckCircle size={13} /> Apply to deal</button>}
        </div>
      </div>

      {/* ── location ── */}
      <div className="bg-white border rounded-lg p-2.5 space-y-2">
        <form onSubmit={search} className="flex flex-wrap gap-2 items-center">
          <span className="text-xs font-semibold flex items-center gap-1 shrink-0"><FiMapPin size={13} /> Site location</span>
          <input className="input-compact flex-1 min-w-[240px]" value={query}
            onChange={(e) => { setQuery(e.target.value); setSearchStatus(null); }}
            placeholder='Place name, a Google Maps link, or "30.9010, 75.8573"' />
          <button type="submit" disabled={searching || !query.trim()} className="btn btn-primary text-xs flex items-center gap-1 disabled:opacity-50">
            {searching ? <FiRotateCw size={13} className="animate-spin" /> : <FiSearch size={13} />} {searching ? 'Searching…' : 'Find'}
          </button>
          <select className="input-compact w-40" value={state} onChange={(e) => setStateName(e.target.value)} title="Drives the specific yield used for absolute energy">
            {STATES.map((st) => <option key={st} value={st}>{st}</option>)}
          </select>
        </form>

        {(results.length > 1 || (results.length === 1 && searchStatus?.type === 'broadened')) && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] text-gray-500 mr-1">{results.length} matches — pick one:</span>
            {results.map((r, i) => (
              <button key={i} onClick={() => pick(r)} className="text-[11px] px-2 py-1 rounded border hover:bg-blue-50">
                {r.name} <span className="text-gray-400">({r.lat.toFixed(3)}, {r.lng.toFixed(3)})</span>
              </button>
            ))}
          </div>
        )}

        {searchStatus && (
          <div className={`text-[11px] rounded px-2 py-1.5 flex items-start gap-2 ${
            searchStatus.type === 'error' ? 'bg-red-50 text-red-800' : searchStatus.type === 'broadened' ? 'bg-blue-50 text-blue-800' : 'bg-amber-50 text-amber-800'
          }`}>
            <FiAlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>{searchStatus.message}</span>
          </div>
        )}

        {lidar && (
          <div className={`text-[11px] rounded px-2 py-1.5 flex items-start gap-2 ${lidar.available ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'}`}>
            {lidar.available ? <FiZap size={13} className="mt-0.5 shrink-0" /> : <FiAlertTriangle size={13} className="mt-0.5 shrink-0" />}
            <div className="flex-1">
              {lidar.available ? (
                <>
                  <b>LiDAR available</b> — {lidar.segments.length} roof plane{lidar.segments.length !== 1 ? 's' : ''} from Google's aerial survey
                  {lidar.imageryDate && <> (imagery {lidar.imageryDate.year}-{String(lidar.imageryDate.month).padStart(2, '0')})</>}.
                  {lidar.googleEstimate?.maxPanels != null && <> Google's own estimate: {lidar.googleEstimate.maxPanels} panels max.</>}
                  <button onClick={importLidar} className="btn btn-primary text-[10px] py-0.5 px-2 ml-2">Import roof planes</button>
                </>
              ) : lidar.message}
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
        {/* ── viewport ── */}
        <div className="xl:col-span-2 space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {VIEW_TABS.map((t) => (
              <button key={t.k} onClick={() => setTab(t.k)}
                className={`text-xs px-3 py-1.5 rounded-md flex items-center gap-1 ${tab === t.k ? 'bg-blue-700 text-white font-semibold' : 'bg-gray-100 text-gray-600'}`}>
                <t.icon size={13} /> {t.label}
              </button>
            ))}
            <div className="flex-1" />
            {tab === 'plan' ? (
              <>
                <button onClick={() => { setDrawMode('surface'); setSelectedId(null); }}
                  className={`text-xs px-2 py-1.5 rounded-md flex items-center gap-1 ${drawMode === 'surface' ? 'bg-sky-600 text-white' : 'bg-sky-50 text-sky-700 border border-sky-200'}`}>
                  <FiPlus size={12} /> Trace surface
                </button>
                <select className="input-compact text-xs w-36" value={newKind} onChange={(e) => setNewKind(e.target.value)}>
                  {OBSTRUCTION_KINDS.map((k) => <option key={k.v} value={k.v}>{k.label}</option>)}
                </select>
                <button onClick={() => { setDrawMode('obstruction'); setSelectedId(null); }}
                  className={`text-xs px-2 py-1.5 rounded-md flex items-center gap-1 ${drawMode === 'obstruction' ? 'bg-amber-500 text-white' : 'bg-amber-50 text-amber-700 border border-amber-200'}`}>
                  <FiPlus size={12} /> Trace obstruction
                </button>
              </>
            ) : (
              <>
                {[['iso', 'Iso'], ['top', 'Top'], ['south', 'South'], ['east', 'East']].map(([k, l]) => (
                  <button key={k} onClick={() => setCameraPreset({ key: k, n: Date.now() })}
                    className="text-xs px-2 py-1.5 rounded-md bg-gray-100 text-gray-700">{l}</button>
                ))}
                <button onClick={() => setShowHeatmap((v) => !v)} title="Irradiance heat-map on the roof"
                  className={`text-xs px-2 py-1.5 rounded-md flex items-center gap-1 ${showHeatmap ? 'bg-blue-700 text-white' : 'bg-gray-100 text-gray-700'}`}><FiGrid size={12} /> Heat-map</button>
                <button onClick={() => setShowPanels((v) => !v)}
                  className={`text-xs px-2 py-1.5 rounded-md flex items-center gap-1 ${showPanels ? 'bg-gray-100 text-gray-700' : 'bg-gray-200 text-gray-400'}`}>
                  {showPanels ? <FiEye size={12} /> : <FiEyeOff size={12} />} Panels</button>
                <button onClick={() => setShowSunPaths((v) => !v)}
                  className={`text-xs px-2 py-1.5 rounded-md ${showSunPaths ? 'bg-gray-100 text-gray-700' : 'bg-gray-200 text-gray-400'}`}>Sun paths</button>
              </>
            )}
          </div>

          <div className="relative h-[440px] md:h-[540px] rounded-lg overflow-hidden border">
            {tab === 'plan' ? (
              <SitePlanner
                lat={loc.lat} lng={loc.lng} site={site} drawMode={drawMode}
                onFinishPolygon={finishPolygon} onCancelDraw={() => setDrawMode(null)}
                onSelect={setSelectedId} selectedId={selectedId}
                onMoveCenter={(la, ln) => { setLoc((p) => ({ ...p, lat: la, lng: ln })); setLidar(null); tryLidar(la, ln); }}
              />
            ) : (
              <SunScene3D
                ref={sceneRef}
                site={{ ...site, lat: loc.lat, lng: loc.lng }} analysis={analysis} sun={sun}
                groundTexture={groundTex} showHeatmap={showHeatmap} showPanels={showPanels}
                showSunPaths={showSunPaths} colorMode={colorMode}
                onSunDrag={onSunDrag} onPickPanel={setPickedPanel}
                selectedPanelId={panelInfo?.index} cameraPreset={cameraPreset}
              />
            )}

            {tab === '3d' && !site.surfaces.length && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-900/55 backdrop-blur-[2px] pointer-events-none">
                <div className="bg-white/95 rounded-xl shadow-lg px-6 py-5 max-w-xs text-center pointer-events-auto">
                  <FiMapPin size={22} className="mx-auto mb-2 text-blue-600" />
                  <p className="font-semibold text-sm mb-1">Nothing to show yet</p>
                  <p className="text-xs text-gray-500 mb-3">Trace the roof (and anything that could shade it) on the satellite plan first — the 3D view fills in once there's a surface to build on.</p>
                  <button onClick={() => setTab('plan')} className="btn btn-primary text-xs">Go to satellite plan</button>
                </div>
              </div>
            )}

            {busy && site.surfaces.length > 0 && (
              <div className="absolute top-2 right-2 bg-slate-900/80 text-white text-[11px] px-2.5 py-1.5 rounded-full flex items-center gap-1.5 shadow">
                <FiRotateCw size={11} className="animate-spin" /> Recomputing shading…
              </div>
            )}
          </div>

          {/* ── sun scrubber ── */}
          <div className="bg-white border rounded-lg p-2.5 flex flex-col md:flex-row gap-3">
            <div className="shrink-0 self-center md:self-start">
              <SunDial lat={loc.lat} lng={loc.lng} doy={sunT.doy} minutes={sunT.minutes}
                onChange={(v) => { setPlaying(false); setSunT(v); }} />
            </div>
            <div className="flex-1 space-y-2 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => setPlaying((p) => !p)} className="btn btn-primary text-xs flex items-center gap-1 w-[86px] justify-center">
                {playing ? <><FiPause size={13} /> Pause</> : <><FiPlay size={13} /> Play day</>}
              </button>
              <div className={`text-xs px-2 py-1 rounded font-mono ${sun.elevation > 0 ? 'bg-amber-100 text-amber-900' : 'bg-slate-200 text-slate-600'}`}>
                {fmtClock(sunT.minutes)} · {day} {MONTHS[month - 1]}
              </div>
              <div className="text-[11px] text-gray-600">
                Sun <b>{sun.elevation.toFixed(1)}°</b> above horizon, bearing <b>{sun.azimuth.toFixed(0)}° {COMPASS(sun.azimuth)}</b>
                {sun.elevation <= 0 && <span className="text-slate-500"> — below the horizon</span>}
              </div>
              <div className="flex-1" />
              <div className="text-[11px] text-gray-500">
                Sunrise {times.sunrise != null ? fmtClock(times.sunrise) : '—'} · noon {fmtClock(times.noon)} · sunset {times.sunset != null ? fmtClock(times.sunset) : '—'}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <label className="block">
                <span className="text-[10px] text-gray-500 uppercase tracking-wide">Time of day</span>
                <input type="range" min="0" max="1439" step="1" value={Math.round(sunT.minutes)} className="w-full accent-amber-500"
                  onChange={(e) => { setPlaying(false); setSunT((p) => ({ ...p, minutes: +e.target.value })); }} />
              </label>
              <label className="block">
                <span className="text-[10px] text-gray-500 uppercase tracking-wide">Day of year</span>
                <input type="range" min="1" max="365" step="1" value={Math.round(sunT.doy)} className="w-full accent-sky-500"
                  onChange={(e) => setSunT((p) => ({ ...p, doy: +e.target.value }))} />
              </label>
            </div>

            <div className="flex flex-wrap gap-1.5 items-center">
              <span className="text-[10px] text-gray-500 uppercase tracking-wide mr-1">Jump to</span>
              {[
                ['Worst case — 21 Dec, 09:00', () => setSunT({ doy: dateToDoy(12, 21), minutes: 540 })],
                ['21 Dec noon', () => setSunT({ doy: dateToDoy(12, 21), minutes: 720 })],
                ['21 Dec, 15:00', () => setSunT({ doy: dateToDoy(12, 21), minutes: 900 })],
                ['21 Jun noon', () => setSunT({ doy: dateToDoy(6, 21), minutes: 720 })],
                ['21 Mar noon', () => setSunT({ doy: dateToDoy(3, 21), minutes: 720 })],
              ].map(([label, fn]) => (
                <button key={label} onClick={() => { setPlaying(false); fn(); }} className="text-[10px] px-2 py-1 rounded border hover:bg-amber-50">{label}</button>
              ))}
              <button onClick={() => { setPlaying(false); setSunT((p) => ({ ...p, minutes: times.noon })); }} className="text-[10px] px-2 py-1 rounded border hover:bg-amber-50">Solar noon</button>
              {tab === '3d' && <span className="text-[10px] text-gray-400 ml-1">— in 3D you can also grab the sun itself once you orbit round to face it</span>}
            </div>

            {live && analysis && (
              <div className="text-[11px] rounded px-2 py-1.5 bg-slate-50 border flex flex-wrap gap-3">
                <span>Right now: <b className={live.shadedPct > 5 ? 'text-red-600' : 'text-emerald-700'}>{live.shadedPct.toFixed(0)}%</b> of modules shaded ({live.total - live.litPanels} of {live.total})</span>
                <span className="text-gray-500">Instant shading at this sun position — the annual figures below integrate the whole year.</span>
              </div>
            )}
            </div>
          </div>
        </div>

        {/* ── right rail ── */}
        <div className="space-y-3">
          {/* results */}
          <div className="bg-white border rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-bold flex items-center gap-1"><FiSun size={14} className="text-amber-500" /> Shadow analysis</h2>
              {busy && <span className="text-[10px] text-blue-600 flex items-center gap-1"><FiRotateCw size={11} className="animate-spin" /> computing…</span>}
            </div>

            {!site.surfaces.length ? (
              <p className="text-xs text-gray-500">
                Pin the site, then <b>Trace surface</b> on the satellite plan to outline the roof or ground area.
                Add every parapet, tank, stair room, tree and neighbouring building that could throw a shadow on it.
              </p>
            ) : !s ? (
              <p className="text-xs text-gray-500">Working…</p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <Stat label="Modules placed" value={fmt(s.panelCount, 0)} />
                  <Stat label="DC capacity" value={`${fmt(s.kWp, 1)} kWp`} />
                  <Stat label="Annual generation" value={`${fmt(Math.round(s.kwhYear), 0)} kWh`} />
                  <Stat label="Specific yield" value={`${fmt(s.specificYield, 0)} kWh/kWp`} />
                  <Stat label="Mean panel efficiency" value={`${fmt(s.meanPerfPct, 1)}%`} hint="of an unshaded, optimally-tilted module"
                    color={s.meanPerfPct >= 92 ? 'text-emerald-700' : s.meanPerfPct >= 80 ? 'text-amber-600' : 'text-red-600'} />
                  <Stat label="Shading loss" value={`${fmt(s.shadeLossPct, 1)}%`}
                    color={s.shadeLossPct <= 5 ? 'text-emerald-700' : s.shadeLossPct <= 15 ? 'text-amber-600' : 'text-red-600'} />
                  <Stat label="Shadow-free array area" value={`${fmt(Math.round(s.usableAreaSqft), 0)} sq ft`} />
                  <Stat label="Traced surface area" value={`${fmt(Math.round(s.roofAreaSqm), 0)} m²`} />
                </div>
                <p className="text-[10px] text-gray-500 mt-2 leading-relaxed">
                  Efficiency is each module's annual plane-of-array irradiance against an unshaded module at the
                  site's optimal {analysis.reference.tilt}° tilt facing {COMPASS(analysis.reference.azimuth)}.
                  {analysis.reference.calibrated
                    ? ` Absolute energy is calibrated to the ${state} specific yield in the solar rate book (${fmt(rateBook?.factors?.state?.[state]?.specific_yield, 0)} × PR ${s.performanceRatio}), so it agrees with the quotation engine.`
                    : ` Energy uses the clear-sky model at PR ${s.performanceRatio} — set a specific yield for ${state} in Solar Settings to calibrate it against the quotation engine.`}
                </p>

                {/* legend */}
                <div className="mt-2 pt-2 border-t">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] text-gray-500 uppercase tracking-wide">Module colour</span>
                    <select className="input-compact text-[10px] py-0.5 w-32" value={colorMode} onChange={(e) => setColorMode(e.target.value)}>
                      <option value="perf">Efficiency %</option>
                      <option value="shade">Shade-free %</option>
                      <option value="plain">Plain (as-built)</option>
                    </select>
                  </div>
                  <div className="flex h-3 rounded overflow-hidden">
                    {[40, 55, 65, 76, 86, 92, 98].map((p) => <div key={p} className="flex-1" style={{ background: perfColor(p) }} />)}
                  </div>
                  <div className="flex justify-between text-[9px] text-gray-500 mt-0.5"><span>&lt;45% poor</span><span>72%</span><span>95%+ excellent</span></div>
                </div>
              </>
            )}
          </div>

          {/* picked panel */}
          {panelInfo && (
            <div className="bg-white border-2 border-blue-300 rounded-lg p-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold">Module #{panelInfo.index}</h3>
                <button onClick={() => setPickedPanel(null)} className="text-xs text-gray-400">clear</button>
              </div>
              <div className="grid grid-cols-2 gap-1.5 mt-1.5 text-[11px]">
                <KV k="Efficiency" v={`${panelInfo.perfPct.toFixed(1)}%`} color={perfColor(panelInfo.perfPct)} />
                <KV k="Shade-free" v={`${panelInfo.shadeFreePct.toFixed(1)}%`} />
                <KV k="Worst corner" v={`${panelInfo.worstCellShadeFreePct.toFixed(1)}%`} />
                <KV k="Annual yield" v={`${fmt(Math.round(panelInfo.kwhYear), 0)} kWh`} />
                <KV k="Irradiance" v={`${fmt(panelInfo.poa, 0)} kWh/m²`} />
                <KV k="Orientation" v={`${panelInfo.tilt.toFixed(0)}° / ${COMPASS(panelInfo.azi)}`} />
                <KV k="Position" v={`${panelInfo.x.toFixed(1)} E, ${panelInfo.y.toFixed(1)} N`} />
                <KV k="Row / col" v={`${panelInfo.row} / ${panelInfo.col}`} />
              </div>
            </div>
          )}

          {/* array config */}
          <div className="bg-white border rounded-lg p-3 space-y-2">
            <h2 className="text-sm font-bold">Array configuration</h2>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Module">
                <select className="input-compact w-full" value={cfg.panelKey} onChange={(e) => setCfg({ ...cfg, panelKey: e.target.value })}>
                  {Object.entries(PANEL_PRESETS).map(([k, p]) => <option key={k} value={k}>{p.wp} Wp — {p.h}×{p.w} m</option>)}
                </select>
              </Field>
              <Field label="Orientation">
                <select className="input-compact w-full" value={cfg.orientation} onChange={(e) => setCfg({ ...cfg, orientation: e.target.value })}>
                  <option value="portrait">Portrait</option><option value="landscape">Landscape</option>
                </select>
              </Field>
              <Field label="Edge setback (m)" hint="Fire access / maintenance walkway">
                <input type="number" step="0.1" className="input-compact w-full" value={cfg.setback} onChange={(e) => setCfg({ ...cfg, setback: e.target.value })} />
              </Field>
              <Field label={`Tilt (blank = optimal ${optimalTilt(loc.lat)}°)`}>
                <input type="number" className="input-compact w-full" placeholder={`${optimalTilt(loc.lat)}`} value={cfg.tiltDeg} onChange={(e) => setCfg({ ...cfg, tiltDeg: e.target.value })} />
              </Field>
              <Field label="Frame height (m)" hint="Tilt-frame clearance on flat roofs">
                <input type="number" step="0.05" className="input-compact w-full" value={cfg.frameHeight} onChange={(e) => setCfg({ ...cfg, frameHeight: e.target.value })} />
              </Field>
              <Field label="Performance ratio">
                <input type="number" step="0.01" className="input-compact w-full" value={cfg.pr} onChange={(e) => setCfg({ ...cfg, pr: e.target.value })} />
              </Field>
              <Field label="Sweep: day step" hint="Lower = more accurate, slower">
                <select className="input-compact w-full" value={cfg.dayStep} onChange={(e) => setCfg({ ...cfg, dayStep: e.target.value })}>
                  <option value="15">Every 15 days (fast)</option><option value="8">Every 8 days</option>
                  <option value="4">Every 4 days</option><option value="2">Every 2 days (fine)</option>
                </select>
              </Field>
              <Field label="Sweep: time step">
                <select className="input-compact w-full" value={cfg.minStep} onChange={(e) => setCfg({ ...cfg, minStep: e.target.value })}>
                  <option value="30">30 min</option><option value="15">15 min</option><option value="10">10 min</option><option value="5">5 min (fine)</option>
                </select>
              </Field>
            </div>
            <p className="text-[10px] text-gray-500">
              Row pitch on flat surfaces is set automatically so no row shades the one behind it between 09:00 and 15:00
              on 21 December — the standard Indian design rule.
            </p>
          </div>

          {/* shapes */}
          <div className="bg-white border rounded-lg p-3">
            <h2 className="text-sm font-bold mb-2">Site model</h2>
            {!site.surfaces.length && !site.obstructions.length && <p className="text-xs text-gray-500">Nothing traced yet.</p>}

            {site.surfaces.map((sf) => (
              <div key={sf.id} className={`border rounded p-2 mb-1.5 ${selectedId === sf.id ? 'border-yellow-400 bg-yellow-50/60' : ''}`}>
                <div className="flex items-center gap-1.5">
                  <input className="input-compact flex-1 text-xs" value={sf.name} onChange={(e) => patchSurface(sf.id, { name: e.target.value })} onFocus={() => setSelectedId(sf.id)} />
                  <span className="text-[10px] text-gray-500 shrink-0">{Math.round(polyArea(sf.polygon))} m²</span>
                  <button onClick={() => patchSurface(sf.id, { enabled: sf.enabled === false })} title="Include in the array"
                    className={`text-[10px] px-1.5 py-0.5 rounded ${sf.enabled === false ? 'bg-gray-200 text-gray-500' : 'bg-emerald-100 text-emerald-700'}`}>
                    {sf.enabled === false ? 'off' : 'on'}
                  </button>
                  <button onClick={() => removeShape(sf.id)} className="text-red-500"><FiTrash2 size={13} /></button>
                </div>
                <div className="grid grid-cols-3 gap-1 mt-1">
                  <Mini label="Height m" value={sf.baseHeight} onChange={(v) => patchSurface(sf.id, { baseHeight: +v })} />
                  <Mini label="Tilt °" value={sf.tiltDeg} onChange={(v) => patchSurface(sf.id, { tiltDeg: +v })} />
                  <Mini label="Faces °" value={sf.aziDeg} onChange={(v) => patchSurface(sf.id, { aziDeg: +v })} hint={COMPASS(sf.aziDeg)} />
                </div>
                {sf.source === 'lidar' && <span className="text-[9px] text-emerald-600">✓ from LiDAR</span>}
              </div>
            ))}

            {site.obstructions.map((o) => (
              <div key={o.id} className={`border rounded p-2 mb-1.5 bg-amber-50/40 ${selectedId === o.id ? 'border-yellow-400' : ''}`}>
                <div className="flex items-center gap-1.5">
                  <input className="input-compact flex-1 text-xs" value={o.name} onChange={(e) => patchObs(o.id, { name: e.target.value })} onFocus={() => setSelectedId(o.id)} />
                  <button onClick={() => removeShape(o.id)} className="text-red-500"><FiTrash2 size={13} /></button>
                </div>
                <div className="grid grid-cols-3 gap-1 mt-1">
                  <Mini label="Base m" value={o.base} onChange={(v) => patchObs(o.id, { base: +v })} />
                  <Mini label="Height m" value={o.height} onChange={(v) => patchObs(o.id, { height: +v })} />
                  <Mini label="Light thru %" value={Math.round((1 - (o.opacity ?? 1)) * 100)} onChange={(v) => patchObs(o.id, { opacity: 1 - (+v) / 100 })} />
                </div>
              </div>
            ))}
            {selected && <p className="text-[10px] text-gray-500 mt-1">Heights are measured from the site pin's ground level (0 m).</p>}
          </div>

          {/* worst panels */}
          {worst.length > 0 && (
            <div className="bg-white border rounded-lg p-3">
              <h2 className="text-sm font-bold mb-1.5 flex items-center gap-1"><FiAlertTriangle size={13} className="text-amber-500" /> Most-shaded modules</h2>
              <p className="text-[10px] text-gray-500 mb-1.5">Drop these, or re-site the obstruction — a shaded module drags its whole series string down.</p>
              <table className="w-full text-[11px]">
                <thead><tr className="text-gray-500 text-left"><th>#</th><th>Position</th><th className="text-right">Shade-free</th><th className="text-right">Efficiency</th></tr></thead>
                <tbody>
                  {worst.map((p) => (
                    <tr key={p.id} className="border-t hover:bg-blue-50 cursor-pointer" onClick={() => { setPickedPanel(p.index - 1); setTab('3d'); }}>
                      <td className="py-0.5">{p.index}</td>
                      <td className="text-gray-500">{p.x.toFixed(0)}E {p.y.toFixed(0)}N</td>
                      <td className="text-right">{p.shadeFreePct.toFixed(0)}%</td>
                      <td className="text-right font-semibold" style={{ color: perfColor(p.perfPct) }}>{p.perfPct.toFixed(0)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Trim the per-panel array before it goes to the DB — the full objects carry
// geometry the server never reads.
const slimPanel = (p) => ({
  index: p.index, surfaceId: p.surfaceId, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
  tilt: +p.tilt.toFixed(1), azi: +p.azi.toFixed(1), wp: p.wp,
  shadeFreePct: +p.shadeFreePct.toFixed(1), perfPct: +p.perfPct.toFixed(1), kwhYear: Math.round(p.kwhYear),
});

const Stat = ({ label, value, color = 'text-gray-900', hint }) => (
  <div className="border rounded p-1.5" title={hint}>
    <div className="text-[9px] text-gray-500 uppercase tracking-wide leading-tight">{label}</div>
    <div className={`text-sm font-bold ${color}`}>{value}</div>
  </div>
);
const KV = ({ k, v, color }) => (
  <div><span className="text-gray-500">{k}: </span><b style={color ? { color } : undefined}>{v}</b></div>
);
const Field = ({ label, hint, children }) => (
  <label className="block" title={hint}>
    <span className="text-[10px] text-gray-500 uppercase tracking-wide leading-tight block">{label}</span>
    {children}
  </label>
);
const Mini = ({ label, value, onChange, hint }) => (
  <label className="block">
    <span className="text-[9px] text-gray-400">{label}{hint ? ` (${hint})` : ''}</span>
    <input type="number" className="input-compact w-full text-xs" value={value ?? 0} onChange={(e) => onChange(e.target.value)} />
  </label>
);
