// Per-employee MIS scorecard matching the SEPL Google Sheet format mam
// shared on 2026-05-04. Three tabs:
//   - My Scorecard  : current user's MIS for the picked week, editable
//   - Team Overview : all employees' weekly score (existing dashboard)
//   - Templates     : admin manages KPI templates per role
//   - Assign        : admin maps each user to a template

import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiTrendingUp, FiCalendar, FiEdit2, FiSave, FiUsers, FiSettings, FiPlus, FiTrash2, FiUser } from 'react-icons/fi';

const lastMonday = (offsetWeeks = 0) => {
  const d = new Date();
  const dow = d.getDay();
  const offset = dow === 0 ? -6 : (1 - dow);
  d.setDate(d.getDate() + offset - (offsetWeeks * 7));
  return d.toISOString().slice(0, 10);
};

const fmtRange = (start) => {
  const s = new Date(start), e = new Date(start);
  e.setDate(s.getDate() + 5);
  const month = (m) => ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m];
  return `${s.getDate()} ${month(s.getMonth())} – ${e.getDate()} ${month(e.getMonth())} ${e.getFullYear()}`;
};

const scorePill = (s) => {
  if (s == null) return 'bg-gray-100 text-gray-500';
  if (s >= 0) return 'bg-emerald-100 text-emerald-700';
  if (s >= -25) return 'bg-blue-100 text-blue-700';
  if (s >= -50) return 'bg-amber-100 text-amber-700';
  return 'bg-red-100 text-red-700';
};

