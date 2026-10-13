import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FiSun, FiAlertTriangle, FiAlertCircle, FiCheckCircle, FiClock,
  FiExternalLink, FiX, FiCheckSquare, FiSquare, FiCalendar,
  FiFilter, FiLayers, FiCheck, FiArrowRight, FiShield, FiMessageSquare
} from 'react-icons/fi';
import api from '../api';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';

export default function DailyStandupModal({ forceOpen = false, onClose = () => {} }) {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [briefingData, setBriefingData] = useState(null);
  const [activeTab, setActiveTab] = useState('all'); // 'all' | 'critical' | 'delegation' | 'pms' | 'ticket' | 'checklist'
  const [focusedTaskIds, setFocusedTaskIds] = useState([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [commitmentNote, setCommitmentNote] = useState('');

  // Get current date string in IST
  const todayIST = useMemo(() => {
    return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  }, []);

  const storageKey = user ? `sepl_daily_standup_dismissed_${user.id}_${todayIST}` : null;
  const snoozeKey = user ? `sepl_daily_standup_snooze_${user.id}` : null;

  // Load briefing data from backend
  const loadBriefing = async (shouldAutoOpen = false) => {
    if (!user) return;
    try {
      setLoading(true);
      const res = await api.get('/daily-standup/briefing');
      const data = res.data;
      setBriefingData(data);

      if (data?.acknowledgment?.focused_task_ids) {
        setFocusedTaskIds(data.acknowledgment.focused_task_ids);
      }
      if (data?.acknowledgment?.commitment_note) {
        setCommitmentNote(data.acknowledgment.commitment_note);
      }
      if (data?.acknowledged_today) {
        setAcknowledged(true);
      }

      // Check if should open automatically
      if (shouldAutoOpen && !data?.acknowledged_today) {
        // If snooze is active, don't open
        const snoozeUntil = localStorage.getItem(snoozeKey);
        if (snoozeUntil && Date.now() < Number(snoozeUntil)) {
          return;
        }

        // Strictly auto-open ONLY if the employee has overdue tasks (>0 days past due)
        // If employee has no overdue tasks (everything on track), NO modal is shown!
        const hasOverdue = (data?.counts?.critical_overdue || 0) > 0 || (data?.counts?.overdue || 0) > 0;
        if (hasOverdue) {
          setIsOpen(true);
        }
      }
    } catch (err) {
      console.warn('[DailyStandup] Failed to load briefing:', err.message);
    } finally {
      setLoading(false);
    }
  };

  // Check trigger condition on mount & route change
  useEffect(() => {
    if (!user) return;

    // Check if dismissed for today in this browser session
    const isDismissedToday = storageKey ? localStorage.getItem(storageKey) === '1' : false;

    if (!isDismissedToday) {
      loadBriefing(true);
    } else {
      // Still load quietly in background so counts are ready if reopened via header button
      loadBriefing(false);
    }

    // Listen to manual open event from header or anywhere in the app
    const handleManualOpen = () => {
      setIsOpen(true);
      loadBriefing(false);
    };

    window.addEventListener('sepl:open-daily-standup', handleManualOpen);
    return () => window.removeEventListener('sepl:open-daily-standup', handleManualOpen);
  }, [user, todayIST]);

  // Handle external forceOpen prop
  useEffect(() => {
    if (forceOpen) {
      setIsOpen(true);
      loadBriefing(false);
    }
  }, [forceOpen]);

  // Toggle a task into "My Focus for Today"
  const toggleFocusTask = (taskId) => {
    setFocusedTaskIds(prev => {
      if (prev.includes(taskId)) {
        return prev.filter(id => id !== taskId);
      } else {
        if (prev.length >= 5) {
          toast('Select up to 5 priority tasks for today to avoid overload.', { icon: '💡' });
          return prev;
        }
        return [...prev, taskId];
      }
    });
  };

  // Submit acknowledgment and commitment
  const handleConfirmAndStart = async () => {
    if (!acknowledged) {
      toast.error('Please check the confirmation box acknowledging your daily tasks.');
      return;
    }

    try {
      setSubmitting(true);
      await api.post('/daily-standup/acknowledge', {
        focused_task_ids: focusedTaskIds,
        commitment_note: commitmentNote,
        total_overdue: briefingData?.counts?.overdue || 0,
        critical_overdue: briefingData?.counts?.critical_overdue || 0,
      });

      if (storageKey) {
        localStorage.setItem(storageKey, '1');
      }
      if (snoozeKey) {
        localStorage.removeItem(snoozeKey);
      }

      toast.success('☀️ Daily Focus confirmed! Have a productive day.', { duration: 4000 });
      setIsOpen(false);
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to record commitment');
    } finally {
      setSubmitting(false);
    }
  };

  // Snooze for 1 hour
  const handleSnooze = () => {
    if (snoozeKey) {
      const snoozeUntil = Date.now() + 60 * 60 * 1000; // 1 hour
      localStorage.setItem(snoozeKey, String(snoozeUntil));
    }
    toast('Reminder snoozed for 1 hour.', { icon: '⏰' });
    setIsOpen(false);
    onClose();
  };

  // Close modal
  const handleClose = () => {
    if (storageKey) {
      localStorage.setItem(storageKey, '1');
    }
    setIsOpen(false);
    onClose();
  };

  // Navigate to task
  const handleOpenTask = (linkUrl) => {
    handleClose();
    if (linkUrl) {
      navigate(linkUrl);
    }
  };

  const tasks = briefingData?.tasks || [];
  const counts = briefingData?.counts || {
    critical_overdue: 0,
    overdue: 0,
    due_today: 0,
    upcoming_48h: 0,
    total_attention_needed: 0,
    total_all: 0,
    by_module: { delegations: 0, pms: 0, tickets: 0, checklists: 0 }
  };

  // Filter tasks based on activeTab
  const filteredTasks = useMemo(() => {
    if (activeTab === 'critical') {
      return tasks.filter(t => t.category === 'critical_overdue');
    }
    if (activeTab === 'overdue') {
      return tasks.filter(t => t.category === 'critical_overdue' || t.category === 'overdue');
    }
    if (activeTab === 'due_today') {
      return tasks.filter(t => t.category === 'due_today');
    }
    if (activeTab === 'delegation') {
      return tasks.filter(t => t.module === 'delegation');
    }
    if (activeTab === 'pms') {
      return tasks.filter(t => t.module === 'pms');
    }
    if (activeTab === 'ticket') {
      return tasks.filter(t => t.module === 'ticket');
    }
    if (activeTab === 'checklist') {
      return tasks.filter(t => t.module === 'checklist');
    }
    return tasks;
  }, [tasks, activeTab]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5">
      <div 
        className="relative bg-white w-full max-w-4xl rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[92vh] animate-in fade-in zoom-in-95 duration-200"
        role="dialog"
        aria-modal="true"
      >
        {/* Header Bar */}
        <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-blue-900 text-white px-5 py-4 flex items-center justify-between border-b border-white/10 select-none">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-amber-400/20 text-amber-300 flex items-center justify-center flex-shrink-0 border border-amber-400/30 shadow-inner">
              <FiSun size={22} className="animate-pulse" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-base sm:text-lg font-bold text-white tracking-tight truncate">
                  Daily Focus & Morning Standup
                </h3>
                <span className="text-[11px] font-medium bg-white/15 px-2.5 py-0.5 rounded-full text-indigo-100 border border-white/10">
                  {todayIST}
                </span>
                {briefingData?.acknowledged_today && (
                  <span className="text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded-full border border-emerald-500/30 flex items-center gap-1">
                    <FiCheck size={11} /> Acknowledged Today
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-300 truncate mt-0.5">
                Good morning, <strong className="text-white">{user?.name}</strong>! Review pending deadlines and align your top priorities for today.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="p-2 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors ml-2 flex-shrink-0"
            title="Close briefing"
          >
            <FiX size={20} />
          </button>
        </div>

        {/* Executive Summary Cards */}
        <div className="p-4 sm:p-5 bg-slate-50/70 border-b border-slate-200">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 sm:gap-3">
            {/* Critical Overdue Card */}
            <div 
              onClick={() => setActiveTab('critical')}
              className={`p-3 rounded-xl border transition-all cursor-pointer ${
                activeTab === 'critical'
                  ? 'bg-rose-50 border-rose-300 shadow-sm ring-2 ring-rose-400/30'
                  : 'bg-white border-rose-200/80 hover:border-rose-300 hover:bg-rose-50/30'
              }`}
            >
              <div className="flex items-center justify-between text-rose-700 mb-1">
                <span className="text-[11px] font-bold uppercase tracking-wider">Critical Overdue</span>
                <FiAlertTriangle size={15} />
              </div>
              <div className="flex items-baseline gap-1.5">
                <span className="text-2xl font-black text-rose-800">{counts.critical_overdue}</span>
                <span className="text-[10px] text-rose-600 font-semibold">{'>'} 7 days old</span>
              </div>
            </div>

            {/* Overdue (1-7d) Card */}
            <div 
              onClick={() => setActiveTab('overdue')}
              className={`p-3 rounded-xl border transition-all cursor-pointer ${
                activeTab === 'overdue'
                  ? 'bg-amber-50 border-amber-300 shadow-sm ring-2 ring-amber-400/30'
                  : 'bg-white border-amber-200/80 hover:border-amber-300 hover:bg-amber-50/30'
              }`}
            >
              <div className="flex items-center justify-between text-amber-700 mb-1">
                <span className="text-[11px] font-bold uppercase tracking-wider">Moderate Overdue</span>
                <FiClock size={15} />
              </div>
              <div className="flex items-baseline gap-1.5">
                <span className="text-2xl font-black text-amber-800">{counts.overdue}</span>
                <span className="text-[10px] text-amber-600 font-semibold">1 to 7 days</span>
              </div>
            </div>

            {/* Due Today Card */}
            <div 
              onClick={() => setActiveTab('due_today')}
              className={`p-3 rounded-xl border transition-all cursor-pointer ${
                activeTab === 'due_today'
                  ? 'bg-blue-50 border-blue-300 shadow-sm ring-2 ring-blue-400/30'
                  : 'bg-white border-blue-200/80 hover:border-blue-300 hover:bg-blue-50/30'
              }`}
            >
              <div className="flex items-center justify-between text-blue-700 mb-1">
                <span className="text-[11px] font-bold uppercase tracking-wider">Due Today</span>
                <FiCalendar size={15} />
              </div>
              <div className="flex items-baseline gap-1.5">
                <span className="text-2xl font-black text-blue-800">{counts.due_today}</span>
                <span className="text-[10px] text-blue-600 font-semibold">Scheduled today</span>
              </div>
            </div>

            {/* Total Needing Attention */}
            <div 
              onClick={() => setActiveTab('all')}
              className={`p-3 rounded-xl border transition-all cursor-pointer ${
                activeTab === 'all'
                  ? 'bg-indigo-50 border-indigo-300 shadow-sm ring-2 ring-indigo-400/30'
                  : 'bg-white border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/30'
              }`}
            >
              <div className="flex items-center justify-between text-indigo-700 mb-1">
                <span className="text-[11px] font-bold uppercase tracking-wider">Total Attention</span>
                <FiLayers size={15} />
              </div>
              <div className="flex items-baseline gap-1.5">
                <span className="text-2xl font-black text-indigo-950">{counts.total_attention_needed}</span>
                <span className="text-[10px] text-slate-500 font-semibold">Pending tasks</span>
              </div>
            </div>
          </div>
        </div>

        {/* Filter Navigation Tabs */}
        <div className="px-5 pt-3 border-b border-slate-200 bg-white flex items-center gap-1 overflow-x-auto text-xs no-scrollbar select-none">
          <button
            type="button"
            onClick={() => setActiveTab('all')}
            className={`px-3 py-2 font-medium border-b-2 whitespace-nowrap transition-colors ${
              activeTab === 'all'
                ? 'border-indigo-600 text-indigo-700 font-semibold'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            All Items ({tasks.length})
          </button>
          {counts.critical_overdue > 0 && (
            <button
              type="button"
              onClick={() => setActiveTab('critical')}
              className={`px-3 py-2 font-medium border-b-2 whitespace-nowrap transition-colors flex items-center gap-1.5 ${
                activeTab === 'critical'
                  ? 'border-rose-600 text-rose-700 font-semibold'
                  : 'border-transparent text-rose-600 hover:text-rose-800'
              }`}
            >
              <span className="w-2 h-2 rounded-full bg-rose-500 animate-ping"></span>
              Critical Overdue ({counts.critical_overdue})
            </button>
          )}
          {counts.by_module.delegations > 0 && (
            <button
              type="button"
              onClick={() => setActiveTab('delegation')}
              className={`px-3 py-2 font-medium border-b-2 whitespace-nowrap transition-colors ${
                activeTab === 'delegation'
                  ? 'border-indigo-600 text-indigo-700 font-semibold'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              Delegations ({counts.by_module.delegations})
            </button>
          )}
          {counts.by_module.pms > 0 && (
            <button
              type="button"
              onClick={() => setActiveTab('pms')}
              className={`px-3 py-2 font-medium border-b-2 whitespace-nowrap transition-colors ${
                activeTab === 'pms'
                  ? 'border-indigo-600 text-indigo-700 font-semibold'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              PMS Tasks ({counts.by_module.pms})
            </button>
          )}
          {counts.by_module.tickets > 0 && (
            <button
              type="button"
              onClick={() => setActiveTab('ticket')}
              className={`px-3 py-2 font-medium border-b-2 whitespace-nowrap transition-colors ${
                activeTab === 'ticket'
                  ? 'border-indigo-600 text-indigo-700 font-semibold'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              Help Tickets ({counts.by_module.tickets})
            </button>
          )}
          {counts.by_module.checklists > 0 && (
            <button
              type="button"
              onClick={() => setActiveTab('checklist')}
              className={`px-3 py-2 font-medium border-b-2 whitespace-nowrap transition-colors ${
                activeTab === 'checklist'
                  ? 'border-indigo-600 text-indigo-700 font-semibold'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              Checklists ({counts.by_module.checklists})
            </button>
          )}
        </div>

        {/* Task List Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-3 min-h-[220px]">
          {loading ? (
            <div className="py-12 text-center text-slate-500">
              <div className="inline-block w-8 h-8 border-3 border-indigo-600 border-t-transparent rounded-full animate-spin mb-3"></div>
              <p className="text-sm font-medium">Analyzing your tasks and SLAs...</p>
            </div>
          ) : filteredTasks.length === 0 ? (
            <div className="py-12 text-center">
              <div className="w-14 h-14 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center mx-auto mb-3 border border-emerald-200 shadow-sm">
                <FiCheckCircle size={28} />
              </div>
              <h4 className="text-base font-bold text-slate-800">Inbox Zero in this category!</h4>
              <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
                No pending or overdue tasks found matching this filter. Excellent job keeping your workflow on track.
              </p>
            </div>
          ) : (
            filteredTasks.map((t) => {
              const isSelectedFocus = focusedTaskIds.includes(t.id);
              const isCritical = t.category === 'critical_overdue';
              const isOverdue = t.is_overdue;

              return (
                <div
                  key={`${t.module}_${t.id}`}
                  className={`p-3.5 rounded-xl border transition-all ${
                    isSelectedFocus
                      ? 'bg-blue-50/60 border-blue-400 ring-2 ring-blue-300/40 shadow-sm'
                      : isCritical
                      ? 'bg-rose-50/30 border-rose-200 hover:border-rose-300'
                      : isOverdue
                      ? 'bg-amber-50/20 border-amber-200 hover:border-amber-300'
                      : 'bg-white border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {/* Focus Checkbox */}
                    <button
                      type="button"
                      onClick={() => toggleFocusTask(t.id)}
                      className="mt-0.5 text-slate-400 hover:text-blue-600 transition-colors flex-shrink-0"
                      title={isSelectedFocus ? 'Remove from today\'s focus' : 'Select as focus task for today'}
                    >
                      {isSelectedFocus ? (
                        <FiCheckSquare size={18} className="text-blue-600" />
                      ) : (
                        <FiSquare size={18} />
                      )}
                    </button>

                    {/* Task Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        {/* Module Badge */}
                        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 border border-slate-200">
                          {t.task_reference}
                        </span>

                        {/* SLA Aging Pill */}
                        {isCritical ? (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-rose-100 text-rose-800 border border-rose-300 flex items-center gap-1 shadow-xs">
                            <FiAlertTriangle size={11} className="text-rose-600" />
                            {t.aging_label}
                          </span>
                        ) : isOverdue ? (
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-amber-100 text-amber-800 border border-amber-300 flex items-center gap-1">
                            <FiClock size={11} className="text-amber-600" />
                            {t.aging_label}
                          </span>
                        ) : (
                          <span className="text-[10px] font-medium px-2 py-0.5 rounded-md bg-blue-100 text-blue-800 border border-blue-200">
                            {t.aging_label}
                          </span>
                        )}

                        {/* Priority Pill */}
                        {t.priority && (
                          <span className={`text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded ${
                            t.priority === 'urgent' ? 'bg-red-50 text-red-700 border border-red-200' :
                            t.priority === 'high' ? 'bg-orange-50 text-orange-700 border border-orange-200' :
                            'bg-slate-50 text-slate-600'
                          }`}>
                            {t.priority}
                          </span>
                        )}

                        {/* Project name if applicable */}
                        {t.project_name && (
                          <span className="text-[10px] text-slate-500 font-medium truncate max-w-[200px]">
                            📁 {t.project_name}
                          </span>
                        )}
                      </div>

                      <h4 className="text-sm font-semibold text-slate-900 leading-snug break-words">
                        {t.title}
                      </h4>

                      {t.description && (
                        <p className="text-xs text-slate-600 line-clamp-2 mt-1">
                          {t.description}
                        </p>
                      )}

                      <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-slate-100 text-[11px] text-slate-500">
                        <div className="truncate">
                          {t.assigned_by_name && (
                            <span>Assigned by: <strong className="text-slate-700 font-medium">{t.assigned_by_name}</strong></span>
                          )}
                          {t.effective_date && (
                            <span className="ml-2 text-slate-400">· Due: {t.effective_date}</span>
                          )}
                        </div>

                        <button
                          type="button"
                          onClick={() => handleOpenTask(t.link_url)}
                          className="flex items-center gap-1 text-blue-600 hover:text-blue-800 font-semibold transition-colors flex-shrink-0"
                        >
                          <span>Open Task</span>
                          <FiExternalLink size={12} />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Commitment & Action Footer */}
        <div className="p-4 sm:p-5 bg-slate-50 border-t border-slate-200 space-y-3">
          {/* Selected Focus Counter & Action Plan Note */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-600">
              <span className="font-semibold text-slate-700">
                🎯 Selected Focus Tasks for Today: <strong className="text-blue-700">{focusedTaskIds.length}</strong> selected
              </span>
              <span className="text-[11px] text-slate-400">Tip: Focus on 2-3 items to clear bottlenecks</span>
            </div>

            <input
              type="text"
              value={commitmentNote}
              onChange={(e) => setCommitmentNote(e.target.value)}
              placeholder="Optional: Enter your today's action plan / notes (e.g. Will close pending drawings by 2 PM)..."
              className="w-full text-xs px-3 py-2 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-slate-800 placeholder-slate-400"
              maxLength={250}
            />
          </div>

          {/* Confirmation Checkbox */}
          <label className="flex items-start gap-2.5 cursor-pointer select-none group">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
            />
            <span className="text-xs text-slate-700 font-medium leading-tight group-hover:text-slate-900">
              I have reviewed my overdue & due tasks for today. I commit to prioritizing these bottleneck items to keep work on schedule.
            </span>
          </label>

          {/* Action Buttons */}
          <div className="flex items-center justify-between gap-3 pt-1 flex-wrap">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleSnooze}
                className="px-3 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800 hover:bg-slate-200/70 rounded-lg transition-colors border border-slate-300"
              >
                Remind Me in 1 Hour
              </button>
              <button
                type="button"
                onClick={handleClose}
                className="px-3 py-2 text-xs font-medium text-slate-500 hover:text-slate-700 rounded-lg transition-colors"
              >
                Dismiss for Today
              </button>
            </div>

            <button
              type="button"
              onClick={handleConfirmAndStart}
              disabled={submitting}
              className={`px-5 py-2.5 rounded-xl text-xs font-bold transition-all shadow-md flex items-center gap-2 ${
                acknowledged
                  ? 'bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white cursor-pointer hover:shadow-lg'
                  : 'bg-slate-300 text-slate-500 cursor-not-allowed shadow-none'
              }`}
            >
              {submitting ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                  <span>Recording...</span>
                </>
              ) : (
                <>
                  <span>Confirm & Start My Day</span>
                  <FiArrowRight size={14} />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Quick Access Header Pill / Button Component
export function DailyFocusHeaderButton() {
  const [counts, setCounts] = useState({ total_attention_needed: 0, critical_overdue: 0, overdue: 0 });

  useEffect(() => {
    // Quiet fetch of counts for badge
    api.get('/daily-standup/briefing')
      .then(res => {
        if (res.data?.counts) {
          setCounts({
            total_attention_needed: res.data.counts.total_attention_needed || 0,
            critical_overdue: res.data.counts.critical_overdue || 0,
            overdue: res.data.counts.overdue || 0,
          });
        }
      })
      .catch(() => {});
  }, []);

  const handleClick = () => {
    window.dispatchEvent(new CustomEvent('sepl:open-daily-standup'));
  };

  // Only render if employee actually has overdue tasks
  const totalOverdue = (counts.critical_overdue || 0) + (counts.overdue || 0);
  if (totalOverdue === 0) return null;

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-all border shadow-xs ${
        counts.critical_overdue > 0
          ? 'bg-rose-50 text-rose-700 border-rose-300 hover:bg-rose-100 hover:border-rose-400'
          : 'bg-amber-50 text-amber-800 border-amber-300 hover:bg-amber-100 hover:border-amber-400'
      }`}
      title={`Daily Focus: ${counts.critical_overdue > 0 ? `${counts.critical_overdue} critical overdue tasks` : `${counts.total_attention_needed} tasks due`}`}
    >
      <FiSun size={14} className={counts.critical_overdue > 0 ? 'text-rose-600 animate-pulse' : 'text-amber-600'} />
      <span className="hidden md:inline">Daily Focus</span>
      <span className={`px-1.5 py-0.2 rounded-full text-[10px] font-black ${
        counts.critical_overdue > 0 ? 'bg-rose-600 text-white' : 'bg-amber-600 text-white'
      }`}>
        {counts.critical_overdue > 0 ? counts.critical_overdue : counts.total_attention_needed}
      </span>
    </button>
  );
}
