// SOP-09 Site Work & Daily Report Board (owner: Project Manager — Adarsh Kumar)
// Reference flow board using the shared FlowBoard shell.
// 6 Stages (SOP-09.1 to SOP-09.6):
//   S1: Ready Checklist Master (Work starts ONLY when checklist is complete — 7 pillars)
//   S2: Daily Report (Mobile) (Work done, manpower, photo proof, 5 min)
//   S3: Problem to Task (Every problem becomes a task — one name, one date)
//   S4: Buffer & Plan Update (System compares actual with plan and updates buffer)
//   S5: Colour Rule (Green / Yellow / Red action rule — 15-min standup for reds)
//   S6: Closing Quality & Safety Checklist (No photo, no closure)

import { useState, useRef, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import FlowBoard from '../components/FlowBoard';
import Modal from '../components/Modal';
import SiteWorkRaciModal from '../components/SiteWorkRaciModal';
import api from '../api';
import toast from 'react-hot-toast';
import {
  FiCheckSquare,
  FiSmartphone,
  FiAlertCircle,
  FiTrendingUp,
  FiActivity,
  FiShield,
  FiPlus,
  FiUser,
  FiCalendar,
  FiFileText,
  FiCheckCircle,
  FiUsers,
  FiCamera,
  FiAlertTriangle,
  FiCheck,
  FiX,
  FiClock,
} from 'react-icons/fi';

const STAGE_LINKS = {
  ready_checklist: '/checklists',
  daily_report: '/dpr?tab=reports',
  problem_task: '/pms-tasks',
  buffer_update: '/dpr?tab=dashboard',
  rag_status: '/dpr',
  closing_checklist: '/checklists',
};

const STAGE_ICONS = {
  ready_checklist: FiCheckSquare,
  daily_report: FiSmartphone,
  problem_task: FiAlertCircle,
  buffer_update: FiTrendingUp,
  rag_status: FiActivity,
  closing_checklist: FiShield,
};

export default function SiteWorkBoard() {
  const reloadRef = useRef(null);

  // Users for assigning tasks
  const [users, setUsers] = useState([]);
  const [sop09Raci, setSop09Raci] = useState(null);
  const [raciModalOpen, setRaciModalOpen] = useState(false);
  const [onlyRedsFilter, setOnlyRedsFilter] = useState(false);

  const loadRaci = useCallback(() => {
    api.get('/dpr/raci')
      .then(r => setSop09Raci(r.data?.raci || null))
      .catch(() => {});
  }, []);

  useEffect(() => {
    api.get('/auth/users?active_only=1').then(r => setUsers(r.data || [])).catch(() => {});
    loadRaci();
  }, [loadRaci]);

  // Action Popup State
  const [actModal, setActModal] = useState(null); // { stage, card, reload }
  
  // S1 Checklist Form
  const [s1Form, setS1Form] = useState({
    drawing_ok: false,
    material_ok: false,
    space_ok: false,
    men_ok: false,
    tools_ok: false,
    safety_ok: false,
    client_ok: false,
    remarks: '',
    work_area: 'Main Work Area',
  });
  const [s1Loading, setS1Loading] = useState(false);
  const [s1Saving, setS1Saving] = useState(false);

  // S3 Task Form
  const [taskForm, setTaskForm] = useState({ title: '', assigned_to: '', due_date: '', description: '' });
  const [savingTask, setSavingTask] = useState(false);

  // S6 Closing Form
  const [s6Form, setS6Form] = useState({
    work_area: 'Main Work Area',
    quality_ok: false,
    safety_ok: false,
    photos: '',
    remarks: '',
  });
  const [s6Saving, setS6Saving] = useState(false);

  // Dynamic Assignee Resolution using SOP-09 RACI
  const resolveAssignee = (cardTitle = '') => {
    const text = String(cardTitle || '').toLowerCase();

    // 1. Manpower / Labour issue -> HR Incharge (Default: Ruksana; dynamic via RACI hr_lead)
    if (text.includes('manpower') || text.includes('labour') || text.includes('labor') || text.includes('worker') || text.includes('contractor') || text.includes('attendance')) {
      if (sop09Raci?.hr_lead?.user_id) return String(sop09Raci.hr_lead.user_id);
      const u = users.find(u => (u.name && u.name.toLowerCase().includes('ruksana')) || (u.role && (u.role.toLowerCase() === 'hr' || u.role.toLowerCase() === 'labour')));
      if (u) return String(u.id);
    }

    // 2. Material / Item issue -> Purchase Head (Awadhesh Kumar Sharma / Anmol / RACI purchase_lead)
    if (text.includes('mat') || text.includes('item') || text.includes('stock') || text.includes('store') || text.includes('procurement') || text.includes('cement') || text.includes('pipe') || text.includes('delivery')) {
      if (sop09Raci?.purchase_lead?.user_id) return String(sop09Raci.purchase_lead.user_id);
      const u = users.find(u => (u.name && (u.name.toLowerCase().includes('awadhesh') || u.name.toLowerCase().includes('awdesh') || u.name.toLowerCase().includes('anmol'))) || (u.role && u.role.toLowerCase() === 'purchase'));
      if (u) return String(u.id);
    }

    // 3. Client / Space / Drawing / Approval issue -> CRM Coordinator (Lovely Sharma / RACI crm_lead)
    if (text.includes('client') || text.includes('space') || text.includes('clearance') || text.includes('permission') || text.includes('draw') || text.includes('design') || text.includes('crm')) {
      if (sop09Raci?.crm_lead?.user_id) return String(sop09Raci.crm_lead.user_id);
      const u = users.find(u => (u.name && u.name.toLowerCase().includes('lovely')) || (u.role && u.role.toLowerCase() === 'crm'));
      if (u) return String(u.id);
    }

    // 4. Money / Payment / Accounts issue -> Accounts Head (Pooja Kaplesh / Aanchal / RACI accounts_lead)
    if (text.includes('money') || text.includes('pay') || text.includes('fund') || text.includes('account') || text.includes('bill')) {
      if (sop09Raci?.accounts_lead?.user_id) return String(sop09Raci.accounts_lead.user_id);
      const u = users.find(u => (u.name && (u.name.toLowerCase().includes('pooja') || u.name.toLowerCase().includes('aanchal') || u.name.toLowerCase().includes('parul'))) || (u.role && (u.role.toLowerCase() === 'accounts' || u.role.toLowerCase() === 'finance')));
      if (u) return String(u.id);
    }

    // 5. Machinery / Tools issue -> Machinery Head (Ajmer / RACI machinery_lead)
    if (text.includes('machin') || text.includes('tool') || text.includes('equip') || text.includes('crane') || text.includes('welding') || text.includes('drill')) {
      if (sop09Raci?.machinery_lead?.user_id) return String(sop09Raci.machinery_lead.user_id);
      const u = users.find(u => (u.name && u.name.toLowerCase().includes('ajmer')) || (u.role && (u.role.toLowerCase() === 'machinery' || u.role.toLowerCase() === 'maintenance')));
      if (u) return String(u.id);
    }

    // Fallback: Project Manager (Adarsh Kumar / RACI pm_lead) or Admin
    if (sop09Raci?.pm_lead?.user_id) return String(sop09Raci.pm_lead.user_id);
    const defaultU = users.find(u => (u.name && u.name.toLowerCase().includes('adarsh')) || (u.role && u.role.toLowerCase() === 'admin'));
    return defaultU ? String(defaultU.id) : (users[0]?.id ? String(users[0].id) : '');
  };

  const openAction = (stage, card, reload) => {
    reloadRef.current = reload;
    setActModal({ stage, card, reload });

    if (stage === 'ready_checklist') {
      const siteId = card.rid;
      setS1Loading(true);
      api.get(`/dpr/sites/${siteId}/ready-checklist`)
        .then(r => {
          const chk = r.data;
          if (chk) {
            setS1Form({
              drawing_ok: !!chk.drawing_ok,
              material_ok: !!chk.material_ok,
              space_ok: !!chk.space_ok,
              men_ok: !!chk.men_ok,
              tools_ok: !!chk.tools_ok,
              safety_ok: !!chk.safety_ok,
              client_ok: !!chk.client_ok,
              remarks: chk.remarks || '',
              work_area: chk.work_area || 'Main Work Area',
            });
          } else {
            setS1Form({
              drawing_ok: false,
              material_ok: false,
              space_ok: false,
              men_ok: false,
              tools_ok: false,
              safety_ok: false,
              client_ok: false,
              remarks: '',
              work_area: 'Main Work Area',
            });
          }
        })
        .catch(() => {})
        .finally(() => setS1Loading(false));
    }

    if (stage === 'problem_task') {
      const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
      const preAssigned = resolveAssignee(card.title || card.problem || card.category || '');
      setTaskForm({
        title: card.title || 'Site Hindrance Resolution',
        assigned_to: preAssigned,
        due_date: tomorrow,
        description: `Site Hindrance: ${card.problem || card.title || ''}\nAuto-assigned via SOP-09.3 Problem-to-Task rule against ${card.ref}`,
      });
    }

    if (stage === 'closing_checklist') {
      setS6Form({
        work_area: 'Main Work Area',
        quality_ok: false,
        safety_ok: false,
        photos: '',
        remarks: '',
      });
    }
  };

  const closeAction = () => {
    setActModal(null);
  };

  // Save S1 Ready Checklist
  const handleSaveReadyChecklist = async (e) => {
    e.preventDefault();
    setS1Saving(true);
    try {
      const siteId = actModal?.card?.rid;
      const res = await api.post(`/dpr/sites/${siteId}/ready-checklist`, {
        ...s1Form,
        checklist_date: actModal?.card?.created_at || new Date().toISOString().slice(0, 10),
      });

      if (res.data?.is_ready) {
        toast.success(res.data.message || 'All 7 Pillars Complete: Ready to Start!');
      } else {
        toast('Checklist saved. Warning: Half-Ready = No Start!', { icon: '⚠️' });
      }

      closeAction();
      if (reloadRef.current) reloadRef.current();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save ready checklist');
    } finally {
      setS1Saving(false);
    }
  };

  // Convert problem to PMS Task (SOP-09.3 "one name, one date")
  const handleCreateTask = async (e) => {
    e.preventDefault();
    if (!taskForm.title.trim()) return toast.error('Task title is required');
    if (!taskForm.assigned_to) return toast.error('One assigned owner (name) is required (SOP-09.3)');
    if (!taskForm.due_date) return toast.error('One target date is required (SOP-09.3)');

    setSavingTask(true);
    try {
      await api.post('/dpr/problem-to-task', {
        title: taskForm.title,
        description: taskForm.description,
        assigned_to: taskForm.assigned_to,
        due_date: taskForm.due_date,
        site_id: actModal?.card?.site_id || actModal?.card?.rid,
        dpr_id: actModal?.card?.rid,
      });

      toast.success('Task created successfully (one name, one date)');
      closeAction();
      if (reloadRef.current) reloadRef.current();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to create task');
    } finally {
      setSavingTask(false);
    }
  };

  // Save S6 Closing Checklist
  const handleSaveClosingChecklist = async (e) => {
    e.preventDefault();
    if (!s6Form.photos.trim()) {
      return toast.error('Golden Rule SOP-09.6: "No photo, no closure." At least one photo URL is compulsory.');
    }

    setS6Saving(true);
    try {
      const siteId = actModal?.card?.rid;
      await api.post(`/dpr/sites/${siteId}/closing-checklist`, {
        ...s6Form,
        closing_date: new Date().toISOString().slice(0, 10),
        photos: s6Form.photos.split(',').map(s => s.trim()).filter(Boolean),
      });

      toast.success('Area closure verified with photo attachment (SOP-09.6)!');
      closeAction();
      if (reloadRef.current) reloadRef.current();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save closing checklist');
    } finally {
      setS6Saving(false);
    }
  };

  const cardAction = (stageKey, card, reload) => {
    return () => openAction(stageKey, card, reload);
  };

  const cardExtra = (stageKey, card, reload) => {
    if (stageKey === 'ready_checklist') {
      const isReady = card.is_ready;
      return (
        <div className="mt-1 flex items-center justify-between text-[10px]">
          <span className={`font-semibold px-1.5 py-0.5 rounded ${isReady ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
            {isReady ? '✓ 7/7 Pillars OK' : `Half-Ready (${card.missing_count || 'Pending'})`}
          </span>
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openAction(stageKey, card, reload);
            }}
            className="text-[10px] text-blue-600 hover:text-blue-800 font-medium underline"
          >
            Inspect / Edit
          </button>
        </div>
      );
    }

    if (stageKey === 'daily_report') {
      const hasPhotos = (card.photos_n || 0) > 0;
      return (
        <div className="mt-1 flex items-center justify-between text-[10px]">
          <span className={`font-semibold px-1.5 py-0.5 rounded flex items-center gap-1 ${hasPhotos ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
            <FiCamera size={11} /> {hasPhotos ? `${card.photos_n} photo(s)` : 'No photo proof'}
          </span>
          <span className="text-gray-500 font-medium">{card.manpower || 0} men</span>
        </div>
      );
    }

    if (stageKey === 'problem_task' && card.is_dpr_hindrance) {
      return (
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openAction(stageKey, card, reload);
          }}
          className="mt-1.5 w-full text-[10px] font-bold py-1 px-1.5 rounded bg-amber-600 text-white hover:bg-amber-700 flex items-center justify-center gap-1"
          title="Convert problem into actionable task (one name, one date)">
          <FiPlus size={12} /> Convert to Task
        </button>
      );
    }

    if (stageKey === 'rag_status') {
      if (card.rag === 'red') {
        return (
          <div className="mt-1 px-1.5 py-0.5 rounded bg-red-100 border border-red-200 text-[10px] font-bold text-red-700 text-center flex items-center justify-center gap-1">
            <FiAlertTriangle size={11} /> Escalated: Ambuj Action Today
          </div>
        );
      }
      if (card.rag === 'yellow') {
        return (
          <div className="mt-1 px-1.5 py-0.5 rounded bg-amber-100 border border-amber-200 text-[10px] font-bold text-amber-800 text-center">
            PM (Adarsh Kumar) Plan Needed
          </div>
        );
      }
    }

    if (stageKey === 'buffer_update') {
      const pct = card.buffer_pct || 100;
      return (
        <div className="mt-1 space-y-0.5">
          <div className="flex justify-between text-[9px] text-gray-500">
            <span>Buffer: {pct}%</span>
            <span>{pct >= 100 ? 'Healthy' : pct >= 70 ? 'Watch' : 'Critical'}</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-1.5 overflow-hidden">
            <div
              className={`h-full ${pct >= 100 ? 'bg-emerald-500' : pct >= 70 ? 'bg-amber-500' : 'bg-red-500'}`}
              style={{ width: `${Math.min(100, Math.max(10, pct))}%` }}
            />
          </div>
        </div>
      );
    }

    if (stageKey === 'closing_checklist') {
      return (
        <div className="mt-1 flex items-center justify-between text-[10px]">
          <span className="font-semibold text-slate-700">Photos verified:</span>
          <span className="font-bold text-indigo-700">{card.photos_n || 0}</span>
        </div>
      );
    }

    return null;
  };

  // Check 7 pillars completion
  const pillarsCount = Object.entries(s1Form).filter(([k, v]) => k.endsWith('_ok') && v).length;
  const allPillarsOk = pillarsCount === 7;

  return (
    <div className="space-y-4">
      {/* SOP-09 Control & RACI Header Banner */}
      <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white p-3.5 rounded-xl shadow-md flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-indigo-600/30 border border-indigo-400/30 text-indigo-300">
            <FiShield size={22} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-white tracking-wide">SOP-09: Site Work & Daily Report</h2>
              <span className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[10px] font-semibold px-2 py-0.5 rounded-full">
                Active Standard
              </span>
            </div>
            <div className="text-xs text-slate-300 mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>Owner (PM): <strong className="text-white">{sop09Raci?.pm_lead?.assigned_name || 'Adarsh Kumar'}</strong></span>
              <span>· Head: <strong className="text-white">{sop09Raci?.dept_head?.assigned_name || 'Ambuj'}</strong></span>
              <span>· HR / Labour: <strong className="text-amber-300">{sop09Raci?.hr_lead?.assigned_name || 'Ruksana'}</strong></span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setOnlyRedsFilter(!onlyRedsFilter)}
            className={`btn text-xs flex items-center gap-1.5 transition-all ${
              onlyRedsFilter
                ? 'bg-red-600 hover:bg-red-700 text-white font-bold shadow-lg ring-2 ring-red-400'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700'
            }`}
            title="SOP-09.5 Rule: Daily 15-minute review meeting focuses exclusively on RED escalated sites"
          >
            <FiAlertTriangle size={13} className={onlyRedsFilter ? 'text-white' : 'text-red-400'} />
            {onlyRedsFilter ? '🚨 Only Reds (Active)' : '15-Min Standup (Only Reds)'}
          </button>

          <button
            onClick={() => setRaciModalOpen(true)}
            className="btn bg-indigo-600 hover:bg-indigo-700 text-white text-xs flex items-center gap-1.5 font-medium shadow-sm"
            title="Configure or transfer SOP-09 workflow roles (HR: Ruksana, PM: Adarsh, Head: Ambuj, etc.)"
          >
            <FiUsers size={14} /> Roles (RACI)
          </button>
        </div>
      </div>

      <FlowBoard
        title="Site Work & Daily Report Board"
        endpoint="/dpr/flow-board"
        stageLinks={STAGE_LINKS}
        stageIcons={STAGE_ICONS}
        openTo={{ extra: { link: '/checklists', label: '📋 Checklists' } }}
        distsOf={(d) => d.dists || []}
        cardAction={cardAction}
        cardExtra={cardExtra}
        extraTiles={(d) => [
          {
            label: 'Red Sites (Escalated)',
            title: `SOP-09.5 Red Sites — Requires Department Head (${sop09Raci?.dept_head?.assigned_name || 'Ambuj'}) action today`,
            value: d.kpis?.red_sites?.value || 0,
            sub: (d.kpis?.red_sites?.value || 0) > 0 ? 'Action needed today' : 'All clear ✓',
            subClass: (d.kpis?.red_sites?.value || 0) > 0 ? 'text-red-700 font-bold' : 'text-emerald-600',
            icon: FiAlertCircle,
            iconClass: (d.kpis?.red_sites?.value || 0) > 0 ? 'bg-red-100 text-red-600' : 'bg-emerald-100 text-emerald-600',
            cardClass: (d.kpis?.red_sites?.value || 0) > 0 ? 'bg-red-50 border-red-200' : '',
          },
          {
            label: 'Active Problem Tasks',
            title: 'SOP-09.3 Problem-to-Task count (One name, one date)',
            value: d.kpis?.open_problems?.value || 0,
            sub: 'S3 Problem Rule',
            subClass: 'text-gray-400',
            icon: FiActivity,
            iconClass: 'bg-indigo-100 text-indigo-600',
            cardClass: 'bg-indigo-50 border-indigo-100',
          },
        ]}
        activityBadge={(k) => ({
          dpr: { bg: 'bg-emerald-500', txt: 'DPR' },
          task: { bg: 'bg-indigo-500', txt: 'TSK' },
          plan: { bg: 'bg-violet-500', txt: 'PLN' },
        }[k] || { bg: 'bg-gray-400', txt: '·' })}
      />

      {/* Dynamic RACI Delegation Modal */}
      {raciModalOpen && (
        <SiteWorkRaciModal
          onClose={() => setRaciModalOpen(false)}
          onSaved={() => {
            loadRaci();
            if (reloadRef.current) reloadRef.current();
          }}
        />
      )}

      {/* Action Modals */}
      <Modal
        isOpen={!!actModal}
        onClose={closeAction}
        title={actModal ? `SOP-09 Action — ${actModal.card?.ref || actModal.card?.title}` : ''}
        wide={actModal?.stage === 'ready_checklist' || actModal?.stage === 'problem_task'}>
        {actModal && (
          <div className="space-y-4">
            <div className="bg-gray-50 border rounded-lg p-3 text-sm">
              <div className="font-semibold text-gray-800">{actModal.card?.title}</div>
              <div className="text-xs text-gray-500 mt-1 flex gap-3 flex-wrap">
                <span>Owner: <b>{actModal.card?.owner || '—'}</b></span>
                <span>Date: <b>{actModal.card?.created_at || 'Today'}</b></span>
                {actModal.card?.client && <span>Client: <b>{actModal.card.client}</b></span>}
              </div>
            </div>

            {/* S1: Ready-Checklist Master (7 Pillars) */}
            {actModal.stage === 'ready_checklist' && (
              <form onSubmit={handleSaveReadyChecklist} className="space-y-4">
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 flex items-start gap-2">
                  <FiAlertTriangle className="text-amber-700 shrink-0 mt-0.5 text-base" />
                  <div>
                    <strong className="block font-bold">SOP-09.1 Golden Rule: Half-ready = no start!</strong>
                    Work starts <i>ONLY</i> when all 7 pillars are verified complete. If even one pillar is missing, work cannot commence on site.
                  </div>
                </div>

                {s1Loading ? (
                  <div className="py-8 text-center text-xs text-gray-400">Loading checklist state…</div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                      {[
                        { key: 'drawing_ok', label: '1. Approved Drawings (GFC) OK', desc: 'Approved site drawings and revisions available' },
                        { key: 'material_ok', label: '2. Site Materials In-Store OK', desc: 'Required installation materials physically received' },
                        { key: 'space_ok', label: '3. Working Space Cleared OK', desc: 'Civil site area accessible, free from obstructions' },
                        { key: 'men_ok', label: '4. Labour / Gang Mobilized OK', desc: 'Trained contractors & skilled manpower present' },
                        { key: 'tools_ok', label: '5. Tools & Machinery Tested OK', desc: 'Installation tools, scaffolding & power working' },
                        { key: 'safety_ok', label: '6. Safety PPE & Induction OK', desc: 'Toolbox talk conducted, helmets & harnesses verified' },
                        { key: 'client_ok', label: '7. Client Clearance / Permit OK', desc: 'Client work permit & access clearance signed' },
                      ].map((item) => (
                        <label
                          key={item.key}
                          className={`p-3 rounded-lg border flex items-start gap-2.5 cursor-pointer transition ${
                            s1Form[item.key]
                              ? 'bg-emerald-50/80 border-emerald-300 text-emerald-900'
                              : 'bg-white border-slate-200 text-slate-800 hover:bg-slate-50'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={!!s1Form[item.key]}
                            onChange={(e) => setS1Form({ ...s1Form, [item.key]: e.target.checked })}
                            className="mt-0.5 rounded text-emerald-600 focus:ring-emerald-500 h-4 w-4"
                          />
                          <div className="min-w-0">
                            <span className="font-semibold text-xs block">{item.label}</span>
                            <span className="text-[11px] text-slate-500">{item.desc}</span>
                          </div>
                        </label>
                      ))}
                    </div>

                    <div className="flex items-center justify-between p-3 rounded-lg border bg-slate-50">
                      <div className="text-xs">
                        <span className="font-medium text-slate-600">Pillars Verified: </span>
                        <strong className={allPillarsOk ? 'text-emerald-700' : 'text-amber-700'}>
                          {pillarsCount} of 7 Pillars OK
                        </strong>
                      </div>
                      <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                        allPillarsOk
                          ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                          : 'bg-amber-100 text-amber-800 border border-amber-300'
                      }`}>
                        {allPillarsOk ? '✅ READY TO COMMENCE WORK' : '⚠️ HALF-READY = NO START'}
                      </span>
                    </div>

                    <div>
                      <label className="label text-xs">Site Inspection Remarks</label>
                      <input
                        type="text"
                        className="input text-xs"
                        placeholder="e.g. Zone 1 cleared for cable laying; drawings signed off by client"
                        value={s1Form.remarks}
                        onChange={(e) => setS1Form({ ...s1Form, remarks: e.target.value })}
                      />
                    </div>
                  </>
                )}

                <div className="flex justify-end gap-2 pt-2 border-t">
                  <button type="button" onClick={closeAction} className="btn btn-secondary text-xs">Close</button>
                  <button
                    type="submit"
                    disabled={s1Saving}
                    className="btn btn-primary text-xs flex items-center gap-1.5"
                  >
                    <FiCheck size={14} /> {s1Saving ? 'Saving…' : 'Save Ready-Checklist (SOP-09.1)'}
                  </button>
                </div>
              </form>
            )}

            {/* S2: Daily Report Format Mobile */}
            {actModal.stage === 'daily_report' && (
              <div className="space-y-3">
                <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-900 flex items-start gap-2">
                  <FiSmartphone className="text-blue-700 shrink-0 mt-0.5 text-base" />
                  <div>
                    <strong className="block font-bold">SOP-09.2 Golden Rule: Photos are proof!</strong>
                    Site engineer fills the daily report on mobile in 5 minutes: work done, men, photos, problems.
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="p-2.5 bg-gray-50 border rounded">
                    <span className="text-gray-500 block text-[11px]">Installed Value (Table A)</span>
                    <strong className="text-sm text-gray-800">₹{Math.round(actModal.card?.installed_val || 0).toLocaleString('en-IN')}</strong>
                  </div>
                  <div className="p-2.5 bg-gray-50 border rounded">
                    <span className="text-gray-500 block text-[11px]">Daily Cost (Table B)</span>
                    <strong className="text-sm text-gray-800">₹{Math.round(actModal.card?.cost_val || 0).toLocaleString('en-IN')}</strong>
                  </div>
                </div>

                {actModal.card?.photos_n === 0 ? (
                  <div className="p-3 rounded-lg border border-amber-300 bg-amber-50 text-amber-900 text-xs flex items-center gap-2">
                    <FiAlertTriangle className="text-amber-700 shrink-0 text-base" />
                    <span><b>Missing Proof:</b> No site photos uploaded with this DPR submission. Golden Rule requires photo attachments.</span>
                  </div>
                ) : (
                  <div className="p-3 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-900 text-xs flex items-center gap-2">
                    <FiCheckCircle className="text-emerald-700 shrink-0 text-base" />
                    <span><b>Photo Proof Verified:</b> {actModal.card?.photos_n || 1} photo(s) attached with report.</span>
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2 border-t">
                  <button onClick={closeAction} className="btn btn-secondary text-xs">Close</button>
                  <Link to="/dpr?tab=reports" onClick={closeAction} className="btn btn-primary text-xs flex items-center gap-1.5">
                    <FiFileText size={14} /> Open Daily Reports Register
                  </Link>
                </div>
              </div>
            )}

            {/* S3: Problem to Task (One name, one date) */}
            {actModal.stage === 'problem_task' && (
              <form onSubmit={handleCreateTask} className="space-y-3">
                <div className="p-3 bg-indigo-50 border border-indigo-200 rounded-lg text-xs text-indigo-900 flex items-start gap-2">
                  <FiAlertCircle className="text-indigo-700 shrink-0 mt-0.5 text-base" />
                  <div>
                    <strong className="block font-bold">SOP-09.3 Golden Rule: Problems can't hide!</strong>
                    Every problem written becomes a task with <b>one name, one date</b>. Auto-assigned to department heads based on the dynamic RACI matrix.
                  </div>
                </div>

                <div>
                  <label className="label text-xs">Task Title *</label>
                  <input
                    type="text"
                    className="input text-xs"
                    value={taskForm.title}
                    onChange={(e) => setTaskForm({ ...taskForm, title: e.target.value })}
                    required
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="label text-xs flex items-center justify-between">
                      <span>Assigned Owner (One Name) *</span>
                      <span className="text-[10px] text-indigo-600 font-semibold">RACI Auto-Resolved</span>
                    </label>
                    <select
                      className="select text-xs"
                      value={taskForm.assigned_to}
                      onChange={(e) => setTaskForm({ ...taskForm, assigned_to: e.target.value })}
                      required>
                      <option value="">Select Assignee</option>
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name} {u.department ? `(${u.department})` : ''} · {u.role}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label text-xs">Due Date (One Date — 24h SLA) *</label>
                    <input
                      type="date"
                      className="input text-xs"
                      value={taskForm.due_date}
                      onChange={(e) => setTaskForm({ ...taskForm, due_date: e.target.value })}
                      required
                    />
                  </div>
                </div>

                <div>
                  <label className="label text-xs">Resolution Notes & Context</label>
                  <textarea
                    rows={3}
                    className="input text-xs"
                    value={taskForm.description}
                    onChange={(e) => setTaskForm({ ...taskForm, description: e.target.value })}
                  />
                </div>

                <div className="flex justify-end gap-2 pt-2 border-t">
                  <button type="button" onClick={closeAction} className="btn btn-secondary text-xs">Cancel</button>
                  <button type="submit" disabled={savingTask} className="btn btn-primary text-xs flex items-center gap-1.5">
                    <FiPlus size={14} /> {savingTask ? 'Saving…' : 'Create Task (SOP-09.3)'}
                  </button>
                </div>
              </form>
            )}

            {/* S4: Buffer Update Rule */}
            {actModal.stage === 'buffer_update' && (
              <div className="space-y-3">
                <div className="p-3 bg-violet-50 border border-violet-200 rounded-lg text-xs text-violet-900 flex items-start gap-2">
                  <FiTrendingUp className="text-violet-700 shrink-0 mt-0.5 text-base" />
                  <div>
                    <strong className="block font-bold">SOP-09.4 Golden Rule: Early warning, automatic!</strong>
                    The system automatically compares actual work with the plan and updates the buffer health.
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="p-2.5 bg-gray-50 border rounded">
                    <span className="text-gray-500 block text-[11px]">Actual Installed This Week</span>
                    <strong className="text-sm text-gray-800">₹{Math.round(actModal.card?.actual_val || 0).toLocaleString('en-IN')}</strong>
                  </div>
                  <div className="p-2.5 bg-gray-50 border rounded">
                    <span className="text-gray-500 block text-[11px]">Planned Target</span>
                    <strong className="text-sm text-gray-800">₹{Math.round(actModal.card?.planned_val || 0).toLocaleString('en-IN')}</strong>
                  </div>
                </div>

                <div className="p-3 bg-slate-50 border rounded-lg text-xs space-y-1.5">
                  <div className="flex justify-between font-semibold">
                    <span>Buffer Health:</span>
                    <span className={actModal.card?.buffer_pct >= 100 ? 'text-emerald-700' : 'text-amber-700'}>
                      {actModal.card?.buffer_pct || 100}%
                    </span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                    <div
                      className={`h-full ${actModal.card?.buffer_pct >= 100 ? 'bg-emerald-500' : actModal.card?.buffer_pct >= 70 ? 'bg-amber-500' : 'bg-red-500'}`}
                      style={{ width: `${Math.min(100, Math.max(10, actModal.card?.buffer_pct || 100))}%` }}
                    />
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-2 border-t">
                  <button onClick={closeAction} className="btn btn-secondary text-xs">Close</button>
                  <Link to="/dpr?tab=dashboard" onClick={closeAction} className="btn btn-primary text-xs flex items-center gap-1.5">
                    <FiTrendingUp size={14} /> Open Full Buffer Dashboard
                  </Link>
                </div>
              </div>
            )}

            {/* S5: Colour Rule (Green / Yellow / Red) */}
            {actModal.stage === 'rag_status' && (
              <div className="space-y-3">
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-900 flex items-start gap-2">
                  <FiActivity className="text-red-700 shrink-0 mt-0.5 text-base" />
                  <div>
                    <strong className="block font-bold">SOP-09.5 Rule: GREEN = fine, YELLOW = PM plan, RED = Head acts today.</strong>
                    Daily 15-minute review meeting focuses exclusively on RED sites.
                  </div>
                </div>

                <div className="border rounded-lg p-3 bg-slate-50 text-xs space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-700">RAG Evaluation:</span>
                    <span className={`font-bold px-2 py-0.5 rounded text-xs ${
                      actModal.card?.rag === 'red' ? 'bg-red-100 text-red-800' : actModal.card?.rag === 'yellow' ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'
                    }`}>
                      {actModal.card?.ragLabel || 'GREEN'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-slate-600">
                    <span>Action Assignee:</span>
                    <strong className="text-slate-900">{actModal.card?.owner || 'Project Manager'}</strong>
                  </div>
                  <div className="flex items-center justify-between text-slate-600">
                    <span>Daily Profit / Loss Margin:</span>
                    <strong className={actModal.card?.margin < 0 ? 'text-red-700' : 'text-emerald-700'}>
                      ₹{Math.round(actModal.card?.margin || 0).toLocaleString('en-IN')}
                    </strong>
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-2 border-t">
                  <button onClick={closeAction} className="btn btn-secondary text-xs">Close</button>
                  <Link to="/dpr" onClick={closeAction} className="btn btn-primary text-xs flex items-center gap-1.5">
                    <FiActivity size={14} /> Open Site DPR
                  </Link>
                </div>
              </div>
            )}

            {/* S6: Closing Quality & Safety Checklist */}
            {actModal.stage === 'closing_checklist' && (
              <form onSubmit={handleSaveClosingChecklist} className="space-y-3">
                <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-900 flex items-start gap-2">
                  <FiShield className="text-emerald-700 shrink-0 mt-0.5 text-base" />
                  <div>
                    <strong className="block font-bold">SOP-09.6 Golden Rule: No photo, no closure!</strong>
                    Before closing a work area — quality & safety checklist with photos. Work area cannot be closed without at least one completion photo.
                  </div>
                </div>

                <div>
                  <label className="label text-xs">Work Area / Zone *</label>
                  <input
                    type="text"
                    className="input text-xs"
                    value={s6Form.work_area}
                    onChange={(e) => setS6Form({ ...s6Form, work_area: e.target.value })}
                    required
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="p-2.5 rounded-lg border bg-white flex items-center gap-2 cursor-pointer text-xs">
                    <input
                      type="checkbox"
                      checked={s6Form.quality_ok}
                      onChange={(e) => setS6Form({ ...s6Form, quality_ok: e.target.checked })}
                      className="rounded text-emerald-600"
                    />
                    <span className="font-semibold text-slate-800">Quality Inspection OK</span>
                  </label>
                  <label className="p-2.5 rounded-lg border bg-white flex items-center gap-2 cursor-pointer text-xs">
                    <input
                      type="checkbox"
                      checked={s6Form.safety_ok}
                      onChange={(e) => setS6Form({ ...s6Form, safety_ok: e.target.checked })}
                      className="rounded text-emerald-600"
                    />
                    <span className="font-semibold text-slate-800">Safety Housekeeping OK</span>
                  </label>
                </div>

                <div>
                  <label className="label text-xs">
                    <span>Completion Photo URLs (Mandatory — Comma Separated) *</span>
                  </label>
                  <input
                    type="text"
                    className="input text-xs"
                    placeholder="/uploads/closure-photo-1.jpg, /uploads/closure-photo-2.jpg"
                    value={s6Form.photos}
                    onChange={(e) => setS6Form({ ...s6Form, photos: e.target.value })}
                    required
                  />
                  <span className="text-[10px] text-gray-500 mt-0.5 block">Golden Rule SOP-09.6: "No photo, no closure."</span>
                </div>

                <div>
                  <label className="label text-xs">Closure Remarks</label>
                  <input
                    type="text"
                    className="input text-xs"
                    placeholder="Inspection completed, work area handed over cleanly"
                    value={s6Form.remarks}
                    onChange={(e) => setS6Form({ ...s6Form, remarks: e.target.value })}
                  />
                </div>

                <div className="flex justify-end gap-2 pt-2 border-t">
                  <button type="button" onClick={closeAction} className="btn btn-secondary text-xs">Cancel</button>
                  <button type="submit" disabled={s6Saving} className="btn btn-primary text-xs flex items-center gap-1.5">
                    <FiShield size={14} /> {s6Saving ? 'Saving…' : 'Verify & Close Area (SOP-09.6)'}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
