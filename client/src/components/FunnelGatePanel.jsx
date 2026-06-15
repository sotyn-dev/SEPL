// Gate classifier for the lead funnel. A lead sitting in a "gate" needs one human
// decision (approve / reject / price / send), not the 12-step chain. gateState()
// reads facts from the GET payload (stage + outbound messages + price) and returns
// a { kind } or null. The action UI itself lives in NextActionCard; this file is
// the single source of gate truth, imported by useLeadDecision.

export function gateState(lead, messages = []) {
  const stage = lead?.stage;
  const hasWelcome = messages.some(m => m.direction === 'out' && (m.template === 'welcome_priced' || m.template === 'welcome_unpriced'));
  const hasBank = messages.some(m => m.direction === 'out' && m.template === 'bank');
  const hasPrice = Number(lead?.quoted_price) > 0;

  if (stage === 'REJECTED') return { kind: 'rejected', hasWelcome, hasPrice };
  if (stage === 'CALL_REQUESTED') return { kind: 'call', hasWelcome, hasPrice };
  if (stage === 'LEAD_ENTERED') return { kind: 'unprocessed', hasWelcome, hasPrice };
  if (stage === 'NEEDS_REVIEW') {
    return hasWelcome && !hasPrice
      ? { kind: 'needs_price', hasWelcome, hasPrice }            // relevant, no catalogue price
      : { kind: 'needs_classification', hasWelcome, hasPrice };  // AI unsure / unavailable
  }
  // Manual-price approval follow-on: priced by hand, greeted, bank not yet sent.
  if (stage === 'WELCOME_SENT' && lead.price_source === 'manual' && hasPrice && !hasBank) {
    return { kind: 'send_bank', hasWelcome: true, hasPrice: true };
  }
  // Customer showed interest → coordinator calls to confirm the order.
  if (stage === 'INTERESTED') return { kind: 'confirm_order', hasWelcome, hasPrice };
  // Order confirmed but bank details not sent yet → send them.
  if (stage === 'ORDER_CONFIRMED' && !hasBank) return { kind: 'send_bank', hasWelcome, hasPrice };

  return null;
}

// Hard gates replace the chain entirely; send_bank is a soft follow-on.
export function isHardGate(gate) {
  return !!gate && gate.kind !== 'send_bank';
}
