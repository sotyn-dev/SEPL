import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import api from '../api';
import Modal from './Modal';
import toast from 'react-hot-toast';
import {
  FiCalendar, FiPlus, FiEdit2, FiTrash2, FiUpload, FiDownload, FiRefreshCw,
  FiChevronRight, FiChevronDown, FiCheckCircle, FiClock, FiAlertTriangle,
  FiSearch, FiLayers, FiMaximize2, FiMinimize2, FiFileText, FiClipboard,
  FiCheck, FiX, FiCornerDownRight, FiSliders
} from 'react-icons/fi';

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const fmtShortDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
};

const daysBetween = (a, b) => {
  if (!a || !b) return 0;
  const da = new Date(a + 'T00:00:00').getTime();
  const db = new Date(b + 'T00:00:00').getTime();
  if (isNaN(da) || isNaN(db)) return 0;
  return Math.round((db - da) / (1000 * 60 * 60 * 24));
};

const addDaysIso = (iso, days) => {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + (days || 0));
  return d.toISOString().slice(0, 10);
};

export default function ExecutionGanttSchedule({ projectId, canEdit }) {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [timeScale, setTimeScale] = useState('weeks'); // 'days' | 'weeks' | 'months'
  const [collapsedIds, setCollapsedIds] = useState(new Set());
  
  // Modals state
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const [parentForNew, setParentForNew] = useState(null);
  const [isMilestoneModal, setIsMilestoneModal] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [hoveredTaskId, setHoveredTaskId] = useState(null);

  // Sync scrolling between left table and right timeline
  const tableScrollRef = useRef(null);
  const chartScrollRef = useRef(null);
  const isSyncingScroll = useRef(false);

  const handleTableScroll = (e) => {
    if (isSyncingScroll.current) return;
    isSyncingScroll.current = true;
    if (chartScrollRef.current) {
      chartScrollRef.current.scrollTop = e.target.scrollTop;
    }
    setTimeout(() => { isSyncingScroll.current = false; }, 20);
  };

  const handleChartScroll = (e) => {
    if (isSyncingScroll.current) return;
    isSyncingScroll.current = true;
    if (tableScrollRef.current) {
      tableScrollRef.current.scrollTop = e.target.scrollTop;
    }
    setTimeout(() => { isSyncingScroll.current = false; }, 20);
  };

  const loadTasks = useCallback(() => {
    if (!projectId) { setTasks([]); return; }
    setLoading(true);
    api.get(`/procurement-schedule/${projectId}/execution-tasks`)
      .then(res => {
        const raw = res.data;
        const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.tasks) ? raw.tasks : []);
        setTasks(list);
      })
      .catch(err => {
        toast.error(err.response?.data?.error || 'Failed to load execution tasks');
        setTasks([]);
      })
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  // Guaranteed array of tasks
  const safeTasks = useMemo(() => {
    return Array.isArray(tasks) ? tasks : (Array.isArray(tasks?.tasks) ? tasks.tasks : []);
  }, [tasks]);

  // Identify parents (tasks with children) and compute rollups
  const { parentIds, childMap } = useMemo(() => {
    const pSet = new Set();
    const cMap = {}; // parentId -> [childTasks]

    safeTasks.forEach(t => {
      if (t.parent_id) {
        pSet.add(t.parent_id);
        if (!cMap[t.parent_id]) cMap[t.parent_id] = [];
        cMap[t.parent_id].push(t);
      }
    });

    // Also check WBS prefix hierarchy if parent_id is missing
    safeTasks.forEach(t => {
      if (t.wbs_code) {
        safeTasks.forEach(other => {
          if (other.wbs_code && other.wbs_code !== t.wbs_code && other.wbs_code.startsWith(t.wbs_code + '.')) {
            pSet.add(t.id);
            if (!cMap[t.id]) cMap[t.id] = [];
            if (!cMap[t.id].some(x => x.id === other.id)) cMap[t.id].push(other);
          }
        });
      }
    });

    return { parentIds: pSet, childMap: cMap };
  }, [safeTasks]);

  // Rolled up tasks with auto start/finish if summary parent
  const processedTasks = useMemo(() => {
    return safeTasks.map(t => {
      const isParent = parentIds.has(t.id);
      if (!isParent) return { ...t, isParent: false };

      // Find all recursive children to roll up dates and progress
      const children = childMap[t.id] || [];
      let minStart = t.start_date;
      let maxEnd = t.end_date;
      let totalProgress = 0;
      let childCount = 0;

      children.forEach(c => {
        if (c.start_date && (!minStart || c.start_date < minStart)) minStart = c.start_date;
        if (c.end_date && (!maxEnd || c.end_date > maxEnd)) maxEnd = c.end_date;
        totalProgress += (c.progress_pct || 0);
        childCount++;
      });

      const avgProgress = childCount > 0 ? Math.round(totalProgress / childCount) : (t.progress_pct || 0);
      const dur = minStart && maxEnd ? daysBetween(minStart, maxEnd) + 1 : t.duration_days;

      return {
        ...t,
        isParent: true,
        start_date: minStart || t.start_date,
        end_date: maxEnd || t.end_date,
        duration_days: dur,
        progress_pct: avgProgress,
      };
    });
  }, [safeTasks, parentIds, childMap]);

  // Visible rows accounting for collapsed parents and search filter
  const visibleTasks = useMemo(() => {
    let list = processedTasks;

    // Filter by collapsed parents
    if (collapsedIds.size > 0) {
      list = list.filter(t => {
        // Check if any ancestor is collapsed
        let curr = t;
        while (curr && curr.parent_id) {
          if (collapsedIds.has(curr.parent_id)) return false;
          curr = processedTasks.find(x => x.id === curr.parent_id);
        }
        // Also check WBS prefix collapsed
        for (const cId of collapsedIds) {
          const parentT = processedTasks.find(x => x.id === cId);
          if (parentT?.wbs_code && t.wbs_code && t.wbs_code !== parentT.wbs_code && t.wbs_code.startsWith(parentT.wbs_code + '.')) {
            return false;
          }
        }
        return true;
      });
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(t =>
        (t.task_name && t.task_name.toLowerCase().includes(q)) ||
        (t.wbs_code && t.wbs_code.toLowerCase().includes(q)) ||
        (t.assigned_to && t.assigned_to.toLowerCase().includes(q))
      );
    }

    return list;
  }, [processedTasks, collapsedIds, searchQuery]);

  // Stats calculation
  const stats = useMemo(() => {
    const total = safeTasks.length;
    let completed = 0;
    let inProgress = 0;
    let milestones = 0;
    let totalPct = 0;

    safeTasks.forEach(t => {
      if (t.is_milestone || t.duration_days === 0) milestones++;
      if ((t.progress_pct || 0) >= 100 || t.status === 'completed') completed++;
      else if ((t.progress_pct || 0) > 0 || t.status === 'in_progress') inProgress++;
      totalPct += (t.progress_pct || 0);
    });

    const avgPct = total > 0 ? Math.round(totalPct / total) : 0;
    return { total, completed, inProgress, milestones, avgPct };
  }, [safeTasks]);

  // Timeline time-scale extents
  const { minDate, maxDate, totalDays } = useMemo(() => {
    let minD = null;
    let maxD = null;

    safeTasks.forEach(t => {
      if (t.start_date && (!minD || t.start_date < minD)) minD = t.start_date;
      if (t.end_date && (!maxD || t.end_date > maxD)) maxD = t.end_date;
    });

    const today = new Date().toISOString().slice(0, 10);
    if (!minD) minD = addDaysIso(today, -3);
    if (!maxD) maxD = addDaysIso(today, 30);

    // Add breathing room padding
    const paddedMin = addDaysIso(minD, -3);
    const paddedMax = addDaysIso(maxD, 7);
    const total = daysBetween(paddedMin, paddedMax) + 1;

    return { minDate: paddedMin, maxDate: paddedMax, totalDays: total };
  }, [safeTasks]);

  const PX_PER_DAY = timeScale === 'days' ? 26 : timeScale === 'weeks' ? 10 : 3.5;
  const CHART_W = Math.max(750, totalDays * PX_PER_DAY);
  const ROW_H = 34;
  const HEADER_H = 50;

  const todayStr = new Date().toISOString().slice(0, 10);
  const todayOffsetDays = todayStr >= minDate && todayStr <= maxDate ? daysBetween(minDate, todayStr) : null;

  // Toggle expand / collapse of a parent task
  const toggleCollapse = (taskId) => {
    setCollapsedIds(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const expandAll = () => setCollapsedIds(new Set());
  const collapseAll = () => {
    const next = new Set();
    parentIds.forEach(id => next.add(id));
    setCollapsedIds(next);
  };

  // Open task create modal
  const openCreateTask = (parent = null, milestone = false) => {
    setParentForNew(parent);
    setIsMilestoneModal(milestone);
    setEditingTask(null);
    setIsTaskModalOpen(true);
  };

  // Open task edit modal
  const openEditTask = (task) => {
    setEditingTask(task);
    setParentForNew(null);
    setIsMilestoneModal(!!task.is_milestone);
    setIsTaskModalOpen(true);
  };

  // Delete task
  const handleDeleteTask = async (task) => {
    const isParent = parentIds.has(task.id);
    const confirmMsg = isParent
      ? `"${task.task_name}" has child tasks. Deleting it will delete all its subtasks too. Are you sure?`
      : `Delete task "${task.task_name}"?`;
    if (!confirm(confirmMsg)) return;

    try {
      await api.delete(`/procurement-schedule/${projectId}/execution-tasks/${task.id}`);
      toast.success('Task deleted');
      loadTasks();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to delete task');
    }
  };

  // Export CSV
  const handleExportCsv = async () => {
    try {
      const res = await api.get(`/procurement-schedule/${projectId}/export-gantter`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `project_${projectId}_gantter_schedule.csv`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      toast.success('Gantter schedule exported to CSV');
    } catch {
      toast.error('Failed to export schedule');
    }
  };

  if (!projectId) {
    return (
      <div className="card p-8 text-center text-gray-400">
        <FiCalendar size={40} className="mx-auto mb-2 opacity-30" />
        <p className="font-medium text-base text-gray-600 mb-1">No Project Selected</p>
        <p className="text-xs text-gray-500">Pick a project from the selector above to view, build, or import its Google Gantter execution schedule.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Top Banner & Stats */}
      <div className="card p-3 bg-gradient-to-r from-slate-50 via-white to-indigo-50/40 border border-slate-200/80">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="p-1.5 bg-indigo-600 text-white rounded-md">
                <FiLayers size={16} />
              </span>
              <h2 className="font-bold text-base text-slate-800">Project Execution Schedule (Gantter WBS)</h2>
              <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 bg-indigo-100 text-indigo-800 rounded-full">
                Interactive Gantt & WBS
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              MS Project & Google Gantter compatible. Manage tasks, dependencies, milestones, and import directly from Google Sheets or XML files.
            </p>
          </div>

          <div className="flex items-center gap-4 text-xs">
            <div className="text-center px-3 py-1 bg-white border border-slate-200 rounded-lg shadow-sm">
              <span className="text-[10px] uppercase font-bold text-slate-400 block">Tasks</span>
              <span className="font-bold text-slate-800 text-sm">{stats.total}</span>
            </div>
            <div className="text-center px-3 py-1 bg-white border border-slate-200 rounded-lg shadow-sm">
              <span className="text-[10px] uppercase font-bold text-purple-500 block">Milestones</span>
              <span className="font-bold text-purple-700 text-sm">{stats.milestones}</span>
            </div>
            <div className="text-center px-3 py-1 bg-white border border-slate-200 rounded-lg shadow-sm">
              <span className="text-[10px] uppercase font-bold text-blue-500 block">In Progress</span>
              <span className="font-bold text-blue-700 text-sm">{stats.inProgress}</span>
            </div>
            <div className="text-center px-3 py-1 bg-white border border-slate-200 rounded-lg shadow-sm">
              <span className="text-[10px] uppercase font-bold text-emerald-500 block">Done</span>
              <span className="font-bold text-emerald-700 text-sm">{stats.completed}</span>
            </div>
            <div className="text-center px-3 py-1 bg-white border border-slate-200 rounded-lg shadow-sm min-w-[90px]">
              <span className="text-[10px] uppercase font-bold text-slate-400 block">Overall</span>
              <div className="flex items-center justify-center gap-1.5">
                <span className="font-bold text-indigo-700 text-sm">{stats.avgPct}%</span>
                <div className="w-8 bg-slate-100 rounded-full h-1.5 overflow-hidden">
                  <div className="bg-indigo-600 h-1.5 rounded-full" style={{ width: `${stats.avgPct}%` }} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Action Toolbar */}
      <div className="card p-2 flex flex-wrap items-center justify-between gap-2 bg-white">
        <div className="flex items-center gap-2 flex-wrap">
          {/* Search box */}
          <div className="relative">
            <FiSearch size={13} className="absolute left-2.5 top-2.5 text-slate-400" />
            <input
              type="text"
              className="input text-xs pl-8 pr-6 py-1 w-48 sm:w-60 h-8"
              placeholder="Filter tasks, WBS, assigned..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="absolute right-2 top-2 text-slate-400 hover:text-slate-600">
                <FiX size={12} />
              </button>
            )}
          </div>

          {/* Time Scale switcher */}
          <div className="flex items-center bg-slate-100 rounded-lg p-0.5 border border-slate-200 text-xs">
            {['days', 'weeks', 'months'].map(s => (
              <button
                key={s}
                onClick={() => setTimeScale(s)}
                className={`px-2.5 py-1 rounded-md capitalize font-medium transition ${
                  timeScale === s ? 'bg-white text-indigo-700 shadow-sm font-semibold' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {s}
              </button>
            ))}
          </div>

          {/* Expand / Collapse */}
          <button
            onClick={collapsedIds.size > 0 ? expandAll : collapseAll}
            className="btn btn-secondary text-xs h-8 px-2 flex items-center gap-1"
            title={collapsedIds.size > 0 ? 'Expand All Tasks' : 'Collapse All Tasks'}
          >
            {collapsedIds.size > 0 ? <FiMaximize2 size={11} /> : <FiMinimize2 size={11} />}
            {collapsedIds.size > 0 ? 'Expand All' : 'Collapse All'}
          </button>

          <button onClick={loadTasks} className="btn btn-secondary text-xs h-8 px-2 flex items-center gap-1" title="Refresh schedule">
            <FiRefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {canEdit && (
            <>
              <button
                onClick={() => setIsImportModalOpen(true)}
                className="btn btn-secondary text-xs h-8 flex items-center gap-1.5 border-indigo-200 text-indigo-700 hover:bg-indigo-50"
                title="Import from Google Sheets, Excel, or Gantter XML"
              >
                <FiUpload size={12} /> Import Gantter / Sheets
              </button>

              <button
                onClick={() => openCreateTask(null, true)}
                className="btn btn-secondary text-xs h-8 flex items-center gap-1.5 text-purple-700 border-purple-200 hover:bg-purple-50"
              >
                <span className="text-purple-600">◆</span> Add Milestone
              </button>

              <button
                onClick={() => openCreateTask()}
                className="btn btn-primary text-xs h-8 flex items-center gap-1.5"
              >
                <FiPlus size={13} /> Add Task
              </button>
            </>
          )}

          <button
            onClick={handleExportCsv}
            disabled={safeTasks.length === 0}
            className="btn btn-secondary text-xs h-8 flex items-center gap-1 text-slate-600 disabled:opacity-40"
            title="Download CSV export"
          >
            <FiDownload size={12} /> Export CSV
          </button>
        </div>
      </div>

      {/* Main Split Content: Left WBS Grid + Right Gantt Timeline */}
      {loading && safeTasks.length === 0 ? (
        <div className="card p-12 text-center text-slate-400">
          <FiRefreshCw size={28} className="mx-auto mb-2 animate-spin text-indigo-500" />
          <p className="font-medium text-slate-600">Loading execution schedule…</p>
        </div>
      ) : safeTasks.length === 0 ? (
        <div className="card p-12 text-center">
          <div className="w-16 h-16 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center mx-auto mb-3">
            <FiLayers size={32} />
          </div>
          <h3 className="text-base font-bold text-slate-800 mb-1">No execution schedule created yet</h3>
          <p className="text-xs text-slate-500 max-w-md mx-auto mb-4">
            Build your project execution timeline with WBS, milestones, and predecessors. You can import directly from Google Gantter, MS Project, or copy-paste rows from Google Sheets.
          </p>
          {canEdit && (
            <div className="flex justify-center gap-2">
              <button
                onClick={() => setIsImportModalOpen(true)}
                className="btn btn-primary text-xs flex items-center gap-1.5"
              >
                <FiUpload size={12} /> Import from Gantter / Google Sheets
              </button>
              <button
                onClick={() => openCreateTask()}
                className="btn btn-secondary text-xs flex items-center gap-1.5"
              >
                <FiPlus size={12} /> Add First Task Manually
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="card p-0 overflow-hidden border border-slate-200 shadow-sm bg-white">
          <div className="flex border-b border-slate-200">
            {/* ──── LEFT WBS TABLE PANE ──── */}
            <div
              ref={tableScrollRef}
              onScroll={handleTableScroll}
              className="w-[460px] lg:w-[500px] flex-shrink-0 border-r border-slate-200 overflow-x-auto overflow-y-auto"
              style={{ maxHeight: '72vh' }}
            >
              <div style={{ minWidth: 460 }}>
                {/* Table Header */}
                <div
                  className="sticky top-0 z-20 bg-slate-100 border-b border-slate-200 flex items-center text-[10px] font-bold uppercase text-slate-600"
                  style={{ height: HEADER_H }}
                >
                  <div className="w-10 text-center flex-shrink-0">#</div>
                  <div className="w-14 px-1 flex-shrink-0">WBS</div>
                  <div className="flex-1 px-2 min-w-[150px]">Task Name</div>
                  <div className="w-12 text-center flex-shrink-0">Dur</div>
                  <div className="w-16 text-center flex-shrink-0">Start</div>
                  <div className="w-16 text-center flex-shrink-0">Finish</div>
                  <div className="w-14 text-center flex-shrink-0">Pred</div>
                  <div className="w-12 text-center flex-shrink-0">%</div>
                  {canEdit && <div className="w-14 text-center flex-shrink-0">Actions</div>}
                </div>

                {/* Table Rows */}
                {visibleTasks.map((t, idx) => {
                  const isHovered = hoveredTaskId === t.id;
                  const isMilestone = t.is_milestone || t.duration_days === 0;
                  const indentPx = Math.max(0, ((t.outline_level || 1) - 1) * 14);

                  return (
                    <div
                      key={t.id}
                      onMouseEnter={() => setHoveredTaskId(t.id)}
                      onMouseLeave={() => setHoveredTaskId(null)}
                      className={`flex items-center text-xs border-b border-slate-100 transition-colors ${
                        isHovered ? 'bg-indigo-50/70' : idx % 2 === 1 ? 'bg-slate-50/40' : 'bg-white'
                      }`}
                      style={{ height: ROW_H }}
                    >
                      {/* # Index */}
                      <div className="w-10 text-center font-mono text-[10px] text-slate-400 flex-shrink-0">
                        {idx + 1}
                      </div>

                      {/* WBS */}
                      <div className="w-14 px-1 font-mono text-[10px] text-slate-600 flex-shrink-0 truncate" title={t.wbs_code}>
                        {t.wbs_code || '—'}
                      </div>

                      {/* Task Name with indentation & expander */}
                      <div className="flex-1 px-2 flex items-center gap-1 min-w-[150px] overflow-hidden" style={{ paddingLeft: `${8 + indentPx}px` }}>
                        {t.isParent ? (
                          <button
                            onClick={(e) => { e.stopPropagation(); toggleCollapse(t.id); }}
                            className="p-0.5 text-slate-500 hover:text-slate-800 rounded"
                          >
                            {collapsedIds.has(t.id) ? <FiChevronRight size={12} /> : <FiChevronDown size={12} />}
                          </button>
                        ) : (
                          <span className="w-3.5 inline-block text-center text-[10px]">
                            {isMilestone ? <span className="text-purple-600 font-bold">◆</span> : <span className="text-slate-300">•</span>}
                          </span>
                        )}

                        <span
                          className={`truncate cursor-pointer hover:text-indigo-600 ${
                            t.isParent ? 'font-bold text-slate-900' : isMilestone ? 'font-semibold text-purple-900' : 'text-slate-700'
                          }`}
                          onClick={() => canEdit && openEditTask(t)}
                          title={`${t.task_name} (Click to edit)`}
                        >
                          {t.task_name}
                        </span>
                      </div>

                      {/* Duration */}
                      <div className="w-12 text-center text-[11px] text-slate-500 flex-shrink-0 font-mono">
                        {isMilestone ? '0d' : `${t.duration_days || 1}d`}
                      </div>

                      {/* Start Date */}
                      <div className="w-16 text-center text-[10px] text-slate-600 flex-shrink-0">
                        {fmtShortDate(t.start_date)}
                      </div>

                      {/* End Date */}
                      <div className="w-16 text-center text-[10px] text-slate-600 flex-shrink-0">
                        {fmtShortDate(t.end_date)}
                      </div>

                      {/* Predecessors */}
                      <div className="w-14 text-center text-[10px] text-slate-500 flex-shrink-0 font-mono truncate" title={t.dependencies}>
                        {t.dependencies || '—'}
                      </div>

                      {/* Progress % */}
                      <div className="w-12 text-center flex-shrink-0">
                        <span className={`text-[10px] font-bold px-1 py-0.5 rounded ${
                          (t.progress_pct || 0) === 100 ? 'bg-emerald-100 text-emerald-800' :
                          (t.progress_pct || 0) > 0 ? 'bg-blue-100 text-blue-800' : 'bg-slate-100 text-slate-600'
                        }`}>
                          {t.progress_pct || 0}%
                        </span>
                      </div>

                      {/* Actions */}
                      {canEdit && (
                        <div className="w-14 flex items-center justify-center gap-1 flex-shrink-0">
                          <button
                            onClick={() => openCreateTask(t)}
                            title="Add subtask below this"
                            className="p-1 text-slate-400 hover:text-indigo-600 rounded"
                          >
                            <FiCornerDownRight size={11} />
                          </button>
                          <button
                            onClick={() => openEditTask(t)}
                            title="Edit task"
                            className="p-1 text-slate-400 hover:text-blue-600 rounded"
                          >
                            <FiEdit2 size={11} />
                          </button>
                          <button
                            onClick={() => handleDeleteTask(t)}
                            title="Delete task"
                            className="p-1 text-slate-400 hover:text-red-600 rounded"
                          >
                            <FiTrash2 size={11} />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ──── RIGHT GANTT TIMELINE PANE ──── */}
            <div
              ref={chartScrollRef}
              onScroll={handleChartScroll}
              className="flex-1 overflow-x-auto overflow-y-auto bg-slate-50/20"
              style={{ maxHeight: '72vh' }}
            >
              <div className="relative select-none" style={{ width: CHART_W }}>
                {/* Timeline Header (Months + Days/Weeks) */}
                <TimelineHeader
                  minDate={minDate}
                  totalDays={totalDays}
                  pxPerDay={PX_PER_DAY}
                  timeScale={timeScale}
                  headerHeight={HEADER_H}
                />

                {/* Today Line Indicator */}
                {todayOffsetDays !== null && (
                  <div
                    className="absolute pointer-events-none z-10"
                    style={{
                      top: HEADER_H,
                      left: todayOffsetDays * PX_PER_DAY,
                      width: 2,
                      height: visibleTasks.length * ROW_H,
                      background: 'rgba(239, 68, 68, 0.75)',
                    }}
                  >
                    <div className="absolute -top-3.5 -left-4 text-[8px] font-extrabold uppercase px-1 py-0.2 bg-red-600 text-white rounded shadow-sm">
                      Today
                    </div>
                  </div>
                )}

                {/* SVG Predecessor Dependency Connector Lines */}
                <svg
                  className="absolute top-0 left-0 pointer-events-none z-[5]"
                  style={{ width: CHART_W, height: HEADER_H + visibleTasks.length * ROW_H }}
                >
                  <defs>
                    <marker
                      id="gantt-arrow"
                      viewBox="0 0 6 6"
                      refX="5"
                      refY="3"
                      markerWidth="6"
                      markerHeight="6"
                      orient="auto"
                    >
                      <path d="M 0 0 L 6 3 L 0 6 z" fill="#64748b" />
                    </marker>
                    <marker
                      id="gantt-arrow-active"
                      viewBox="0 0 6 6"
                      refX="5"
                      refY="3"
                      markerWidth="6"
                      markerHeight="6"
                      orient="auto"
                    >
                      <path d="M 0 0 L 6 3 L 0 6 z" fill="#4f46e5" />
                    </marker>
                  </defs>

                  <DependencyLines
                    tasks={visibleTasks}
                    minDate={minDate}
                    pxPerDay={PX_PER_DAY}
                    rowHeight={ROW_H}
                    headerHeight={HEADER_H}
                    hoveredTaskId={hoveredTaskId}
                  />
                </svg>

                {/* Chart Rows & Bars */}
                {visibleTasks.map((t, idx) => {
                  const isHovered = hoveredTaskId === t.id;
                  const isMilestone = t.is_milestone || t.duration_days === 0;
                  const offsetStart = t.start_date ? daysBetween(minDate, t.start_date) : 0;
                  const offsetEnd = t.end_date ? daysBetween(minDate, t.end_date) + 1 : offsetStart + (t.duration_days || 1);
                  const barWidthDays = Math.max(1, offsetEnd - offsetStart);

                  const barX = Math.max(0, offsetStart * PX_PER_DAY);
                  const barW = Math.max(14, barWidthDays * PX_PER_DAY - 2);

                  return (
                    <div
                      key={t.id}
                      onMouseEnter={() => setHoveredTaskId(t.id)}
                      onMouseLeave={() => setHoveredTaskId(null)}
                      onClick={() => canEdit && openEditTask(t)}
                      className={`relative border-b border-slate-100 transition-colors cursor-pointer ${
                        isHovered ? 'bg-indigo-50/50' : idx % 2 === 1 ? 'bg-slate-50/30' : 'bg-white'
                      }`}
                      style={{ height: ROW_H, width: CHART_W }}
                      title={`${t.task_name} | ${fmtShortDate(t.start_date)} → ${fmtShortDate(t.end_date)} (${t.duration_days || 1}d) | Progress: ${t.progress_pct || 0}%`}
                    >
                      {/* Milestone Diamond */}
                      {isMilestone && (
                        <div
                          className="absolute flex items-center gap-1.5"
                          style={{
                            left: barX,
                            top: 7,
                            height: 20,
                          }}
                        >
                          <div className="w-4 h-4 bg-purple-600 border border-purple-800 rotate-45 rounded-[2px] shadow-sm flex-shrink-0" />
                          <span className="text-[10px] font-semibold text-purple-900 whitespace-nowrap drop-shadow-sm">
                            {t.task_name} <span className="text-purple-600 font-normal">({fmtShortDate(t.start_date)})</span>
                          </span>
                        </div>
                      )}

                      {/* Summary Parent Bracket Bar (Gantter / MS Project style) */}
                      {!isMilestone && t.isParent && (
                        <div
                          className="absolute"
                          style={{
                            left: barX,
                            width: barW,
                            top: 8,
                            height: 14,
                          }}
                        >
                          {/* Top charcoal bar */}
                          <div className="h-2 bg-slate-800 rounded-sm relative overflow-hidden">
                            {/* Inner progress fill */}
                            <div
                              className="h-full bg-indigo-500"
                              style={{ width: `${t.progress_pct || 0}%` }}
                            />
                          </div>
                          {/* Left and Right downward wedges */}
                          <div className="absolute -left-0 -bottom-1 w-0 h-0 border-t-[6px] border-t-slate-800 border-r-[5px] border-r-transparent" />
                          <div className="absolute -right-0 -bottom-1 w-0 h-0 border-t-[6px] border-t-slate-800 border-l-[5px] border-l-transparent" />
                          {/* Label beside if bar is small */}
                          <span className="absolute left-full ml-1.5 -top-0.5 text-[9px] font-bold text-slate-700 whitespace-nowrap">
                            {t.progress_pct || 0}%
                          </span>
                        </div>
                      )}

                      {/* Standard Task Bar */}
                      {!isMilestone && !t.isParent && (
                        <div
                          className={`absolute rounded-md shadow-xs flex items-center overflow-hidden border transition-all ${
                            (t.progress_pct || 0) === 100
                              ? 'bg-emerald-200 border-emerald-400 text-emerald-950'
                              : (t.progress_pct || 0) > 0
                              ? 'bg-indigo-100 border-indigo-300 text-indigo-950'
                              : 'bg-slate-200 border-slate-300 text-slate-800'
                          } ${isHovered ? 'ring-2 ring-indigo-400 brightness-95' : ''}`}
                          style={{
                            left: barX,
                            width: barW,
                            top: 6,
                            height: 22,
                          }}
                        >
                          {/* Progress fill bar */}
                          <div
                            className={`h-full absolute left-0 top-0 opacity-80 ${
                              (t.progress_pct || 0) === 100
                                ? 'bg-emerald-500'
                                : (t.progress_pct || 0) > 0
                                ? 'bg-indigo-600'
                                : 'bg-slate-400'
                            }`}
                            style={{ width: `${t.progress_pct || 0}%` }}
                          />

                          {/* Task text inside bar or truncated */}
                          <span className="relative z-[2] px-1.5 text-[10px] font-medium truncate pointer-events-none drop-shadow-xs">
                            {barW > 50 ? `${t.task_name} · ${t.progress_pct || 0}%` : `${t.progress_pct || 0}%`}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ──── IMPORT MODAL ──── */}
      <ImportGantterModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        projectId={projectId}
        onSuccess={() => { setIsImportModalOpen(false); loadTasks(); }}
      />

      {/* ──── TASK ADD / EDIT MODAL ──── */}
      <TaskEditModal
        isOpen={isTaskModalOpen}
        onClose={() => { setIsTaskModalOpen(false); setEditingTask(null); }}
        task={editingTask}
        parentTask={parentForNew}
        isMilestoneInitial={isMilestoneModal}
        allTasks={safeTasks}
        projectId={projectId}
        onSuccess={() => { setIsTaskModalOpen(false); setEditingTask(null); loadTasks(); }}
        onDelete={handleDeleteTask}
      />
    </div>
  );
}

// ─── TIMELINE HEADER (Two tiers: Months & Days/Weeks) ─────────────
function TimelineHeader({ minDate, totalDays, pxPerDay, timeScale, headerHeight }) {
  const monthTicks = useMemo(() => {
    const ticks = [];
    let lastMonth = '';
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(minDate + 'T00:00:00');
      d.setDate(d.getDate() + i);
      const m = d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
      if (m !== lastMonth) {
        ticks.push({ offset: i * pxPerDay, label: m });
        lastMonth = m;
      }
    }
    return ticks;
  }, [minDate, totalDays, pxPerDay]);

  const subTicks = useMemo(() => {
    const ticks = [];
    if (timeScale === 'days') {
      for (let i = 0; i < totalDays; i++) {
        const d = new Date(minDate + 'T00:00:00');
        d.setDate(d.getDate() + i);
        const dayNum = d.getDate();
        const dayOfWeek = ['S','M','T','W','T','F','S'][d.getDay()];
        const isWeekend = d.getDay() === 0 || d.getDay() === 6;
        ticks.push({
          offset: i * pxPerDay,
          label: `${dayNum} ${dayOfWeek}`,
          isWeekend,
          width: pxPerDay,
        });
      }
    } else if (timeScale === 'weeks') {
      let lastOffset = -100;
      for (let i = 0; i < totalDays; i++) {
        const d = new Date(minDate + 'T00:00:00');
        d.setDate(d.getDate() + i);
        if (d.getDay() === 1) {
          const offset = i * pxPerDay;
          if (offset - lastOffset >= 35) {
            const label = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
            ticks.push({ offset, label });
            lastOffset = offset;
          }
        }
      }
    } else if (timeScale === 'months') {
      for (let i = 0; i < totalDays; i++) {
        const d = new Date(minDate + 'T00:00:00');
        d.setDate(d.getDate() + i);
        if (d.getDate() === 1 || d.getDate() === 15) {
          const label = `${d.getDate()} ${d.toLocaleDateString('en-IN', { month: 'short' })}`;
          ticks.push({ offset: i * pxPerDay, label });
        }
      }
    }
    return ticks;
  }, [minDate, totalDays, pxPerDay, timeScale]);

  return (
    <div className="sticky top-0 z-20 bg-slate-100 border-b border-slate-200" style={{ height: headerHeight }}>
      {/* Month row */}
      <div className="h-7 relative border-b border-slate-200">
        {monthTicks.map((t, i) => (
          <div
            key={i}
            className="absolute top-0 text-[10px] font-bold text-slate-700 border-l border-slate-300 pl-1.5 leading-7 truncate"
            style={{ left: t.offset }}
          >
            {t.label}
          </div>
        ))}
      </div>

      {/* Sub-tier row (days or weeks) */}
      <div className="h-5 relative bg-white overflow-hidden">
        {subTicks.map((t, i) => (
          <div
            key={i}
            className={`absolute top-0 text-[9px] border-l border-slate-200 pl-1 leading-5 whitespace-nowrap ${
              t.isWeekend ? 'bg-slate-100/80 font-bold text-slate-500' : 'text-slate-600'
            }`}
            style={{ left: t.offset, width: t.width || 'auto' }}
          >
            {t.label}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── DEPENDENCY CONNECTOR LINES (SVG) ─────────────────────────────
function DependencyLines({ tasks, minDate, pxPerDay, rowHeight, headerHeight, hoveredTaskId }) {
  const paths = useMemo(() => {
    const list = [];
    const taskIndexMap = new Map();
    const taskIdMap = new Map();
    const taskWbsMap = new Map();

    tasks.forEach((t, i) => {
      taskIndexMap.set(t.id, i);
      taskIdMap.set(String(t.id), t);
      if (t.wbs_code) taskWbsMap.set(String(t.wbs_code).trim(), t);
    });

    tasks.forEach((succ, succIdx) => {
      if (!succ.dependencies) return;

      const depParts = String(succ.dependencies).split(/[,;]/).map(s => s.trim()).filter(Boolean);
      depParts.forEach(rawDep => {
        // Strip out relationship codes like FS, SS and lags like +2d
        const cleanRef = rawDep.replace(/[^0-9\.]/g, '');
        if (!cleanRef) return;

        // Try matching WBS code, or ID, or 1-based row number
        let pred = taskWbsMap.get(cleanRef) || taskIdMap.get(cleanRef);
        if (!pred && !isNaN(Number(cleanRef))) {
          const rowNum = Number(cleanRef);
          if (rowNum >= 1 && rowNum <= tasks.length) {
            pred = tasks[rowNum - 1];
          }
        }

        if (!pred || pred.id === succ.id) return;
        const predIdx = taskIndexMap.get(pred.id);
        if (predIdx === undefined) return; // predecessor is filtered or collapsed

        // Calculate connector points
        const predOffsetEnd = pred.end_date ? daysBetween(minDate, pred.end_date) + 1 : (daysBetween(minDate, pred.start_date) + (pred.duration_days || 1));
        const succOffsetStart = succ.start_date ? daysBetween(minDate, succ.start_date) : 0;

        const x1 = Math.max(0, predOffsetEnd * pxPerDay);
        const y1 = headerHeight + predIdx * rowHeight + rowHeight / 2;

        const x2 = Math.max(0, succOffsetStart * pxPerDay);
        const y2 = headerHeight + succIdx * rowHeight + rowHeight / 2;

        const isRelated = hoveredTaskId === succ.id || hoveredTaskId === pred.id;

        // Orthogonal stepped path: x1,y1 -> right 8px -> down/up to y2 -> into x2
        let pathD = '';
        if (x2 >= x1 + 10) {
          const midX = x1 + 8;
          pathD = `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`;
        } else {
          // If successor starts earlier, route around
          const midY = y1 + (y2 > y1 ? rowHeight / 2 : -rowHeight / 2);
          pathD = `M ${x1} ${y1} L ${x1 + 8} ${y1} L ${x1 + 8} ${midY} L ${Math.max(4, x2 - 8)} ${midY} L ${Math.max(4, x2 - 8)} ${y2} L ${x2} ${y2}`;
        }

        list.push({ id: `${pred.id}->${succ.id}`, d: pathD, isRelated });
      });
    });

    return list;
  }, [tasks, minDate, pxPerDay, rowHeight, headerHeight, hoveredTaskId]);

  return (
    <>
      {paths.map(p => (
        <path
          key={p.id}
          d={p.d}
          fill="none"
          stroke={p.isRelated ? '#4f46e5' : '#94a3b8'}
          strokeWidth={p.isRelated ? 2 : 1.2}
          strokeDasharray={p.isRelated ? 'none' : '3 2'}
          markerEnd={p.isRelated ? 'url(#gantt-arrow-active)' : 'url(#gantt-arrow)'}
        />
      ))}
    </>
  );
}

// ─── IMPORT GANTTER / SHEETS MODAL ────────────────────────────────
function ImportGantterModal({ isOpen, onClose, projectId, onSuccess }) {
  const [importTab, setImportTab] = useState('paste'); // 'paste' | 'file'
  const [pasteContent, setPasteContent] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [importMode, setImportMode] = useState('replace'); // 'replace' | 'append'
  const [submitting, setSubmitting] = useState(false);

  // Real-time live parser preview for pasted text
  const preview = useMemo(() => {
    if (!pasteContent.trim()) return null;
    const lines = pasteContent.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length === 0) return null;

    // Detect separator
    const firstLine = lines[0];
    const sep = firstLine.includes('\t') ? '\t' : ',';
    const headers = firstLine.split(sep).map(h => h.trim().replace(/^["']|["']$/g, ''));

    const rows = lines.slice(1, 6).map(l => {
      return l.split(sep).map(c => c.trim().replace(/^["']|["']$/g, ''));
    });

    return {
      totalRows: lines.length - 1,
      headers: headers.slice(0, 6),
      sampleRows: rows,
    };
  }, [pasteContent]);

  const loadSampleTemplate = () => {
    const sample = `WBS\tTask Name\tStart Date\tEnd Date\tDuration\tPredecessors\tProgress\tAssigned To
1\tProject Inception & Approvals\t2026-09-10\t2026-09-18\t8\t—\t100%\tProject Manager
1.1\tClient Kickoff & Site Clearance\t2026-09-10\t2026-09-14\t4\t—\t100%\tSite Admin
1.2\tSite Mobilization & Temporary Power\t2026-09-15\t2026-09-18\t4\t1.1\t100%\tElectrical Team
2\tCivil & Structural Works\t2026-09-19\t2026-10-15\t26\t1.2\t40%\tCivil Contractor
2.1\tExcavation & Footing Casting\t2026-09-19\t2026-09-30\t11\t1.2\t85%\tCivil Subcontractor
2.2\tRCC Column Casting & Beams\t2026-10-01\t2026-10-15\t14\t2.1\t10%\tMasonry Gang
3\tMEP & Piping Services\t2026-10-16\t2026-11-05\t20\t2.2\t0%\tMEP Engineer
3.1\tConduit Laying & Sleeves\t2026-10-16\t2026-10-26\t10\t2.2\t0%\tElectrical
3.2\tPiping & Valve Assemblies\t2026-10-27\t2026-11-05\t9\t3.1\t0%\tPlumbing
4\tTesting & Pressure Commissioning\t2026-11-08\t2026-11-08\t0\t3.2\t0%\tQuality Lead
5\tClient Handover & Signoff\t2026-11-12\t2026-11-12\t0\t4\t0%\tManagement`;
    setPasteContent(sample);
  };

  const handleImport = async () => {
    setSubmitting(true);
    try {
      if (importTab === 'paste') {
        if (!pasteContent.trim()) {
          toast.error('Please paste table data from Google Sheets or Excel');
          setSubmitting(false);
          return;
        }

        const res = await api.post(`/procurement-schedule/${projectId}/import-gantter`, {
          content: pasteContent,
          text: pasteContent,
          format: 'tsv',
          mode: importMode,
        });

        toast.success(res.data?.message || 'Schedule imported successfully!');
        onSuccess();
      } else {
        if (!selectedFile) {
          toast.error('Please choose a file (.xml, .gantter, .json, .csv) to upload');
          setSubmitting(false);
          return;
        }

        const formData = new FormData();
        formData.append('file', selectedFile);
        formData.append('mode', importMode);

        const res = await api.post(`/procurement-schedule/${projectId}/import-gantter`, formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });

        toast.success(res.data?.message || 'File imported successfully!');
        onSuccess();
      }
    } catch (e) {
      const errMsg = e.response?.data?.error || e.message || 'Import failed';
      toast.error(errMsg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Import Schedule into Gantter WBS" xwide>
      <div className="space-y-4">
        {/* Method selector tabs */}
        <div className="flex border-b border-slate-200">
          <button
            onClick={() => setImportTab('paste')}
            className={`px-4 py-2 text-xs font-semibold border-b-2 -mb-px flex items-center gap-1.5 transition ${
              importTab === 'paste' ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <FiClipboard size={13} /> Paste from Google Sheets / Excel
          </button>
          <button
            onClick={() => setImportTab('file')}
            className={`px-4 py-2 text-xs font-semibold border-b-2 -mb-px flex items-center gap-1.5 transition ${
              importTab === 'file' ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <FiUpload size={13} /> Upload Gantter XML / MS Project / CSV
          </button>
        </div>

        {/* Tab 1: Paste from Google Sheets */}
        {importTab === 'paste' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[10px] font-bold uppercase text-slate-500 block">
                Paste Tabular Data (Ctrl+V)
              </label>
              <button
                type="button"
                onClick={loadSampleTemplate}
                className="text-[11px] text-indigo-600 hover:text-indigo-800 font-semibold"
              >
                + Load Sample Template
              </button>
            </div>
            <textarea
              className="input text-xs font-mono w-full"
              rows={8}
              placeholder="Copy rows in Google Sheets or Excel and paste here (Tab or Comma separated). Columns supported: WBS, Task Name, Start Date, End Date, Duration, Predecessors, Progress %, Assigned To."
              value={pasteContent}
              onChange={e => setPasteContent(e.target.value)}
            />

            {preview && (
              <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-200 space-y-1.5 text-xs">
                <div className="flex items-center justify-between text-slate-700">
                  <span className="font-semibold flex items-center gap-1 text-emerald-700">
                    <FiCheck size={12} /> Detected {preview.totalRows} task row{preview.totalRows === 1 ? '' : 's'}
                  </span>
                  <span className="text-[10px] text-slate-500">First 5 preview rows</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[10px]">
                    <thead className="bg-slate-200/70 text-slate-700 font-bold uppercase">
                      <tr>
                        {preview.headers.map((h, i) => (
                          <th key={i} className="p-1 text-left">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.sampleRows.map((r, i) => (
                        <tr key={i} className="border-t border-slate-200">
                          {r.slice(0, 6).map((col, j) => (
                            <td key={j} className="p-1 truncate max-w-[120px]">{col}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Tab 2: Upload File */}
        {importTab === 'file' && (
          <div className="space-y-3">
            <div className="border-2 border-dashed border-slate-200 rounded-xl p-6 text-center hover:border-indigo-400 transition bg-slate-50/50">
              <FiUpload size={32} className="mx-auto text-slate-400 mb-2" />
              <p className="text-xs font-semibold text-slate-700 mb-1">
                Drag and drop your Gantter XML, MS Project XML, JSON, or CSV file here
              </p>
              <p className="text-[11px] text-slate-500 mb-3">Supports .xml, .gantter, .json, .csv, .tsv</p>
              <label className="btn btn-secondary text-xs cursor-pointer inline-flex items-center gap-1.5">
                <span>Browse File</span>
                <input
                  type="file"
                  className="hidden"
                  accept=".xml,.gantter,.json,.csv,.tsv,.txt"
                  onChange={e => setSelectedFile(e.target.files?.[0] || null)}
                />
              </label>
            </div>

            {selectedFile && (
              <div className="p-2.5 bg-indigo-50 border border-indigo-200 rounded-lg flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <FiFileText className="text-indigo-600" size={16} />
                  <div>
                    <span className="font-semibold text-slate-800">{selectedFile.name}</span>
                    <span className="text-[10px] text-slate-500 ml-2">({(selectedFile.size / 1024).toFixed(1)} KB)</span>
                  </div>
                </div>
                <button onClick={() => setSelectedFile(null)} className="text-slate-400 hover:text-red-600">
                  <FiX size={14} />
                </button>
              </div>
            )}
          </div>
        )}

        {/* Import Mode Options */}
        <div className="pt-2 border-t border-slate-200">
          <label className="text-[10px] font-bold uppercase text-slate-500 block mb-1.5">Import Option</label>
          <div className="flex items-center gap-4 text-xs">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="importMode"
                value="replace"
                checked={importMode === 'replace'}
                onChange={e => setImportMode(e.target.value)}
              />
              <span className="font-medium text-slate-700">Replace existing tasks (Clean slate)</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="importMode"
                value="append"
                checked={importMode === 'append'}
                onChange={e => setImportMode(e.target.value)}
              />
              <span className="font-medium text-slate-700">Append to existing tasks</span>
            </label>
          </div>
        </div>

        {/* Modal Buttons */}
        <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
          <button onClick={onClose} disabled={submitting} className="btn btn-secondary text-xs">
            Cancel
          </button>
          <button
            onClick={handleImport}
            disabled={submitting}
            className="btn btn-primary text-xs flex items-center gap-1.5"
          >
            <FiCheck size={12} /> {submitting ? 'Importing…' : 'Import Schedule'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── TASK ADD / EDIT MODAL ─────────────────────────────────────────
function TaskEditModal({ isOpen, onClose, task, parentTask, isMilestoneInitial, allTasks, projectId, onSuccess, onDelete }) {
  const [form, setForm] = useState({
    task_name: '',
    wbs_code: '',
    parent_id: null,
    outline_level: 1,
    start_date: new Date().toISOString().slice(0, 10),
    end_date: addDaysIso(new Date().toISOString().slice(0, 10), 5),
    duration_days: 5,
    progress_pct: 0,
    status: 'not_started',
    dependencies: '',
    is_milestone: false,
    assigned_to: '',
    notes: '',
  });

  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (task) {
      setForm({
        task_name: task.task_name || '',
        wbs_code: task.wbs_code || '',
        parent_id: task.parent_id || null,
        outline_level: task.outline_level || 1,
        start_date: task.start_date || new Date().toISOString().slice(0, 10),
        end_date: task.end_date || addDaysIso(task.start_date || new Date().toISOString().slice(0, 10), task.duration_days || 1),
        duration_days: task.duration_days ?? 1,
        progress_pct: task.progress_pct || 0,
        status: task.status || 'not_started',
        dependencies: task.dependencies || '',
        is_milestone: !!task.is_milestone,
        assigned_to: task.assigned_to || '',
        notes: task.notes || '',
      });
    } else {
      // New task setup
      const today = new Date().toISOString().slice(0, 10);
      const isM = !!isMilestoneInitial;
      let nextWbs = '';
      let parentId = null;
      let level = 1;

      if (parentTask) {
        parentId = parentTask.id;
        level = (parentTask.outline_level || 1) + 1;
        const siblings = allTasks.filter(t => t.parent_id === parentTask.id);
        nextWbs = `${parentTask.wbs_code || parentTask.id}.${siblings.length + 1}`;
      } else {
        const rootTasks = allTasks.filter(t => !t.parent_id);
        nextWbs = `${rootTasks.length + 1}`;
      }

      setForm({
        task_name: '',
        wbs_code: nextWbs,
        parent_id: parentId,
        outline_level: level,
        start_date: parentTask?.start_date || today,
        end_date: isM ? (parentTask?.start_date || today) : addDaysIso(parentTask?.start_date || today, 5),
        duration_days: isM ? 0 : 5,
        progress_pct: 0,
        status: 'not_started',
        dependencies: '',
        is_milestone: isM,
        assigned_to: '',
        notes: '',
      });
    }
  }, [task, parentTask, isMilestoneInitial, allTasks]);

  // Handle duration change -> update end_date
  const handleDurationChange = (d) => {
    const dur = Math.max(0, parseInt(d, 10) || 0);
    setForm(f => ({
      ...f,
      duration_days: dur,
      is_milestone: dur === 0 ? true : f.is_milestone,
      end_date: dur === 0 ? f.start_date : addDaysIso(f.start_date, dur - 1),
    }));
  };

  // Handle start_date change -> update end_date based on duration
  const handleStartDateChange = (sd) => {
    setForm(f => ({
      ...f,
      start_date: sd,
      end_date: f.is_milestone || f.duration_days === 0 ? sd : addDaysIso(sd, Math.max(0, (f.duration_days || 1) - 1)),
    }));
  };

  // Handle end_date change -> update duration
  const handleEndDateChange = (ed) => {
    setForm(f => {
      const dur = f.start_date && ed ? Math.max(1, daysBetween(f.start_date, ed) + 1) : f.duration_days;
      return {
        ...f,
        end_date: ed,
        duration_days: dur,
      };
    });
  };

  // Handle milestone toggle
  const handleMilestoneToggle = (isM) => {
    setForm(f => ({
      ...f,
      is_milestone: isM,
      duration_days: isM ? 0 : (f.duration_days === 0 ? 1 : f.duration_days),
      end_date: isM ? f.start_date : f.end_date,
    }));
  };

  const handleSave = async (e) => {
    e?.preventDefault();
    if (!form.task_name.trim()) {
      toast.error('Task name is required');
      return;
    }

    setSaving(true);
    try {
      if (task) {
        await api.put(`/procurement-schedule/${projectId}/execution-tasks/${task.id}`, form);
        toast.success('Task updated');
      } else {
        await api.post(`/procurement-schedule/${projectId}/execution-tasks`, form);
        toast.success('Task created');
      }
      onSuccess();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save task');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={task ? `Edit: ${task.task_name}` : parentTask ? `Add Subtask under ${parentTask.task_name}` : form.is_milestone ? 'Add Milestone' : 'Add New Task'}
      wide
    >
      <form onSubmit={handleSave} className="space-y-3">
        {/* Name & WBS */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
          <div className="sm:col-span-3">
            <label className="text-[10px] font-bold uppercase text-slate-500 block mb-1">Task Name *</label>
            <input
              type="text"
              required
              className="input text-xs w-full"
              placeholder="e.g. AHU Duct Fabrication & Leak Testing"
              value={form.task_name}
              onChange={e => setForm(f => ({ ...f, task_name: e.target.value }))}
              autoFocus
            />
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase text-slate-500 block mb-1">WBS Code</label>
            <input
              type="text"
              className="input text-xs w-full font-mono"
              placeholder="e.g. 1.2.1"
              value={form.wbs_code}
              onChange={e => setForm(f => ({ ...f, wbs_code: e.target.value }))}
            />
          </div>
        </div>

        {/* Milestone toggle & Parent selector */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-2 bg-slate-50 rounded-lg border border-slate-200">
          <label className="flex items-center gap-2 cursor-pointer text-xs">
            <input
              type="checkbox"
              checked={form.is_milestone}
              onChange={e => handleMilestoneToggle(e.target.checked)}
              className="rounded text-purple-600 focus:ring-purple-500"
            />
            <span className="font-semibold text-purple-900">Mark as Milestone (0 duration event)</span>
          </label>

          <div>
            <label className="text-[10px] font-bold uppercase text-slate-500 block mb-0.5">Parent Summary Task</label>
            <select
              className="select text-xs w-full"
              value={form.parent_id || ''}
              onChange={e => {
                const pid = e.target.value ? Number(e.target.value) : null;
                const parent = allTasks.find(t => t.id === pid);
                setForm(f => ({
                  ...f,
                  parent_id: pid,
                  outline_level: parent ? (parent.outline_level || 1) + 1 : 1,
                }));
              }}
            >
              <option value="">None (Top / Root Level)</option>
              {allTasks
                .filter(t => !task || t.id !== task.id)
                .map(t => (
                  <option key={t.id} value={t.id}>
                    {t.wbs_code ? `${t.wbs_code} ` : ''}{t.task_name}
                  </option>
                ))}
            </select>
          </div>
        </div>

        {/* Dates & Duration */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div>
            <label className="text-[10px] font-bold uppercase text-slate-500 block mb-1">Start Date</label>
            <input
              type="date"
              className="input text-xs w-full"
              value={form.start_date || ''}
              onChange={e => handleStartDateChange(e.target.value)}
            />
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase text-slate-500 block mb-1">Finish Date</label>
            <input
              type="date"
              className="input text-xs w-full"
              value={form.end_date || ''}
              disabled={form.is_milestone}
              onChange={e => handleEndDateChange(e.target.value)}
            />
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase text-slate-500 block mb-1">Duration (Days)</label>
            <input
              type="number"
              min="0"
              className="input text-xs w-full font-mono"
              value={form.duration_days}
              disabled={form.is_milestone}
              onChange={e => handleDurationChange(e.target.value)}
            />
          </div>
        </div>

        {/* Predecessors & Assigned To */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] font-bold uppercase text-slate-500 block mb-1">
              Predecessors / Dependencies
            </label>
            <input
              type="text"
              className="input text-xs w-full font-mono"
              placeholder="e.g. 1, 2 or 1FS, 2SS"
              value={form.dependencies}
              onChange={e => setForm(f => ({ ...f, dependencies: e.target.value }))}
            />
            <span className="text-[10px] text-slate-400">Comma-separated WBS codes, task numbers, or IDs</span>
          </div>

          <div>
            <label className="text-[10px] font-bold uppercase text-slate-500 block mb-1">Assigned Resource / Trade</label>
            <input
              type="text"
              className="input text-xs w-full"
              placeholder="e.g. HVAC Subcontractor, Civil Gang"
              value={form.assigned_to}
              onChange={e => setForm(f => ({ ...f, assigned_to: e.target.value }))}
            />
          </div>
        </div>

        {/* Progress & Status */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-2 bg-slate-50 rounded-lg border border-slate-200">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[10px] font-bold uppercase text-slate-500">Progress: {form.progress_pct}%</label>
              <span className="text-[10px] text-indigo-700 font-bold">{form.progress_pct}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              className="w-full accent-indigo-600"
              value={form.progress_pct}
              onChange={e => {
                const p = Number(e.target.value);
                setForm(f => ({
                  ...f,
                  progress_pct: p,
                  status: p === 100 ? 'completed' : p > 0 ? 'in_progress' : 'not_started',
                }));
              }}
            />
          </div>

          <div>
            <label className="text-[10px] font-bold uppercase text-slate-500 block mb-1">Task Status</label>
            <select
              className="select text-xs w-full"
              value={form.status}
              onChange={e => {
                const s = e.target.value;
                setForm(f => ({
                  ...f,
                  status: s,
                  progress_pct: s === 'completed' ? 100 : s === 'not_started' ? 0 : f.progress_pct,
                }));
              }}
            >
              <option value="not_started">Not Started</option>
              <option value="in_progress">In Progress</option>
              <option value="completed">Completed (100%)</option>
              <option value="on_hold">On Hold</option>
            </select>
          </div>
        </div>

        {/* Notes */}
        <div>
          <label className="text-[10px] font-bold uppercase text-slate-500 block mb-1">Notes / Scope details</label>
          <textarea
            className="input text-xs w-full"
            rows={2}
            placeholder="Special site conditions, equipment requirements, inspection criteria..."
            value={form.notes}
            onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
          />
        </div>

        {/* Form Actions */}
        <div className="flex items-center justify-between pt-3 border-t border-slate-200">
          {task ? (
            <button
              type="button"
              onClick={() => onDelete(task)}
              className="btn btn-danger text-xs flex items-center gap-1"
            >
              <FiTrash2 size={12} /> Delete Task
            </button>
          ) : <div />}

          <div className="flex gap-2">
            <button type="button" onClick={onClose} disabled={saving} className="btn btn-secondary text-xs">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="btn btn-primary text-xs flex items-center gap-1.5">
              <FiCheck size={12} /> {saving ? 'Saving…' : task ? 'Save Changes' : 'Create Task'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
