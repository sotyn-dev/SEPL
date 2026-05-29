// Procurement Schedule — Phase A Gantt (mam 2026-05-28).
// Custom SVG Gantt (no npm dependency added). Two-tier rows: a trade
// header summarises its category, click to expand the BOQ items under
// it. Bars are coloured by phase. "Today" line drawn in red. Hover
// gives item description + phase + dates.

import { useState, useEffect, useMemo, useCallback } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { useUrlTab } from '../hooks/useUrlTab';
import {
  FiCalendar, FiRefreshCw, FiSettings, FiChevronDown, FiChevronRight,
  FiAlertTriangle, FiClock, FiFlag, FiX,
} from 'react-icons/fi';

const PHASES = ['indent', 'quotes', 'po', 'dispatch', 'receive', 'install'];
const PHASE_LABEL = {
  indent:   'Indent raise',
  quotes:   'Vendor quotes',
  po:       'PO sent',
  dispatch: 'Vendor dispatch',
  receive:  'Site receive',
  install:  'Install',
};
// Distinct colour per phase so a single bar reads at a glance.
const PHASE_COLOR = {
  indent:   { bg: '#fef3c7', border: '#f59e0b', text: '#92400e' },  // amber
  quotes:   { bg: '#e0e7ff', border: '#6366f1', text: '#3730a3' },  // indigo
  po:       { bg: '#dbeafe', border: '#3b82f6', text: '#1e40af' },  // blue
  dispatch: { bg: '#fce7f3', border: '#ec4899', text: '#9d174d' },  // pink
  receive:  { bg: '#d1fae5', border: '#10b981', text: '#065f46' },  // green
  install:  { bg: '#fed7aa', border: '#ea580c', text: '#7c2d12' },  // orange
};

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
};
const daysBetween = (a, b) => {
  const da = new Date(a + 'T00:00:00').getTime();
  const db = new Date(b + 'T00:00:00').getTime();
  return Math.round((db - da) / (1000 * 60 * 60 * 24));
};

