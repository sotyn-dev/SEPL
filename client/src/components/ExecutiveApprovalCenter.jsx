import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import api from '../api';
import { useAuth } from '../context/AuthContext';
import Modal from './Modal';
import ProofPreview from './ProofPreview';
import {
  FiCheckCircle, FiXCircle, FiClock, FiAlertTriangle, FiFileText,
  FiExternalLink, FiChevronRight, FiCheck, FiX, FiShield, FiRefreshCw,
  FiUser, FiCalendar, FiArrowRight, FiInfo
} from 'react-icons/fi';

export function parseProofUrls(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [String(parsed)];
  } catch (_) {
    return [String(raw)];
  }
}

export default function ExecutiveApprovalCenter({ isDark = false }) {
  const { user, isAdmin } = useAuth();
  const [data, setData] = useState({
    totalCount: 0,
    delegationsCount: 0,
    extensionsCount: 0,
    ticketsCount: 0,
    delegations: [],
    extensions: [],
    tickets: []
  });
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('all'); // 'all', 'delegations', 'extensions', 'tickets'
  const [actionBusy, setActionBusy] = useState(null); // id of item being processed
  const [rejectModal, setRejectModal] = useState(null); // { type: 'delegation'|'extension'|'ticket', item, reason: '' }
  const [previewModal, setPreviewModal] = useState(null); // { url, title }

  const isMDOrAdmin = useMemo(() => {
    if (!user) return false;
    const email = String(user.email || '').trim().toLowerCase();
    const role = String(user.role || '').trim().toLowerCase();
    return role === 'admin' || email === 'director@securedengineers.com' || isAdmin();
  }, [user, isAdmin]);

  const loadApprovals = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await api.get('/dashboard/executive-approvals');
      setData(res.data || {
        totalCount: 0,
        delegationsCount: 0,
        extensionsCount: 0,
        ticketsCount: 0,
        delegations: [],
        extensions: [],
        tickets: []
      });
    } catch (err) {
      console.warn('[ExecutiveApprovalCenter] Failed to load:', err.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadApprovals();
    const interval = setInterval(() => {
      if (!document.hidden) loadApprovals(true);
    }, 20000);
    return () => clearInterval(interval);
  }, [loadApprovals]);

  // Fast 1-Click Approve Handlers
  const handleApproveDelegation = async (d) => {
    setActionBusy(`delegation-${d.id}`);
    try {
      await api.post(`/delegations/${d.id}/approve`);
      toast.success(`Approved delegated task: "${d.title}"`);
      // Optimistic state update
      setData(prev => ({
        ...prev,
        totalCount: Math.max(0, prev.totalCount - 1),
        delegationsCount: Math.max(0, prev.delegationsCount - 1),
        delegations: prev.delegations.filter(item => item.id !== d.id)
      }));
      window.dispatchEvent(new CustomEvent('sepl:approvals-updated'));
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to approve task');
    } finally {
      setActionBusy(null);
    }
  };

  const handleApproveExtension = async (d) => {
    setActionBusy(`extension-${d.id}`);
    try {
      await api.post(`/delegations/${d.id}/approve-extension`);
      toast.success(`Extension approved to ${d.requested_due_date}`);
      setData(prev => ({
        ...prev,
        totalCount: Math.max(0, prev.totalCount - 1),
        extensionsCount: Math.max(0, prev.extensionsCount - 1),
        extensions: prev.extensions.filter(item => item.id !== d.id)
      }));
      window.dispatchEvent(new CustomEvent('sepl:approvals-updated'));
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to approve extension');
    } finally {
      setActionBusy(null);
    }
  };

  const handleApproveTicket = async (t) => {
    setActionBusy(`ticket-${t.id}`);
    try {
      await api.post(`/support/${t.id}/approve`);
      toast.success(`Approved and closed Ticket: ${t.ticket_no}`);
      setData(prev => ({
        ...prev,
        totalCount: Math.max(0, prev.totalCount - 1),
        ticketsCount: Math.max(0, prev.ticketsCount - 1),
        tickets: prev.tickets.filter(item => item.id !== t.id)
      }));
      window.dispatchEvent(new CustomEvent('sepl:approvals-updated'));
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to approve ticket');
    } finally {
      setActionBusy(null);
    }
  };

  // Reject / Request Changes Submissions
  const handleSubmitReject = async (e) => {
    e.preventDefault();
    if (!rejectModal) return;
    const { type, item, reason } = rejectModal;
    if (!reason || !reason.trim()) {
      toast.error('Please enter a reason for requesting changes');
      return;
    }
    setActionBusy(`${type}-${item.id}`);
    try {
      if (type === 'delegation') {
        await api.post(`/delegations/${item.id}/reject`, { reason: reason.trim() });
        toast.success(`Sent back delegated task for correction`);
        setData(prev => ({
          ...prev,
          totalCount: Math.max(0, prev.totalCount - 1),
          delegationsCount: Math.max(0, prev.delegationsCount - 1),
          delegations: prev.delegations.filter(i => i.id !== item.id)
        }));
      } else if (type === 'extension') {
        await api.post(`/delegations/${item.id}/reject-extension`, { reason: reason.trim() });
        toast.success(`Deadline extension rejected`);
        setData(prev => ({
          ...prev,
          totalCount: Math.max(0, prev.totalCount - 1),
          extensionsCount: Math.max(0, prev.extensionsCount - 1),
          extensions: prev.extensions.filter(i => i.id !== item.id)
        }));
      } else if (type === 'ticket') {
        await api.post(`/support/${item.id}/reject`, { reason: reason.trim() });
        toast.success(`Requested changes for Ticket ${item.ticket_no}`);
        setData(prev => ({
          ...prev,
          totalCount: Math.max(0, prev.totalCount - 1),
          ticketsCount: Math.max(0, prev.ticketsCount - 1),
          tickets: prev.tickets.filter(i => i.id !== item.id)
        }));
      }
      setRejectModal(null);
      window.dispatchEvent(new CustomEvent('sepl:approvals-updated'));
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to send back');
    } finally {
      setActionBusy(null);
    }
  };

  // Format waiting time badge
  const renderAgingBadge = (hours) => {
    if (hours == null) return null;
    const h = Number(hours);
    if (h >= 48) {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-extrabold bg-rose-600 text-white animate-pulse shadow-sm">
          <FiAlertTriangle size={12} />
          Overdue: Waiting {Math.round(h / 24)}d ({Math.round(h)}h)
        </span>
      );
    }
    if (h >= 24) {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-500 text-white shadow-sm">
          <FiClock size={12} />
          Waiting {Math.round(h)}h
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 text-slate-700 border border-slate-200">
        <FiClock size={12} className="text-slate-400" />
        Submitted {h < 1 ? '<1 hr ago' : `${Math.round(h)}h ago`}
      </span>
    );
  };

  const hasAnyItems = data.totalCount > 0;

  return (
    <section
      id="executive-approvals"
      aria-label="Executive Approval Center"
      className={`rounded-2xl transition-all ${isDark
          ? 'bg-slate-900 border border-slate-800 text-slate-100 p-5 shadow-xl'
          : 'bg-white border-2 border-amber-300/80 rounded-2xl shadow-sm overflow-hidden'
        }`}
    >
      {/* Executive Header Banner */}
      <div className={`${isDark
          ? 'border-b border-slate-800 pb-4'
          : 'bg-gradient-to-r from-amber-600 via-amber-700 to-indigo-900 text-white px-5 py-3.5'
        } flex flex-wrap items-center justify-between gap-3`}>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-white/20 backdrop-blur-md flex items-center justify-center text-white shadow-inner flex-shrink-0">
            <FiShield size={20} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-amber-200 font-semibold">
                Direct Approval Queue
              </span>
            </div>
            <h2 className="text-lg font-bold leading-tight flex items-center gap-2">
              <span>Approvals Awaiting Your Sign-off</span>
              {hasAnyItems && (
                <span className="bg-rose-500 text-white text-xs font-black px-2 py-0.5 rounded-full animate-bounce">
                  {data.totalCount} Pending
                </span>
              )}
            </h2>
          </div>
        </div>

        {/* Quick links & refresh */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => loadApprovals()}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white/10 hover:bg-white/20 text-white rounded-lg transition-colors border border-white/15"
            title="Refresh pending approvals list"
          >
            <FiRefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
          <Link
            to="/delegations"
            className="text-xs text-amber-100 hover:text-white underline font-medium px-2 py-1"
          >
            All Delegations →
          </Link>
          <Link
            to="/help-tickets"
            className="text-xs text-amber-100 hover:text-white underline font-medium px-2 py-1"
          >
            Help Tickets →
          </Link>
        </div>
      </div>

      {/* Tabs / Filter strip */}
      <div className="bg-slate-50/80 px-5 py-2.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setActiveTab('all')}
            className={`px-3 py-1 rounded-full font-bold transition-all ${activeTab === 'all'
                ? 'bg-amber-600 text-white shadow-sm'
                : 'text-slate-600 hover:bg-slate-200/60'
              }`}
          >
            All Items ({data.totalCount})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('delegations')}
            className={`px-3 py-1 rounded-full font-bold transition-all flex items-center gap-1.5 ${activeTab === 'delegations'
                ? 'bg-purple-600 text-white shadow-sm'
                : 'text-slate-600 hover:bg-slate-200/60'
              }`}
          >
            <span>Delegated Tasks</span>
            <span className={`px-1.5 py-0.2 rounded-full text-[10px] ${activeTab === 'delegations' ? 'bg-purple-700 text-white' : 'bg-purple-100 text-purple-800'}`}>
              {data.delegationsCount}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('extensions')}
            className={`px-3 py-1 rounded-full font-bold transition-all flex items-center gap-1.5 ${activeTab === 'extensions'
                ? 'bg-amber-500 text-white shadow-sm'
                : 'text-slate-600 hover:bg-slate-200/60'
              }`}
          >
            <span>Extension Requests</span>
            <span className={`px-1.5 py-0.2 rounded-full text-[10px] ${activeTab === 'extensions' ? 'bg-amber-600 text-white' : 'bg-amber-100 text-amber-800'}`}>
              {data.extensionsCount}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('tickets')}
            className={`px-3 py-1 rounded-full font-bold transition-all flex items-center gap-1.5 ${activeTab === 'tickets'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-600 hover:bg-slate-200/60'
              }`}
          >
            <span>Help Tickets</span>
            <span className={`px-1.5 py-0.2 rounded-full text-[10px] ${activeTab === 'tickets' ? 'bg-blue-700 text-white' : 'bg-blue-100 text-blue-800'}`}>
              {data.ticketsCount}
            </span>
          </button>
        </div>
        <div className="text-[11px] text-slate-500 font-medium">
          Auto-refreshes · Zero navigation sign-off
        </div>
      </div>

      {/* Main Content Area */}
      <div className="p-4 sm:p-5">
        {loading && (
          <div className="py-8 text-center text-slate-400 text-sm flex items-center justify-center gap-2">
            <FiRefreshCw className="animate-spin text-amber-600" />
            Loading pending executive approvals...
          </div>
        )}

        {!loading && !hasAnyItems && (
          <div className="py-6 px-4 bg-emerald-50/70 border border-emerald-200 rounded-xl text-center flex flex-col items-center justify-center gap-2">
            <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center shadow-inner">
              <FiCheckCircle size={26} />
            </div>
            <div>
              <h3 className="font-bold text-emerald-900 text-base">
                All Delegated Tasks & Tickets Approved — Up to Date!
              </h3>
              <p className="text-xs text-emerald-700 max-w-md mx-auto mt-0.5">
                No submitted completion proofs or deadline extensions are currently waiting for executive sign-off.
              </p>
            </div>
          </div>
        )}

        {!loading && hasAnyItems && (
          <div className="space-y-4">
            {/* 1. Delegated Tasks Awaiting Sign-off */}
            {(activeTab === 'all' || activeTab === 'delegations') && data.delegations.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-xs font-bold text-purple-900 uppercase tracking-wider">
                  <span className="w-2 h-2 rounded-full bg-purple-600" />
                  <span>Delegated Tasks Awaiting Your Review ({data.delegations.length})</span>
                </div>
                <div className="grid grid-cols-1 gap-3">
                  {data.delegations.map(d => {
                    const proofs = parseProofUrls(d.proof_url);
                    const isBusy = actionBusy === `delegation-${d.id}`;
                    return (
                      <article
                        key={`deleg-${d.id}`}
                        className="bg-white border-2 border-purple-200/90 rounded-xl p-4 shadow-sm hover:shadow-md transition-shadow relative overflow-hidden"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[10px] font-extrabold uppercase px-2 py-0.5 rounded bg-purple-100 text-purple-800 border border-purple-200">
                              Task #{d.id} · Delegation
                            </span>
                            {d.project_name && (
                              <span className="text-[11px] font-semibold text-slate-600 bg-slate-100 px-2 py-0.5 rounded">
                                🏗️ {d.project_name}
                              </span>
                            )}
                            <span className="text-xs text-slate-600 flex items-center gap-1 font-medium">
                              <FiUser size={12} className="text-purple-600" />
                              Assigned to: <strong className="text-slate-800">{d.assigned_to_name || 'Staff'}</strong>
                            </span>
                          </div>
                          <div>
                            {renderAgingBadge(d.hours_waiting)}
                          </div>
                        </div>

                        <h4 className="text-sm font-bold text-slate-900 mb-1">
                          {d.title}
                        </h4>
                        {d.description && (
                          <p className="text-xs text-slate-600 mb-2.5 line-clamp-2">
                            {d.description}
                          </p>
                        )}

                        {/* Staff Remarks / Submission note */}
                        {d.proof_remarks && (
                          <div className="bg-purple-50/70 border border-purple-200/70 rounded-lg p-2.5 mb-3 text-xs">
                            <span className="font-bold text-purple-900 block mb-0.5">
                              💬 Remarks from {d.assigned_to_name || 'Assignee'}:
                            </span>
                            <span className="text-slate-700 whitespace-pre-wrap">
                              {d.proof_remarks}
                            </span>
                          </div>
                        )}

                        {/* Proof Files Preview */}
                        {proofs.length > 0 && (
                          <div className="mb-3">
                            <span className="text-[11px] font-bold text-slate-700 uppercase tracking-wide block mb-1.5">
                              📎 Attached Proof ({proofs.length}):
                            </span>
                            <div className="flex flex-wrap gap-2">
                              {proofs.map((url, idx) => (
                                <button
                                  key={idx}
                                  type="button"
                                  onClick={() => setPreviewModal({ url, title: `Proof #${idx + 1} for Task #${d.id}` })}
                                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg border border-blue-200 transition-colors"
                                >
                                  <FiFileText size={13} />
                                  <span>View Proof {proofs.length > 1 ? `#${idx + 1}` : ''}</span>
                                  <FiExternalLink size={11} className="text-blue-500" />
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* 1-Click Action Buttons */}
                        <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2">
                          <div className="text-[11px] text-slate-400">
                            Due Date: <strong className="text-slate-600">{d.due_date || 'No deadline'}</strong>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => setRejectModal({ type: 'delegation', item: d, reason: '' })}
                              className="px-3 py-1.5 text-xs font-bold text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-300 rounded-lg transition-colors flex items-center gap-1 shadow-sm"
                              title="Send back to assignee with feedback"
                            >
                              <FiX size={13} />
                              <span>Request Changes</span>
                            </button>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => handleApproveDelegation(d)}
                              className="px-4 py-1.5 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg shadow-sm transition-all flex items-center gap-1.5 hover:scale-[1.02] active:scale-95"
                              title="Approve proof and complete task"
                            >
                              <FiCheck size={14} className="stroke-[3]" />
                              <span>{isBusy ? 'Approving...' : 'Approve & Complete'}</span>
                            </button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 2. Deadline Extension Requests */}
            {(activeTab === 'all' || activeTab === 'extensions') && data.extensions.length > 0 && (
              <div className="space-y-3 pt-2">
                <div className="flex items-center gap-2 text-xs font-bold text-amber-900 uppercase tracking-wider">
                  <span className="w-2 h-2 rounded-full bg-amber-500" />
                  <span>Deadline Extension Requests ({data.extensions.length})</span>
                </div>
                <div className="grid grid-cols-1 gap-3">
                  {data.extensions.map(d => {
                    const isBusy = actionBusy === `extension-${d.id}`;
                    return (
                      <article
                        key={`ext-${d.id}`}
                        className="bg-white border-2 border-amber-200/90 rounded-xl p-4 shadow-sm hover:shadow-md transition-shadow"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[10px] font-extrabold uppercase px-2 py-0.5 rounded bg-amber-100 text-amber-900 border border-amber-200">
                              Task #{d.id} · Extension Request #{d.extension_count || 1}
                            </span>
                            <span className="text-xs text-slate-600 flex items-center gap-1 font-medium">
                              <FiUser size={12} className="text-amber-600" />
                              Requested by: <strong className="text-slate-800">{d.assigned_to_name}</strong>
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 text-xs">
                            <span className="text-slate-400 line-through">Due: {d.due_date}</span>
                            <FiArrowRight size={12} className="text-amber-600" />
                            <span className="font-extrabold text-amber-700 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
                              New Target: {d.requested_due_date}
                            </span>
                          </div>
                        </div>

                        <h4 className="text-sm font-bold text-slate-900 mb-1.5">
                          {d.title}
                        </h4>

                        <div className="bg-amber-50/60 border border-amber-200/70 rounded-lg p-2.5 mb-3 text-xs">
                          <span className="font-bold text-amber-900 block mb-0.5">
                            Reason for Extension:
                          </span>
                          <span className="text-slate-700">
                            {d.extension_reason || 'No detailed reason provided'}
                          </span>
                        </div>

                        <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => setRejectModal({ type: 'extension', item: d, reason: '' })}
                            className="px-3 py-1.5 text-xs font-bold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg transition-colors flex items-center gap-1"
                          >
                            <FiX size={13} />
                            <span>Reject Extension</span>
                          </button>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => handleApproveExtension(d)}
                            className="px-4 py-1.5 text-xs font-bold text-white bg-amber-600 hover:bg-amber-700 rounded-lg shadow-sm transition-all flex items-center gap-1.5"
                          >
                            <FiCheck size={14} className="stroke-[3]" />
                            <span>{isBusy ? 'Saving...' : 'Grant Extension'}</span>
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 3. Help Tickets with Submitted Proof */}
            {(activeTab === 'all' || activeTab === 'tickets') && data.tickets.length > 0 && (
              <div className="space-y-3 pt-2">
                <div className="flex items-center gap-2 text-xs font-bold text-blue-900 uppercase tracking-wider">
                  <span className="w-2 h-2 rounded-full bg-blue-600" />
                  <span>Help Tickets Proof Submitted — Awaiting Approval ({data.tickets.length})</span>
                </div>
                <div className="grid grid-cols-1 gap-3">
                  {data.tickets.map(t => {
                    const proofs = parseProofUrls(t.proof_url);
                    const isBusy = actionBusy === `ticket-${t.id}`;
                    return (
                      <article
                        key={`ticket-${t.id}`}
                        className="bg-white border-2 border-blue-200/90 rounded-xl p-4 shadow-sm hover:shadow-md transition-shadow"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[10px] font-extrabold uppercase px-2 py-0.5 rounded bg-blue-100 text-blue-800 border border-blue-200">
                              {t.ticket_no} · {(t.priority || 'medium').toUpperCase()}
                            </span>
                            {t.module && (
                              <span className="text-[11px] font-semibold text-slate-600 bg-slate-100 px-2 py-0.5 rounded">
                                📌 {t.module}
                              </span>
                            )}
                            <span className="text-xs text-slate-600 font-medium">
                              Assigned to: <strong className="text-slate-800">{t.assigned_to_name || 'Staff'}</strong>
                            </span>
                          </div>
                          <div>
                            {renderAgingBadge(t.hours_waiting)}
                          </div>
                        </div>

                        <h4 className="text-sm font-bold text-slate-900 mb-1">
                          {t.subject}
                        </h4>
                        {t.description && (
                          <p className="text-xs text-slate-600 mb-2.5 line-clamp-2">
                            {t.description}
                          </p>
                        )}

                        {/* Proof Notes from Assignee */}
                        {t.proof_notes && (
                          <div className="bg-blue-50/70 border border-blue-200/70 rounded-lg p-2.5 mb-3 text-xs">
                            <span className="font-bold text-blue-900 block mb-0.5">
                              💬 Fix Proof Note from {t.assigned_to_name || 'Assignee'}:
                            </span>
                            <span className="text-slate-700 whitespace-pre-wrap">
                              {t.proof_notes}
                            </span>
                          </div>
                        )}

                        {/* Proof Files Preview */}
                        {proofs.length > 0 && (
                          <div className="mb-3">
                            <span className="text-[11px] font-bold text-slate-700 uppercase tracking-wide block mb-1.5">
                              📎 Attached Proof of Fix ({proofs.length}):
                            </span>
                            <div className="flex flex-wrap gap-2">
                              {proofs.map((url, idx) => (
                                <button
                                  key={idx}
                                  type="button"
                                  onClick={() => setPreviewModal({ url, title: `Proof #${idx + 1} for ${t.ticket_no}` })}
                                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg border border-blue-200 transition-colors"
                                >
                                  <FiFileText size={13} />
                                  <span>View Proof {proofs.length > 1 ? `#${idx + 1}` : ''}</span>
                                  <FiExternalLink size={11} className="text-blue-500" />
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* 1-Click Action Buttons */}
                        <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2">
                          <div className="text-[11px] text-slate-400">
                            Raised by: <strong className="text-slate-600">{t.user_name || 'MD/Admin'}</strong>
                            {t.deadline_date && ` · Due: ${t.deadline_date}`}
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => setRejectModal({ type: 'ticket', item: t, reason: '' })}
                              className="px-3 py-1.5 text-xs font-bold text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-300 rounded-lg transition-colors flex items-center gap-1 shadow-sm"
                            >
                              <FiX size={13} />
                              <span>Request Changes</span>
                            </button>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => handleApproveTicket(t)}
                              className="px-4 py-1.5 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg shadow-sm transition-all flex items-center gap-1.5 hover:scale-[1.02] active:scale-95"
                            >
                              <FiCheck size={14} className="stroke-[3]" />
                              <span>{isBusy ? 'Closing...' : 'Approve & Close Ticket'}</span>
                            </button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Rejection / Request Changes Modal */}
      {rejectModal && (
        <Modal
          isOpen={true}
          onClose={() => setRejectModal(null)}
          title={`Request Changes / Send Back · ${rejectModal.item.title || rejectModal.item.subject || rejectModal.item.ticket_no}`}
        >
          <form onSubmit={handleSubmitReject} className="space-y-4">
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900">
              <span className="font-bold block mb-1">Feedback will be sent directly to the assignee:</span>
              <span>{rejectModal.item.assigned_to_name} will be notified with your feedback and required to submit revised proof.</span>
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                Reason for sending back / Specific corrections needed:
              </label>
              <textarea
                rows={4}
                required
                value={rejectModal.reason}
                onChange={(e) => setRejectModal({ ...rejectModal, reason: e.target.value })}
                placeholder="E.g., Measurement sheet missing consultant stamp; please re-upload with clear signature..."
                className="input w-full text-xs font-sans p-2.5 rounded-lg border border-slate-300"
              />
            </div>
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setRejectModal(null)}
                className="btn btn-secondary text-xs"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!rejectModal.reason.trim()}
                className="btn bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold px-4 py-2 rounded-lg"
              >
                Send Back for Correction
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Proof Preview Modal */}
      {previewModal && (
        <Modal
          isOpen={true}
          onClose={() => setPreviewModal(null)}
          title={previewModal.title}
        >
          <div className="space-y-3">
            <ProofPreview url={previewModal.url} reviewOnly={true} />
            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={() => setPreviewModal(null)}
                className="btn btn-secondary text-xs"
              >
                Close Preview
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

// Sticky Top Header Notification Pill
export function ExecutiveApprovalHeaderButton() {
  const { user } = useAuth();
  const [count, setCount] = useState(0);

  const isMDOrAdmin = useMemo(() => {
    if (!user) return false;
    const email = String(user.email || '').trim().toLowerCase();
    const role = String(user.role || '').trim().toLowerCase();
    return role === 'admin' || email === 'director@securedengineers.com';
  }, [user]);

  const fetchCount = useCallback(async () => {
    if (!isMDOrAdmin) return;
    try {
      const res = await api.get('/dashboard/executive-approvals');
      setCount(res.data?.totalCount || 0);
    } catch (_) { }
  }, [isMDOrAdmin]);

  useEffect(() => {
    fetchCount();
    const timer = setInterval(fetchCount, 25000);
    const handler = () => fetchCount();
    window.addEventListener('sepl:approvals-updated', handler);
    return () => {
      clearInterval(timer);
      window.removeEventListener('sepl:approvals-updated', handler);
    };
  }, [fetchCount]);

  if (!isMDOrAdmin || count === 0) return null;

  return (
    <button
      type="button"
      onClick={() => {
        if (window.location.pathname === '/') {
          document.getElementById('executive-approvals')?.scrollIntoView({ behavior: 'smooth' });
        } else {
          window.location.href = '/#executive-approvals';
        }
      }}
      className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-extrabold bg-gradient-to-r from-amber-500/15 to-rose-500/15 text-amber-800 hover:from-amber-500/25 hover:to-rose-500/25 border border-amber-300 rounded-full transition-all shadow-sm"
      title={`${count} tasks/tickets awaiting executive approval`}
    >
      <span className="w-2 h-2 rounded-full bg-rose-500 animate-ping" />
      <span className="hidden sm:inline">Approvals</span>
      <span className="bg-rose-600 text-white text-[10px] font-black px-1.5 py-0.2 rounded-full shadow-inner">
        {count}
      </span>
    </button>
  );
}

