// Lead-to-Dispatch Funnel — stage definitions (frontend mirror).
// Keep in sync with server/lib/l2dStages.js. Stage-config driven so the
// stepper / summary / filters all read from one place and a future lead
// source reuses the same UI.

export const STAGES = [
  { key: 'LEAD_ENTERED',       label: 'Lead Entered',         order: 1,  auto: true,  whatsapp: false },
  { key: 'WELCOME_SENT',       label: 'Welcome + Price Sent', order: 2,  auto: true,  whatsapp: true  },
  { key: 'INTERESTED',         label: 'Interested',           order: 3,  auto: true,  whatsapp: false },
  { key: 'ORDER_CONFIRMED',    label: 'Order Confirmed',      order: 4,  auto: true,  whatsapp: false },
  { key: 'BANK_SENT',          label: 'Bank Details Sent',    order: 5,  auto: true,  whatsapp: true  },
  { key: 'PAYMENT_CONFIRMED',  label: 'Payment Confirmed',    order: 6,  auto: false, whatsapp: false },
  { key: 'PO_DRAFTED',         label: 'PO to Vendor',         order: 7,  auto: false, whatsapp: false },
  { key: 'DISPATCH_CONFIRMED', label: 'Dispatched',           order: 8,  auto: false, whatsapp: false },
  { key: 'PURCHASE_BILL',      label: 'Purchase Bill',        order: 9,  auto: false, whatsapp: false },
  { key: 'SALES_BILL',         label: 'Sales Bill',           order: 10, auto: false, whatsapp: false },
  { key: 'RECEIPT',            label: 'Receipt',              order: 11, auto: false, whatsapp: false },
  { key: 'KEEP_IN_TOUCH',      label: 'Keep in Touch',        order: 12, auto: false, whatsapp: true, terminalGood: true },
];

export const SIDE_STATES = [
  { key: 'REJECTED',       label: 'Rejected (junk)', tone: 'red'    },
  { key: 'NEEDS_REVIEW',   label: 'Needs Review',    tone: 'yellow' },
  { key: 'CALL_REQUESTED', label: 'Call Requested',  tone: 'blue'   },
];

export const STAGE_KEYS = STAGES.map(s => s.key);
export const SIDE_KEYS = SIDE_STATES.map(s => s.key);
export const STAGE_BY_KEY = Object.fromEntries([...STAGES, ...SIDE_STATES].map(s => [s.key, s]));

export function stageLabel(key) {
  return STAGE_BY_KEY[key]?.label || key || '—';
}

export function stageOrder(key) {
  return STAGE_BY_KEY[key]?.order ?? 999;
}

export function isSideState(key) {
  return SIDE_KEYS.includes(key);
}
