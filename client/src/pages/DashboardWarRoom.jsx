// Director's War Room — CMD + COO + DO-NOT-SHOW dashboard.
// Mirrors mam's HTML spec SEPL_CMD_COO_Dashboard_v1.html exactly:
//   - Light theme (cream #F5F4F0 background, white cards)
//   - Black header with red bottom border, dark tab bar
//   - 3 tabs: CMD VIEW · COO VIEW · DO-NOT-SHOW LIST
//   - Section-numbered layout (Section 1..7 on CMD view)
//   - Traffic lights auto-computed from /api/dashboards/cmd-detail
//   - Top 3 bottlenecks auto-derived from worst metrics in payload
//
// All numbers come from the same compute function as the dark CMD
// dashboards — single source of truth across the three views.

import { useState, useEffect } from 'react';
import api from '../api';
import { useUrlTab } from '../hooks/useUrlTab';
import toast from 'react-hot-toast';

// Palette — matches the HTML --vars exactly
const C = {
  bg: '#F5F4F0', card: '#FFFFFF', ink: '#0E1116', ink2: '#4A4F57',
  line: '#E5E2DA', red: '#D33A2C', amber: '#E2A52E', green: '#1F8A4A',
  blue: '#2C5BA1', violet: '#6B4AAF', soft: '#FAF8F4',
};

const fmtINR = (v) => {
  if (v == null || isNaN(v)) return '—';
  if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)} cr`;
  if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(1)} L`;
  if (Math.abs(v) >= 1e3) return `₹${(v / 1e3).toFixed(1)} K`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
};
const fmtNum = (v) => (v == null || isNaN(v) ? '—' : Math.round(v).toLocaleString('en-IN'));

// ─── Auto-compute traffic light status for each pillar ────────────
function trafficLights(data) {
  const { pulse, cash, sales, operations, data_quality, people } = data;
  const ar90 = cash.ar_aging.bucket_90_plus;
  const bank = pulse.bank_balance;
  const runway = pulse.runway_days;

  // CASH — green if runway > 90d, yellow 30–90d, red < 30d
  const cashLight = runway == null ? 'amber'
    : runway > 90 ? 'green' : runway > 30 ? 'amber' : 'red';
  const cashEv = `Runway ${runway ?? '—'} days · AR >90d ${fmtINR(ar90)}`;

  // SALES — based on lead-to-PO % and active leads
  const conv = pulse.lead_to_po_pct;
  const salesLight = conv == null ? 'red' : conv >= 40 ? 'green' : conv >= 25 ? 'amber' : 'red';
  const salesEv = `${sales.funnel.leads} leads · ${sales.funnel.pos} won · funnel ${sales.funnel.leads < 5 ? 'dry' : 'flowing'}`;

  // DELIVERY — based on DPR adherence today
  const dprPct = pulse.dpr_adherence_pct;
  const delivLight = dprPct == null ? 'amber' : dprPct >= 80 ? 'green' : dprPct >= 50 ? 'amber' : 'red';
  const delivEv = `${operations.active_sites} active sites · ${operations.dpr.on_time} DPRs today`;

  // PEOPLE — based on attendance + KPI distribution
  const att = people.attendance_today;
  const absencePct = att.total > 0 ? (att.absent / att.total) * 100 : 0;
  const peopleLight = absencePct < 5 ? 'green' : absencePct < 15 ? 'amber' : 'red';
  const peopleEv = `${att.total} employees · ${att.present} present · ${att.absent} absent`;

  // SYSTEMS — placeholder (until Sentry wires up) — always amber for now
  const sysLight = 'amber';
  const sysEv = 'Sentry not wired on 8 critical flows · P95 OK';

  // DATA QUALITY — junk POs + missing fields. Use the full count (not the
  // capped display list) so the banner reflects every junk PO.
  const junkCount = data_quality.junk_po_count ?? data_quality.junk_pos.length;
  const dqLight = junkCount === 0 ? 'green' : junkCount < 3 ? 'amber' : 'red';
  const dqEv = `${junkCount} junk PO numbers · ${fmtINR(data_quality.junk_po_total)} affected`;

  return {
    cash:    { light: cashLight,   evidence: cashEv },
    sales:   { light: salesLight,  evidence: salesEv },
    delivery:{ light: delivLight,  evidence: delivEv },
    people:  { light: peopleLight, evidence: peopleEv },
    systems: { light: sysLight,    evidence: sysEv },
    dq:      { light: dqLight,     evidence: dqEv },
  };
}

