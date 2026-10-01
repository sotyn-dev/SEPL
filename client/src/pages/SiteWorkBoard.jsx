// SOP-09 Site Work & Daily Report Board (owner: Project Manager — Adarsh Kumar)
// Reference flow board using the shared FlowBoard shell.
// 6 Stages (SOP-09.1 to SOP-09.6):
//   S1: Ready Checklist Master (Work starts ONLY when checklist is complete)
//   S2: Daily Report (Mobile) (Work done, manpower, photo proof, 5 min)
//   S3: Problem to Task (Every problem becomes a task — one name, one date)
//   S4: Buffer & Plan Update (System compares actual with plan and updates buffer)
//   S5: Colour Rule (Green / Yellow / Red action rule)
//   S6: Closing Quality & Safety Checklist (No photo, no closure)

import { useState, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import FlowBoard from '../components/FlowBoard';
import Modal from '../components/Modal';
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
  useEffect(() => {
    api.get('/auth/users?active_only=1').then(r => setUsers(r.data || [])).catch(() => {});
  }, []);

  // Action Popup State
  const [actModal, setActModal] = useState(null); // { stage, card, reload }
  const [taskForm, setTaskForm] = useState({ title: '', assigned_to: '', due_date: '', description: '' });
  const [savingTask, setSavingTask] = useState(false);

  const resolveAssignee = (cardTitle = '') => {
    const text = String(cardTitle || '').toLowerCase();
    if (text.includes('mat') || text.includes('item') || text.includes('stock') || text.includes('store') || text.includes('procurement') || text.includes('cement') || text.includes('pipe') || text.includes('delivery')) {
      const u = users.find(u => (u.name && (u.name.toLowerCase().includes('awdesh') || u.name.toLowerCase().includes('avadesh') || u.name.toLowerCase().includes('anmol'))) || (u.role && u.role.toLowerCase() === 'purchase'));
      if (u) return String(u.id);
    }
    if (text.includes('manpower') || text.includes('labour') || text.includes('labor') || text.includes('worker') || text.includes('contractor') || text.includes('attendance')) {
      const u = users.find(u => (u.name && (u.name.toLowerCase().includes('pravdeep') || u.name.toLowerCase().includes('prabhdeep'))) || (u.role && (u.role.toLowerCase() === 'hr' || u.role.toLowerCase() === 'labour')));
      if (u) return String(u.id);
    }
    if (text.includes('client') || text.includes('space') || text.includes('clearance') || text.includes('permission') || text.includes('draw') || text.includes('design') || text.includes('crm')) {
      const u = users.find(u => (u.name && (u.name.toLowerCase().includes('lovely') || u.name.toLowerCase().includes('lavoly') || u.name.toLowerCase().includes('lavoli'))) || (u.role && u.role.toLowerCase() === 'crm'));
      if (u) return String(u.id);
    }
    if (text.includes('money') || text.includes('pay') || text.includes('fund') || text.includes('account') || text.includes('bill')) {
      const u = users.find(u => (u.name && u.name.toLowerCase().includes('aanchal')) || (u.role && (u.role.toLowerCase() === 'accounts' || u.role.toLowerCase() === 'finance')));
      if (u) return String(u.id);
    }
    if (text.includes('machin') || text.includes('tool') || text.includes('equip') || text.includes('crane') || text.includes('welding') || text.includes('drill')) {
      const u = users.find(u => (u.name && u.name.toLowerCase().includes('ajmer')) || (u.role && (u.role.toLowerCase() === 'machinery' || u.role.toLowerCase() === 'maintenance')));
      if (u) return String(u.id);
    }
    const defaultU = users.find(u => (u.name && (u.name.toLowerCase().includes('lovely') || u.name.toLowerCase().includes('lavoly') || u.name.toLowerCase().includes('ajmer'))) || (u.role && u.role.toLowerCase() === 'admin'));
    return defaultU ? String(defaultU.id) : (users[0]?.id ? String(users[0].id) : '');
  };

  const openAction = (stage, card, reload) => {
    reloadRef.current = reload;
    setActModal({ stage, card, reload });

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
  };

  const closeAction = () => {
    setActModal(null);
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

  const cardAction = (stageKey, card, reload) => {
    return () => openAction(stageKey, card, reload);
  };

  const cardExtra = (stageKey, card, reload) => {
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
    if (stageKey === 'rag_status' && card.rag === 'red') {
      return (
        <div className="mt-1 px-1.5 py-0.5 rounded bg-red-100 border border-red-200 text-[10px] font-bold text-red-700 text-center">
          🚨 Head Action Required
        </div>
      );
    }
    if (stageKey === 'buffer_update') {
      const pct = card.buffer_pct || 100;
      return (
        <div className="mt-1 w-full bg-gray-200 rounded-full h-1.5 overflow-hidden">
          <div
            className={`h-full ${pct >= 100 ? 'bg-emerald-500' : pct >= 70 ? 'bg-amber-500' : 'bg-red-500'}`}
            style={{ width: `${Math.min(100, Math.max(10, pct))}%` }}
          />
        </div>
      );
    }
    return null;
  };

  return (
    <>
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
            title: 'SOP-09.5 Red Sites — Requires Department Head (Ambuj) action today',
            value: d.kpis?.red_sites?.value || 0,
            sub: (d.kpis?.red_sites?.value || 0) > 0 ? 'Action needed today' : 'All clear ✓',
            subClass: (d.kpis?.red_sites?.value || 0) > 0 ? 'text-red-700 font-bold' : 'text-emerald-600',
            icon: FiAlertCircle,
            iconClass: (d.kpis?.red_sites?.value || 0) > 0 ? 'bg-red-100 text-red-600' : 'bg-emerald-100 text-emerald-600',
            cardClass: (d.kpis?.red_sites?.value || 0) > 0 ? 'bg-red-50 border-red-200' : '',
          },
          {
            label: 'Active Problem Tasks',
            title: 'SOP-09.3 Problem-to-Task count',
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

      {/* Action Modals */}
      <Modal
        isOpen={!!actModal}
        onClose={closeAction}
        title={actModal ? `SOP-09 Action — ${actModal.card?.ref || actModal.card?.title}` : ''}>
        {actModal && (
          <div className="space-y-4">
            <div className="bg-gray-50 border rounded-lg p-3 text-sm">
              <div className="font-semibold text-gray-800">{actModal.card?.title}</div>
              <div className="text-xs text-gray-500 mt-1 flex gap-3">
                <span>Owner: <b>{actModal.card?.owner || '—'}</b></span>
                <span>Date: <b>{actModal.card?.created_at || 'Today'}</b></span>
              </div>
            </div>

            {/* S1: Ready-Checklist Action */}
            {actModal.stage === 'ready_checklist' && (
              <div className="space-y-3">
                <p className="text-xs text-gray-600 leading-relaxed">
                  <b>SOP-09.1 Rule:</b> Work starts <i>ONLY</i> when the ready-checklist is complete — drawing, material, space, men, tools, safety, client OK. <b>Half-ready = no start.</b>
                </p>
                <div className="border rounded-lg p-3 bg-amber-50 border-amber-200 text-xs space-y-1">
                  <div className="font-bold text-amber-800">Checklist Items:</div>
                  <div className="grid grid-cols-2 gap-1 text-gray-700">
                    <div>✓ Approved Drawings</div>
                    <div>✓ Site Materials In-store</div>
                    <div>✓ Working Space Cleared</div>
                    <div>✓ Labour / Gang Mobilized</div>
                    <div>✓ Tools & Equipment Tested</div>
                    <div>✓ Safety PPE & Client Clearance</div>
                  </div>
                </div>
                <div className="flex justify-end gap-2 pt-2 border-t">
                  <button onClick={closeAction} className="btn btn-secondary text-xs">Close</button>
                  <Link to="/checklists" onClick={closeAction} className="btn btn-primary text-xs flex items-center gap-1">
                    <FiCheckCircle size={14} /> Open Full Checklist
                  </Link>
                </div>
              </div>
            )}

            {/* S2: Daily Report Format Mobile */}
            {actModal.stage === 'daily_report' && (
              <div className="space-y-3">
                <p className="text-xs text-gray-600 leading-relaxed">
                  <b>SOP-09.2 Rule:</b> Site Engineer fills the daily report on mobile — work done, men, photos, problems. 5 minutes. <b>Photos are proof.</b>
                </p>
                <div className="flex justify-end gap-2 pt-2 border-t">
                  <button onClick={closeAction} className="btn btn-secondary text-xs">Close</button>
                  <Link to="/dpr?tab=reports" onClick={closeAction} className="btn btn-primary text-xs flex items-center gap-1">
                    <FiFileText size={14} /> View / Edit Daily Report
                  </Link>
                </div>
              </div>
            )}

            {/* S3: Problem to Task (One name, one date) */}
            {actModal.stage === 'problem_task' && (
              <form onSubmit={handleCreateTask} className="space-y-3">
                <p className="text-xs text-gray-600 leading-relaxed">
                  <b>SOP-09.3 Rule:</b> Every problem written becomes a task — <b>one name, one date</b>. Not just a note. <i>Problems can't hide.</i>
                </p>
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
                    <label className="label text-xs">Assigned To (One Name) *</label>
                    <select
                      className="select text-xs"
                      value={taskForm.assigned_to}
                      onChange={(e) => setTaskForm({ ...taskForm, assigned_to: e.target.value })}
                      required>
                      <option value="">Select Assignee</option>
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name} ({u.role})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label text-xs">Due Date (One Date) *</label>
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
                  <label className="label text-xs">Resolution Notes</label>
                  <textarea
                    rows={2}
                    className="input text-xs"
                    value={taskForm.description}
                    onChange={(e) => setTaskForm({ ...taskForm, description: e.target.value })}
                  />
                </div>
                <div className="flex justify-end gap-2 pt-2 border-t">
                  <button type="button" onClick={closeAction} className="btn btn-secondary text-xs">Cancel</button>
                  <button type="submit" disabled={savingTask} className="btn btn-primary text-xs flex items-center gap-1">
                    <FiPlus size={14} /> {savingTask ? 'Saving…' : 'Create Task (SOP-09.3)'}
                  </button>
                </div>
              </form>
            )}

            {/* S4: Buffer Update Rule */}
            {actModal.stage === 'buffer_update' && (
              <div className="space-y-3">
                <p className="text-xs text-gray-600 leading-relaxed">
                  <b>SOP-09.4 Rule:</b> System compares actual work with the plan and updates the buffer. <b>Early warning, automatic.</b>
                </p>
                <div className="flex justify-end gap-2 pt-2 border-t">
                  <button onClick={closeAction} className="btn btn-secondary text-xs">Close</button>
                  <Link to="/dpr?tab=dashboard" onClick={closeAction} className="btn btn-primary text-xs flex items-center gap-1">
                    <FiTrendingUp size={14} /> Open Buffer Dashboard
                  </Link>
                </div>
              </div>
            )}

            {/* S5: Colour Rule (Green / Yellow / Red) */}
            {actModal.stage === 'rag_status' && (
              <div className="space-y-3">
                <p className="text-xs text-gray-600 leading-relaxed">
                  <b>SOP-09.5 Rule:</b> GREEN — fine. YELLOW — PM makes a plan. RED — Head acts today. <b>Daily 15-minute meeting — only reds.</b>
                </p>
                <div className="p-3 rounded-lg border text-xs bg-red-50 border-red-200 text-red-800">
                  <div className="font-bold">15-minute Red Project Protocol:</div>
                  <div>• Escalate to Department Head (Ambuj) & PM (Adarsh Kumar).</div>
                  <div>• Identify critical bottleneck (materials, drawings, client clearance).</div>
                  <div>• Assign mandatory corrective task today.</div>
                </div>
                <div className="flex justify-end gap-2 pt-2 border-t">
                  <button onClick={closeAction} className="btn btn-secondary text-xs">Close</button>
                  <Link to="/dpr" onClick={closeAction} className="btn btn-primary text-xs flex items-center gap-1">
                    <FiActivity size={14} /> Open Site DPR
                  </Link>
                </div>
              </div>
            )}

            {/* S6: Closing Quality & Safety Checklist */}
            {actModal.stage === 'closing_checklist' && (
              <div className="space-y-3">
                <p className="text-xs text-gray-600 leading-relaxed">
                  <b>SOP-09.6 Rule:</b> Before closing a work area — quality & safety checklist with photos. <b>No photo, no closure.</b>
                </p>
                <div className="flex justify-end gap-2 pt-2 border-t">
                  <button onClick={closeAction} className="btn btn-secondary text-xs">Close</button>
                  <Link to="/checklists" onClick={closeAction} className="btn btn-primary text-xs flex items-center gap-1">
                    <FiShield size={14} /> Open Closing Checklists
                  </Link>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
