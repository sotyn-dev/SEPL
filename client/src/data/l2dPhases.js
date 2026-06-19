// Lead-to-Dispatch Funnel — human-milestone model. The 12 technical stages
// (l2dStages.js) compile into 6 phases that map to what a person actually does.
// Automatic stages still exist underneath; they surface as timestamped log lines
// inside their phase rather than as their own jarring step.

import { STAGES, stageOrder, stageLabel } from './l2dStages';

export const PHASES = [
  { id: 'qualify',  label: 'Qualify & greet',   owner: 'AI · Sales Coordinator', stages: ['LEAD_ENTERED', 'NEEDS_REVIEW', 'CALL_REQUESTED', 'REJECTED'] },
  { id: 'confirm',  label: 'Confirm order',      owner: 'Sales Coordinator',      stages: ['WELCOME_SENT', 'INTERESTED', 'ORDER_CONFIRMED'] },
  { id: 'payment',  label: 'Get paid',           owner: 'ERP · Coordinator',      stages: ['BANK_SENT', 'PAYMENT_CONFIRMED'] },
  { id: 'procure',  label: 'Procure & dispatch', owner: 'Coordinator',            stages: ['PO_DRAFTED', 'DISPATCH_CONFIRMED'] },
  { id: 'billing',  label: 'Billing',            owner: 'Purchase Exec · ERP',    stages: ['PURCHASE_BILL', 'SALES_BILL'] },
  { id: 'close',    label: 'Close & nurture',    owner: 'Delivery · ERP',         stages: ['RECEIPT', 'KEEP_IN_TOUCH'] },
];

const PHASE_INDEX_BY_STAGE = {};
PHASES.forEach((p, i) => p.stages.forEach(s => { PHASE_INDEX_BY_STAGE[s] = i; }));

// Index of the phase that owns a stage (defaults to the first phase).
export function phaseIndexForStage(stage) {
  return PHASE_INDEX_BY_STAGE[stage] ?? 0;
}

export function phaseForStage(stage) {
  return PHASES[phaseIndexForStage(stage)];
}

// Next linear stage key in the 12-stage chain, or null at the terminal stage.
// stageOrder is 1-based; STAGES is 0-based, so STAGES[order] is the next one.
export function nextStageKey(stage) {
  return STAGES[stageOrder(stage)]?.key || null;
}

// Which phase an activity/message row belongs to, for the per-phase log.
const TEMPLATE_PHASE = { welcome: 1, bank: 2, followup: 5 };
export function phaseIndexForMessage(m) {
  if (m.template && TEMPLATE_PHASE[m.template] != null) return TEMPLATE_PHASE[m.template];
  return 1; // inbound / free-text reply → Confirm order
}

// Human-readable label for one message row in the activity log.
export function messageLabel(m) {
  if (m.direction === 'in') {
    const body = (m.body || '').trim();
    return 'Customer replied' + (body ? `: ${body.length > 48 ? body.slice(0, 48) + '…' : body}` : '');
  }
  const map = { welcome: 'Welcome + price sent', bank: 'Bank details sent', followup: 'Follow-up sent' };
  const base = map[m.template] || 'Message sent';
  return base + (m.status === 'failed' ? ' (failed)' : '');
}

// Stage transition → log label.
export function historyLabel(h) {
  return stageLabel(h.to_stage);
}
