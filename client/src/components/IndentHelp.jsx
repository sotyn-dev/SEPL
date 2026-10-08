import NumberedTable from './NumberedTable';
import { useEffect, useRef, useState } from 'react';
import { FiCheck, FiHelpCircle, FiPlus, FiRefreshCw, FiSearch } from 'react-icons/fi';
import toast from 'react-hot-toast';
import api from '../api';
import Modal from './Modal';
import SearchableSelect from './SearchableSelect';
import { fmtDateIST } from '../utils/dateIST';

const ticketNo = id => `IH-${String(id).padStart(5, '0')}`;
const date = value => value ? fmtDateIST(value, { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const priorityStyle = { normal: 'bg-slate-100 text-slate-600', high: 'bg-amber-50 text-amber-800', urgent: 'bg-red-50 text-red-700' };

export default function IndentHelp({ user }) {
  const [data, setData] = useState({ rows: [], stats: {}, total: 0, page: 1, pages: 1 });
  const [options, setOptions] = useState({ indents: [], people: [], stages: [] });
  const [filters, setFilters] = useState({ scope: 'all', status: 'all', q: '', page: 1 });
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState(null);
  const [formError, setFormError] = useState('');
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const [completionNote, setCompletionNote] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const timer = setTimeout(() => {
      api.get('/procurement/indent-help', { params: filters }).then(({ data: result }) => {
        if (active) { setData(result); setError(''); }
      }).catch(err => {
        if (active) setError(err.response?.data?.error || 'Could not load Indent Help. Try Refresh.');
      }).finally(() => { if (active) setLoading(false); });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [filters, refresh]);

  const changeFilter = (key, value) => setFilters(f => ({ ...f, [key]: value, page: 1 }));
  const openCreate = async () => {
    setForm({ indent_id: '', assigned_to: '', subject: '', description: '', stage: 'Indent approval', priority: 'normal', request_id: crypto.randomUUID() });
    setFormError(''); setOptionsLoading(true);
    try { const res = await api.get('/procurement/indent-help/options'); setOptions(res.data); }
    catch (err) { setFormError(err.response?.data?.error || 'Could not load indents and people. Close and try again.'); }
    finally { setOptionsLoading(false); }
  };
  const submit = async e => {
    e.preventDefault();
    if (savingRef.current || optionsLoading) return;
    if (!form.indent_id) return setFormError('Select an indent number. It is compulsory.');
    if (!form.assigned_to) return setFormError('Select the person who will resolve this issue.');
    savingRef.current = true; setSaving(true); setFormError('');
    try {
      const res = await api.post('/procurement/indent-help', form);
      toast.success(`${ticketNo(res.data.id)} raised`);
      setForm(null); setFilters(f => ({ ...f, scope: 'raised', status: 'all', q: '', page: 1 })); setRefresh(n => n + 1);
    } catch (err) { setFormError(err.response?.data?.error || 'Could not save. Your entries are kept; please try again.'); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const markDone = async () => {
    if (savingRef.current) return;
    savingRef.current = true; setSaving(true);
    try {
      await api.patch(`/procurement/indent-help/${selected.id}/done`, { completion_note: completionNote });
      toast.success('Marked Done'); setSelected(null); setRefresh(n => n + 1);
    } catch (err) { toast.error(err.response?.data?.error || 'Could not mark Done'); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const chosenIndent = options.indents.find(i => i.id === form?.indent_id);

  return <section className="space-y-4" aria-label="Indent Help">
    <div className="rounded-xl border border-blue-100 bg-blue-50/50 p-4 flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-white border border-blue-100 p-2.5 text-blue-800"><FiHelpCircle size={22} /></div>
        <div><h3 className="text-lg font-semibold text-slate-900">Indent Help</h3>
          <p className="text-sm text-slate-600 mt-1">Raise an issue against an indent and assign the person who can help.</p>
          <p className="text-xs text-slate-500 mt-1">Only the assigned person can mark it Done. No proof upload required.</p>
        </div>
      </div>
      <button className="btn btn-primary inline-flex items-center gap-2" onClick={openCreate}><FiPlus /> Raise Indent Help</button>
    </div>
    <div className="grid grid-cols-3 gap-3">
      {[['Open', data.stats.open, 'text-amber-700'], ['Open · assigned to me', data.stats.assigned_to_me, 'text-blue-800'], ['Done', data.stats.done, 'text-emerald-700']].map(([label, count, color]) =>
        <div key={label} className="rounded-xl border border-slate-200 bg-white px-4 py-3"><p className="text-xs text-slate-500">{label}</p><p className={`text-2xl font-semibold mt-1 ${color}`}>{count ?? '—'}</p></div>)}
    </div>
    <div className="flex flex-wrap gap-3 items-center">
      <select aria-label="Ticket scope" className="input !w-auto" value={filters.scope} onChange={e => changeFilter('scope', e.target.value)}>
        <option value="all">{data.can_see_all ? 'All indent help' : 'My tickets'}</option><option value="mine">Assigned to me</option><option value="raised">Raised by me</option>
      </select>
      <select aria-label="Help status" className="input !w-auto" value={filters.status} onChange={e => changeFilter('status', e.target.value)}><option value="all">All statuses</option><option value="open">Open</option><option value="done">Done</option></select>
      <div className="relative flex-1 min-w-[220px]"><FiSearch className="absolute left-3 top-3 text-slate-400" /><input aria-label="Search indent help" className="input pl-9" placeholder="Search indent, project, issue or person…" value={filters.q} onChange={e => changeFilter('q', e.target.value)} /></div>
      <button className="btn btn-secondary inline-flex items-center gap-2" onClick={() => setRefresh(n => n + 1)}><FiRefreshCw /> Refresh</button>
    </div>
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
    <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
      <NumberedTable start={(data.page - 1) * 20 + 1} className="w-full min-w-[1000px] text-sm">
        <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500"><tr>{['Indent / Project', 'Issue', 'Stage', 'Raised by', 'Assigned to', 'Priority', 'Status', 'Action'].map(h => <th key={h} className="px-4 py-3 text-left font-semibold">{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-slate-100">
          {loading ? <tr><td colSpan={8} className="p-10 text-center text-slate-500">Loading indent help…</td></tr> : data.rows.length === 0 ? <tr><td colSpan={8} className="p-10 text-center text-slate-500">{error ? 'Tickets are unavailable.' : 'No tickets match this view. Raise Indent Help to get started.'}</td></tr> : data.rows.map(t => <tr key={t.id} className="hover:bg-blue-50/30">
            <td className="px-4 py-4"><div className="font-semibold text-blue-800">{t.indent_number}</div><div className="text-xs text-slate-500 mt-1 max-w-[180px]">{t.site_name || '—'}</div></td>
            <td className="px-4 py-4 max-w-[260px]"><button className="text-left font-medium text-slate-800 hover:text-blue-700" onClick={() => { setSelected(t); setCompletionNote(''); }}>{t.subject}</button><div className="text-[11px] text-slate-400 mt-1">{ticketNo(t.id)} · {date(t.created_at)}</div></td>
            <td className="px-4 py-4 text-slate-600">{t.stage}</td><td className="px-4 py-4 text-slate-600">{t.raised_by_name}</td><td className="px-4 py-4 font-medium text-slate-700">{t.assigned_to_name}{t.assigned_to === user?.id && <span className="block text-[10px] text-blue-600">You</span>}</td>
            <td className="px-4 py-4"><span className={`rounded px-2 py-1 text-[11px] capitalize ${priorityStyle[t.priority]}`}>{t.priority}</span></td>
            <td className="px-4 py-4"><span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${t.status === 'done' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'}`}>{t.status === 'done' ? 'Done' : 'Open'}</span></td>
            <td className="px-4 py-4"><button className={`btn whitespace-nowrap text-xs ${t.status === 'open' && t.assigned_to === user?.id ? 'btn-primary' : 'btn-secondary'}`} onClick={() => { setSelected(t); setCompletionNote(''); }}>{t.status === 'open' && t.assigned_to === user?.id ? 'Mark Done' : 'View'}</button></td>
          </tr>)}
        </tbody>
      </NumberedTable>
      <div className="border-t px-4 py-3 flex items-center justify-between gap-3 text-xs text-slate-500"><span>{data.total} ticket{data.total === 1 ? '' : 's'} · Page {data.page} of {data.pages}</span><div className="flex gap-2"><button className="btn btn-secondary text-xs" disabled={loading || data.page <= 1} onClick={() => setFilters(f => ({ ...f, page: data.page - 1 }))}>Previous</button><button className="btn btn-secondary text-xs" disabled={loading || data.page >= data.pages} onClick={() => setFilters(f => ({ ...f, page: data.page + 1 }))}>Next</button></div></div>
    </div>

    <Modal isOpen={!!form} onClose={() => { if (!saving) setForm(null); }} title="Raise Indent Help" wide>
      {form && <form onSubmit={submit} className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <div><label htmlFor="help-indent" className="label">Indent number *</label><SearchableSelect id="help-indent" ariaLabel="Indent number" options={options.indents.map(i => ({ value: i.id, label: `${i.indent_number} · ${i.site_name || 'No project'}` }))} value={form.indent_id} disabled={optionsLoading || saving} placeholder={optionsLoading ? 'Loading indents…' : 'Search and select an indent'} onChange={o => setForm(f => ({ ...f, indent_id: o?.value || '' }))} /><p className="text-xs text-slate-500 mt-1">{chosenIndent?.site_name || 'An existing indent number is compulsory.'}</p></div>
          <div><label htmlFor="help-person" className="label">Assign to *</label><SearchableSelect id="help-person" ariaLabel="Assign to" options={options.people.map(p => ({ value: p.id, label: p.name }))} value={form.assigned_to} disabled={optionsLoading || saving} placeholder="Select the person who can help" onChange={o => setForm(f => ({ ...f, assigned_to: o?.value || '' }))} /><p className="text-xs text-slate-500 mt-1">Active people with access to this module.</p></div>
          <div><label htmlFor="help-stage" className="label">Issue stage</label><select id="help-stage" className="input" disabled={saving} value={form.stage} onChange={e => setForm({ ...form, stage: e.target.value })}>{options.stages.map(s => <option key={s}>{s}</option>)}</select></div>
          <div><label htmlFor="help-priority" className="label">Priority</label><select id="help-priority" className="input" disabled={saving} value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })}><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></div>
        </div>
        <div><label htmlFor="help-subject" className="label">Issue title *</label><input id="help-subject" className="input" required maxLength={180} disabled={saving} placeholder="e.g. Vendor PO is waiting for approval" value={form.subject} onChange={e => setForm({ ...form, subject: e.target.value })} /></div>
        <div><label htmlFor="help-details" className="label">What help do you need? *</label><textarea id="help-details" className="input" required rows={3} maxLength={4000} disabled={saving} placeholder="Explain the issue and the action you need." value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></div>
        {formError && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{formError}</p>}
        <div className="flex justify-end gap-2 border-t pt-4"><button type="button" className="btn btn-secondary" disabled={saving} onClick={() => setForm(null)}>Cancel</button><button className="btn btn-primary" disabled={saving || optionsLoading}>{saving ? 'Saving…' : 'Raise Indent Help'}</button></div>
      </form>}
    </Modal>
    <Modal isOpen={!!selected} onClose={() => { if (!saving) setSelected(null); }} title={selected ? `${ticketNo(selected.id)} · ${selected.indent_number}` : 'Indent Help'}>
      {selected && <div className="space-y-4"><div><p className="text-xs text-blue-700">{selected.site_name} · {selected.stage}</p><h4 className="font-semibold text-lg mt-1">{selected.subject}</h4><p className="text-sm text-slate-600 mt-3 whitespace-pre-wrap">{selected.description}</p></div>
        <div className="rounded-lg bg-slate-50 p-3 text-sm space-y-1"><p>Raised by: <b>{selected.raised_by_name}</b></p><p>Assigned to: <b>{selected.assigned_to_name}</b></p><p>Status: <b>{selected.status === 'done' ? 'Done' : 'Open'}</b></p></div>
        {selected.status === 'done' ? <div className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800"><p>Done by {selected.assigned_to_name} · {date(selected.completed_at)}</p>{selected.completion_note && <p className="mt-2 whitespace-pre-wrap">{selected.completion_note}</p>}</div> : selected.assigned_to === user?.id ? <><div><label htmlFor="help-completion" className="label">Completion note <span className="font-normal text-slate-400">(optional)</span></label><textarea id="help-completion" className="input" rows={3} maxLength={2000} value={completionNote} onChange={e => setCompletionNote(e.target.value)} placeholder="Briefly explain what was done." /></div><div className="flex justify-end gap-2"><button className="btn btn-secondary" disabled={saving} onClick={() => setSelected(null)}>Cancel</button><button className="btn btn-primary inline-flex items-center gap-2" disabled={saving} onClick={markDone}><FiCheck />{saving ? 'Saving…' : 'Mark Done'}</button></div></> : <p className="text-sm text-slate-500">Only {selected.assigned_to_name} can mark this Done.</p>}
      </div>}
    </Modal>
  </section>;
}
