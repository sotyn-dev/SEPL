// SYSTEM FLOW — ERP Management system register (v2).
//
// Mam (2026-09-08): "change it fully, 2,3 photo is steps and 4 is create system".
// Laid out like her spreadsheet: one row per system, with the four steps as
// grouped column blocks — Planned · Actual · Time Delay, plus each step's own
// extra column (proof + person, proof, PC name, score of system).
//
// Every desktop control is mirrored in the md:hidden mobile card (parity rule).

import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from 'react';
import { flowStepLabel, flowStepNumber } from '../utils/moduleFlows';
import api from '../api';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { fmtDateTime } from '../utils/datetime';
import { exportCsv } from '../utils/exportCsv';
import Pagination, { usePagination } from '../components/PaginationBar';
import {
  FiRefreshCw, FiDownload, FiSearch, FiPlus, FiTrash2, FiEdit2,
  FiCheckCircle, FiClock, FiUpload, FiExternalLink, FiLock, FiUploadCloud,
} from 'react-icons/fi';

const M = 'system_flow';

// The four steps, as the sheet defines them. The server owns the real template
// (db/systemFlowSchema.js) and sends it in /meta; this is the display fallback.
const FALLBACK_STEPS = [
  { step_no: 1, step_name: 'CREATE',    owner_label: 'MONIKA',            method: 'G-form',                        planned_days: 1,  extra: 'proof_person' },
  { step_no: 2, step_name: 'ALIGN',     owner_label: 'RESPECTIVE PERSON', method: 'UPLOAD SIGN FROM EVERY PERSON', planned_days: 1,  extra: 'proof' },
  { step_no: 3, step_name: 'ROLL-OUT',  owner_label: 'AUTOMATIC',         method: 'MANUALLY',                      planned_days: 0,  extra: 'pc_name' },
  { step_no: 4, step_name: 'ALIGNMENT', owner_label: 'PC',                method: 'Automatically',                 planned_days: 30, extra: 'score' },
];

const EXTRA_LABEL = {
  proof_person: 'Upload proof · Person',
  proof: 'Upload proof',
  pc_name: 'PC name',
  score: 'Score of system',
};

const STEP_TONE = [
  'bg-sky-50 border-sky-200',
  'bg-emerald-50 border-emerald-200',
  'bg-amber-50 border-amber-200',
  'bg-violet-50 border-violet-200',
];

const fmtDate = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '—');

// Late is red, early is green, on time is plain. The sheet's "Time Delay".
function Delay({ days }) {
  if (days === null || days === undefined) return <span className="text-slate-300">—</span>;
  if (days > 0) return <span className="text-red-600 font-semibold">+{days}d</span>;
  if (days < 0) return <span className="text-emerald-600">{days}d</span>;
  return <span className="text-slate-500">0d</span>;
}