export default function ProcurementSchedule() {
  const { isAdmin, canEdit } = useAuth();
  const [tab, setTab] = useUrlTab('gantt');                 // gantt | rules | holidays
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useUrlTab('', 'project'); // ?project=42 persists across reloads
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [detail, setDetail] = useState(null);

  const loadProjects = useCallback(() => {
    api.get('/procurement-schedule/projects').then(r => setProjects(r.data || [])).catch(() => {});
  }, []);
  useEffect(() => { loadProjects(); }, [loadProjects]);

  const loadSchedule = useCallback(() => {
    if (!projectId) { setData(null); return; }
    setLoading(true);
    api.get(`/procurement-schedule/${projectId}`)
      .then(r => setData(r.data))
      .catch(err => toast.error(err.response?.data?.error || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [projectId]);
  useEffect(() => { loadSchedule(); }, [loadSchedule]);

  const regenerate = async () => {
    if (!projectId) { toast.error('Pick a project first'); return; }
    if (!confirm('Regenerate the procurement schedule? This replaces any existing bars for this project.')) return;
    try {
      const r = await api.post(`/procurement-schedule/${projectId}/regenerate`);
      toast.success(`Generated ${r.data.rows_written} bars across ${r.data.items_scheduled} items`);
      loadSchedule();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Regenerate failed');
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2"><FiCalendar className="text-red-600" /> Procurement Schedule</h1>
          <p className="text-xs text-gray-500">Backward-pass Gantt per project — surfaces the date by which you MUST raise each indent so the project finishes on time.</p>
        </div>
        {tab === 'gantt' && canEdit('procurement_schedule') && (
          <button onClick={regenerate} disabled={!projectId} className="btn btn-primary text-sm flex items-center gap-1 disabled:opacity-40">
            <FiRefreshCw size={14} /> Regenerate
          </button>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-gray-200">
        {[
          { id: 'gantt',    label: 'Schedule (Gantt)', icon: FiCalendar },
          { id: 'rules',    label: 'Lead-Time Rules',  icon: FiSettings },
          { id: 'holidays', label: 'Holidays',         icon: FiFlag },
        ].map(t => {
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-4 py-2 text-sm border-b-2 -mb-px transition ${
                active ? 'border-red-600 text-red-700 font-semibold' : 'border-transparent text-gray-600 hover:text-red-700'
              }`}>
              <t.icon size={14} /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'gantt' && (
        <>
          {/* Project picker */}
          <div className="card p-3 flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[260px]">
              <label className="text-[10px] font-bold uppercase text-gray-500 mb-1 block">Project</label>
              <SearchableSelect
                options={projects.map(p => ({
                  id: p.id,
                  label: `${p.company_name}${p.client_name ? ' · ' + p.client_name : ''} — completes ${fmtDate(p.completion_date)}${p.scheduled_rows > 0 ? ' · scheduled' : ''}`,
                }))}
                value={projectId ? +projectId : null}
                valueKey="id" displayKey="label"
                placeholder="Pick a project to view its Gantt…"
                onChange={v => setProjectId(v?.id ? String(v.id) : '')}
              />
            </div>
            {data?.project && (
              <div className="text-right text-xs">
                <div className="text-gray-500">Anchor (completion)</div>
                <div className="font-bold text-red-700">{fmtDate(data.project.completion_date)}</div>
              </div>
            )}
          </div>

          {!projectId && (
            <div className="card p-8 text-center text-gray-400">
              <FiCalendar size={36} className="mx-auto mb-2 opacity-30" />
              Pick a project above to view its procurement schedule.
            </div>
          )}

          {projectId && loading && <div className="card p-6 text-center text-gray-400">Loading…</div>}

          {projectId && !loading && data && data.rows.length === 0 && (
            <div className="card p-8 text-center">
              <FiAlertTriangle size={32} className="mx-auto mb-2 text-amber-500" />
              <p className="font-semibold mb-1">No schedule generated yet</p>
              <p className="text-xs text-gray-500 mb-3">Click <b>Regenerate</b> to compute the backward-pass for this project's BOQ items.</p>
            </div>
          )}

          {projectId && !loading && data && data.rows.length > 0 && (
            <GanttView data={data} expanded={expanded} setExpanded={setExpanded} onPickBar={setDetail} />
          )}
        </>
      )}

      {tab === 'rules'    && <PhaseRulesEditor canEdit={canEdit('procurement_schedule')} />}
      {tab === 'holidays' && <HolidaysEditor canEdit={canEdit('procurement_schedule')} />}

      <Modal isOpen={!!detail} onClose={() => setDetail(null)} title={detail ? `${PHASE_LABEL[detail.phase]} · ${detail.item_description || 'Item'}` : 'Detail'}>
        {detail && <BarDetail row={detail} />}
      </Modal>
    </div>
  );
}

// ─── GANTT VIEW (custom SVG) ──────────────────────────────────────
function GanttView({ data, expanded, setExpanded, onPickBar }) {
  // Bucket rows by trade then item
  const grouped = useMemo(() => {
    const out = {};
    for (const r of data.rows) {
      const t = r.trade || 'Other';
      if (!out[t]) out[t] = {};
      const key = r.item_id ?? 'rollup';
      if (!out[t][key]) out[t][key] = { item_id: r.item_id, item_description: r.item_description, item_code: r.item_code, phases: {} };
      out[t][key].phases[r.phase] = r;
    }
    return out;
  }, [data]);

  // Time scale — fit the chart from earliest start to latest end
  const { minDate, maxDate, totalDays } = useMemo(() => {
    let mn = null, mx = null;
    for (const r of data.rows) {
      if (!mn || r.start_date < mn) mn = r.start_date;
      if (!mx || r.end_date   > mx) mx = r.end_date;
    }
    const total = mn && mx ? daysBetween(mn, mx) + 1 : 0;
    return { minDate: mn, maxDate: mx, totalDays: total };
  }, [data]);

  const PX_PER_DAY = totalDays > 180 ? 5 : totalDays > 90 ? 8 : 14;
  const CHART_W = Math.max(800, totalDays * PX_PER_DAY);
  const ROW_H = 28;
  const LEFT_LABEL_W = 280;

  // Build row list — trade headers + (if expanded) item rows
  const rowList = [];
  Object.keys(grouped).sort().forEach(trade => {
    const items = Object.values(grouped[trade]);
    rowList.push({ kind: 'trade', trade, items, expanded: !!expanded[trade] });
    if (expanded[trade]) {
      items.forEach(it => rowList.push({ kind: 'item', trade, ...it }));
    }
  });

  const today = new Date().toISOString().slice(0, 10);
  const todayOffsetDays = today >= minDate && today <= maxDate ? daysBetween(minDate, today) : null;

  return (
    <div className="card p-0 overflow-hidden">
      {/* Legend */}
      <div className="px-3 py-2 border-b border-gray-100 flex flex-wrap items-center gap-3 bg-gray-50">
        <span className="text-[10px] font-bold uppercase text-gray-500">Phases:</span>
        {PHASES.map(p => (
          <span key={p} className="text-[10px] flex items-center gap-1">
            <span className="w-3 h-3 rounded" style={{ background: PHASE_COLOR[p].bg, border: `1px solid ${PHASE_COLOR[p].border}` }} />
            {PHASE_LABEL[p]}
          </span>
        ))}
        {data.generated_at && (
          <span className="text-[10px] text-gray-400 ml-auto">
            Last generated: {String(data.generated_at).replace('T', ' ').slice(0, 16)}
          </span>
        )}
      </div>

      <div className="overflow-x-auto" style={{ maxHeight: '70vh' }}>
        <div className="relative" style={{ width: LEFT_LABEL_W + CHART_W }}>
          {/* Sticky left label column */}
          <div className="absolute top-0 left-0 z-10 bg-white border-r border-gray-200" style={{ width: LEFT_LABEL_W }}>
            <div className="h-8 px-3 flex items-center text-[10px] font-bold uppercase text-gray-500 border-b border-gray-200 bg-gray-50">
              Trade / Item
            </div>
            {rowList.map((r, i) => (
              <div key={i}
                className={`h-7 px-3 flex items-center text-xs border-b border-gray-100 ${r.kind === 'trade' ? 'bg-gray-50 font-semibold cursor-pointer hover:bg-gray-100' : ''}`}
                onClick={() => r.kind === 'trade' ? setExpanded(prev => ({ ...prev, [r.trade]: !prev[r.trade] })) : null}
              >
                {r.kind === 'trade' ? (
                  <>
                    {r.expanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
                    <span className="ml-1">{r.trade}</span>
                    <span className="ml-auto text-[10px] font-normal text-gray-500">{r.items.length} item{r.items.length === 1 ? '' : 's'}</span>
                  </>
                ) : (
                  <>
                    <span className="text-gray-400 ml-3 mr-1.5 text-[10px]">{r.item_code || '—'}</span>
                    <span className="truncate" title={r.item_description}>{r.item_description || '(no description)'}</span>
                  </>
                )}
              </div>
            ))}
          </div>

          {/* Chart area */}
          <div className="ml-[280px]">
            {/* Date axis (month labels) */}
            <DateAxis minDate={minDate} totalDays={totalDays} pxPerDay={PX_PER_DAY} />

            {/* Today line */}
            {todayOffsetDays !== null && (
              <div className="absolute pointer-events-none" style={{
                top: 32,
                left: LEFT_LABEL_W + todayOffsetDays * PX_PER_DAY,
                width: 2,
                height: rowList.length * 28,
                background: 'rgba(220, 38, 38, 0.6)',
              }} title={`Today · ${fmtDate(today)}`}>
                <div className="absolute -top-3 -left-4 text-[9px] font-bold text-red-600 whitespace-nowrap">TODAY</div>
              </div>
            )}

            {/* Bars */}
            {rowList.map((r, i) => (
              <div key={i} className="h-7 border-b border-gray-100 relative" style={{ width: CHART_W }}>
                {r.kind === 'item' && PHASES.map(phase => {
                  const ph = r.phases[phase];
                  if (!ph) return null;
                  const startOffset = daysBetween(minDate, ph.start_date);
                  const widthDays = daysBetween(ph.start_date, ph.end_date) + 1;
                  const c = PHASE_COLOR[phase];
                  return (
                    <button
                      key={phase}
                      onClick={() => onPickBar({ ...ph, item_description: r.item_description })}
                      title={`${PHASE_LABEL[phase]} · ${fmtDate(ph.start_date)} → ${fmtDate(ph.end_date)} (${widthDays}d)`}
                      className="absolute top-1 h-5 rounded text-[10px] font-bold flex items-center justify-center px-1 truncate hover:brightness-95"
                      style={{
                        left: startOffset * PX_PER_DAY,
                        width: Math.max(8, widthDays * PX_PER_DAY - 1),
                        background: c.bg, border: `1px solid ${c.border}`, color: c.text,
                      }}
                    >
                      {widthDays * PX_PER_DAY > 50 ? PHASE_LABEL[phase] : ''}
                    </button>
                  );
                })}
                {/* For trade headers, draw a faint span covering the trade's earliest-start → latest-end */}
                {r.kind === 'trade' && (() => {
                  let mn = null, mx = null;
                  for (const it of r.items) {
                    for (const phase of PHASES) {
                      const p = it.phases[phase]; if (!p) continue;
                      if (!mn || p.start_date < mn) mn = p.start_date;
                      if (!mx || p.end_date   > mx) mx = p.end_date;
                    }
                  }
                  if (!mn || !mx) return null;
                  const startOffset = daysBetween(minDate, mn);
                  const widthDays = daysBetween(mn, mx) + 1;
                  return (
                    <div className="absolute top-2 h-3 rounded bg-gray-200/60 border border-gray-300" style={{
                      left: startOffset * PX_PER_DAY,
                      width: Math.max(8, widthDays * PX_PER_DAY - 1),
                    }} />
                  );
                })()}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── DATE AXIS HEADER ─────────────────────────────────────────────
function DateAxis({ minDate, totalDays, pxPerDay }) {
  // Render a month label tick every ~30 px-equivalent
  const ticks = [];
  let lastMonth = '';
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(minDate + 'T00:00:00');
    d.setDate(d.getDate() + i);
    const m = d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
    if (m !== lastMonth) {
      ticks.push({ offset: i * pxPerDay, label: m });
      lastMonth = m;
    }
  }
  return (
    <div className="h-8 relative border-b border-gray-200 bg-gray-50">
      {ticks.map((t, i) => (
        <div key={i} className="absolute top-0 text-[10px] font-semibold text-gray-600 border-l border-gray-300 pl-1" style={{ left: t.offset, height: '100%' }}>
          {t.label}
        </div>
      ))}
    </div>
  );
}

// ─── BAR DETAIL PANEL ─────────────────────────────────────────────
function BarDetail({ row }) {
  return (
    <div className="space-y-2 text-sm">
      <div className="grid grid-cols-2 gap-2">
        <div><span className="text-gray-500 text-[10px] uppercase block">Phase</span><b>{PHASE_LABEL[row.phase] || row.phase}</b></div>
        <div><span className="text-gray-500 text-[10px] uppercase block">Trade</span><b>{row.trade}</b></div>
        <div><span className="text-gray-500 text-[10px] uppercase block">Start</span><b>{fmtDate(row.start_date)}</b></div>
        <div><span className="text-gray-500 text-[10px] uppercase block">End</span><b>{fmtDate(row.end_date)}</b></div>
        <div><span className="text-gray-500 text-[10px] uppercase block">Duration</span><b>{row.lead_days} business day{row.lead_days === 1 ? '' : 's'}</b></div>
        <div><span className="text-gray-500 text-[10px] uppercase block">Status</span><b className="uppercase">{row.status}</b></div>
      </div>
      {row.item_description && (
        <div className="bg-gray-50 rounded p-2 text-xs">
          <div className="text-[10px] uppercase text-gray-500">Item</div>
          <div>{row.item_description}</div>
          {row.boq_qty && <div className="text-[10px] text-gray-500 mt-0.5">BOQ qty: {row.boq_qty} {row.unit || ''}</div>}
        </div>
      )}
      {row.phase === 'indent' && (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
          <FiAlertTriangle className="inline mr-1" size={12} />
          This is the "must raise indent by" window. Slipping past <b>{fmtDate(row.end_date)}</b> will cascade delays through every later phase.
        </p>
      )}
    </div>
  );
}

// ─── PHASE RULES EDITOR (admin) ───────────────────────────────────
function PhaseRulesEditor({ canEdit }) {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api.get('/procurement-schedule/phase-rules').then(r => { setData(r.data); setDraft(JSON.parse(JSON.stringify(r.data.grouped))); }).catch(()=>{});
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!data) return <div className="card p-6 text-center text-gray-400">Loading…</div>;

  const save = async () => {
    const rules = [];
    for (const cat of Object.keys(draft)) {
      for (const phase of PHASES) {
        rules.push({ category: cat, phase, days: +draft[cat][phase] || 0 });
      }
    }
    setSaving(true);
    try {
      await api.put('/procurement-schedule/phase-rules', { rules });
      toast.success('Lead times saved');
      load();
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
    setSaving(false);
  };

  return (
    <div className="card p-0 overflow-x-auto">
      <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between bg-gray-50">
        <h3 className="font-semibold text-sm">Lead-Time Rules — days per phase, per category</h3>
        {canEdit && <button onClick={save} disabled={saving} className="btn btn-primary text-xs">{saving ? 'Saving…' : 'Save'}</button>}
      </div>
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-[10px] uppercase text-gray-500">
          <tr>
            <th className="text-left p-2">Category</th>
            {PHASES.map(p => <th key={p} className="text-center p-2">{PHASE_LABEL[p]}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.categories.map(cat => (
            <tr key={cat} className="border-t border-gray-100">
              <td className="p-2 font-medium">{cat}</td>
              {PHASES.map(p => (
                <td key={p} className="p-1 text-center">
                  <input type="number" min="0" max="365" disabled={!canEdit}
                    className="input text-xs w-16 text-center mx-auto"
                    value={draft[cat]?.[p] ?? 0}
                    onChange={e => setDraft(d => ({ ...d, [cat]: { ...d[cat], [p]: +e.target.value || 0 } }))}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[10px] text-gray-500 p-2 border-t border-gray-100">
        Edits here only affect <b>future</b> regenerations. Existing schedules stay until you re-click <b>Regenerate</b> on the Gantt tab.
      </p>
    </div>
  );
}

// ─── HOLIDAYS EDITOR (admin) ──────────────────────────────────────
function HolidaysEditor({ canEdit }) {
  const [list, setList] = useState([]);
  const [date, setDate] = useState('');
  const [label, setLabel] = useState('');

  const load = useCallback(() => {
    api.get('/procurement-schedule/holidays').then(r => setList(r.data || [])).catch(()=>{});
  }, []);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!date) { toast.error('Pick a date'); return; }
    try {
      await api.post('/procurement-schedule/holidays', { holiday_date: date, label });
      toast.success('Added'); setDate(''); setLabel(''); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };
  const del = async (id) => {
    if (!confirm('Remove this holiday from the calendar?')) return;
    try { await api.delete(`/procurement-schedule/holidays/${id}`); toast.success('Removed'); load(); }
    catch { toast.error('Failed'); }
  };

  return (
    <div className="card p-3 space-y-3">
      <h3 className="font-semibold text-sm">Holiday Calendar — dates skipped by lead-time math</h3>
      {canEdit && (
        <div className="flex flex-wrap gap-2 items-end border-b border-gray-100 pb-3">
          <div>
            <label className="text-[10px] font-bold uppercase text-gray-500 block">Date</label>
            <input type="date" className="input text-sm" value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div className="flex-1 min-w-[180px]">
            <label className="text-[10px] font-bold uppercase text-gray-500 block">Label (optional)</label>
            <input className="input text-sm" value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Diwali" />
          </div>
          <button onClick={add} className="btn btn-primary text-sm">Add holiday</button>
        </div>
      )}
      <div className="space-y-1">
        {list.length === 0 && <p className="text-xs text-gray-400 italic">No holidays — only Sundays will be skipped.</p>}
        {list.map(h => (
          <div key={h.id} className="flex items-center gap-2 text-xs py-1 border-b border-gray-50">
            <span className="font-mono w-24">{h.holiday_date}</span>
            <span className="flex-1">{h.label || <em className="text-gray-400">no label</em>}</span>
            {canEdit && <button onClick={() => del(h.id)} className="text-gray-400 hover:text-red-600"><FiX size={14} /></button>}
          </div>
        ))}
      </div>
    </div>
  );
}
