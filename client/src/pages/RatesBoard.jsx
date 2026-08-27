// SOP-05 Rates Board (mam 2026-08-28): "Vendor & rates fixed BEFORE indent"
// — same reference design as the SOP-07 flow board via the shared FlowBoard
// component. Stages: S1 Package List → S2 Rate Enquiry → S3 Comparison →
// S4 Finalise Vendor → S5 Rate Lock/MD (above estimate → MD sir) →
// S6 Rate Contract → S7 Long-Delivery (order today).
import FlowBoard from '../components/FlowBoard';
import api from '../api';
import toast from 'react-hot-toast';
import { FiFileText, FiDollarSign, FiSend, FiColumns, FiCheckCircle, FiShield, FiLock, FiTruck } from 'react-icons/fi';

// One-click actions ON the board (mam 2026-08-28 "make it here system"):
// S1 ⚡ Make Plan creates the order-planning record instantly; S2 📄 Enquiry
// Sheet opens the ready-made SOP-05.2 rate-enquiry format for vendors.
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
  if (stageKey === 'enquiry' && card.rid) {
    return (
      <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.open(`/rate-enquiry/${card.rid}/print`, '_blank'); }}
        className="mt-1 w-full text-[10px] font-bold py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700"
        title="Open the SOP-05.2 rate-enquiry sheet — full project quantity, print / send to vendors">
        📄 Enquiry Sheet
      </button>
    );
  }
  return null;
};

const STAGE_LINKS = {
  packages: '/orders?tab=planning',
  enquiry: '/procurement?tab=rates',
  compare: '/procurement?tab=rates',
  finalise: '/procurement?tab=rates',
  md_lock: '/procurement?tab=rates',
  contract: '/procurement?tab=rates',
  long_delivery: '/procurement?tab=vendorpo',
};

const STAGE_ICONS = {
  packages: FiFileText, enquiry: FiSend, compare: FiColumns, finalise: FiCheckCircle,
  md_lock: FiShield, contract: FiLock, long_delivery: FiTruck,
};

export default function RatesBoard() {
  return (
    <FlowBoard
      title="Rates Board"
      subtitle="SOP-05 · Vendor & rates fixed BEFORE indent — live board"
      endpoint="/procurement/rates-board"
      stageLinks={STAGE_LINKS}
      stageIcons={STAGE_ICONS}
      openTo={{ link: '/orders?tab=planning', label: 'Open Planning' }}
      distsOf={(d) => d.dists || []}
      cardExtra={cardExtra}
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
  );
}
