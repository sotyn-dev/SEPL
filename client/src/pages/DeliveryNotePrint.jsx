import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../api';

export default function DeliveryNotePrint() {
  const { id } = useParams();
  const { canApprove, isAdmin } = useAuth();
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState('');
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    setData(null); setSelected(''); setHtml(''); setError('');
    api.get(`/procurement/vendor-po/${id}/delivery-notes`).then(({ data }) => {
      if (!active) return;
      setData(data);
      setSelected(data.delivery_notes.length === 1 ? String(data.delivery_notes[0].id) : '');
    }).catch(e => { if (active) setError(e.response?.data?.error || 'Could not load delivery notes.'); });
    return () => { active = false; };
  }, [id]);

  useEffect(() => {
    let active = true;
    setHtml('');
    if (!selected) return;
    setError('');
    api.get(`/procurement/delivery-notes/${selected}/print`).then(({ data }) => {
      if (active) setHtml(data);
    }).catch(e => { if (active) setError(e.response?.data?.error || 'Could not load this delivery note.'); });
    return () => { active = false; };
  }, [selected]);

  const create = async () => {
    setSaving(true); setError('');
    try {
      const result = await api.post(`/procurement/vendor-po/${id}/delivery-notes`);
      const notes = result.data.delivery_notes;
      setData(previous => ({ ...previous, delivery_notes: notes }));
      setSelected(notes.length === 1 ? String(notes[0].id) : '');
    } catch (e) { setError(e.response?.data?.error || 'Could not create the delivery note.'); }
    finally { setSaving(false); }
  };

  return <div className="min-h-screen bg-slate-100 p-4">
    <div className="max-w-5xl mx-auto rounded-xl bg-white border border-slate-200 p-4 mb-4">
      <a href="/procurement?tab=delivery&subtab=list" className="text-sm text-blue-700">← Dispatch &amp; Receiving</a>
      <h1 className="text-lg font-semibold text-slate-900 mt-3">Delivery Note {data?.po.po_number ? `· ${data.po.po_number}` : ''}</h1>
      {error && <div role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-red-700">{error}</div>}
      {!data && !error && <p className="mt-3 text-slate-500">Loading delivery notes…</p>}
      {data?.delivery_notes.length > 0 && <>
        <label className="block text-sm text-slate-600 mt-3" htmlFor="delivery-batch">Delivery / challan</label>
        <select id="delivery-batch" value={selected} onChange={e => setSelected(e.target.value)} className="mt-1 border border-slate-300 rounded-lg p-2 min-w-64">
          <option value="">Choose a delivery to print</option>
          {data.delivery_notes.map(note => <option key={note.id} value={note.id}>{note.document_number || `Delivery #${note.id}`}{note.delivery_date ? ` · ${note.delivery_date}` : ''}</option>)}
        </select>
        <p className="text-sm text-slate-500 mt-2">The saved challan number, material and quantities match Dispatch &amp; Receiving.</p>
      </>}
      {data?.delivery_notes.length === 0 && <div className="mt-3">
        <p className="text-sm text-slate-600 mb-3">No delivery note has been saved for this PO. Create one for its material before printing.</p>
        {!data.po.cancelled && (isAdmin() || canApprove('procurement'))
          ? <button disabled={saving} onClick={create} className="btn btn-primary">{saving ? 'Saving…' : 'Create delivery note'}</button>
          : <p className="text-sm text-slate-500">Ask the procurement team to create the delivery note.</p>}
      </div>}
    </div>
    {selected && !html && !error && <p className="text-center text-slate-500">Loading print preview…</p>}
    {html && <iframe key={selected} title="Saved delivery note print preview" srcDoc={html}
      className="w-full max-w-5xl mx-auto block border-0" style={{ height: '1250px', background: '#e5e5e5' }} />}
  </div>;
}
