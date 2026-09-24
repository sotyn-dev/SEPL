// Completion of an indent's purchase stages requires every live line/PO.
// Unknown or unlinked delivery quantities cannot prove full delivery.
const latest = values => values.length && values.every(Boolean) ? values.slice().sort().at(-1) : null;
function purchaseCompletion(items, pos, lines, rates, notes, bills) {
  const required = items.filter(i => i.source !== 'store' && +i.quantity > 0);
  const live = pos.filter(p => !+p.cancelled);
  const liveIds = new Set(live.map(p => p.id));
  const ordered = lines.filter(l => liveIds.has(l.vendor_po_id) && +l.quantity > 0);
  const covered = required.length > 0 && required.every(i =>
    ordered.filter(l => l.indent_item_id === i.id).reduce((n, l) => n + +(l.original_qty_mtr ?? l.quantity), 0) + 1e-6 >= +i.quantity);
  const stamps = { rates: null, po_l1: null, po_l2: null, payment: null, dispatch: null, received: null, purchase_bill: null };
  const rateDates = required.map(i => latest(rates.filter(r => r.indent_item_id === i.id && r.status === 'finalized' && +r.final_rate > 0).map(r => r.finalized_at)));
  stamps.rates = latest(rateDates);
  if (!covered && required.length) return stamps;
  stamps.po_l1 = latest(live.map(p => p.po_l1_at));
  stamps.po_l2 = latest(live.map(p => p.po_l2_at));
  stamps.payment = latest(live.map(p => p.payment_cleared_at ||
    (!p.payment_block_type || p.payment_block_type === 'no_advance' ? p.created_at : null)));
  const quantities = { dispatch: new Map(), received: new Map() };
  const dates = { dispatch: [], received: [] };
  for (const note of notes) {
    if (!liveIds.has(note.vendor_po_id) || +note.is_draft || note.status === 'rejected' || note.document_type === 'sales_bill') continue;
    let entries;
    try { entries = JSON.parse(note.items_json || '[]'); } catch { continue; }
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || entry.include === false) continue;
      const line = ordered.find(l => l.id === +entry.vendor_po_item_id && l.vendor_po_id === note.vendor_po_id);
      if (!line) continue;
      for (const stage of ['dispatch', 'received']) {
        if (stage === 'received' && (!note.received_at || !['received', 'partial'].includes(note.status))) continue;
        const qty = stage === 'received' ? +(entry.received_qty ?? entry.quantity ?? entry.qty) : +(entry.quantity ?? entry.qty ?? entry.received_qty);
        if (!(qty > 0) || !Number.isFinite(qty)) continue;
        quantities[stage].set(line.id, (quantities[stage].get(line.id) || 0) + qty);
        dates[stage].push(stage === 'received' ? note.received_at : note.created_at);
      }
    }
  }
  for (const stage of ['dispatch', 'received']) {
    const store = items.filter(i => i.source === 'store' && +i.quantity > 0);
    const storeIds = [...new Set(store.map(i => i.stock_issue_note_id))];
    const storeDates = storeIds.map(id => {
      if (!id) return null;
      // A stock issue has one challan; do not sum duplicate documents to
      // manufacture a full dispatch. Require one complete recorded issue.
      const needed = store.filter(i => i.stock_issue_note_id === id);
      return latest(notes.filter(n => n.stock_issue_note_id === id && n.document_type === 'challan' && !+n.is_draft && n.status !== 'rejected').map(n => {
        if (stage === 'received' && (!n.received_at || n.status !== 'received')) return null;
        let entries; try { entries = JSON.parse(n.items_json); } catch { return null; }
        if (!Array.isArray(entries)) return null;
        const norm = v => String(v || '').trim().toLowerCase();
        const groups = new Map();
        for (const item of needed) {
          const key = JSON.stringify([norm(item.description), norm(item.unit)]);
          groups.set(key, (groups.get(key) || 0) + +item.quantity);
        }
        const complete = [...groups].every(([key, qty]) => {
          const supplied = entries.filter(e => e && e.include !== false && JSON.stringify([norm(e.description), norm(e.unit)]) === key)
            .reduce((sum, e) => sum + Math.max(0, +(stage === 'received' ? (e.received_qty ?? e.quantity ?? e.qty) : (e.quantity ?? e.qty)) || 0), 0);
          return supplied + 1e-6 >= qty;
        });
        return complete ? (stage === 'received' ? n.received_at : n.created_at) : null;
      }).filter(Boolean));
    });
    if ((ordered.length || store.length) && ordered.every(l => (quantities[stage].get(l.id) || 0) + 1e-6 >= +l.quantity) && storeDates.every(Boolean)) stamps[stage] = latest([...dates[stage], ...storeDates]);
  }
  stamps.purchase_bill = stamps.received ? latest(live.map(p => {
    const own = bills.filter(b => b.vendor_po_id === p.id);
    const billed = own.reduce((sum, b) => sum + (+b.total_amount || 0), 0);
    return own.length && +p.total_amount > 0 && billed + 0.01 >= +p.total_amount ? latest(own.map(b => b.created_at)) : null;
  })) : null;
  return stamps;
}
module.exports = { purchaseCompletion };