function StepCell({ step, tpl, onEdit, canEdit, locked, prevName }) {
  const extra = tpl?.extra;
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const overdue = !step.actual_date && step.planned_date && step.planned_date < today;
  return (
    <>
      <td className={`px-2 py-1.5 text-xs whitespace-nowrap ${overdue ? 'text-red-600 font-semibold' : ''}`}>
        {fmtDate(step.planned_date)}
      </td>
      <td className="px-2 py-1.5 text-xs whitespace-nowrap">
        {step.actual_date
          ? <span className="text-emerald-700">{fmtDate(step.actual_date)}</span>
          : locked
            ? <span className="text-slate-400" title={`Finish ${prevName} first — the steps run in order`}>
                <FiLock size={10} className="inline -mt-0.5" /> after {prevName}
              </span>
            : canEdit
              ? <button onClick={() => onEdit(step)} className="text-blue-600 hover:underline">mark…</button>
              : <span className="text-slate-300">—</span>}
      </td>
      <td className="px-2 py-1.5 text-xs whitespace-nowrap"><Delay days={step.time_delay_days} /></td>
      <td className="px-2 py-1.5 text-xs whitespace-nowrap max-w-[150px] truncate">
        {extra === 'score' ? (
          step.system_score === null || step.system_score === undefined
            ? <span className="text-slate-300">—</span>
            : <span className="font-semibold">{step.system_score}</span>
        ) : extra === 'pc_name' ? (step.pc_name || <span className="text-slate-300">—</span>)
        : (
          <span className="inline-flex items-center gap-1">
            {step.proof_url
              ? <a href={step.proof_url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-0.5">proof <FiExternalLink size={10} /></a>
              : <span className="text-slate-300">—</span>}
            {extra === 'proof_person' && step.person_name && <span className="text-slate-500">· {step.person_name}</span>}
          </span>
        )}
      </td>
    </>
  );
}

export default function SystemFlow() {
  const { canCreate, canEdit, canDelete } = useAuth();
  const perms = useMemo(() => ({
    create: canCreate(M), edit: canEdit(M), remove: canDelete(M),
  }), [canCreate, canEdit, canDelete]);

  const [rows, setRows] = useState([]);
  const [stats, setStats] = useState(null);
  const [meta, setMeta] = useState({ steps: FALLBACK_STEPS, users: [], categories: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('');
  // Which step's columns are on screen. 0 = the full sheet view, 1-4 = one step.
  // Mam (2026-09-08): "steps i need into pilltabs".
  const [stepTab, setStepTab] = useState(1);
  const [create, setCreate] = useState(null);      // the create form
  const [editSys, setEditSys] = useState(null);    // system header being edited
  const [editStep, setEditStep] = useState(null);  // { system, step, tpl }
  const [saving, setSaving] = useState(false);
  // Bulk upload — mam (2026-09-08): "bulk upload". Her register IS a spreadsheet,
  // so the sheet is the input. Preview first, write only on a second click.
  const [bulk, setBulk] = useState(null);          // { fileName, file_b64, text, preview }
  const reqSeq = useRef(0);

  useEffect(() => { const t = setTimeout(() => setDebounced(search.trim()), 350); return () => clearTimeout(t); }, [search]);

  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (debounced) params.set('q', debounced);
      if (status) params.set('status', status);
      const [list, s] = await Promise.all([
        api.get(`/system-flow?${params}`),
        api.get('/system-flow/stats'),
      ]);
      if (seq !== reqSeq.current) return;
      setRows(list.data?.rows || []);
      setStats(s.data || null);
      setLoadError('');
    } catch (e) {
      if (seq === reqSeq.current) setLoadError(e?.response?.data?.error || e.message || 'Could not load systems');
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [debounced, status]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/system-flow/meta').then((r) => setMeta(r.data)).catch(() => {}); }, []);

  const steps = meta.steps?.length ? meta.steps : FALLBACK_STEPS;
  const tplOf = (no) => steps.find((s) => s.step_no === no) || FALLBACK_STEPS[no - 1];
  // Only the selected step's columns are rendered; 0 shows them all.
  const shownSteps = stepTab === 0 ? steps : steps.filter((t) => t.step_no === stepTab);

  // Each pill carries how much of that step is still outstanding, so the
  // bottleneck is visible without opening the tab.
  const stepCounts = useMemo(() => {
    const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const out = {};
    for (const t of steps) {
      let pending = 0, overdue = 0, done = 0;
      for (const r of rows) {
        const st = r.steps.find((x) => x.step_no === t.step_no);
        if (!st) continue;
        if (st.actual_date) done++;
        else {
          pending++;
          if (st.planned_date && st.planned_date < today) overdue++;
        }
      }
      out[t.step_no] = { pending, overdue, done };
    }
    return out;
  }, [rows, steps]);

  const runBulk = async (commit) => {
    if (!bulk?.file_b64 && !bulk?.text?.trim()) { toast.error('Choose a file, or paste the rows first'); return; }
    setSaving(true);
    try {
      const r = await api.post('/system-flow/bulk', {
        file_b64: bulk.file_b64 || undefined, text: bulk.text || undefined, commit,
      });
      if (commit) {
        toast.success(`${r.data.inserted} system${r.data.inserted === 1 ? '' : 's'} registered`);
        setBulk(null);
        load();
      } else {
        setBulk({ ...bulk, preview: r.data });
        if (!r.data.found) toast('No rows with a system name were found');
      }
    } catch (e) { toast.error(e?.response?.data?.error || 'Could not read that file'); }
    finally { setSaving(false); }
  };

  const readBulkFile = (file) => {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast.error('That file is larger than 8 MB'); return; }
    const fr = new FileReader();
    fr.onload = () => {
      // base64 of the raw bytes — the server reads .xlsx, .xls and .csv alike.
      const b = new Uint8Array(fr.result);
      let bin = '';
      for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
      setBulk({ fileName: file.name, file_b64: btoa(bin), text: '', preview: null });
    };
    fr.onerror = () => toast.error('Could not read that file');
    fr.readAsArrayBuffer(file);
  };

  const submitCreate = async () => {
    if (!create.system_name?.trim()) { toast.error('System name is required'); return; }
    setSaving(true);
    try {
      const r = await api.post('/system-flow', create);
      toast.success(`${r.data.uid} created`);
      setCreate(null);
      load();
    } catch (e) { toast.error(e?.response?.data?.error || 'Could not create'); }
    finally { setSaving(false); }
  };

  const submitSys = async () => {
    setSaving(true);
    try {
      await api.patch(`/system-flow/${editSys.id}`, editSys);
      toast.success('Updated');
      setEditSys(null);
      load();
    } catch (e) { toast.error(e?.response?.data?.error || 'Could not update'); }
    finally { setSaving(false); }
  };

  const submitStep = async () => {
    setSaving(true);
    try {
      const { system_id, step_no, ...body } = editStep.draft;
      await api.patch(`/system-flow/${system_id}/steps/${step_no}`, body);
      toast.success(`Step ${step_no} updated`);
      setEditStep(null);
      load();
    } catch (e) { toast.error(e?.response?.data?.error || 'Could not update the step'); }
    finally { setSaving(false); }
  };

  const remove = async (sys) => {
    if (!window.confirm(`Delete ${sys.uid} — ${sys.system_name}? Its four steps go with it.`)) return;
    try {
      await api.delete(`/system-flow/${sys.id}`);
      toast.success('Deleted');
      load();
    } catch (e) { toast.error(e?.response?.data?.error || 'Could not delete'); }
  };

  const openStep = (sys, step) => {
    if (!perms.edit) return;
    setEditStep({
      system: sys, step, tpl: tplOf(step.step_no),
      locked: (() => { const prev = sys.steps.find((x) => x.step_no === step.step_no - 1); return !!prev && !prev.actual_date; })(),
      prevName: (sys.steps.find((x) => x.step_no === step.step_no - 1) || {}).step_name || '',
      draft: {
        system_id: sys.id, step_no: step.step_no,
        actual_date: step.actual_date || '',
        planned_days: step.planned_days,
        owner_id: step.owner_id || '',
        proof_url: step.proof_url || '',
        person_name: step.person_name || '',
        pc_name: step.pc_name || '',
        remarks: step.remarks || '',
      },
    });
  };

  const csvSafe = (v) => (v === null || v === undefined ? ''
    : /^[=+@\t\r\-]/.test(String(v)) ? "'" + String(v) : v);

  const exportRows = () => exportCsv(
    'erp-system-flow',
    ['UID', 'Timestamp', 'System Name', 'Type', 'Category', 'Frequency', "HOD's Name",
      ...steps.flatMap((t) => [
        `${t.step_no}. ${t.step_name} Planned`, `${t.step_name} Actual`, `${t.step_name} Delay`,
        `${t.step_name} ${EXTRA_LABEL[t.extra]}`,
      ])],
    rows.map((r) => [
      r.uid, fmtDateTime(r.created_at), r.system_name, r.type, r.system_category, r.frequency,
      r.hod_user_name || r.hod_name,
      ...steps.flatMap((t) => {
        const s = r.steps.find((x) => x.step_no === t.step_no) || {};
        const extra = t.extra === 'score' ? s.system_score
          : t.extra === 'pc_name' ? s.pc_name
          : [s.proof_url, t.extra === 'proof_person' ? s.person_name : null].filter(Boolean).join(' · ');
        return [fmtDate(s.planned_date), fmtDate(s.actual_date), s.time_delay_days ?? '', extra ?? ''];
      }),
    ].map(csvSafe))
  );

  const pager = usePagination(rows, { initialPerPage: 15 });
  const tiles = [
    { label: 'Total systems', value: stats?.total ?? '—', tone: 'text-slate-800' },
    { label: 'Completed', value: stats?.completed ?? '—', tone: 'text-emerald-700' },
    { label: 'In progress', value: stats?.in_progress ?? '—', tone: 'text-blue-700' },
    { label: 'Overdue', value: stats?.overdue ?? '—', tone: 'text-red-600' },
    { label: 'Due this week', value: stats?.due_this_week ?? '—', tone: 'text-amber-700' },
    { label: 'Completion %', value: stats ? `${stats.completion_pct}%` : '—', tone: 'text-indigo-700' },
    { label: 'Avg delay', value: stats?.avg_delay_days === null || stats?.avg_delay_days === undefined ? '—' : `${stats.avg_delay_days}d`, tone: 'text-rose-700' },
    { label: 'Avg score', value: stats?.avg_score === null || stats?.avg_score === undefined ? '—' : stats.avg_score, tone: 'text-violet-700' },
  ];

  const FILTERS = [
    { id: '', label: 'All' },
    { id: 'open', label: 'Open' },
    { id: 'overdue', label: 'Overdue' },
    { id: 'delayed', label: 'Delayed' },
    { id: 'completed', label: 'Completed' },
  ];

  return (
    <div className="p-3 sm:p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">ERP Management — System Flow</h1>
          <p className="text-sm text-slate-500">
            Every system is registered, then runs through {steps.length} steps: {steps.map((s) => s.step_name).join(' → ')}.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => load()} className="px-3 py-1.5 text-sm border rounded-lg hover:bg-slate-50 inline-flex items-center gap-1.5">
            <FiRefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button onClick={exportRows} className="px-3 py-1.5 text-sm border rounded-lg hover:bg-slate-50 inline-flex items-center gap-1.5">
            <FiDownload size={14} /> Export
          </button>
          {perms.create && (
            <button onClick={() => setBulk({ fileName: '', file_b64: '', text: '', preview: null })}
                    className="px-3 py-1.5 text-sm border rounded-lg hover:bg-slate-50 inline-flex items-center gap-1.5">
              <FiUploadCloud size={14} /> Bulk upload
            </button>
          )}
          {perms.create && (
            <button onClick={() => setCreate({ system_name: '', type: '', system_category: '', frequency: '', hod_id: '', hod_name: '', remarks: '' })}
                    className="px-3 py-1.5 text-sm font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 inline-flex items-center gap-1.5">
              <FiPlus size={14} /> Create System
            </button>
          )}
        </div>
      </div>

      {loadError && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm">{loadError}</div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2">
        {tiles.map((t) => (
          <div key={t.label} className="bg-white border rounded-xl px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">{t.label}</div>
            <div className={`text-xl font-bold ${t.tone}`}>{t.value}</div>
          </div>
        ))}
      </div>

      {/* Step pill tabs — mam (2026-09-08): "steps i need into pilltabs" */}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setStepTab(0)}
                className={`px-3 py-1.5 text-sm rounded-full border ${stepTab === 0 ? 'bg-slate-800 text-white border-slate-800' : 'bg-white hover:bg-slate-50'}`}>
          All steps
        </button>
        {steps.map((t, i) => {
          const c = stepCounts[t.step_no] || { pending: 0, overdue: 0 };
          const on = stepTab === t.step_no;
          return (
            <button key={t.step_no} onClick={() => setStepTab(t.step_no)}
                    title={`${t.owner_label} · ${t.method} · planned ${t.planned_days} day(s)`}
                    className={`px-3 py-1.5 text-sm rounded-full border inline-flex items-center gap-2 ${on ? 'bg-slate-800 text-white border-slate-800' : `${STEP_TONE[i % 4]} hover:brightness-95`}`}>
              {/* "CREATE (65.1)"; a step added on the server later keeps its "5. NAME" form */}
              <span className="font-semibold">{flowStepNumber('/system-flow', t.step_name) ? flowStepLabel('/system-flow', t.step_name) : `${t.step_no}. ${t.step_name}`}</span>
              {c.pending > 0 && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${c.overdue > 0 ? 'bg-red-600 text-white' : on ? 'bg-white/20' : 'bg-white/70 text-slate-700'}`}>
                  {c.pending} left{c.overdue > 0 ? ` · ${c.overdue} late` : ''}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button key={f.id} onClick={() => setStatus(f.id)}
                  className={`px-3 py-1.5 text-sm rounded-lg border ${status === f.id ? 'bg-slate-800 text-white border-slate-800' : 'hover:bg-slate-50'}`}>
            {f.label}
          </button>
        ))}
        <div className="relative ml-auto">
          <FiSearch className="absolute left-2.5 top-2.5 text-slate-400" size={14} />
          <input value={search} onChange={(e) => setSearch(e.target.value)}
                 placeholder="System, UID, type, category, HOD…"
                 className="pl-8 pr-3 py-1.5 text-sm border rounded-lg w-72" />
        </div>
      </div>

      {/* Desktop: the sheet's layout — one row per system, four step blocks */}
      <div className="hidden md:block bg-white border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="text-sm min-w-max">
            <thead>
              <tr className="bg-slate-100 border-b">
                <th colSpan={7} className="px-2 py-1.5 text-left text-[11px] font-bold text-slate-600 border-r">SYSTEM</th>
                {shownSteps.map((t, i) => (
                  <th key={t.step_no} colSpan={4} className={`px-2 py-1.5 text-center text-[11px] font-bold border-r ${STEP_TONE[i % 4]}`}>
                    Step {t.step_no} · {t.step_name}
                    <div className="font-normal text-slate-500 normal-case">
                      {t.owner_label} · {t.method} · {t.planned_days}d
                    </div>
                  </th>
                ))}
                <th className="px-2 py-1.5"></th>
              </tr>
              <tr className="bg-slate-50 border-b text-[11px] text-slate-500 text-left">
                <th className="px-2 py-1.5 font-semibold">UID</th>
                <th className="px-2 py-1.5 font-semibold">Timestamp</th>
                <th className="px-2 py-1.5 font-semibold">System name</th>
                <th className="px-2 py-1.5 font-semibold">Type</th>
                <th className="px-2 py-1.5 font-semibold">Category</th>
                <th className="px-2 py-1.5 font-semibold">Frequency</th>
                <th className="px-2 py-1.5 font-semibold border-r">HOD</th>
                {shownSteps.map((t, i) => (
                  <Fragment key={t.step_no}>
                    <th className={`px-2 py-1.5 font-semibold ${STEP_TONE[i % 4]}`}>Planned</th>
                    <th className={`px-2 py-1.5 font-semibold ${STEP_TONE[i % 4]}`}>Actual</th>
                    <th className={`px-2 py-1.5 font-semibold ${STEP_TONE[i % 4]}`}>Time delay</th>
                    <th className={`px-2 py-1.5 font-semibold border-r ${STEP_TONE[i % 4]}`}>{EXTRA_LABEL[t.extra]}</th>
                  </Fragment>
                ))}
                <th className="px-2 py-1.5 font-semibold text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {pager.pageItems.map((r) => (
                <tr key={r.id} className="border-b last:border-0 hover:bg-slate-50/60">
                  <td className="px-2 py-1.5 font-mono text-xs whitespace-nowrap">{r.uid}</td>
                  <td className="px-2 py-1.5 text-xs whitespace-nowrap text-slate-500">{fmtDateTime(r.created_at)}</td>
                  <td className="px-2 py-1.5 font-semibold text-slate-800 max-w-[220px] truncate" title={r.system_name}>
                    {r.system_name}
                    {r.completed && <FiCheckCircle className="inline ml-1 text-emerald-600" size={12} />}
                  </td>
                  <td className="px-2 py-1.5 text-xs">{r.type || '—'}</td>
                  <td className="px-2 py-1.5 text-xs">{r.system_category || '—'}</td>
                  <td className="px-2 py-1.5 text-xs">{r.frequency || '—'}</td>
                  <td className="px-2 py-1.5 text-xs border-r">{r.hod_user_name || r.hod_name || '—'}</td>
                  {shownSteps.map((t) => {
                    const s = r.steps.find((x) => x.step_no === t.step_no)
                      || { step_no: t.step_no, planned_days: t.planned_days };
                    const prev = r.steps.find((x) => x.step_no === t.step_no - 1);
                    return <StepCell key={t.step_no} step={s} tpl={t} canEdit={perms.edit}
                                     locked={!!prev && !prev.actual_date}
                                     prevName={prev ? prev.step_name : ''}
                                     onEdit={() => openStep(r, s)} />;
                  })}
                  <td className="px-2 py-1.5 text-right whitespace-nowrap">
                    {perms.edit && (
                      <button onClick={() => setEditSys({ ...r })} aria-label={`Edit ${r.system_name}`}
                              className="p-1.5 text-slate-600 hover:bg-slate-100 rounded" title="Edit system"><FiEdit2 size={13} /></button>
                    )}
                    {perms.remove && (
                      <button onClick={() => remove(r)} aria-label={`Delete ${r.system_name}`}
                              className="p-1.5 text-red-600 hover:bg-red-50 rounded" title="Delete"><FiTrash2 size={13} /></button>
                    )}
                  </td>
                </tr>
              ))}
              {!pager.pageItems.length && (
                <tr><td colSpan={7 + shownSteps.length * 4 + 1} className="text-center text-slate-400 py-10">
                  {loading ? 'Loading…' : loadError ? 'Could not load the register.' : 'No systems yet. Press Create System to add the first one.'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination {...pager} />
      </div>

      {/* Mobile: same data, same actions */}
      <div className="md:hidden space-y-2">
        {pager.pageItems.map((r) => (
          <div key={r.id} className="bg-white border rounded-xl p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-semibold text-slate-800">{r.system_name}</div>
                <div className="text-[11px] text-slate-500 font-mono">{r.uid} · {fmtDateTime(r.created_at)}</div>
              </div>
              <div className="flex gap-1">
                {perms.edit && <button onClick={() => setEditSys({ ...r })} aria-label={`Edit ${r.system_name}`} className="p-1.5 text-slate-600 hover:bg-slate-100 rounded"><FiEdit2 size={13} /></button>}
                {perms.remove && <button onClick={() => remove(r)} aria-label={`Delete ${r.system_name}`} className="p-1.5 text-red-600 hover:bg-red-50 rounded"><FiTrash2 size={13} /></button>}
              </div>
            </div>
            <div className="text-xs text-slate-500 mt-1">
              {[r.type, r.system_category, r.frequency, r.hod_user_name || r.hod_name].filter(Boolean).join(' · ') || '—'}
            </div>
            <div className="mt-2 space-y-1">
              {shownSteps.map((t) => {
                const s = r.steps.find((x) => x.step_no === t.step_no) || { step_no: t.step_no };
                return (
                  <button key={t.step_no} onClick={() => openStep(r, s)} disabled={!perms.edit}
                          className="w-full text-left border rounded-lg px-2 py-1.5 text-xs flex items-center justify-between gap-2 disabled:opacity-70">
                    <span className="font-semibold">{t.step_no}. {t.step_name}</span>
                    <span className="text-slate-500">
                      {fmtDate(s.planned_date)} → {s.actual_date ? fmtDate(s.actual_date) : <span className="text-blue-600">pending</span>}
                      {' '}<Delay days={s.time_delay_days} />
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {!pager.pageItems.length && (
          <div className="text-center text-slate-400 py-8 bg-white border rounded-xl">
            {loading ? 'Loading…' : loadError ? 'Could not load the register.' : 'No systems yet.'}
          </div>
        )}
        <Pagination {...pager} />
      </div>

      {/* Bulk upload — register many systems straight from the sheet */}
      <Modal isOpen={!!bulk} onClose={() => setBulk(null)} title="Bulk upload systems" xwide>
        {bulk && (
          <div className="space-y-3">
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-900">
              Upload your register as it is — <b>.xlsx</b>, <b>.xls</b> or <b>.csv</b>.
              The sheet needs a header row with <b>System Name</b>; <b>Type</b>,
              <b> System Category</b>, <b>Frequency</b> and <b>HOD's Name</b> are used when present.
              <div className="mt-1 text-blue-800">
                UID and Timestamp are ignored — the ERP issues those, so re-uploading the same
                sheet cannot overwrite a system that already exists. The four steps are created
                for every row. An HOD whose name matches an ERP user is linked to them.
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input type="file" accept=".xlsx,.xls,.csv,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                     onChange={(e) => readBulkFile(e.target.files?.[0])}
                     className="text-xs file:mr-2 file:px-3 file:py-1.5 file:rounded-lg file:border file:border-slate-300 file:bg-white file:text-sm" />
              {bulk.fileName && <span className="text-xs text-slate-600">{bulk.fileName}</span>}
            </div>

            <div className="text-xs text-slate-500">…or paste rows (comma separated, first line the headers):</div>
            <textarea rows={4} value={bulk.text}
                      onChange={(e) => setBulk({ ...bulk, text: e.target.value, file_b64: '', fileName: '', preview: null })}
                      placeholder={'System Name,Type,System Category,Frequency,HOD\'s Name\nDaily DPR review,Process,Projects,Daily,Ankur Kaplesh'}
                      className="w-full border rounded-lg px-3 py-2 text-xs font-mono" />

            {bulk.preview && (
              <div className="border rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-slate-50 border-b text-xs flex flex-wrap gap-x-4">
                  <span><b>{bulk.preview.found}</b> row{bulk.preview.found === 1 ? '' : 's'} found</span>
                  <span className="text-emerald-700"><b>{bulk.preview.importable}</b> new</span>
                  <span className="text-amber-700"><b>{bulk.preview.duplicates}</b> already there</span>
                </div>
                <div className="max-h-64 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-white sticky top-0">
                      <tr className="text-left text-slate-500 border-b">
                        <th className="px-2 py-1.5 font-semibold">System name</th>
                        <th className="px-2 py-1.5 font-semibold">Type</th>
                        <th className="px-2 py-1.5 font-semibold">Category</th>
                        <th className="px-2 py-1.5 font-semibold">Frequency</th>
                        <th className="px-2 py-1.5 font-semibold">HOD</th>
                        <th className="px-2 py-1.5 font-semibold">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(bulk.preview.rows || []).map((r, i) => (
                        <tr key={i} className={`border-b last:border-0 ${r.duplicate ? 'bg-slate-50 text-slate-400' : ''}`}>
                          <td className="px-2 py-1.5 font-semibold">{r.system_name}</td>
                          <td className="px-2 py-1.5">{r.type || '—'}</td>
                          <td className="px-2 py-1.5">{r.system_category || '—'}</td>
                          <td className="px-2 py-1.5">{r.frequency || '—'}</td>
                          <td className="px-2 py-1.5">
                            {r.hod_name || '—'}
                            {r.hod_id && <span className="text-emerald-600" title="matched to an ERP user"> ✓</span>}
                          </td>
                          <td className="px-2 py-1.5">
                            {r.duplicate
                              ? <span className="text-amber-700">{r.duplicate}</span>
                              : <span className="text-emerald-700 font-semibold">will be registered</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="flex flex-wrap justify-end gap-2 pt-1">
              <button onClick={() => setBulk(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-slate-50">Cancel</button>
              <button onClick={() => runBulk(false)} disabled={saving || (!bulk.file_b64 && !bulk.text.trim())}
                      className="px-4 py-2 text-sm border rounded-lg hover:bg-slate-50 disabled:opacity-50">
                {saving && !bulk.preview ? 'Reading…' : 'Check the sheet'}
              </button>
              <button onClick={() => runBulk(true)} disabled={saving || !bulk.preview || !bulk.preview.importable}
                      className="px-4 py-2 text-sm font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {bulk.preview ? `Register ${bulk.preview.importable} system${bulk.preview.importable === 1 ? '' : 's'}` : 'Register'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Create System — the sheet's photo 4 */}
      <Modal isOpen={!!create} onClose={() => setCreate(null)} title="Create System">
        {create && (
          <div className="space-y-3">
            <p className="text-xs text-slate-500">
              The UID and timestamp are set automatically, and the {steps.length} steps are created with it.
            </p>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">System name *</label>
              <input autoFocus value={create.system_name} onChange={(e) => setCreate({ ...create, system_name: e.target.value })}
                     className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="e.g. Daily DPR review" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Type</label>
                <input list="sf-types" value={create.type} onChange={(e) => setCreate({ ...create, type: e.target.value })}
                       className="w-full border rounded-lg px-3 py-2 text-sm" />
                <datalist id="sf-types">{(meta.types || []).map((v) => <option key={v} value={v} />)}</datalist>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">System category</label>
                <input list="sf-cats" value={create.system_category} onChange={(e) => setCreate({ ...create, system_category: e.target.value })}
                       className="w-full border rounded-lg px-3 py-2 text-sm" />
                <datalist id="sf-cats">{(meta.categories || []).map((v) => <option key={v} value={v} />)}</datalist>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Frequency</label>
                <input list="sf-freq" value={create.frequency} onChange={(e) => setCreate({ ...create, frequency: e.target.value })}
                       className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="Daily / Weekly / Monthly" />
                <datalist id="sf-freq">{(meta.frequencies || []).map((v) => <option key={v} value={v} />)}</datalist>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">HOD</label>
                <select value={create.hod_id} onChange={(e) => setCreate({ ...create, hod_id: e.target.value })}
                        className="w-full border rounded-lg px-3 py-2 text-sm">
                  <option value="">— not in the ERP —</option>
                  {(meta.users || []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
            </div>
            {!create.hod_id && (
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">HOD's name (if not an ERP user)</label>
                <input value={create.hod_name} onChange={(e) => setCreate({ ...create, hod_name: e.target.value })}
                       className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
            )}
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Remarks</label>
              <textarea rows={2} value={create.remarks} onChange={(e) => setCreate({ ...create, remarks: e.target.value })}
                        className="w-full border rounded-lg px-3 py-2 text-sm" />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setCreate(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-slate-50">Cancel</button>
              <button onClick={submitCreate} disabled={saving || !create.system_name.trim()}
                      className="px-4 py-2 text-sm font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {saving ? 'Creating…' : 'Create System'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Edit the system header */}
      <Modal isOpen={!!editSys} onClose={() => setEditSys(null)} title={editSys ? `Edit ${editSys.uid}` : ''}>
        {editSys && (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">System name *</label>
              <input value={editSys.system_name || ''} onChange={(e) => setEditSys({ ...editSys, system_name: e.target.value })}
                     className="w-full border rounded-lg px-3 py-2 text-sm" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Type</label>
                <input value={editSys.type || ''} onChange={(e) => setEditSys({ ...editSys, type: e.target.value })}
                       className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">System category</label>
                <input value={editSys.system_category || ''} onChange={(e) => setEditSys({ ...editSys, system_category: e.target.value })}
                       className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Frequency</label>
                <input value={editSys.frequency || ''} onChange={(e) => setEditSys({ ...editSys, frequency: e.target.value })}
                       className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">HOD</label>
                <select value={editSys.hod_id || ''} onChange={(e) => setEditSys({ ...editSys, hod_id: e.target.value })}
                        className="w-full border rounded-lg px-3 py-2 text-sm">
                  <option value="">— not in the ERP —</option>
                  {(meta.users || []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setEditSys(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-slate-50">Cancel</button>
              <button onClick={submitSys} disabled={saving}
                      className="px-4 py-2 text-sm font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Work one step */}
      <Modal isOpen={!!editStep} onClose={() => setEditStep(null)}
             title={editStep ? `Step ${editStep.step.step_no} · ${editStep.tpl.step_name}` : ''}>
        {editStep && (
          <div className="space-y-3">
            <div className="bg-slate-50 border rounded-lg px-3 py-2 text-xs text-slate-600">
              <b>{editStep.system.uid}</b> · {editStep.system.system_name}
              <div className="mt-0.5">
                {editStep.tpl.owner_label} · {editStep.tpl.method} · planned {editStep.tpl.planned_days} day(s)
                {editStep.step.planned_date && <> · planned for <b>{fmtDate(editStep.step.planned_date)}</b></>}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Actual date</label>
                <input type="date" value={editStep.draft.actual_date} disabled={editStep.locked}
                       onChange={(e) => setEditStep({ ...editStep, draft: { ...editStep.draft, actual_date: e.target.value } })}
                       className="w-full border rounded-lg px-3 py-2 text-sm disabled:bg-slate-100 disabled:text-slate-400" />
                {editStep.locked && (
                  <p className="text-[11px] text-amber-700 mt-1 inline-flex items-center gap-1">
                    <FiLock size={10} /> Finish {editStep.prevName} first — the steps run in order.
                  </p>
                )}
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Planned days</label>
                <input type="number" min="0" value={editStep.draft.planned_days}
                       onChange={(e) => setEditStep({ ...editStep, draft: { ...editStep.draft, planned_days: e.target.value } })}
                       className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Who did it</label>
              <select value={editStep.draft.owner_id}
                      onChange={(e) => setEditStep({ ...editStep, draft: { ...editStep.draft, owner_id: e.target.value } })}
                      className="w-full border rounded-lg px-3 py-2 text-sm">
                <option value="">— {editStep.tpl.owner_label} —</option>
                {(meta.users || []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>

            {/* The step's own extra column, exactly as the sheet defines it */}
            {(editStep.tpl.extra === 'proof' || editStep.tpl.extra === 'proof_person') && (
              <div className="grid grid-cols-1 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1 inline-flex items-center gap-1">
                    <FiUpload size={12} /> Upload proof (link)
                  </label>
                  <input value={editStep.draft.proof_url} placeholder="paste the file link"
                         onChange={(e) => setEditStep({ ...editStep, draft: { ...editStep.draft, proof_url: e.target.value } })}
                         className="w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
                {editStep.tpl.extra === 'proof_person' && (
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Person's name</label>
                    <input value={editStep.draft.person_name}
                           onChange={(e) => setEditStep({ ...editStep, draft: { ...editStep.draft, person_name: e.target.value } })}
                           className="w-full border rounded-lg px-3 py-2 text-sm" />
                  </div>
                )}
              </div>
            )}
            {editStep.tpl.extra === 'pc_name' && (
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">PC name</label>
                <input value={editStep.draft.pc_name}
                       onChange={(e) => setEditStep({ ...editStep, draft: { ...editStep.draft, pc_name: e.target.value } })}
                       className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
            )}
            {editStep.tpl.extra === 'score' && (
              <div className="bg-violet-50 border border-violet-200 rounded-lg px-3 py-2">
                <div className="text-xs font-semibold text-violet-900">Score of system — calculated</div>
                <div className="text-3xl font-bold text-violet-800 mt-0.5">
                  {editStep.system.score_ready
                    ? editStep.system.system_score
                    : <span className="text-lg font-semibold text-violet-400">pending</span>}
                </div>
                <div className="text-[11px] text-violet-800 mt-1">
                  {editStep.system.score_ready
                    ? <>100 − 5 per late day · {editStep.system.score_late_days} late day
                        {editStep.system.score_late_days === 1 ? '' : 's'} across steps 1–3</>
                    : <>It is worked out once steps 1, 2 and 3 all have an actual date.</>}
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Remarks</label>
              <textarea rows={2} value={editStep.draft.remarks}
                        onChange={(e) => setEditStep({ ...editStep, draft: { ...editStep.draft, remarks: e.target.value } })}
                        className="w-full border rounded-lg px-3 py-2 text-sm" />
            </div>
            <p className="text-[11px] text-slate-500 inline-flex items-center gap-1">
              <FiClock size={11} /> Saving an actual date moves the planned dates of the steps behind this one.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setEditStep(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-slate-50">Cancel</button>
              <button onClick={submitStep} disabled={saving}
                      className="px-4 py-2 text-sm font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {saving ? 'Saving…' : 'Save step'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
