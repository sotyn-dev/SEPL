// Lead-to-Dispatch Funnel — canonical stage definitions (server side).
// The 13-step pipeline mam described, modelled as status-tracking only.
// Frontend keeps a byte-identical mirror in client/src/data/l2dStages.js.
//
// auto:true  → the system advances into this stage on its own (ingestion,
//              filter+match, webhook button taps).
// whatsapp:true → entering this stage fires a WhatsApp template send.
// terminalGood → KEEP_IN_TOUCH is the happy end-state of the funnel.

const STAGES = [
  { key: 'LEAD_ENTERED',       label: 'Lead Entered',        order: 1,  auto: true,  whatsapp: false },
  { key: 'WELCOME_SENT',       label: 'Welcome + Price Sent', order: 2,  auto: true,  whatsapp: true  },
  { key: 'INTERESTED',         label: 'Interested',          order: 3,  auto: true,  whatsapp: false },
  { key: 'ORDER_CONFIRMED',    label: 'Order Confirmed',     order: 4,  auto: true,  whatsapp: false },
  { key: 'BANK_SENT',          label: 'Bank Details Sent',   order: 5,  auto: true,  whatsapp: true  },
  { key: 'PAYMENT_CONFIRMED',  label: 'Payment Confirmed',   order: 6,  auto: false, whatsapp: false },
  { key: 'PO_DRAFTED',         label: 'PO to Vendor',        order: 7,  auto: false, whatsapp: false },
  { key: 'DISPATCH_CONFIRMED', label: 'Dispatched',          order: 8,  auto: false, whatsapp: false },
  { key: 'PURCHASE_BILL',      label: 'Purchase Bill',       order: 9,  auto: false, whatsapp: false },
  { key: 'SALES_BILL',         label: 'Sales Bill',          order: 10, auto: false, whatsapp: false },
  { key: 'RECEIPT',            label: 'Receipt',             order: 11, auto: false, whatsapp: false },
  { key: 'KEEP_IN_TOUCH',      label: 'Keep in Touch',       order: 12, auto: false, whatsapp: true, terminalGood: true },
];

// Off-pipeline side states (not part of the linear order).
const SIDE_STATES = [
  { key: 'REJECTED',       label: 'Rejected (junk)',     tone: 'red'    },
  { key: 'NEEDS_REVIEW',   label: 'Needs Review',        tone: 'yellow' },
  { key: 'CALL_REQUESTED', label: 'Call Requested',      tone: 'blue'   },
];

const STAGE_KEYS = STAGES.map(s => s.key);
const SIDE_KEYS = SIDE_STATES.map(s => s.key);
const ALL_KEYS = [...STAGE_KEYS, ...SIDE_KEYS];

const STAGE_BY_KEY = Object.fromEntries([...STAGES, ...SIDE_STATES].map(s => [s.key, s]));

function isValidStage(key) {
  return ALL_KEYS.includes(key);
}

function stageOrder(key) {
  return STAGE_BY_KEY[key]?.order ?? 999;
}

module.exports = { STAGES, SIDE_STATES, STAGE_KEYS, SIDE_KEYS, ALL_KEYS, STAGE_BY_KEY, isValidStage, stageOrder };
