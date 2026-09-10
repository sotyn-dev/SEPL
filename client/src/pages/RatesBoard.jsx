// SOP-05 Rates Board (mam 2026-08-28): "Vendor & rates fixed BEFORE indent"
// — same reference design as the SOP-07 flow board via the shared FlowBoard
// component. Stages: S1 Package List → S2 Rate Enquiry → S3 Comparison →
// S4 Finalise Vendor → S5 Rate Lock/MD (above estimate → MD sir) →
// S6 Rate Contract → S7 Long-Delivery (order today).
import { useRef } from 'react';
import FlowBoard from '../components/FlowBoard';
import api from '../api';
import toast from 'react-hot-toast';
import { useRateActions } from '../components/RateActions';
import { FiFileText, FiDollarSign, FiSend, FiColumns, FiCheckCircle, FiShield, FiLock, FiTruck } from 'react-icons/fi';

// One-click actions ON the board (mam 2026-08-28 "make it here system";
// 2026-09-05 "all action show on click"): S1 ⚡ Make Plan creates the
// order-planning record instantly; every rates stage (S2–S6) opens the SAME
// Rate Contract modal the register uses — 3 quotes → finalise → lock — right
// on the card, and S7 toggles the long-delivery flag. The modals come from
// useRateActions, shared with the Item-wise Rates register, so the board
// cannot drift from the screen it summarises.
const makePlan = async (card, reload) => {
  try {
    await api.post('/orders/planning', {
      po_id: card.rid, business_book_id: card.bb || null,
      planned_start: new Date().toISOString().slice(0, 10), planned_end: null,
      notes: 'Created from Rates Board (SOP-05.1)',
    });
    toast.success(`Plan created for ${card.ref} — package list started`);
    reload();
  } catch (err) { toast.error(err.response?.data?.error || 'Could not create the plan'); }
};

const RATE_STAGES = ['enquiry', 'compare', 'finalise', 'md_lock', 'contract'];

// What the card's button should say for a rates-stage item.
const rateLabel = (card) => {
  if (!card.item_master_id) return '🔗 Map item first';
  if (+card.final_rate > 0) return '🔒 Rate contract';
  const q = +card.quotes || 0;
  return q >= 3 ? '✓ Finalise vendor' : `₹ Enter quotes ${q}/3`;
};

// Every rates stage lives on the Order Planning tab now (the item-wise
// register) — not the indent-time rates tab it used to point at.
const STAGE_LINKS = {
  packages: '/orders?tab=planning',
  enquiry: '/orders?tab=planning',
  compare: '/orders?tab=planning',
  finalise: '/orders?tab=planning',
  md_lock: '/orders?tab=planning',
  contract: '/orders?tab=planning',
  long_delivery: '/orders?tab=planning',
};

const STAGE_ICONS = {
  packages: FiFileText, enquiry: FiSend, compare: FiColumns, finalise: FiCheckCircle,
  md_lock: FiShield, contract: FiLock, long_delivery: FiTruck,
};

export default function RatesBoard() {
  // FlowBoard owns its own loader and hands it to us per card; keep the
  // latest one in a ref so a modal save can refresh the board it was
  // opened from.
  const reloadRef = useRef(null);
  const { openMap, openQuotes, toggleS7, modals } = useRateActions({ onChanged: () => reloadRef.current && reloadRef.current() });

  // Clicking the CARD opens the action (the first photo), not a page.
  // The ref is written inside the click handler, not while FlowBoard is
  // rendering the card (cardAction runs in the render pass).
  const cardAction = (stageKey, card, reload) => {
    if (!RATE_STAGES.includes(stageKey) || !card.id) return null;
    return () => { reloadRef.current = reload; card.item_master_id ? openQuotes(card) : openMap(card); };
  };

  const cardExtra = (stageKey, card, reload) => {
    if (stageKey === 'packages' && card.rid) {
      return (
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); makePlan(card, reload); }}
          className="mt-1 w-full text-[10px] font-bold py-1 rounded bg-violet-600 text-white hover:bg-violet-700"
          title="Create the order-planning record now (SOP-05.1)">
          ⚡ Make Plan
        </button>
      );
    }
    if (RATE_STAGES.includes(stageKey) && card.id) {
      const locked = +card.final_rate > 0;
      return (
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); reloadRef.current = reload; card.item_master_id ? openQuotes(card) : openMap(card); }}
          className={`mt-1 w-full text-[10px] font-bold py-1 rounded text-white ${locked ? 'bg-emerald-600 hover:bg-emerald-700' : card.item_master_id ? 'bg-indigo-600 hover:bg-indigo-700' : 'bg-red-600 hover:bg-red-700'}`}
          title={locked ? 'Open the Rate Contract — edit quotes / final' : card.item_master_id ? 'Enter the 3 vendor quotes / finalise — SOP-05.2–05.6' : 'Link this line to the Item Master first'}>
          {rateLabel(card)}
        </button>
      );
    }
    if (stageKey === 'long_delivery' && card.id) {
      return (
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); reloadRef.current = reload; toggleS7(card); }}
          className="mt-1 w-full text-[10px] font-bold py-1 rounded bg-red-600 text-white hover:bg-red-700"
          title="Flagged — order today (click to unflag)">
          🚚 ORDER TODAY · unflag
        </button>
      );
    }
    return null;
  };

  return (
    <>
    {modals}
    <FlowBoard
      title="Rates Board"
      subtitle="SOP-05 · Vendor & rates fixed BEFORE indent — live board"
      endpoint="/procurement/rates-board"
      stageLinks={STAGE_LINKS}
      stageIcons={STAGE_ICONS}
      openTo={{ link: '/orders?tab=planning', label: 'Open Planning', extra: { link: '/rates-items', label: '📋 Item-wise' } }}
      distsOf={(d) => d.dists || []}
      cardExtra={cardExtra}
      cardAction={cardAction}
      extraTiles={(d) => (d.kpis?.overdue ? [{
        label: 'Overdue Process', title: 'Past the 3-day rate-comparison clock (SOP-05.3), in hours',
        value: d.kpis.overdue.value,
        sub: d.kpis.overdue.value > 0 ? `oldest ${d.kpis.overdue.oldest_hrs} hrs` : 'on time ✓',
        subClass: d.kpis.overdue.value > 0 ? 'text-amber-700 font-semibold' : 'text-emerald-600',
        icon: FiDollarSign,
        iconClass: d.kpis.overdue.value > 0 ? 'bg-amber-100 text-amber-600' : 'bg-emerald-100 text-emerald-600',
        cardClass: d.kpis.overdue.value > 0 ? 'bg-amber-50 border-amber-200' : '',
      }] : [])}
      activityBadge={(k) => ({
        contract: { bg: 'bg-emerald-500', txt: '₹' },
        package: { bg: 'bg-violet-500', txt: 'PK' },
      }[k] || { bg: 'bg-gray-400', txt: '·' })}
    />
    </>
  );
}
