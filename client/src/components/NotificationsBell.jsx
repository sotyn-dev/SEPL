// NotificationsBell — header bell icon + dropdown.
//
// Mam (2026-05-22 Phase 1 Batch E, module #15): polls
// /hr/my-notifications every 60s, shows unread count badge, opens a
// dropdown with the 50 most recent.  Clicking a notification marks
// it read AND navigates to its link_url.

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { FiBell, FiCheck, FiAlertCircle, FiCalendar, FiClock, FiAward } from 'react-icons/fi';

const TYPE_ICON = {
  interview_reminder: FiCalendar,
  offer_expiry:       FiClock,
  approval_pending:   FiAlertCircle,
  training_assigned:  FiAward,
  generic:            FiBell,
};

const TYPE_COLOR = {
  interview_reminder: 'text-indigo-600',
  offer_expiry:       'text-amber-600',
  approval_pending:   'text-rose-600',
  training_assigned:  'text-emerald-600',
  generic:            'text-gray-600',
};

export default function NotificationsBell() {
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const navigate = useNavigate();

  const load = async () => {
    try {
      const r = await api.get('/hr/my-notifications');
      setRows(r.data || []);
    } catch (_) { /* silent — bell is non-critical */ }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);   // 60s
    return () => clearInterval(id);
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const unreadCount = rows.filter(n => !n.read_at).length;

  const onClick = async (n) => {
    if (!n.read_at) {
      try { await api.put(`/hr/notifications/${n.id}/read`); } catch (_) {}
    }
    setOpen(false);
    if (n.link_url) navigate(n.link_url);
    load();
  };

  const markAllRead = async () => {
    try { await api.post('/hr/notifications/mark-all-read'); load(); } catch (_) {}
  };

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(o => !o)} className="relative p-2 rounded-full hover:bg-gray-100" title="Notifications">
        <FiBell size={18} className="text-gray-600"/>
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 bg-red-600 text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-[360px] max-w-[calc(100vw-2rem)] bg-white rounded-lg shadow-xl border border-gray-200 z-50">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
            <h3 className="font-semibold text-sm">Notifications</h3>
            {unreadCount > 0 && (
              <button onClick={markAllRead} className="text-[11px] text-blue-700 hover:underline flex items-center gap-1">
                <FiCheck size={11}/> Mark all read
              </button>
            )}
          </div>
          <div className="max-h-[400px] overflow-y-auto">
            {rows.length === 0 ? (
              <div className="px-3 py-10 text-center text-gray-400 text-[12px]">
                <FiBell size={28} className="mx-auto opacity-30 mb-2"/>
                No notifications yet
              </div>
            ) : (
              rows.map(n => {
                const Icon = TYPE_ICON[n.type] || FiBell;
                const colorCls = TYPE_COLOR[n.type] || 'text-gray-600';
                const dt = n.created_at ? new Date(n.created_at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' }) : '';
                return (
                  <button
                    key={n.id}
                    onClick={() => onClick(n)}
                    className={`w-full text-left px-3 py-2.5 border-b border-gray-100 hover:bg-gray-50 flex items-start gap-2.5 ${!n.read_at ? 'bg-blue-50/40' : ''}`}>
                    <Icon size={16} className={`mt-0.5 ${colorCls}`}/>
                    <div className="flex-1 min-w-0">
                      <div className={`text-[12.5px] ${!n.read_at ? 'font-semibold' : 'text-gray-700'} truncate`}>{n.title}</div>
                      {n.body && <div className="text-[11px] text-gray-500 line-clamp-2">{n.body}</div>}
                      <div className="text-[10px] text-gray-400 mt-0.5">{dt}</div>
                    </div>
                    {!n.read_at && <span className="w-2 h-2 rounded-full bg-blue-600 mt-1.5 flex-shrink-0"/>}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
