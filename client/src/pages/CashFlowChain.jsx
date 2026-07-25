// Cash Flow Chain — the PMS → CRM → Finance handoff, on one screen.
//
// mam 2026-07-25: "make the system for cash flow … understand the flow first",
// then "show data so the team feels motivated, accountable, and numbers can't be
// faked / hand-entered."
//
// Design answers to that brief:
//   • CAN'T BE FAKED — a system-verified banner + a provenance chip on every seat
//     card. Every figure is computed live from transactions (task approvals, POs,
//     bills, receivables, collections). There is NO "type your score" box.
//   • ACCOUNTABLE — each seat OWNS a named queue: "N stuck · ₹X at stake · oldest
//     Yd". The live chain names the owner on every single order. No hiding in an
//     average.
//   • MOTIVATED — an auto-score (0–100) + grade + leaderboard medal per seat,
//     computed only from the verified inputs. Idle seats read "No activity yet",
//     never a fake 100.
//
// The three seats work as a chain: PMS delivers → CRM bills & pushes AR → Finance
// collects. See server/routes/cashChain.js for all computations.

import { useState, useEffect } from 'react';
import api from '../api';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';
import {
  FiRefreshCw, FiShield, FiArrowRight, FiAlertTriangle, FiClock, FiLock,
} from 'react-icons/fi';
import { LuIndianRupee } from 'react-icons/lu';

// Money in the compact Indian style the cash-flow pages use.
const fmt = (n) => `₹${(n || 0).toLocaleString('en-IN')}`;
const fmtL = (n) => {
  const v = n || 0;
  if (Math.abs(v) >= 10000000) return `₹${(v / 10000000).toFixed(2)} Cr`;
  if (Math.abs(v) >= 100000) return `₹${(v / 100000).toFixed(2)} L`;
  return fmt(v);
};
const pct = (n) => (n == null ? '—' : `${n}%`);
const num = (n) => (n == null ? '—' : n);
const initials = (name) => (name || '?').split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();

const STAGE_STYLE = {
  PMS:     { label: 'PMS · Delivery',   badge: 'bg-indigo-100 text-indigo-700 border-indigo-200' },
  CRM:     { label: 'CRM · AR Push',    badge: 'bg-amber-100 text-amber-700 border-amber-200' },
  Finance: { label: 'Finance · Collect', badge: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
};

const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };
const gradeTone = (g) => ({ A: 'text-emerald-600', B: 'text-lime-600', C: 'text-amber-600', D: 'text-red-600' }[g] || 'text-gray-400');
// Escalation colour by how long an order has been stuck — red = someone must act.
const ageTone = (d) => (d > 45 ? 'text-red-600' : d > 20 ? 'text-amber-600' : 'text-gray-700');

// One agenda KPI tile.
function Tile({ icon: Icon, label, value, sub, tone = 'default' }) {
  const tones = { default: 'text-gray-900', good: 'text-emerald-600', warn: 'text-amber-600', bad: 'text-red-600' };
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-center gap-2 text-gray-500 text-xs font-medium uppercase tracking-wide">
        {Icon && <Icon className="w-3.5 h-3.5" />} {label}
      </div>
      <div className={`mt-1.5 text-2xl font-semibold ${tones[tone]}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-gray-400">{sub}</div>}
    </div>
  );
}

// One seat's motivational + accountable scorecard.
function SeatCard({ accent, seat, name, focus, role, rows }) {
  const scored = role.score != null;
  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden flex flex-col">
      {/* Header: who owns the seat + live auto-score + leaderboard medal */}
      <div className={`px-4 py-3 ${accent} text-white`}>
        <div className="flex items-center justify-between">
          <span className="font-semibold">{seat}</span>
          <span className="text-sm">{name || <em className="opacity-70">unassigned</em>}</span>
        </div>
        <div className="text-white/80 text-xs mt-0.5">{focus}</div>
        <div className="mt-2 flex items-end justify-between">
          <div className="flex items-baseline gap-1.5">
            <span className="text-3xl font-bold leading-none">{scored ? role.score : '—'}</span>
            <span className="text-white/70 text-sm">{scored ? `/100 · ${role.grade}` : 'No activity yet'}</span>
          </div>
          {role.rank && <span className="text-2xl" title={`Rank #${role.rank}`}>{MEDAL[role.rank] || `#${role.rank}`}</span>}
        </div>
      </div>

      {/* Accountability strip — what this seat owns RIGHT NOW */}
      <div className="px-4 py-2 bg-gray-50 border-b border-gray-100 flex items-center justify-between text-xs">
        <span className="text-gray-500">Owns now</span>
        <span className="text-gray-700 font-medium">
          {role.stuckOrders} stuck · {fmtL(role.stuckValue)} at stake{role.oldestAgeDays ? ` · oldest ${role.oldestAgeDays}d` : ''}
        </span>
      </div>

      {/* Verified metrics */}
      <div className="divide-y divide-gray-100 flex-1">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between px-4 py-2.5">
            <span className="text-sm text-gray-600">{r.label}</span>
            <span className={`text-sm font-semibold ${r.tone || 'text-gray-900'}`}>{r.value}</span>
          </div>
        ))}
      </div>

      {/* Provenance — proves the numbers are system-derived, not typed in */}
      <div className="px-4 py-2 border-t border-gray-100 flex items-center gap-1.5 text-[11px] text-gray-400">
        <FiLock className="w-3 h-3" /> Auto from <code className="text-gray-500">{role.source}</code>
      </div>
    </div>
  );
}