// ─── Auto-derive Top 3 Bottlenecks ────────────────────────────────
function bottlenecks(data) {
  const { pulse, cash, sales, operations, data_quality } = data;
  const out = [];

  // Bottleneck 1: Sales funnel dry / poor conversion
  if (sales.funnel.leads < 5 || (pulse.lead_to_po_pct ?? 0) < 25) {
    const opportunityCost = Math.round((40 - (pulse.lead_to_po_pct ?? 0)) * 10000); // rough
    out.push({
      rank: 1,
      title: `Sales funnel — ${sales.funnel.leads} leads, ${sales.funnel.pos} won, ${pulse.lead_to_po_pct ?? 0}% conversion`,
      who: 'Sales Head (set owner in Roles & Permissions if NAME GAP)',
      why: `Window has ${sales.funnel.leads} leads; conversion below 40% benchmark. Pipeline is the binding constraint upstream of cash.`,
      evidence: 'Sales Funnel · CRM Funnel · /api/dashboards/cmd-detail#funnel',
      cost: opportunityCost,
      costLabel: 'opportunity cost',
      badge: 'DECIDE TODAY',
      badgeColor: 'red',
      owner: 'Sales Head · 17:00',
    });
  }

  // Bottleneck 2: WIP locked / installations not closing
  const wipLocked = pulse.wip_locked;
  const wipUnbilled = pulse.wip_unbilled;
  if (wipUnbilled > wipLocked * 0.4 || sales.funnel.collected === 0) {
    out.push({
      rank: out.length + 1,
      title: `${operations.active_sites} active sites · ${fmtINR(wipUnbilled)} WIP unbilled`,
      who: 'COO + Installation Head',
      why: 'WIP is locked in execution — sales bills not catching up to PO book. Cash conversion blocked downstream of order receipt.',
      evidence: 'Active POs · Installation module · Sales bills',
      cost: Math.round(wipUnbilled * 0.001),
      costLabel: 'delayed cash conversion',
      badge: 'DECIDE TODAY',
      badgeColor: 'red',
      owner: 'COO · 17:00',
    });
  }

  // Bottleneck 3: Junk POs in book
  if (data_quality.junk_pos.length > 0) {
    out.push({
      rank: out.length + 1,
      title: `${data_quality.junk_po_count ?? data_quality.junk_pos.length} junk PO numbers in book (${data_quality.junk_pos.slice(0, 4).map(p => p.po_number).join(', ')})`,
      who: 'Purchase Head + IT Head (validation now blocks NEW; legacy to clean)',
      why: `Test / dummy data co-mingled with live transactions worth ${fmtINR(data_quality.junk_po_total)}. Reconciliation nightmare if left for 90 days.`,
      evidence: 'Business Book · Recent Orders · validator on PO field now active for new entries',
      cost: 40000,
      costLabel: 'compounding rework',
      badge: 'FIX THIS WEEK',
      badgeColor: 'amber',
      owner: 'IT Head · Fri',
    });
  }

  // Bottleneck (alt): AR aged > 90 days
  if (out.length < 3 && cash.ar_aging.bucket_90_plus > pulse.bank_balance * 0.3) {
    out.push({
      rank: out.length + 1,
      title: `AR aged >90 days: ${fmtINR(cash.ar_aging.bucket_90_plus)} stuck`,
      who: 'CFO + Collections Officer (role gap — needs hire)',
      why: 'Overdue AR exceeds 30% of bank balance. Cash gap risk if dues hit.',
      evidence: 'Receivables · ageing_bucket=90+',
      cost: Math.round(cash.ar_aging.bucket_90_plus * 0.0005),
      costLabel: 'interest + opportunity',
      badge: 'DECIDE TODAY',
      badgeColor: 'red',
      owner: 'CFO · 17:00',
    });
  }

  return out.slice(0, 3);
}

// ─── Style helpers ────────────────────────────────────────────────
const headerStyle = {
  background: '#0E1116', color: '#fff', padding: '18px 28px',
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  borderBottom: `3px solid ${C.red}`,
};
const tabBarStyle = { display: 'flex', gap: 0, background: '#1a1d22', padding: '0 28px' };
const tabStyle = (active) => ({
  padding: '14px 24px', color: active ? '#fff' : '#bdbdbd', cursor: 'pointer',
  fontSize: 13, fontWeight: 500,
  borderBottom: `3px solid ${active ? C.red : 'transparent'}`,
  background: active ? '#0E1116' : 'transparent',
});
const sectionTitle = {
  fontSize: 11, letterSpacing: '1.2px', textTransform: 'uppercase',
  color: C.ink2, fontWeight: 700, margin: '30px 0 12px',
};
const cardStyle = {
  background: C.card, border: `1px solid ${C.line}`,
  borderRadius: 10, padding: 18,
};
const dotStyle = (color) => ({
  width: 14, height: 14, borderRadius: '50%', flexShrink: 0, background: color,
  boxShadow: `0 0 0 4px ${color}26`,
});
const badge = (kind) => {
  const map = {
    red:    { bg: '#FCE7E5', color: C.red },
    amber:  { bg: '#FFF4DC', color: '#9A6E12' },
    green:  { bg: '#E0F1E5', color: C.green },
    blue:   { bg: '#E1ECF7', color: C.blue },
    violet: { bg: '#EBE3F7', color: C.violet },
  };
  const s = map[kind] || map.blue;
  return {
    display: 'inline-block', padding: '3px 8px', borderRadius: 4,
    fontSize: 10.5, fontWeight: 600, letterSpacing: '.3px',
    background: s.bg, color: s.color,
  };
};

// Reusable little card
function TrafficCard({ title, light, evidence }) {
  const colorMap = { red: C.red, amber: C.amber, green: C.green };
  const label = light.toUpperCase();
  return (
    <div style={cardStyle}>
      <h3 style={{ margin: '0 0 4px', fontSize: 11, letterSpacing: 1, color: C.ink2, textTransform: 'uppercase', fontWeight: 600 }}>{title}</h3>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
        <div style={dotStyle(colorMap[light])} />
        <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
      </div>
      <div style={{ fontSize: 12, color: C.ink2, marginTop: 6, lineHeight: 1.45 }}>{evidence}</div>
    </div>
  );
}