export default function Scorecard() {
  const { user, isAdmin } = useAuth();
  const [tab, setTab] = useState('my');
  const [weekStart, setWeekStart] = useState(lastMonday(0));
  const [viewUserId, setViewUserId] = useState(user?.id);
  const [scorecard, setScorecard] = useState(null);
  const [savingKpi, setSavingKpi] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [tplDetail, setTplDetail] = useState(null);
  const [overview, setOverview] = useState(null);

  const loadScorecard = useCallback(() => {
    api.get(`/scoring/scorecard?user_id=${viewUserId}&week_start=${weekStart}`)
      .then(r => setScorecard(r.data))
      .catch(err => toast.error(err.response?.data?.error || 'Failed'));
  }, [viewUserId, weekStart]);

  const loadOverview = useCallback(() => {
    api.get(`/scoring/weekly?week_start=${weekStart}`)
      .then(r => setOverview(r.data))
      .catch(() => setOverview(null));
  }, [weekStart]);

  useEffect(() => {
    if (tab === 'my' || tab === 'view') loadScorecard();
    if (tab === 'overview') loadOverview();
    if (tab === 'templates') api.get('/scoring/templates').then(r => setTemplates(r.data || [])).catch(() => {});
    if (tab === 'assign') {
      Promise.all([
        api.get('/scoring/assignments').then(r => r.data),
        api.get('/scoring/templates').then(r => r.data),
      ]).then(([a, t]) => { setAssignments(a || []); setTemplates(t || []); }).catch(() => {});
    }
  }, [tab, loadScorecard, loadOverview]);

  const saveEntry = async (kpi, patch) => {
    setSavingKpi(kpi.kpi_id);
    try {
      await api.put('/scoring/scorecard/entry', {
        user_id: viewUserId,
        kpi_id: kpi.kpi_id,
        week_start: weekStart,
        ...patch,
      });
      // Reload to get fresh totals
      loadScorecard();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    } finally {
      setSavingKpi(null);
    }
  };

  // Group KPIs by group_name for the table render
  const grouped = (scorecard?.kpis || []).reduce((acc, k) => {
    const g = k.group_name || 'Other';
    if (!acc[g]) acc[g] = [];
    acc[g].push(k);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><FiTrendingUp className="text-indigo-600" /> Scorecard</h1>
          <p className="text-sm text-gray-500">Weekly MIS — Mon-Sat. Per-role KPI templates with planned vs actual and weighted score.</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        <button onClick={() => { setTab('my'); setViewUserId(user.id); }}
          className={`btn ${tab === 'my' ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1`}>
          <FiUser size={14} /> My Scorecard
        </button>
        <button onClick={() => setTab('overview')}
          className={`btn ${tab === 'overview' ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1`}>
          <FiUsers size={14} /> Team Overview
        </button>
        {isAdmin() && (
          <>
            <button onClick={() => setTab('templates')}
              className={`btn ${tab === 'templates' ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1`}>
              <FiSettings size={14} /> Templates
            </button>
            <button onClick={() => setTab('assign')}
              className={`btn ${tab === 'assign' ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1`}>
              <FiUsers size={14} /> Assign Templates
            </button>
          </>
        )}
      </div>

      {(tab === 'my' || tab === 'overview' || tab === 'view') && (
        <div className="card p-4 flex flex-wrap items-center gap-3">
          <FiCalendar className="text-gray-400" />
          <div>
            <label className="label">Week starting (Monday)</label>
            <input type="date" className="input" value={weekStart} onChange={e => setWeekStart(e.target.value)} />
          </div>
          <div className="flex gap-1">
            <button onClick={() => setWeekStart(lastMonday(1))} className="btn btn-secondary text-xs">Last Week</button>
            <button onClick={() => setWeekStart(lastMonday(0))} className="btn btn-secondary text-xs">This Week</button>
            <button onClick={() => setWeekStart(lastMonday(2))} className="btn btn-secondary text-xs">Two Weeks Ago</button>
          </div>
          {/* Admin-only employee switcher — pick anyone to inspect their MIS
              without leaving the My Scorecard tab. */}
          {(tab === 'my' || tab === 'view') && isAdmin() && (
            <EmployeeSwitcher value={viewUserId} onChange={setViewUserId} />
          )}
          <div className="ml-auto text-sm text-gray-700">
            <span className="font-semibold">{fmtRange(weekStart)}</span>
          </div>
        </div>
      )}

      {/* MY SCORECARD */}
      {(tab === 'my' || tab === 'view') && scorecard && (
        <>
          <div className="card p-4 flex flex-wrap items-center justify-between gap-3 bg-gradient-to-r from-indigo-50 to-blue-50">
            <div>
              <p className="text-xs text-gray-500">Template</p>
              <p className="text-lg font-bold">{scorecard.template?.name || <span className="text-amber-600">No template assigned</span>}</p>
              {scorecard.template?.description && <p className="text-xs text-gray-500">{scorecard.template.description}</p>}
            </div>
            <div className="text-right">
              <p className="text-xs text-gray-500">Weekly Score</p>
              <p className={`text-3xl font-bold ${scorecard.score >= 0 ? 'text-emerald-700' : scorecard.score >= -50 ? 'text-amber-700' : 'text-red-700'}`}>
                {scorecard.score?.toFixed(2) || '0.00'}%
              </p>
            </div>
          </div>

          {!scorecard.template && (
            <div className="card p-6 text-center text-gray-400 text-sm">
              No template assigned to this user yet. {isAdmin() && <span>Open the <button className="text-blue-600 underline" onClick={() => setTab('assign')}>Assign Templates</button> tab to set one.</span>}
            </div>
          )}

          {scorecard.template && Object.keys(grouped).map(groupName => (
            <div key={groupName} className="card p-0 overflow-x-auto">
              <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 font-bold text-amber-800 text-sm">{groupName}</div>
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-[10px] text-gray-500 uppercase">
                  <tr>
                    <th className="text-left p-2 w-[260px]">Team / Person</th>
                    <th className="text-center p-2 w-16">Weight %</th>
                    <th className="text-center p-2 w-20">Last Week %</th>
                    <th className="text-center p-2 w-24">Planned</th>
                    <th className="text-center p-2 w-24">Actual</th>
                    <th className="text-center p-2 w-20">Actual %</th>
                    <th className="text-center p-2 w-20">Total Up-to-date</th>
                    <th className="text-center p-2 w-20">Pending</th>
                    <th className="text-left p-2">Commitment</th>
                  </tr>
                </thead>
                <tbody>
                  {grouped[groupName].map(k => (
                    <KpiRow
                      key={k.kpi_id}
                      kpi={k}
                      saving={savingKpi === k.kpi_id}
                      onSave={(patch) => saveEntry(k, patch)}
                      readOnly={viewUserId !== user.id && !isAdmin()}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </>
      )}

      {/* TEAM OVERVIEW (existing weekly aggregator) */}
      {tab === 'overview' && overview && (
        <div className="card p-0 overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Rank</th>
                <th>Employee</th>
                <th>Dept</th>
                <th className="text-center">Delegations</th>
                <th className="text-center">PMS</th>
                <th className="text-center">Checklists</th>
                <th className="text-center">Tickets</th>
                <th className="text-right">Score</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {overview.users.map((u, i) => (
                <tr key={u.user_id}>
                  <td className="text-gray-400 font-bold">#{i + 1}</td>
                  <td className="font-medium">{u.name}</td>
                  <td className="text-xs text-gray-500">{u.department || u.role}</td>
                  <td className="text-center">{u.delegations.done}/{u.delegations.given}</td>
                  <td className="text-center">{u.pms.done}/{u.pms.given}</td>
                  <td className="text-center">{u.checklists.done}/{u.checklists.given}</td>
                  <td className="text-center">{u.tickets.done}/{u.tickets.given}</td>
                  <td className="text-right">
                    <span className={`px-2 py-1 rounded text-xs font-bold ${scorePill(u.score - 100)}`}>{u.score}%</span>
                  </td>
                  <td>
                    <button onClick={() => { setViewUserId(u.user_id); setTab('view'); }} className="btn btn-secondary text-xs">Open MIS</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* TEMPLATES (admin) */}
      {tab === 'templates' && (
        <TemplatesAdmin templates={templates} reload={() => api.get('/scoring/templates').then(r => setTemplates(r.data))} setTplDetail={setTplDetail} />
      )}

      {/* ASSIGN (admin) */}
      {tab === 'assign' && (
        <AssignTemplates assignments={assignments} templates={templates} reload={() => api.get('/scoring/assignments').then(r => setAssignments(r.data))} />
      )}

      {/* Template detail modal */}
      <Modal isOpen={!!tplDetail} onClose={() => setTplDetail(null)} title={tplDetail?.name || 'Template'} wide>
        {tplDetail && <TemplateKpiEditor templateId={tplDetail.id} onChange={() => api.get(`/scoring/templates/${tplDetail.id}`).then(r => setTplDetail(r.data))} />}
      </Modal>
    </div>
  );
}

// ---------- Employee Switcher (admin) ----------
function EmployeeSwitcher({ value, onChange }) {
  const [users, setUsers] = useState([]);
  useEffect(() => {
    api.get('/scoring/assignments').then(r => setUsers(r.data || [])).catch(() => {});
  }, []);
  return (
    <div>
      <label className="label">View as</label>
      <select className="select" value={value || ''} onChange={e => onChange(+e.target.value)}>
        {users.map(u => (
          <option key={u.user_id} value={u.user_id}>
            {u.name} {u.template_name ? `— ${u.template_name}` : '(no template)'}
          </option>
        ))}
      </select>
    </div>
  );
}

// ---------- KPI Row (editable) ----------
function KpiRow({ kpi, saving, onSave, readOnly }) {
  const [planned, setPlanned] = useState(kpi.planned ?? 0);
  const [actual, setActual] = useState(kpi.actual ?? 0);
  const [pendingUp, setPendingUp] = useState(kpi.pending_uptodate ?? '');
  const [pendingWork, setPendingWork] = useState(kpi.pending_work ?? '');
  const [commitment, setCommitment] = useState(kpi.commitment ?? '');
  const [totalUp, setTotalUp] = useState(kpi.total_uptodate ?? '');
  useEffect(() => {
    setPlanned(kpi.planned ?? 0);
    setActual(kpi.actual ?? 0);
    setPendingUp(kpi.pending_uptodate ?? '');
    setPendingWork(kpi.pending_work ?? '');
    setCommitment(kpi.commitment ?? '');
    setTotalUp(kpi.total_uptodate ?? '');
  }, [kpi.kpi_id, kpi.planned, kpi.actual, kpi.pending_uptodate, kpi.pending_work, kpi.commitment, kpi.total_uptodate]);

  const flush = () => {
    if (readOnly) return;
    onSave({
      planned: Number(planned) || 0,
      actual: Number(actual) || 0,
      pending_uptodate: pendingUp === '' ? null : Number(pendingUp),
      pending_work: pendingWork === '' ? null : Number(pendingWork),
      total_uptodate: totalUp === '' ? null : Number(totalUp),
      commitment: commitment || null,
    });
  };

  const pctClr = kpi.actual_pct >= 0 ? 'text-emerald-700' : kpi.actual_pct >= -50 ? 'text-amber-700' : 'text-red-700';
  const isAuto = kpi.is_auto;

  return (
    <tr className={`border-t ${saving ? 'bg-amber-50' : ''}`}>
      <td className="p-2">
        <div className="font-medium">{kpi.metric_name}</div>
        <div className="text-[10px] text-gray-500">
          {kpi.direction === 'lower_better' && <span className="text-blue-600">↓ lower better</span>}
          {kpi.direction !== 'lower_better' && <span className="text-emerald-600">↑ higher better</span>}
          {isAuto && <span className="ml-2 px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-[9px] font-bold">AUTO</span>}
        </div>
      </td>
      <td className="text-center p-2">{kpi.weightage}%</td>
      <td className="text-center p-2">
        {kpi.last_week_pct != null ? <span className={kpi.last_week_pct >= 0 ? 'text-emerald-600' : 'text-red-600'}>{kpi.last_week_pct}%</span> : <span className="text-gray-300">—</span>}
      </td>
      <td className="text-center p-2">
        {isAuto ? <span className="text-gray-700">{planned}</span> :
          <input type="number" className="input text-center text-xs w-20 mx-auto" value={planned} onChange={e => setPlanned(e.target.value)} onBlur={flush} disabled={readOnly} />}
      </td>
      <td className="text-center p-2">
        {isAuto ? <span className="text-gray-700">{actual}</span> :
          <input type="number" className="input text-center text-xs w-20 mx-auto" value={actual} onChange={e => setActual(e.target.value)} onBlur={flush} disabled={readOnly} />}
      </td>
      <td className={`text-center p-2 font-bold ${pctClr}`}>{kpi.actual_pct}%</td>
      <td className="text-center p-2">
        <input type="number" className="input text-center text-xs w-20 mx-auto" value={totalUp} onChange={e => setTotalUp(e.target.value)} onBlur={flush} disabled={readOnly} />
      </td>
      <td className="text-center p-2">
        <div className="flex items-center justify-center gap-1">
          <input type="number" className="input text-center text-xs w-16" placeholder="up" value={pendingUp} onChange={e => setPendingUp(e.target.value)} onBlur={flush} disabled={readOnly} />
          <span className="text-gray-300">/</span>
          <input type="number" className="input text-center text-xs w-16" placeholder="wk" value={pendingWork} onChange={e => setPendingWork(e.target.value)} onBlur={flush} disabled={readOnly} />
        </div>
      </td>
      <td className="p-2">
        <input type="text" className="input text-xs w-full" placeholder="…" value={commitment} onChange={e => setCommitment(e.target.value)} onBlur={flush} disabled={readOnly} />
      </td>
    </tr>
  );
}

// ---------- Templates Admin ----------
function TemplatesAdmin({ templates, reload, setTplDetail }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const create = async (e) => {
    e.preventDefault();
    try {
      await api.post('/scoring/templates', { name, description });
      toast.success('Template created');
      setName(''); setDescription(''); setAdding(false);
      reload();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const del = async (t) => {
    if (!confirm(`Delete template "${t.name}" and all its KPIs?`)) return;
    try { await api.delete(`/scoring/templates/${t.id}`); toast.success('Deleted'); reload(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <p className="text-sm text-gray-500">Per-role KPI templates. Edit weights / metrics / data sources here. Mam pre-seeded 20 templates from your MIS PDFs.</p>
        <button onClick={() => setAdding(true)} className="btn btn-primary text-sm flex items-center gap-1"><FiPlus size={14} /> New Template</button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {templates.map(t => (
          <div key={t.id} className="card p-4 hover:shadow-md transition cursor-pointer" onClick={() => api.get(`/scoring/templates/${t.id}`).then(r => setTplDetail(r.data))}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-bold text-sm">{t.name}</div>
                {t.description && <p className="text-[11px] text-gray-500 mt-0.5">{t.description}</p>}
              </div>
              <button onClick={(e) => { e.stopPropagation(); del(t); }} className="text-red-500 hover:text-red-700"><FiTrash2 size={14} /></button>
            </div>
            <div className="flex gap-3 mt-3 text-[10px] text-gray-500">
              <span>{t.kpi_count} KPIs</span>
              <span>{t.user_count} assigned</span>
            </div>
          </div>
        ))}
      </div>

      <Modal isOpen={adding} onClose={() => setAdding(false)} title="New Template">
        <form onSubmit={create} className="space-y-3">
          <div><label className="label">Name *</label><input className="input" required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Site Engineer" /></div>
          <div><label className="label">Description</label><input className="input" value={description} onChange={e => setDescription(e.target.value)} placeholder="What this role's KPIs measure" /></div>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setAdding(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Create</button></div>
        </form>
      </Modal>
    </div>
  );
}

// ---------- Template KPI Editor ----------
function TemplateKpiEditor({ templateId, onChange }) {
  const [tpl, setTpl] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ group_name: 'Weekly', metric_name: '', weightage: 0, direction: 'higher_better', data_source: 'manual', default_planned: 0 });

  const load = useCallback(() => {
    api.get(`/scoring/templates/${templateId}`).then(r => setTpl(r.data));
  }, [templateId]);
  useEffect(() => { load(); }, [load]);

  const addKpi = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/scoring/templates/${templateId}/kpis`, form);
      setForm({ group_name: 'Weekly', metric_name: '', weightage: 0, direction: 'higher_better', data_source: 'manual', default_planned: 0 });
      setAdding(false);
      load(); onChange?.();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const updateKpi = async (k, patch) => {
    try { await api.put(`/scoring/kpis/${k.id}`, patch); load(); onChange?.(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const delKpi = async (k) => {
    if (!confirm(`Delete KPI "${k.metric_name}"?`)) return;
    try { await api.delete(`/scoring/kpis/${k.id}`); load(); onChange?.(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  if (!tpl) return <div className="text-gray-400 text-center py-6">Loading…</div>;

  const totalWeight = (tpl.kpis || []).reduce((s, k) => s + (k.weightage || 0), 0);

  return (
    <div className="space-y-3 max-h-[70vh] overflow-y-auto">
      <div className="flex justify-between items-center">
        <p className="text-xs text-gray-500">Total weight: <span className={`font-bold ${totalWeight === 100 ? 'text-emerald-600' : 'text-amber-600'}`}>{totalWeight}%</span> {totalWeight !== 100 && '(should be 100)'}</p>
        <button onClick={() => setAdding(true)} className="btn btn-primary text-xs flex items-center gap-1"><FiPlus size={12} /> Add KPI</button>
      </div>
      <table className="w-full text-xs">
        <thead className="bg-gray-50">
          <tr>
            <th className="text-left p-2">Group</th>
            <th className="text-left p-2">Metric</th>
            <th className="text-center p-2 w-16">Weight</th>
            <th className="text-center p-2 w-20">Target</th>
            <th className="text-center p-2 w-24">Direction</th>
            <th className="text-center p-2 w-32">Source</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {tpl.kpis.map(k => (
            <tr key={k.id} className="border-t">
              <td className="p-2"><input className="input text-xs" defaultValue={k.group_name} onBlur={e => updateKpi(k, { group_name: e.target.value })} /></td>
              <td className="p-2"><input className="input text-xs" defaultValue={k.metric_name} onBlur={e => updateKpi(k, { metric_name: e.target.value })} /></td>
              <td className="p-2"><input type="number" className="input text-xs text-center" defaultValue={k.weightage} onBlur={e => updateKpi(k, { weightage: +e.target.value })} /></td>
              <td className="p-2"><input type="number" step="0.1" className="input text-xs text-center" defaultValue={k.default_planned || 0} onBlur={e => updateKpi(k, { default_planned: +e.target.value })} title="Fixed weekly Planned target" /></td>
              <td className="p-2">
                <select className="select text-xs" defaultValue={k.direction} onChange={e => updateKpi(k, { direction: e.target.value })}>
                  <option value="higher_better">↑ higher</option>
                  <option value="lower_better">↓ lower</option>
                </select>
              </td>
              <td className="p-2">
                <select className="select text-xs" defaultValue={k.data_source} onChange={e => updateKpi(k, { data_source: e.target.value })}>
                  <option value="manual">manual entry</option>
                  <option value="auto:delegations">auto: delegations</option>
                  <option value="auto:pms">auto: pms tasks</option>
                  <option value="auto:checklists">auto: checklists</option>
                  <option value="auto:tickets">auto: tickets</option>
                  <option value="auto:dpr_profit">auto: DPR profit (planned vs actual ₹)</option>
                  <option value="auto:dpr_count">auto: DPR count (6 days/week target)</option>
                  <option value="auto:dpr_by_user">auto: DPR submitted BY user (count)</option>
                  <option value="auto:dpr_profit_by_user">auto: DPR profit/loss SUM (by user)</option>
                  <option value="auto:dpr_cost_by_user">auto: DPR submitted vs approved (by user)</option>
                  <option value="auto:indents_in_week">auto: indents created (site)</option>
                  <option value="auto:mb_signed">auto: MB signed by client (site)</option>
                  <option value="auto:ra_bills">auto: RA bills raised (site)</option>
                  <option value="auto:material_received">auto: material received (delivery notes)</option>
                  <option value="auto:stock_updates">auto: stock updates (per site/week)</option>
                  <option value="auto:tools_list">auto: tools list submission (per site)</option>
                  <option value="auto:stock_at_site">auto: stock at site flag</option>
                </select>
              </td>
              <td className="p-2"><button onClick={() => delKpi(k)} className="text-red-500 hover:text-red-700"><FiTrash2 size={12} /></button></td>
            </tr>
          ))}
        </tbody>
      </table>

      {adding && (
        <form onSubmit={addKpi} className="border-t pt-3 grid grid-cols-2 gap-2">
          <input className="input text-sm" placeholder="Group (e.g. Weekly)" value={form.group_name} onChange={e => setForm(f => ({ ...f, group_name: e.target.value }))} />
          <input className="input text-sm" placeholder="Metric name" required value={form.metric_name} onChange={e => setForm(f => ({ ...f, metric_name: e.target.value }))} />
          <input type="number" className="input text-sm" placeholder="Weight %" value={form.weightage} onChange={e => setForm(f => ({ ...f, weightage: +e.target.value }))} />
          <input type="number" step="0.1" className="input text-sm" placeholder="Default Target (fixed Planned)" value={form.default_planned} onChange={e => setForm(f => ({ ...f, default_planned: +e.target.value }))} />
          <select className="select text-sm" value={form.direction} onChange={e => setForm(f => ({ ...f, direction: e.target.value }))}>
            <option value="higher_better">↑ higher better</option>
            <option value="lower_better">↓ lower better</option>
          </select>
          <select className="select text-sm col-span-2" value={form.data_source} onChange={e => setForm(f => ({ ...f, data_source: e.target.value }))}>
            <option value="manual">manual entry</option>
            <option value="auto:delegations">auto: delegations</option>
            <option value="auto:pms">auto: pms tasks</option>
            <option value="auto:checklists">auto: checklists</option>
            <option value="auto:tickets">auto: tickets</option>
          </select>
          <div className="col-span-2 flex justify-end gap-2">
            <button type="button" onClick={() => setAdding(false)} className="btn btn-secondary text-sm">Cancel</button>
            <button type="submit" className="btn btn-primary text-sm">Add</button>
          </div>
        </form>
      )}
    </div>
  );
}

// ---------- Assign Templates ----------
function AssignTemplates({ assignments, templates, reload }) {
  const setTpl = async (uid, tid) => {
    try { await api.put(`/scoring/assignments/${uid}`, { template_id: tid || null }); reload(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  return (
    <div className="card p-0 overflow-x-auto">
      <table>
        <thead><tr><th>Employee</th><th>Dept</th><th>Role</th><th>Template</th></tr></thead>
        <tbody>
          {assignments.map(a => (
            <tr key={a.user_id}>
              <td className="font-medium">{a.name}</td>
              <td className="text-xs text-gray-500">{a.department || '-'}</td>
              <td className="text-xs text-gray-500">{a.role}</td>
              <td>
                <select className="select text-sm" value={a.template_id || ''} onChange={e => setTpl(a.user_id, e.target.value ? +e.target.value : null)}>
                  <option value="">— None —</option>
                  {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
