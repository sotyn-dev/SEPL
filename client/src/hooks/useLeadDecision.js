// Classifies a lead into a single action mode for the drawer's action card.
// Gate detection is reused from gateState(); everything else is either an
// automatic "status" wait, a manual "capture" form, or the terminal good state.

import { gateState } from '../components/FunnelGatePanel';

const CAPTURE_STAGES = [
  'PAYMENT_CONFIRMED', 'PO_DRAFTED', 'DISPATCH_CONFIRMED',
  'PURCHASE_BILL', 'SALES_BILL', 'RECEIPT',
];

// Pure classifier (no React state) — returns { mode, gate, gateKind, stageKey }.
export default function useLeadDecision(lead, messages = []) {
  if (!lead) return { mode: 'status', gate: null, gateKind: null, stageKey: null };

  const gate = gateState(lead, messages);
  if (gate) return { mode: 'gate', gate, gateKind: gate.kind, stageKey: lead.stage };

  const stage = lead.stage;
  if (stage === 'KEEP_IN_TOUCH') return { mode: 'terminal_good', gate: null, gateKind: null, stageKey: stage };
  if (CAPTURE_STAGES.includes(stage)) return { mode: 'capture', gate: null, gateKind: null, stageKey: stage };
  return { mode: 'status', gate: null, gateKind: null, stageKey: stage };
}
