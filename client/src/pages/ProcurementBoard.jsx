// SOP-07 Procurement Flow Board (mam 2026-08-28) — thin config over the
// shared FlowBoard component (design + behaviour live there; the SOP-05
// Rates Board reuses the same shell).
import FlowBoard from '../components/FlowBoard';
import { FiFileText, FiCheckCircle, FiTruck, FiPackage, FiCreditCard, FiAlertTriangle, FiClock, FiDollarSign, FiFilePlus } from 'react-icons/fi';

const STAGE_LINKS = {
  indent: '/procurement?tab=indents',
  rates: '/procurement?tab=rates',
  po_create: '/procurement?tab=vendorpo',
  po_approval: '/procurement?tab=vendorpo',
  purchase_bill: '/procurement?tab=bills',
  sales_bill: '/procurement?tab=dispatch',
  received: '/procurement?tab=dispatch',
  billed: '/procurement?tab=bills',
};

const STAGE_ICONS = {
  indent: FiFileText, rates: FiDollarSign, po_create: FiFilePlus, po_approval: FiCheckCircle,
  purchase_bill: FiCreditCard, sales_bill: FiTruck, received: FiPackage, billed: FiFileText,
};

export default function ProcurementBoard() {
  return (
    <FlowBoard
      title="Procurement Flow"
      subtitle="SOP-07 · Indent to material at site — live board"
      endpoint="/procurement/flow-board"
      stageLinks={STAGE_LINKS}
      stageIcons={STAGE_ICONS}
      openTo={{ link: '/procurement', label: 'Open Procurement' }}
      distsOf={(d) => [
        { title: 'Indent Status Distribution', data: d.indentDist || [] },
        { title: 'PO Stage Distribution', data: d.poDist || [] },
      ]}
      extraTiles={(d) => [
        { label: 'Open Debit Notes', title: 'Open Debit Notes — S10 short/bad material',
          value: d.kpis.debit_open.value, sub: 'S10 short/bad', subClass: 'text-gray-400',
          icon: FiAlertTriangle, iconClass: 'bg-red-100 text-red-600', cardClass: 'bg-red-50 border-red-100' },
        ...(d.kpis.overdue ? [{
          label: 'Overdue Process', title: 'Overdue Process — past the SOP clock, in hours',
          value: d.kpis.overdue.value,
          sub: d.kpis.overdue.value > 0 ? `oldest ${d.kpis.overdue.oldest_hrs} hrs` : 'on time ✓',
          subClass: d.kpis.overdue.value > 0 ? 'text-amber-700 font-semibold' : 'text-emerald-600',
          icon: FiClock,
          iconClass: d.kpis.overdue.value > 0 ? 'bg-amber-100 text-amber-600' : 'bg-emerald-100 text-emerald-600',
          cardClass: d.kpis.overdue.value > 0 ? 'bg-amber-50 border-amber-200' : '',
        }] : []),
      ]}
      activityBadge={(k) => ({
        indent: { bg: 'bg-violet-500', txt: 'IN' }, po: { bg: 'bg-blue-500', txt: 'PO' },
        grn: { bg: 'bg-emerald-500', txt: 'GR' }, bill: { bg: 'bg-amber-500', txt: '₹' },
        debit: { bg: 'bg-red-500', txt: 'DN' },
      }[k] || { bg: 'bg-gray-400', txt: '·' })}
    />
  );
}
