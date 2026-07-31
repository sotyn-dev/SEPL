import { useEffect, useState } from 'react';
import Modal from './Modal';
import api from '../api';
import { fmtDate, fmtDateTime } from '../utils/datetime';
import { FiArrowRight, FiClock } from 'react-icons/fi';

// Read-only change history for ONE employee. Opened from a directory row (never
// from inside the Edit modal — the two modals must not stack). Clones the
// candidate-activity timeline look.
export default function EmployeeHistoryDrawer({ isOpen, onClose, employee }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen || !employee) return;
    setLoading(true);
    api.get(`/hr/employees/${employee.id}/history`)
      .then((r) => setEvents(r.data || []))
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  }, [isOpen, employee]);

  const show = (x) => (x == null || x === '' ? '—' : String(x));

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Change History" subtitle={employee?.name} wide>
      {loading && <div className="py-8 text-center text-gray-400 text-sm">Loading…</div>}

      {!loading && events.length === 0 && (
        <div className="py-8 text-center text-gray-400 text-sm">
          No recorded history yet.
          <div className="text-[11px] mt-1 text-gray-400">
            History starts from the first tracked edit. An admin can reconstruct past
            changes from the audit log via <span className="font-semibold">History &amp; Reports → Sync from audit log</span>.
            <br />Note: login on/off changes made in User Management aren’t recorded here — this is a
            history of employee-record changes, not login toggles.
          </div>
        </div>
      )}

      {!loading && events.length > 0 && (
        <ol className="relative border-l-2 border-gray-100 ml-2 space-y-4 py-1">
          {events.map((ev, i) => (
            <li key={i} className="ml-4">
              <span className="absolute -left-[7px] w-3 h-3 rounded-full bg-red-500 border-2 border-white" />
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-gray-800">{ev.action || 'Change'}</span>
                {ev.source === 'backfill' && (
                  <span className="text-[9px] uppercase tracking-wide bg-gray-100 text-gray-500 rounded px-1.5 py-0.5" title="Reconstructed from the audit log — from-values inferred, reason unavailable">reconstructed</span>
                )}
                {ev.source === 'payroll' && (
                  <span className="text-[9px] uppercase tracking-wide bg-indigo-50 text-indigo-500 rounded px-1.5 py-0.5">payroll</span>
                )}
                <span className="text-[11px] text-gray-400 flex items-center gap-1">
                  <FiClock size={10} /> {fmtDate(ev.effective)}
                </span>
              </div>

              {ev.field ? (
                <div className="mt-1 text-[13px] flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">{ev.label}</span>
                  <span className="text-gray-500">{show(ev.from)}</span>
                  <FiArrowRight size={12} className="text-gray-400" />
                  <span className="font-semibold text-gray-800">{show(ev.to)}</span>
                  {ev.restricted && <span className="text-[10px] text-gray-400">(restricted)</span>}
                </div>
              ) : (
                <div className="mt-1 text-[13px] text-gray-500">{ev.label || 'Record created'}</div>
              )}

              {ev.reason && <div className="mt-1 text-[12px] text-gray-600 italic">“{ev.reason}”</div>}
              {ev.reason_code && <div className="text-[11px] text-gray-500">Turnover: {ev.reason_code}</div>}
              <div className="text-[10px] text-gray-400 mt-0.5">
                {ev.by ? `by ${ev.by} · ` : ''}recorded {fmtDateTime(ev.recorded)}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}