function DecisionCard({ q, optA, optB, recommend, owner, deadline }) {
  return (
    <div style={{
      padding: '12px 14px', background: C.soft, borderLeft: `3px solid ${C.red}`,
      borderRadius: 4,
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{q}</div>
      <div style={{ fontSize: 11.5, color: C.ink2, marginBottom: 4 }}>
        <strong style={{ color: C.ink }}>A:</strong> {optA}<br />
        <strong style={{ color: C.ink }}>B:</strong> {optB}
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, color: C.green }}>{recommend}</div>
      <div style={{ fontSize: 10.5, color: C.ink2, marginTop: 6 }}>
        Owner: {owner} · Deadline: {deadline}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────
export default function DashboardWarRoom() {
  const [data, setData] = useState(null);
  const [days, setDays] = useState(90);
  const [tab, setTab] = useUrlTab('cmd');
  const [loading, setLoading] = useState(false);

  const load = async (d = days) => {
    setLoading(true);
    try { setData((await api.get(`/dashboards/cmd-detail?days=${d}`)).data); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed to load'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  if (!data) {
    return (
      <div style={{ background: C.bg, color: C.ink, padding: 60, margin: -8, minHeight: '100vh', textAlign: 'center' }}>
        Loading Director's War Room…
      </div>
    );
  }

  const lights = trafficLights(data);
  const bn = bottlenecks(data);
  const { pulse, cash, sales, operations, inventory, procurement, people, customer, data_quality } = data;

  // ─── Section 4 sub-data (funnel steps) ───────────────────
  const funnelSteps = [
    { lbl: 'Lead',  val: sales.funnel.leads, drop: null },
    { lbl: 'Quote', val: sales.funnel.quoted,
      drop: sales.funnel.leads > 0 ? Math.round((1 - sales.funnel.quoted / sales.funnel.leads) * 100) + '% drop' : null },
    { lbl: 'PO',    val: sales.funnel.pos,
      drop: sales.funnel.quoted > 0 ? Math.round((1 - sales.funnel.pos / sales.funnel.quoted) * 100) + '% drop' : null },
    { lbl: 'Bill',  val: sales.funnel.billed,
      drop: sales.funnel.pos > 0 ? Math.round((1 - sales.funnel.billed / sales.funnel.pos) * 100) + '% drop' : null },
    { lbl: 'Cash',  val: sales.funnel.collected,
      drop: sales.funnel.billed > 0 ? Math.round((1 - sales.funnel.collected / sales.funnel.billed) * 100) + '% drop' : null },
  ];

  return (
    <div style={{ background: C.bg, color: C.ink, margin: -8, minHeight: '100vh', fontFamily: 'Inter, -apple-system, sans-serif' }}>
      <header style={headerStyle}>
        <div>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, letterSpacing: '.3px' }}>SEPL ERP — Director's War Room</h1>
          <div style={{ fontSize: 12, color: '#bdbdbd' }}>Secured Engineers Pvt Ltd · Path to ₹10,000 cr · Read in 30 sec / Decide in 5 min</div>
        </div>
        <div style={{ fontSize: 12, color: '#bdbdbd' }}>
          {new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} · {new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} IST · Auto-refresh 7:30 AM daily
          <select value={days} onChange={e => { setDays(+e.target.value); load(+e.target.value); }}
            style={{ marginLeft: 12, background: '#1a1d22', color: '#fff', border: 'none', padding: '4px 10px', borderRadius: 4, fontSize: 11 }}>
            <option value={30}>30d</option>
            <option value={90}>90d</option>
            <option value={180}>6mo</option>
            <option value={365}>1y</option>
          </select>
        </div>
      </header>

      <div style={tabBarStyle}>
        <div onClick={() => setTab('cmd')} style={tabStyle(tab === 'cmd')}>CMD VIEW (Director)</div>
        <div onClick={() => setTab('coo')} style={tabStyle(tab === 'coo')}>COO VIEW (Operations)</div>
        <div onClick={() => setTab('hide')} style={tabStyle(tab === 'hide')}>DO-NOT-SHOW LIST</div>
      </div>

      <main style={{ padding: 28, maxWidth: 1400, margin: '0 auto' }}>

        {/* ============== CMD VIEW ============== */}
        {tab === 'cmd' && (<>

          {/* Section 1 — Traffic Light */}
          <div style={{ ...sectionTitle, marginTop: 0 }}>Section 1 · Traffic Light (30-second read)</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 20, marginBottom: 24 }}>
            <TrafficCard title="Cash"         {...lights.cash} />
            <TrafficCard title="Sales"        {...lights.sales} />
            <TrafficCard title="Delivery"     {...lights.delivery} />
            <TrafficCard title="People"       {...lights.people} />
            <TrafficCard title="Systems"      {...lights.systems} />
            <TrafficCard title="Data Quality" {...lights.dq} />
          </div>

          {/* Escalation banner */}
          {[lights.cash, lights.sales, lights.delivery, lights.dq].filter(l => l.light === 'red').length >= 2 && (
            <div style={{ background: '#FCE7E5', color: '#7B1F18', padding: '10px 14px', borderRadius: 6, fontSize: 12, fontWeight: 500, margin: '12px 0', borderLeft: `3px solid ${C.red}` }}>
              <strong style={{ color: C.red }}>ESCALATION:</strong>
              {' '}{Object.entries(lights).filter(([k, l]) => l.light === 'red').map(([k]) => k.toUpperCase()).join(' · ')} RED.
              Cost-of-inaction (compounding) ≈ <strong>{fmtINR(cash.cost_of_inaction_daily)}/day</strong>
              {data_quality.junk_pos.length > 0 && <> in misallocated POs + lost pipeline opportunity.</>}
            </div>
          )}

          {/* Section 2 — Top 3 Bottlenecks */}
          <div style={sectionTitle}>Section 2 · Top 3 Bottlenecks (₹/day cost)</div>
          <div style={cardStyle}>
            {bn.length === 0 ? (
              <div style={{ textAlign: 'center', color: C.green, padding: 30 }}>No critical bottlenecks detected today. System is running clean.</div>
            ) : bn.map((b, i) => (
              <div key={i} style={{
                display: 'grid', gridTemplateColumns: '30px 1fr 110px 130px',
                gap: 14, alignItems: 'start', padding: '14px 0',
                borderBottom: i === bn.length - 1 ? 'none' : `1px solid ${C.line}`,
              }}>
                <div style={{ fontSize: 22, fontWeight: 700, color: C.red, lineHeight: 1 }}>{b.rank}</div>
                <div>
                  <strong style={{ display: 'block', fontSize: 13.5, marginBottom: 3 }}>{b.title}</strong>
                  <span style={{ fontSize: 12, color: C.ink2, lineHeight: 1.5 }}>
                    <strong>WHO:</strong> {b.who}.<br />
                    <strong>WHY:</strong> {b.why}<br />
                    <strong>EVIDENCE:</strong> {b.evidence}
                  </span>
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, color: C.red, textAlign: 'right' }}>
                  {fmtINR(b.cost)}/day
                  <small style={{ display: 'block', fontSize: 10, fontWeight: 400, color: C.ink2, textTransform: 'uppercase', letterSpacing: '.5px' }}>{b.costLabel}</small>
                </div>
                <div>
                  <span style={badge(b.badgeColor)}>{b.badge}</span>
                  <div style={{ fontSize: 11, color: C.ink2, marginTop: 6 }}>Owner: {b.owner}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Section 3 — Today's 3 Decisions */}
          <div style={sectionTitle}>Section 3 · Today's 3 Decisions</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>
            <DecisionCard
              q="D1: Sales pipeline rescue"
              optA="Run 2-week field blitz, COO leads, target 25 leads."
              optB="Hire 1 sales head ₹18 L CTC, 8-week ramp."
              recommend="→ RECOMMEND: A (cost ₹3 L, week-1 results)"
              owner="CMD" deadline="17:00" />
            <DecisionCard
              q="D2: Installation throughput"
              optA="Pause new orders > ₹5 L until 10 closures done."
              optB="Add 2 installation engineers on contract ₹65 K/mo."
              recommend="→ RECOMMEND: B (faster, reversible)"
              owner="COO" deadline="17:00" />
            <DecisionCard
              q="D3: PO field validation"
              optA="Block free-text PO input today (1-line code change)."
              optB="Audit + clean junk POs first, validate later."
              recommend="→ RECOMMEND: A (already shipped) + B (cleanup ongoing)"
              owner="IT Head" deadline="today EoD" />
          </div>

          {/* Section 4 — Cash · Sales · Delivery */}
          <div style={sectionTitle}>Section 4 · Cash · Sales · Delivery (numbers, no fluff)</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>
            <div style={cardStyle}>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Cash position</h2>
              <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-.5px', margin: '4px 0' }}>
                {pulse.runway_days != null ? `${pulse.runway_days} days` : '—'}
              </div>
              <div style={{ fontSize: 11, color: C.red }}>runway · burn-rate based</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, marginTop: 14 }}>
                <tbody>
                  <tr style={{ borderBottom: `1px solid ${C.line}` }}><td style={{ padding: '11px 8px' }}>Bank balance</td><td style={{ padding: '11px 8px', textAlign: 'right' }}><strong>{fmtINR(pulse.bank_balance)}</strong></td></tr>
                  <tr style={{ borderBottom: `1px solid ${C.line}` }}><td style={{ padding: '11px 8px' }}>AR (total)</td><td style={{ padding: '11px 8px', textAlign: 'right' }}>{fmtINR(cash.ar_outstanding)}</td></tr>
                  <tr style={{ borderBottom: `1px solid ${C.line}` }}><td style={{ padding: '11px 8px' }}>AR &gt; 90 days</td><td style={{ padding: '11px 8px', textAlign: 'right', color: C.red }}><strong>{fmtINR(cash.ar_aging.bucket_90_plus)}</strong></td></tr>
                  <tr style={{ borderBottom: `1px solid ${C.line}` }}><td style={{ padding: '11px 8px' }}>AP outstanding</td><td style={{ padding: '11px 8px', textAlign: 'right' }}>{fmtINR(cash.ap_outstanding)}</td></tr>
                  <tr><td style={{ padding: '11px 8px' }}>Free cash (deployable)</td><td style={{ padding: '11px 8px', textAlign: 'right' }}>{fmtINR(pulse.free_cash)}</td></tr>
                </tbody>
              </table>
            </div>

            <div style={cardStyle}>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Sales funnel (live)</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginTop: 8 }}>
                {funnelSteps.map((s, i) => (
                  <div key={i} style={{ background: C.soft, padding: 10, borderRadius: 6, textAlign: 'center' }}>
                    <div style={{ fontSize: 10.5, color: C.ink2, letterSpacing: '.5px', textTransform: 'uppercase', fontWeight: 600 }}>{s.lbl}</div>
                    <div style={{ fontSize: 18, fontWeight: 700, marginTop: 3 }}>{s.val}</div>
                    {s.drop && <div style={{ fontSize: 10, color: C.red, fontWeight: 600, marginTop: 2 }}>{s.drop}</div>}
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 12, color: C.ink2, marginTop: 14, lineHeight: 1.45 }}>
                Biggest leak: <strong>Bill → Cash</strong> &amp; <strong>Lead → Quote</strong>. Pipeline volume below the 5-lead-per-window threshold.
              </div>
            </div>

            <div style={cardStyle}>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Delivery health</h2>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <tbody>
                  <tr style={{ borderBottom: `1px solid ${C.line}` }}><td style={{ padding: '11px 8px' }}>Active orders</td><td style={{ padding: '11px 8px', textAlign: 'right' }}><strong>{pulse.order_book_count}</strong></td></tr>
                  <tr style={{ borderBottom: `1px solid ${C.line}` }}><td style={{ padding: '11px 8px' }}>Order value</td><td style={{ padding: '11px 8px', textAlign: 'right' }}><strong>{fmtINR(pulse.order_book)}</strong></td></tr>
                  <tr style={{ borderBottom: `1px solid ${C.line}` }}><td style={{ padding: '11px 8px' }}>Installations done (MTD)</td><td style={{ padding: '11px 8px', textAlign: 'right', color: sales.funnel.collected > 0 ? C.ink : C.red }}><strong>{sales.funnel.collected}</strong></td></tr>
                  <tr style={{ borderBottom: `1px solid ${C.line}` }}><td style={{ padding: '11px 8px' }}>DPR adherence (today)</td><td style={{ padding: '11px 8px', textAlign: 'right', color: (pulse.dpr_adherence_pct ?? 0) >= 80 ? C.green : C.red }}><strong>{pulse.dpr_adherence_pct ?? '—'}%</strong></td></tr>
                  <tr style={{ borderBottom: `1px solid ${C.line}` }}><td style={{ padding: '11px 8px' }}>Open complaints</td><td style={{ padding: '11px 8px', textAlign: 'right' }}>{customer.complaints_by_priority.reduce((s, r) => s + r.cnt, 0)}</td></tr>
                  <tr><td style={{ padding: '11px 8px' }}>Open snags</td><td style={{ padding: '11px 8px', textAlign: 'right' }}>{pulse.open_snags}</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Section 5 — Pareto · Predictive · Exceptions */}
          <div style={sectionTitle}>Section 5 · Pareto · Predictive · Exceptions</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>
            <div style={cardStyle}>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>20% of customers = 80% revenue</h2>
              {sales.top_customers.length === 0 ? (
                <div style={{ color: C.ink2, fontSize: 12, marginTop: 12 }}>No business_book rows with po_amount yet.</div>
              ) : (() => {
                const total = sales.top_customers.reduce((s, c) => s + (c.total_order || 0), 0) + 1;
                return sales.top_customers.slice(0, 4).map((c, i) => {
                  const pct = Math.round((c.total_order / total) * 100);
                  return (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 60px', gap: 8, fontSize: 12, padding: '6px 0' }}>
                      <div>
                        {(c.client || c.company || '—').slice(0, 28)}<br />
                        <span style={{ color: C.ink2, fontSize: 11 }}>{fmtINR(c.total_order)}</span>
                        <div style={{ height: 6, background: '#eee', borderRadius: 3, marginTop: 4, overflow: 'hidden' }}>
                          <div style={{ width: `${pct}%`, height: '100%', background: C.red }} />
                        </div>
                      </div>
                      <div style={{ fontWeight: 600, textAlign: 'right' }}>{pct}%</div>
                    </div>
                  );
                });
              })()}
              <div style={{ fontSize: 12, color: C.ink2, marginTop: 10 }}>
                Top 2 customers = <strong>{((sales.top_customers[0]?.share_pct || 0) + (sales.top_customers[1]?.share_pct || 0))}%</strong> of order book — concentration risk.
              </div>
            </div>

            <div style={cardStyle}>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Predictive flags (next 14 days)</h2>
              {customer.predictive_flags.length === 0 ? (
                <div style={{ color: C.green, fontSize: 12, marginTop: 12 }}>No flags raised.</div>
              ) : (
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, color: C.ink2, lineHeight: 1.6 }}>
                  {customer.predictive_flags.map((f, i) => (
                    <li key={i}>
                      <strong style={{ color: f.severity === 'red' ? C.red : C.amber }}>{f.label}</strong>
                      {' · '}{f.detail}
                    </li>
                  ))}
                </ul>
              )}
              <div style={{ fontSize: 12, color: C.ink2, marginTop: 10, fontStyle: 'italic' }}>
                Predictive scoring uses DPR + AR aging + slip-risk signals. Full ML coming in P2.
              </div>
            </div>

            <div style={cardStyle}>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Anomalies (&gt;2σ today)</h2>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, color: C.ink2, lineHeight: 1.6 }}>
                {data_quality.junk_pos.length > 0 && (
                  <li><strong>{data_quality.junk_po_count ?? data_quality.junk_pos.length} PO numbers</strong> below the 10-char alphanumeric rule (junk pattern).</li>
                )}
                {sales.funnel.leads <= 1 && (
                  <li><strong>{sales.funnel.leads} lead{sales.funnel.leads === 1 ? '' : 's'}</strong> in funnel for the {data.window.days}-day window — pipeline dry.</li>
                )}
                {sales.funnel.collected === 0 && sales.funnel.billed > 0 && (
                  <li><strong>{sales.funnel.billed} bills</strong> issued but 0 collected — payment status not being updated.</li>
                )}
                {cash.ar_aging.bucket_90_plus > pulse.bank_balance && (
                  <li><strong>AR &gt;90d exceeds bank balance</strong> — collection war room required.</li>
                )}
                {inventory.dead_stock > 0 && (
                  <li><strong>Dead stock</strong> {fmtINR(inventory.dead_stock)} unmoved for 365+ days · liquidate at 60%.</li>
                )}
              </ul>
            </div>
          </div>

          {/* Section 6 — Accountability */}
          <div style={sectionTitle}>Section 6 · Accountability — who shipped, who didn't</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 20 }}>
            <div style={cardStyle}>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Top / Bottom this week (Friday view)</h2>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, marginTop: 10 }}>
                <thead><tr style={{ borderBottom: `1px solid ${C.line}` }}>
                  <th style={{ textAlign: 'left', fontSize: 11, padding: '10px 8px', color: C.ink2, textTransform: 'uppercase', letterSpacing: '.5px' }}>Rank</th>
                  <th style={{ textAlign: 'left', fontSize: 11, padding: '10px 8px', color: C.ink2, textTransform: 'uppercase', letterSpacing: '.5px' }}>Name</th>
                  <th style={{ textAlign: 'left', fontSize: 11, padding: '10px 8px', color: C.ink2, textTransform: 'uppercase', letterSpacing: '.5px' }}>KPI hit</th>
                </tr></thead>
                <tbody>
                  {people.kpi_top.length === 0 && people.kpi_bottom.length === 0 ? (
                    <tr><td colSpan="3" style={{ textAlign: 'center', padding: 12, color: C.ink2 }}>No score_entries in last 30d. Scorecard module needs data.</td></tr>
                  ) : (<>
                    {people.kpi_top.map((t, i) => (
                      <tr key={'t' + i} style={{ borderBottom: `1px solid ${C.line}` }}>
                        <td style={{ padding: '11px 8px', color: C.green, fontWeight: 600 }}>↑ {i + 1}</td>
                        <td style={{ padding: '11px 8px' }}>{t.user}</td>
                        <td style={{ padding: '11px 8px' }}>{t.pct}%</td>
                      </tr>
                    ))}
                    {people.kpi_bottom.map((t, i) => (
                      <tr key={'b' + i} style={{ borderBottom: `1px solid ${C.line}` }}>
                        <td style={{ padding: '11px 8px', color: C.red, fontWeight: 600 }}>↓ {i + 1}</td>
                        <td style={{ padding: '11px 8px' }}>{t.user}</td>
                        <td style={{ padding: '11px 8px', color: C.red }}>{t.pct}%</td>
                      </tr>
                    ))}
                  </>)}
                </tbody>
              </table>
            </div>
            <div style={cardStyle}>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>SLA breaches &amp; culture flags</h2>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, color: C.ink2, lineHeight: 1.6 }}>
                {operations.sites_past_target.slice(0, 3).map((s, i) => (
                  <li key={i}>{s.project} — site overdue {s.slip_days}d · {fmtINR(s.value)} locked</li>
                ))}
                {customer.complaints_by_priority.length > 0 && (
                  <li>{customer.complaints_by_priority.reduce((s, r) => s + r.cnt, 0)} open complaints — review priority breakdown</li>
                )}
                {operations.sites_past_target.length === 0 && customer.complaints_by_priority.length === 0 && (
                  <li style={{ color: C.green }}>No SLA breaches detected today.</li>
                )}
              </ul>
            </div>
          </div>

          {/* Section 7 — IT Head Watchlist */}
          <div style={sectionTitle}>Section 7 · IT Head Watchlist (this week)</div>
          <div style={cardStyle}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead><tr style={{ borderBottom: `1px solid ${C.line}` }}>
                <th style={{ textAlign: 'left', fontSize: 11, padding: '10px 8px', color: C.ink2, textTransform: 'uppercase' }}>P</th>
                <th style={{ textAlign: 'left', fontSize: 11, padding: '10px 8px', color: C.ink2, textTransform: 'uppercase' }}>Item</th>
                <th style={{ textAlign: 'left', fontSize: 11, padding: '10px 8px', color: C.ink2, textTransform: 'uppercase' }}>ETA</th>
                <th style={{ textAlign: 'left', fontSize: 11, padding: '10px 8px', color: C.ink2, textTransform: 'uppercase' }}>Status</th>
              </tr></thead>
              <tbody>
                <tr style={{ borderBottom: `1px solid ${C.line}` }}><td style={{ padding: '11px 8px' }}><span style={badge('green')}>P0 ✓</span></td><td style={{ padding: '11px 8px' }}>PO field validation (regex 10-char alphanumeric)</td><td style={{ padding: '11px 8px' }}>Shipped</td><td style={{ padding: '11px 8px', color: C.green }}>Live · validator active</td></tr>
                <tr style={{ borderBottom: `1px solid ${C.line}` }}><td style={{ padding: '11px 8px' }}><span style={badge('green')}>P0 ✓</span></td><td style={{ padding: '11px 8px' }}>Lead module: dropdown source (Tenders/Referral/Direct/Website/Channel)</td><td style={{ padding: '11px 8px' }}>Shipped</td><td style={{ padding: '11px 8px', color: C.green }}>Live · free-text blocked</td></tr>
                <tr style={{ borderBottom: `1px solid ${C.line}` }}><td style={{ padding: '11px 8px' }}><span style={badge('green')}>P0 ✓</span></td><td style={{ padding: '11px 8px' }}>Daily 07:30 audit JSON snapshot</td><td style={{ padding: '11px 8px' }}>Shipped</td><td style={{ padding: '11px 8px', color: C.green }}>Scheduled</td></tr>
                <tr style={{ borderBottom: `1px solid ${C.line}` }}><td style={{ padding: '11px 8px' }}><span style={badge('green')}>P1 ✓</span></td><td style={{ padding: '11px 8px' }}>DPR auto-prompt at 6 PM daily</td><td style={{ padding: '11px 8px' }}>Shipped</td><td style={{ padding: '11px 8px', color: C.green }}>Scheduled</td></tr>
                <tr style={{ borderBottom: `1px solid ${C.line}` }}><td style={{ padding: '11px 8px' }}><span style={badge('red')}>P0</span></td><td style={{ padding: '11px 8px' }}>Sentry instrumentation on 8 critical flows</td><td style={{ padding: '11px 8px' }}>Day 7</td><td style={{ padding: '11px 8px', color: C.amber }}>Waiting DSN from MD</td></tr>
                <tr style={{ borderBottom: `1px solid ${C.line}` }}><td style={{ padding: '11px 8px' }}><span style={badge('amber')}>P1</span></td><td style={{ padding: '11px 8px' }}>RBAC for 5 roles (CMD / COO / CFO / HR / Site Eng)</td><td style={{ padding: '11px 8px' }}>Day 14</td><td style={{ padding: '11px 8px', color: C.ink2 }}>Spec in this view ↓</td></tr>
                <tr><td style={{ padding: '11px 8px' }}><span style={badge('amber')}>P1</span></td><td style={{ padding: '11px 8px' }}>Scorecard MIS: wire KPI feeds for top-10 roles</td><td style={{ padding: '11px 8px' }}>Day 14</td><td style={{ padding: '11px 8px', color: C.ink2 }}>Schema ready · KPI list needed</td></tr>
              </tbody>
            </table>
          </div>

          {/* Footer */}
          <div style={{ marginTop: 30, padding: 18, background: '#0E1116', color: '#bdbdbd', borderRadius: 8, fontSize: 11, lineHeight: 1.6 }}>
            <strong style={{ color: '#fff' }}>HOW TO READ:</strong> Section 1 in 30 seconds. Sections 2 + 3 in 5 minutes — those are the levers.
            Sections 4–7 over morning coffee or delegate. RED &gt; YELLOW &gt; GREEN, never "looks good." If a pillar stays RED 2 days in a row, the escalation banner appears at top.
            <br /><br />
            <strong style={{ color: '#fff' }}>NORTH STAR:</strong> ₹10,000 cr by FY32 · 12 → 50 → 150 → 400 → 1000 → 2000 cr · Operating spine: Uber timestamps · Apple clarity · Tata governance · Reliance/Adani leverage.
          </div>
        </>)}

        {/* ============== COO VIEW ============== */}
        {tab === 'coo' && (<>
          <div style={{ ...sectionTitle, marginTop: 0 }}>COO Daily Operating Screen — execution-only, no narrative</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 20, marginBottom: 24 }}>
            {[
              { lbl: 'DPR Adherence', val: pulse.dpr_adherence_pct != null ? `${pulse.dpr_adherence_pct}%` : '—', delta: `target 90% · ${operations.dpr.missed} sites missed`, bad: (pulse.dpr_adherence_pct ?? 0) < 80 },
              { lbl: 'Snags Open',    val: pulse.open_snags, delta: pulse.oldest_snag_days ? `oldest ${pulse.oldest_snag_days}d` : '—', bad: pulse.open_snags > 10 },
              { lbl: 'Sites Live',    val: operations.active_sites, delta: `of ${pulse.order_book_count} active POs`, bad: false },
              { lbl: 'Manpower Today', val: `${people.attendance_today.present}/${people.attendance_today.total}`, delta: `${people.attendance_today.absent} absent · ${people.attendance_today.late} late`, bad: people.attendance_today.absent > 2 },
              { lbl: 'Material in Transit', val: '—', delta: 'indents pending dispatch', bad: false },
              { lbl: 'Tools Out', val: '—', delta: 'data gap · tools module', bad: false },
            ].map((k, i) => (
              <div key={i} style={cardStyle}>
                <h3 style={{ margin: 0, fontSize: 11, letterSpacing: 1, color: C.ink2, textTransform: 'uppercase', fontWeight: 600 }}>{k.lbl}</h3>
                <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-.5px', margin: '4px 0', color: k.bad ? C.red : C.ink }}>{k.val}</div>
                <div style={{ fontSize: 11, color: k.bad ? C.red : C.ink2 }}>{k.delta}</div>
              </div>
            ))}
          </div>

          {/* Today's Site Map */}
          <div style={sectionTitle}>Today's Site Map (DPR + Snag + Risk)</div>
          <div style={cardStyle}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead><tr style={{ borderBottom: `1px solid ${C.line}` }}>
                {['Project', 'Client', 'Slip days', 'Locked ₹', 'Risk'].map(h =>
                  <th key={h} style={{ textAlign: 'left', fontSize: 11, padding: '10px 8px', color: C.ink2, textTransform: 'uppercase', letterSpacing: '.5px' }}>{h}</th>
                )}
              </tr></thead>
              <tbody>
                {operations.sites_past_target.length === 0 ? (
                  <tr><td colSpan="5" style={{ textAlign: 'center', padding: 16, color: C.green }}>No sites past target close date.</td></tr>
                ) : operations.sites_past_target.slice(0, 6).map((s, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${C.line}` }}>
                    <td style={{ padding: '11px 8px', fontFamily: 'monospace' }}>{s.project}</td>
                    <td style={{ padding: '11px 8px' }}>{(s.client || '—').slice(0, 26)}</td>
                    <td style={{ padding: '11px 8px', color: s.slip_days > 30 ? C.red : C.amber, fontWeight: 600 }}>{s.slip_days}d</td>
                    <td style={{ padding: '11px 8px' }}>{fmtINR(s.value)}</td>
                    <td style={{ padding: '11px 8px' }}>
                      <span style={badge(s.slip_days > 30 ? 'red' : s.slip_days > 14 ? 'amber' : 'green')}>
                        {s.slip_days > 30 ? 'SLIP HIGH' : s.slip_days > 14 ? 'WATCH' : 'RECOVERING'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* People */}
          <div style={sectionTitle}>People — Attendance · Behaviour · Performance</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>
            <div style={cardStyle}>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Attendance today</h2>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, marginTop: 10 }}>
                <tbody>
                  <tr style={{ borderBottom: `1px solid ${C.line}` }}><td style={{ padding: '11px 8px' }}>Present</td><td style={{ padding: '11px 8px', textAlign: 'right' }}><strong>{people.attendance_today.present}</strong></td></tr>
                  <tr style={{ borderBottom: `1px solid ${C.line}` }}><td style={{ padding: '11px 8px' }}>On leave (approved)</td><td style={{ padding: '11px 8px', textAlign: 'right' }}>{people.attendance_today.leave}</td></tr>
                  <tr style={{ borderBottom: `1px solid ${C.line}` }}><td style={{ padding: '11px 8px' }}>Absent</td><td style={{ padding: '11px 8px', textAlign: 'right', color: C.red }}><strong>{people.attendance_today.absent}</strong></td></tr>
                  <tr><td style={{ padding: '11px 8px' }}>Late mark</td><td style={{ padding: '11px 8px', textAlign: 'right' }}>{people.attendance_today.late}</td></tr>
                </tbody>
              </table>
            </div>
            <div style={cardStyle}>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Bottom 3 KPI hit (week)</h2>
              {people.kpi_bottom.length === 0 ? (
                <div style={{ fontSize: 12, color: C.ink2, marginTop: 8, fontStyle: 'italic' }}>No score_entries — Scorecard module needs population.</div>
              ) : (
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, color: C.ink2, lineHeight: 1.6 }}>
                  {people.kpi_bottom.map((b, i) => <li key={i}>{b.user} — {b.pct}% KPI hit</li>)}
                </ul>
              )}
              <div style={{ fontSize: 12, color: C.ink2, marginTop: 10, fontStyle: 'italic' }}>If a name appears here 3 weeks in a row → PIP.</div>
            </div>
            <div style={cardStyle}>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Top 3 KPI hit (week)</h2>
              {people.kpi_top.length === 0 ? (
                <div style={{ fontSize: 12, color: C.ink2, marginTop: 8, fontStyle: 'italic' }}>No score_entries yet.</div>
              ) : (
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, color: C.ink2, lineHeight: 1.6 }}>
                  {people.kpi_top.map((t, i) => <li key={i}>{t.user} — {t.pct}% KPI hit</li>)}
                </ul>
              )}
            </div>
          </div>

          {/* Procure-to-Pay */}
          <div style={sectionTitle}>Procure-to-Pay &amp; Inventory health</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>
            <div style={cardStyle}>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Top vendors by spend</h2>
              {procurement.top_vendors.length === 0 ? (
                <div style={{ fontSize: 12, color: C.ink2, marginTop: 8, fontStyle: 'italic' }}>No purchase_bills linked to vendors yet.</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, marginTop: 8 }}>
                  <tbody>{procurement.top_vendors.slice(0, 5).map((v, i) => (
                    <tr key={i} style={{ borderBottom: i === 4 ? 'none' : `1px solid ${C.line}` }}>
                      <td style={{ padding: '8px 6px' }}>{(v.name || '—').slice(0, 22)}</td>
                      <td style={{ padding: '8px 6px', textAlign: 'right', fontWeight: 600 }}>{fmtINR(v.total_spend)}</td>
                      <td style={{ padding: '8px 6px', textAlign: 'right', color: v.paid_pct >= 80 ? C.green : v.paid_pct >= 50 ? C.amber : C.red }}>{Math.round(v.paid_pct || 0)}%</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
            </div>
            <div style={cardStyle}>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Inventory exceptions</h2>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, color: C.ink2, lineHeight: 1.6 }}>
                <li>Total stock value: <strong>{fmtINR(inventory.total)}</strong></li>
                <li>Free-to-use: <strong style={{ color: C.green }}>{fmtINR(inventory.free_to_use)}</strong></li>
                <li>Reserved at sites: <strong>{fmtINR(inventory.reserved)}</strong></li>
                <li>Slow-moving (180+ days): <strong style={{ color: C.amber }}>{fmtINR(inventory.slow_moving)}</strong></li>
                <li>Dead stock (365+ days): <strong style={{ color: C.red }}>{fmtINR(inventory.dead_stock)}</strong></li>
              </ul>
            </div>
            <div style={cardStyle}>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Cash gap watch (30d)</h2>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, color: C.ink2, lineHeight: 1.6 }}>
                <li>Bank now: <strong>{fmtINR(pulse.bank_balance)}</strong></li>
                <li>Free cash: <strong>{fmtINR(pulse.free_cash)}</strong></li>
                <li>AR &gt;90d: <strong style={{ color: C.red }}>{fmtINR(cash.ar_aging.bucket_90_plus)}</strong></li>
                <li>Runway: <strong>{pulse.runway_days ?? '—'} days</strong></li>
                <li>Cost of inaction: <strong style={{ color: C.red }}>{fmtINR(cash.cost_of_inaction_daily)}/day</strong></li>
              </ul>
            </div>
          </div>

          {/* Customer voice */}
          <div style={sectionTitle}>Customer voice — Complaints &amp; Tickets</div>
          <div style={cardStyle}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead><tr style={{ borderBottom: `1px solid ${C.line}` }}>
                {['Priority', 'Open count'].map(h =>
                  <th key={h} style={{ textAlign: 'left', fontSize: 11, padding: '10px 8px', color: C.ink2, textTransform: 'uppercase', letterSpacing: '.5px' }}>{h}</th>
                )}
              </tr></thead>
              <tbody>
                {customer.complaints_by_priority.length === 0 ? (
                  <tr><td colSpan="2" style={{ padding: 12, color: C.green, textAlign: 'center' }}>No open complaints.</td></tr>
                ) : customer.complaints_by_priority.map((p, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${C.line}` }}>
                    <td style={{ padding: '11px 8px' }}>
                      <span style={badge(p.priority === 'critical' || p.priority === 'high' ? 'red' : p.priority === 'medium' ? 'amber' : 'green')}>
                        {(p.priority || '—').toUpperCase()}
                      </span>
                    </td>
                    <td style={{ padding: '11px 8px', fontWeight: 600 }}>{p.cnt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 30, padding: 18, background: '#0E1116', color: '#bdbdbd', borderRadius: 8, fontSize: 11, lineHeight: 1.6 }}>
            <strong style={{ color: '#fff' }}>COO ROUTINE:</strong> 09:00 read this screen → 09:15 call to top 2 RED projects →
            09:30 huddle with Installation Head + Procurement → 17:00 close-out review.
            <br /><br />
            Anything not on this screen is delegated. If you want to see it daily, ask IT Head to add it as a widget.
          </div>
        </>)}

        {/* ============== DO NOT SHOW LIST ============== */}
        {tab === 'hide' && (<>
          <div style={{ ...sectionTitle, marginTop: 0 }}>What NOT to show — and to whom</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <div style={cardStyle}>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Hide from Sales / Junior Ops (RBAC)</h2>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, color: C.ink2, lineHeight: 1.6 }}>
                <li><strong>Cash runway, bank balance, statutory dues</strong> — CMD + CFO only</li>
                <li><strong>Salary &amp; payroll components</strong> — HR + CMD only</li>
                <li><strong>Vendor pricing &amp; PO margins</strong> — Purchase Head + CMD</li>
                <li><strong>PIP candidate list, private confront notes</strong> — CMD only</li>
                <li><strong>Customer churn-risk scores</strong> — CMD + COO + Sales Head only</li>
                <li><strong>Employee attrition risk scores</strong> — CMD + HR Head only</li>
                <li><strong>Bottom-3 leaderboard with names</strong> — CMD only (top-3 can be public)</li>
              </ul>
            </div>
            <div style={cardStyle}>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Hide from CMD daily (delegate, don't drown)</h2>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, color: C.ink2, lineHeight: 1.6 }}>
                <li><strong>Daily attendance roll</strong> — COO &amp; HR only (CMD sees only anomalies)</li>
                <li><strong>Tool issuance log</strong> — Stores Head only</li>
                <li><strong>Indent line-item details</strong> — Procurement only</li>
                <li><strong>Per-engineer DPR text</strong> — COO + line manager only</li>
                <li><strong>Help ticket detail</strong> — IT Head only (CMD sees count only)</li>
                <li><strong>Raw Sentry log lines</strong> — IT Head only</li>
              </ul>
              <div style={{ fontSize: 12, color: C.ink2, marginTop: 10, fontStyle: 'italic' }}>
                Rule of thumb: CMD sees exceptions and decisions. Detail belongs to the person who can act on it.
              </div>
            </div>
          </div>

          <div style={sectionTitle}>RBAC build sheet (handover to IT Head)</div>
          <div style={cardStyle}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead><tr style={{ borderBottom: `1px solid ${C.line}` }}>
                {['Module', 'CMD', 'COO', 'CFO', 'HR', 'Sales', 'Site Eng'].map(h =>
                  <th key={h} style={{ textAlign: 'left', fontSize: 11, padding: '10px 8px', color: C.ink2, textTransform: 'uppercase', letterSpacing: '.5px' }}>{h}</th>
                )}
              </tr></thead>
              <tbody>
                {[
                  ['Cash Flow',          'green:View',  'blue:View',  'green:Edit', '—', '—', '—'],
                  ['Sales Funnel',       'green:View',  'blue:View',  'blue:View',  '—', 'green:Edit', '—'],
                  ['Payroll',            'green:View',  '—',          'blue:View',  'green:Edit', '—', '—'],
                  ['Vendors / Pricing',  'green:View',  'blue:View',  'blue:View',  '—', '—', '—'],
                  ['DPR / PMS',          'blue:View',   'green:Edit', '—',          '—', '—', 'green:Edit own'],
                  ['Scorecard (MIS)',    'green:All',   'blue:Team',  '—',          'blue:Team', 'blue:Self', 'blue:Self'],
                  ['Complaints / Tickets','blue:Count', 'green:Edit', '—',          '—', '—', 'blue:Assigned'],
                  ['User & Roles admin', 'green:Edit',  '—',          '—',          '—', '—', '—'],
                ].map((row, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${C.line}` }}>
                    <td style={{ padding: '11px 8px', fontWeight: 600 }}>{row[0]}</td>
                    {row.slice(1).map((cell, j) => (
                      <td key={j} style={{ padding: '11px 8px' }}>
                        {cell === '—' ? '—' : (
                          <span style={badge(cell.split(':')[0])}>{cell.split(':')[1]}</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 30, padding: 18, background: '#0E1116', color: '#bdbdbd', borderRadius: 8, fontSize: 11, lineHeight: 1.6 }}>
            <strong style={{ color: '#fff' }}>WHY THIS MATTERS:</strong> Showing everything to everyone destroys clarity (Apple) and breaks
            governance (Tata). Each role sees only what they can act on. Audit log captures who saw what,
            so any data leak is traceable. RBAC is a Day-30 P0 — without it, every other dashboard is at risk.
          </div>
        </>)}

      </main>
    </div>
  );
}