export default function CashFlowChain() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(90);
  const [stageFilter, setStageFilter] = useState('all');
  const [mineOnly, setMineOnly] = useState(false);

  const load = () => {
    setLoading(true);
    api.get('/cash-chain/overview', { params: { days } })
      .then((r) => setData(r.data))
      .catch((e) => toast.error(e.response?.data?.error || 'Failed to load cash flow chain'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [days]);

  if (loading && !data) return <div className="p-8 text-gray-400">Loading cash flow chain…</div>;
  if (!data) return null;

  const { seats, agenda, roles, stageSummary, chain, integrity, meta, sop } = data;
  const visibleChain = chain.filter((c) => {
    if (stageFilter !== 'all' && c.stage !== stageFilter) return false;
    if (mineOnly && c.ownerUserId !== user?.id) return false;
    return true;
  });
  const asOf = meta?.generatedAt ? new Date(meta.generatedAt).toLocaleString('en-IN', { hour12: true }) : '';

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
            <LuIndianRupee className="w-5 h-5 text-emerald-600" /> Cash Flow Chain
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            PMS delivers → CRM bills &amp; pushes AR → Finance collects. Find the stuck link, close it, pull DSO down.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select value={days} onChange={(e) => setDays(+e.target.value)} className="border border-gray-300 rounded-md text-sm px-2 py-1.5">
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={180}>Last 180 days</option>
            <option value={365}>Last 365 days</option>
          </select>
          <button onClick={load} className="inline-flex items-center gap-1.5 border border-gray-300 rounded-md text-sm px-3 py-1.5 hover:bg-gray-50">
            <FiRefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      {/* Integrity banner — the "numbers can't be faked" promise, made loud */}
      {integrity?.verified && (
        <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
          <FiShield className="w-5 h-5 text-emerald-600 mt-0.5 shrink-0" />
          <div className="text-sm">
            <span className="font-semibold text-emerald-800">System-verified — no hand-entered numbers.</span>{' '}
            <span className="text-emerald-700">{integrity.note}</span>
            {asOf && <span className="text-emerald-600/70 block mt-0.5 text-xs">Live as of {asOf}. Refreshes on demand.</span>}
          </div>
        </div>
      )}

      {/* SOP — the locked-in accountability rule, front and centre */}
      {sop && (
        <div className="rounded-lg border border-gray-800 bg-gray-900 text-gray-100 px-4 py-3">
          <div className="flex items-center gap-2 mb-2">
            <FiLock className="w-4 h-4 text-amber-400" />
            <span className="font-semibold text-sm uppercase tracking-wide text-amber-300">{sop.title}</span>
          </div>
          <ol className="space-y-1.5 text-sm">
            {sop.rules.map((r, i) => (
              <li key={i} className="flex gap-2">
                <span className={`shrink-0 w-5 h-5 rounded-full text-[11px] font-bold flex items-center justify-center ${i === 2 ? 'bg-amber-400 text-gray-900' : 'bg-gray-700 text-gray-200'}`}>{i + 1}</span>
                <span className={i === 2 ? 'text-amber-200 font-medium' : 'text-gray-300'}>{r}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Shared agenda */}
      <div>
        <div className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Shared agenda — decrease DSO, speed up billing, deliver before timeline</div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <Tile icon={FiClock} label="DSO (days)" value={num(agenda.dso)} sub="avg ageing, open AR" tone={agenda.dso > 60 ? 'bad' : agenda.dso > 30 ? 'warn' : 'good'} />
          <Tile icon={LuIndianRupee} label="Outstanding AR" value={fmtL(agenda.outstandingValue)} />
          <Tile icon={LuIndianRupee} label="Collected" value={fmtL(agenda.collectedPeriod)} sub={`last ${meta?.days} days`} tone="good" />
          <Tile icon={FiAlertTriangle} label="Overdue AR (60+)" value={fmtL(agenda.overdueArValue)} tone={agenda.overdueArValue > 0 ? 'bad' : 'good'} />
          <Tile icon={FiClock} label="Billing lag" value={agenda.billingLagDays == null ? '—' : `${agenda.billingLagDays}d`} sub="delivery → bill" tone={agenda.billingLagDays > 15 ? 'warn' : 'default'} />
          <Tile icon={FiAlertTriangle} label="Past due delivery" value={agenda.pastDueProjects} sub="in-flight projects" tone={agenda.pastDueProjects > 0 ? 'warn' : 'good'} />
        </div>
      </div>

      {/* Seat scorecards */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <SeatCard accent="bg-indigo-600" seat={seats.pms.seat} name={seats.pms.name} focus={seats.pms.focus} role={roles.pms}
          rows={[
            { label: 'Internal open (all)', value: num(roles.pms.internalOpenTotal), tone: roles.pms.internalOpenTotal > 0 ? 'text-red-600' : 'text-emerald-600' },
            { label: '↳ Tasks', value: num(roles.pms.openTasks) },
            { label: '↳ Snags', value: num(roles.pms.openSnags) },
            { label: '↳ Client tickets', value: num(roles.pms.openTickets) },
            { label: 'Overdue tasks', value: num(roles.pms.overdueTasks), tone: roles.pms.overdueTasks > 0 ? 'text-red-600' : 'text-emerald-600' },
            { label: 'On-time closure', value: pct(roles.pms.onTimeClosurePct), tone: roles.pms.onTimeClosurePct != null && roles.pms.onTimeClosurePct < 80 ? 'text-amber-600' : 'text-emerald-600' },
            { label: 'Projects blocked', value: num(roles.pms.blockedProjects), tone: roles.pms.blockedProjects > 0 ? 'text-red-600' : 'text-emerald-600' },
          ]} />
        <SeatCard accent="bg-amber-600" seat={seats.crm.seat} name={seats.crm.name} focus={seats.crm.focus} role={roles.crm}
          rows={[
            { label: 'On me — work done, unpaid', value: `${num(roles.crm.crmResponsibleCount)} · ${fmtL(roles.crm.crmResponsibleValue)}`, tone: roles.crm.crmResponsibleCount > 0 ? 'text-red-600' : 'text-emerald-600' },
            { label: 'Tasks assigned (period)', value: `${num(roles.crm.tasksAssigned)}${roles.crm.tasksAssignedOpen ? ` · ${roles.crm.tasksAssignedOpen} open` : ''}` },
            { label: 'Follow-ups (period)', value: num(roles.crm.followupsPeriod) },
            { label: 'Promises secured', value: `${num(roles.crm.promisedCount)} · ${fmtL(roles.crm.promisedValue)}` },
            { label: '% AR with promise', value: pct(roles.crm.pctWithPromise), tone: roles.crm.pctWithPromise != null && roles.crm.pctWithPromise < 50 ? 'text-amber-600' : 'text-emerald-600' },
            { label: 'Under-billed', value: fmtL(roles.crm.underBilledValue), tone: roles.crm.underBilledValue > 0 ? 'text-amber-600' : 'text-emerald-600' },
          ]} />
        <SeatCard accent="bg-emerald-600" seat={seats.finance.seat} name={seats.finance.name} focus={seats.finance.focus} role={roles.finance}
          rows={[
            { label: 'DSO (days)', value: num(roles.finance.dso), tone: roles.finance.dso > 60 ? 'text-red-600' : 'text-emerald-600' },
            { label: 'Collected (period)', value: fmtL(roles.finance.collectedPeriod), tone: 'text-emerald-600' },
            { label: 'Overdue AR (60+)', value: `${num(roles.finance.overdueArCount)} · ${fmtL(roles.finance.overdueArValue)}`, tone: roles.finance.overdueArValue > 0 ? 'text-red-600' : 'text-emerald-600' },
            { label: 'Promise kept', value: pct(roles.finance.promiseKeptPct), tone: roles.finance.promiseKeptPct != null && roles.finance.promiseKeptPct < 70 ? 'text-amber-600' : 'text-emerald-600' },
          ]} />
      </div>

      {/* Chain table */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <FiArrowRight className="w-4 h-4 text-gray-400" />
            <h2 className="font-semibold text-gray-900">Live chain — where each order is stuck</h2>
            <span className="text-xs text-gray-400">({visibleChain.length} shown)</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {['all', 'PMS', 'CRM', 'Finance'].map((s) => (
              <button key={s} onClick={() => setStageFilter(s)}
                className={`text-xs px-2.5 py-1 rounded-full border ${stageFilter === s ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
                {s === 'all' ? `All (${chain.length})` : `${s} (${stageSummary[s] || 0})`}
              </button>
            ))}
            <label className="flex items-center gap-1.5 text-xs text-gray-600 ml-1">
              <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} /> My queue
            </label>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-400 uppercase tracking-wide border-b border-gray-100">
                <th className="px-4 py-2 font-medium">#</th>
                <th className="px-4 py-2 font-medium">Project</th>
                <th className="px-4 py-2 font-medium">Client</th>
                <th className="px-4 py-2 font-medium text-right">Order</th>
                <th className="px-4 py-2 font-medium text-right">Outstanding</th>
                <th className="px-4 py-2 font-medium">Stuck at</th>
                <th className="px-4 py-2 font-medium">Owner</th>
                <th className="px-4 py-2 font-medium text-right">Age</th>
                <th className="px-4 py-2 font-medium">Next action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {visibleChain.length === 0 && (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-400">Nothing stuck here — chain is clear.</td></tr>
              )}
              {visibleChain.map((c, i) => {
                const st = STAGE_STYLE[c.stage];
                return (
                  <tr key={c.projectId} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5 text-gray-400 tabular-nums">{i + 1}</td>
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-gray-900">{c.projectName}</div>
                      {c.overdueDelivery && <span className="text-[11px] text-red-500">delivery past due</span>}
                    </td>
                    <td className="px-4 py-2.5 text-gray-600">{c.clientName || '—'}</td>
                    <td className="px-4 py-2.5 text-right text-gray-700">{fmtL(c.orderValue)}</td>
                    <td className="px-4 py-2.5 text-right text-gray-700">{c.outstanding ? fmtL(c.outstanding) : '—'}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-block text-[11px] px-2 py-0.5 rounded-full border ${st.badge}`}>{st.label}</span>
                      {c.internalOpen > 0 && (
                        <div className="mt-1 text-[10px] text-gray-400">{[c.openTasks && `${c.openTasks}T`, c.openSnags && `${c.openSnags}S`, c.openTickets && `${c.openTickets}Tk`].filter(Boolean).join(' · ')} open</div>
                      )}
                      {c.crmResponsible && (
                        <div className="mt-1"><span className="inline-block text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-medium">CRM responsible</span></div>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-200 text-gray-600 text-[10px] font-semibold">{initials(c.ownerName || c.ownerSeat)}</span>
                        <span className="text-gray-600">{c.ownerName || <span className="text-gray-300">{c.ownerSeat}</span>}</span>
                      </div>
                    </td>
                    <td className={`px-4 py-2.5 text-right font-medium ${ageTone(c.ageDays)}`}>{c.ageDays}d</td>
                    <td className="px-4 py-2.5 text-gray-500 text-xs max-w-[260px]">{c.note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
