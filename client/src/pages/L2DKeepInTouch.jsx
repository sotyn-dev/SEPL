import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import {
  FiRefreshCw, FiClock, FiSend, FiBellOff, FiBell, FiUsers, FiCalendar,
} from 'react-icons/fi';
import { leadFunnel } from '../api';
import { useAuth } from '../context/AuthContext';
import { fmtIST } from '../utils/dateIST';
import FunnelLeadDrawer from '../components/FunnelLeadDrawer';

const money = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN');

// Deal value: receipt amount is the truest "what they paid"; fall back to the
// sales bill, then the quoted price.
const dealValue = (c) => Number(c.receipt_amount) || Number(c.sales_bill_amount) || Number(c.quoted_price) || 0;

// What the customer bought / was interested in — matched catalogue item first,
// else the raw enquiry product + category.
const interest = (c) => c.matched_item_name
  || [c.query_product_name, c.query_mcat_name].filter(Boolean).join(' · ')
  || '—';

// A due date is "due now" when it's today or in the past (the daily tick fires it).
const isDue = (iso) => {
  if (!iso) return false;
  const d = new Date(iso.includes('T') ? iso : iso + 'T00:00:00');
  return !isNaN(d.getTime()) && d.getTime() <= Date.now();
};

// Post-sale relationship surface. Lists closed (KEEP_IN_TOUCH) customers with
// their nurture schedule + deal value, and lets a coordinator re-engage them.
// The daily follow-up tick sends what's scheduled here; this is where the queue
// gets seeded and managed.
export default function L2DKeepInTouch() {
  const { isAdmin } = useAuth();
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ]             = useState('');
  const [openId, setOpenId]   = useState(null);
  const [busyId, setBusyId]   = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    leadFunnel.keepInTouch()
      .then(setRows)
      .catch(e => toast.error(e.response?.data?.error || 'Failed to load customers'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = rows.filter(c => {
    if (!q.trim()) return true;
    const hay = [c.sender_name, c.sender_company, c.sender_mobile, interest(c)].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });

  // Schedule a follow-up N days out, then refresh the row's nurture status.
  const scheduleIn = async (c, days) => {
    setBusyId(c.id);
    try {
      const due = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
      await leadFunnel.addFollowup({ lead_id: c.id, due_date: due, note: `Follow-up in ${days} days` });
      toast.success(`Follow-up set for ${days} days out`);
      load();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
    finally { setBusyId(null); }
  };

  const sendNow = async (c) => {
    setBusyId(c.id);
    try {
      await leadFunnel.followupNow(c.id, {});
      toast.success('Follow-up sent');
      load();
    } catch (e) { toast.error(e.response?.data?.error || 'Send failed'); }
    finally { setBusyId(null); }
  };

  const toggleOptOut = async (c) => {
    setBusyId(c.id);
    try {
      await leadFunnel.update(c.id, { opted_out: c.opted_out ? 0 : 1 });
      toast.success(c.opted_out ? 'Opted back in' : 'Opted out of follow-ups');
      load();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
    finally { setBusyId(null); }
  };

  const totalValue = filtered.reduce((s, c) => s + dealValue(c), 0);

  return (<>
    <div className="space-y-4">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 leading-tight">Keep in Touch</h1>
          <p className="text-sm text-blue-600 mt-0.5">Re-engage closed customers and turn them into repeat business.</p>
        </div>
        <button onClick={load} className="btn btn-secondary btn-sm shrink-0">
          <FiRefreshCw className="inline mr-1" size={13} /> Refresh
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <SummaryCard Icon={FiUsers}  label="Closed customers" value={filtered.length} tone="text-slate-800" />
        <SummaryCard Icon={FiCalendar} label="Lifetime value"  value={money(totalValue)} tone="text-green-700" />
        <SummaryCard Icon={FiClock}  label="Follow-ups due"   value={filtered.filter(c => isDue(c.next_followup)).length} tone="text-amber-700" />
      </div>

      {/* Search */}
      <input
        className="input input-sm w-full max-w-xs"
        placeholder="Search name / company / product…"
        aria-label="Search closed customers"
        value={q}
        onChange={e => setQ(e.target.value)}
      />

      {/* Table */}
      <div className="bg-white rounded-lg border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left text-xs text-gray-500">
              <th className="p-2">Customer</th>
              <th className="p-2">Bought / interested in</th>
              <th className="p-2 text-right">Deal value</th>
              <th className="p-2">Closed</th>
              <th className="p-2">Next follow-up</th>
              <th className="p-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan="6" className="p-4 text-gray-400 text-center">Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan="6" className="p-6 text-gray-400 text-center">No closed customers yet. Deals reaching “Keep in Touch” appear here.</td></tr>
            ) : filtered.map(c => (
              <tr key={c.id} className="border-b hover:bg-blue-50/40">
                <td className="p-2 cursor-pointer" onClick={() => setOpenId(c.id)}>
                  <div className="font-medium text-gray-800">{c.sender_name || '—'}</div>
                  <div className="text-xs text-gray-400">{c.sender_company || c.sender_mobile || ''}</div>
                </td>
                <td className="p-2 text-gray-700">{interest(c)}</td>
                <td className="p-2 text-right text-gray-700">{dealValue(c) ? money(dealValue(c)) : '—'}</td>
                <td className="p-2 text-xs text-gray-400">{fmtIST(c.closed_at) || '—'}</td>
                <td className="p-2 text-xs">
                  {c.opted_out ? (
                    <span className="text-gray-400">Opted out</span>
                  ) : c.next_followup ? (
                    <span className={isDue(c.next_followup) ? 'text-amber-700 font-medium' : 'text-gray-600'}>
                      {fmtIST(c.next_followup) || c.next_followup}
                      {isDue(c.next_followup) && ' · due'}
                    </span>
                  ) : (
                    <span className="text-gray-400">None scheduled</span>
                  )}
                  {c.followups_sent > 0 && <div className="text-[10px] text-gray-400">{c.followups_sent} sent</div>}
                </td>
                <td className="p-2">
                  <div className="flex items-center justify-end gap-1">
                    <PresetMenu disabled={busyId === c.id || c.opted_out} onPick={(d) => scheduleIn(c, d)} />
                    <button
                      onClick={() => sendNow(c)}
                      disabled={busyId === c.id || c.opted_out}
                      title="Send a follow-up now"
                      className="p-1.5 rounded border border-gray-200 text-gray-600 hover:bg-green-50 hover:text-green-700 disabled:opacity-40"
                    >
                      <FiSend size={13} />
                    </button>
                    <button
                      onClick={() => toggleOptOut(c)}
                      disabled={busyId === c.id}
                      title={c.opted_out ? 'Opt back in' : 'Opt out of follow-ups'}
                      className={`p-1.5 rounded border border-gray-200 disabled:opacity-40 ${c.opted_out ? 'text-gray-400 hover:bg-gray-50' : 'text-gray-600 hover:bg-red-50 hover:text-red-700'}`}
                    >
                      {c.opted_out ? <FiBell size={13} /> : <FiBellOff size={13} />}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>

    {openId && (
      <FunnelLeadDrawer
        leadId={openId}
        isAdmin={isAdmin()}
        onClose={() => setOpenId(null)}
        onChanged={load}
      />
    )}
  </>);
}

function SummaryCard({ Icon, label, value, tone }) {
  return (
    <div className="relative rounded-lg border border-gray-200 bg-white pl-4 pr-3 py-3">
      <div className="flex items-start justify-between mb-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">{label}</span>
        <Icon size={14} className="text-gray-300" />
      </div>
      <div className={`text-2xl font-bold tabular-nums leading-none ${tone}`}>{value}</div>
    </div>
  );
}

// Quick "follow up in 30 / 60 / 90 days" presets.
function PresetMenu({ onPick, disabled }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        title="Schedule a follow-up"
        className="p-1.5 rounded border border-gray-200 text-gray-600 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-40"
      >
        <FiClock size={13} />
      </button>
      {open && !disabled && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-32 rounded-md border border-gray-200 bg-white shadow-lg py-1 text-xs">
            {[30, 60, 90].map(d => (
              <button
                key={d}
                onClick={() => { setOpen(false); onPick(d); }}
                className="block w-full text-left px-3 py-1.5 text-gray-700 hover:bg-blue-50"
              >
                In {d} days
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
