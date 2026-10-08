import { useEffect, useState, useRef } from 'react';
import Modal from './Modal';
import api from '../api';
import { rentalEndDate } from '../utils/rentalPeriod';

export default function RentalDispatchModal({ target, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const request = useRef(crypto.randomUUID());
  const attempted = useRef(null);
  useEffect(() => {
    let active = true;
    const url = target.noteId ? `/procurement/delivery-notes/${target.noteId}/rental-dispatch`
      : `/procurement/vendor-po/${target.poId}/rental-dispatch-items`;
    api.get(url).then(res => {
      if (!active) return;
      setData(res.data);
      setItems(res.data.items.map(item => ({ ...item, selected: item.quantity > 0 })));
    }).catch(err => { if (active) setError(err.response?.data?.error || 'Could not load rental items. Close and try again.'); });
    return () => { active = false; };
  }, [target]);
  const change = (key, patch) => setItems(rows => rows.map(row => row.line_key === key ? { ...row, ...patch } : row));
  const submit = async event => {
    event.preventDefault();
    const chosen = items.filter(item => item.selected);
    if (!chosen.length) return setError('Select at least one rental item.');
    for (const item of chosen) {
      if (!(Number(item.quantity) > 0) || Number(item.quantity) > item.max_quantity) return setError(`${item.item_name}: enter a quantity up to ${item.max_quantity}.`);
      if (!rentalEndDate(item.rental_start_date, item.rental_days)) return setError(`${item.item_name}: enter a valid Rental Start Date and positive whole-number Total Rental Days.`);
    }
    const body = { request_id: request.current, revision: data.revision,
      rental_items: chosen.map(({ line_key, quantity, rental_start_date, rental_days }) => ({ line_key, quantity: +quantity, rental_start_date, rental_days: +rental_days })) };
    // A failed response may already have committed. Retry the identical payload;
    // never turn a network retry into a second dispatch with changed quantities.
    if (attempted.current && attempted.current !== JSON.stringify(body)) return setError('Retry the original values first, or close and refresh to check whether the dispatch was saved.');
    attempted.current = JSON.stringify(body);
    setSaving(true); setError('');
    try {
      const res = target.noteId ? await api.put(`/procurement/delivery-notes/${target.noteId}/rental-dispatch`, body)
        : await api.post('/procurement/delivery-notes', { ...body, document_type: 'challan', vendor_po_id: target.poId });
      onSaved(res.data);
    } catch (err) {
      if (err.response && err.response.status < 500) attempted.current = null;
      setError(err.response?.data?.error || 'Could not confirm the response. Retry with the same values; this will not create duplicate rentals.');
    } finally { setSaving(false); }
  };
  return <Modal isOpen wide onClose={() => { if (!saving) onClose(); }} title={data?.confirmed_at ? 'Edit rental dispatch details' : 'Confirm rental dispatch'}>
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-gray-600">{data?.indent_number} · {data?.site_name}</p>
      <p className="text-xs text-gray-500">Set each item’s rental period. The start date counts as Day 1. Confirmation adds these items to Rental Tools, awaiting site receipt.</p>
      {error && <p role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {!data && !error && <p>Loading rental items…</p>}
      {data && !items.length && <p>No rental items on this document.</p>}
      {items.map(item => <fieldset key={item.line_key} className="rounded-lg border p-3 space-y-3">
        <label className="flex items-start gap-2 text-sm font-semibold"><input type="checkbox" checked={item.selected} disabled={saving || !!item.existing_id} onChange={e => change(item.line_key, { selected: e.target.checked })} />{item.item_name}</label>
        <div className="text-xs text-gray-500">{[item.description, item.specification, item.size].filter(Boolean).join(' · ')}</div>
        {item.selected && <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="text-xs">Quantity ({item.unit}) *<input className="input mt-1" type="number" min="0.000001" step="any" max={item.max_quantity} required disabled={saving} value={item.quantity} onChange={e => change(item.line_key, { quantity: e.target.value })} /><span className="text-gray-500">Available: {item.max_quantity}</span></label>
          <label className="text-xs">Rental Start Date *<input className="input mt-1" type="date" required disabled={saving} value={item.rental_start_date} onChange={e => change(item.line_key, { rental_start_date: e.target.value })} /></label>
          <label className="text-xs">Total Rental Days *<input className="input mt-1" type="number" min="1" step="1" required disabled={saving} value={item.rental_days} onChange={e => change(item.line_key, { rental_days: e.target.value })} /></label>
          <div className="sm:col-span-3 text-xs text-blue-800">Expected rental end: <b>{rentalEndDate(item.rental_start_date, item.rental_days) || 'Enter start date and days'}</b></div>
        </div>}
      </fieldset>)}
      <div className="flex justify-end gap-2"><button type="button" className="btn btn-secondary" disabled={saving} onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={saving || !data || !items.length}>{saving ? 'Saving…' : data?.confirmed_at ? 'Save rental correction' : 'Confirm dispatch'}</button></div>
    </form>
  </Modal>;
}
