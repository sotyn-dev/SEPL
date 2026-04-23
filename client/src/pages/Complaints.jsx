import { useEffect, useState } from 'react';
import api from '../api';
import { FiPlus, FiEye, FiSearch, FiAlertCircle, FiClock, FiCheckCircle, FiList } from 'react-icons/fi';

// Matches mam's "Complaint Register Form 24-25" Google Form. Categories are
// the SEPL service lines; Customer Type is Old Site / Running Site (not
// New/Existing); Complaint Type is Paid / Free. State + Remarks are new.
const CATEGORY_OPTIONS = ['Fire Fighting', 'Electrical', 'Low Voltage', 'HVAC', 'MEPF', 'Solar', 'Plumbing', 'Other'];
const CUSTOMER_TYPES = ['Old Site', 'Running Site'];
const COMPLAINT_TYPES = ['Paid', 'Free'];

const emptyForm = {
  client_name:'', company_name:'', mobile_number:'', category:'', state:'',
  problem_detail:'', customer_type:'Running Site', complaint_type:'Free',
  emp_name:'', remarks:'',
  step1_planned_date:'', step1_actual_date:'', step1_assigned_to:'',
  step2_planned_date:'', step2_actual_date:'', step2_assigned_to:'',
  service_report:'', status:'open', priority:'normal'
};

// Tab-based workflow — same design pattern as Indent to Dispatch.
// Each tab filters the list by stage so users focus on one workflow step.
const TABS = [
  { id: 'all', label: 'All Complaints' },
  { id: 'register', label: '+ Register New' },
  { id: 'step1', label: 'Step 1 — Assign' },
  { id: 'step2', label: 'Step 2 — Resolve' },
  { id: 'resolved', label: 'Resolved' },
];

export default function Complaints() {
  const [list, setList] = useState([]);
  const [stats, setStats] = useState({ total:0, open:0, inProgress:0, resolved:0, byCategory:[] });
  const [q, setQ] = useState({ search:'', status:'', category:'' });
  const [tab, setTab] = useState('all');
  const [showAdd, setShowAdd] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [form, setForm] = useState(emptyForm);

  const load = async () => {
    const params = new URLSearchParams(Object.entries(q).filter(([,v]) => v)).toString();
    const [l, s] = await Promise.all([
      api.get('/complaints' + (params ? '?'+params : '')),
      api.get('/complaints/stats'),
    ]);
    setList(l.data);
    setStats(s.data);
  };

  useEffect(() => { load(); }, [q]);

  const create = async (e) => {
    e.preventDefault();
    await api.post('/complaints', form);
    setShowAdd(false);
    setTab('step1'); // jump to "Step 1 — Assign" tab so CRM can immediately assign the new complaint
    setForm(emptyForm);
    load();
  };

  const save = async () => {
    await api.put(`/complaints/${viewing.id}`, viewing);
    setViewing(null);
    load();
  };

  const badge = (s) => ({
    open: 'bg-yellow-100 text-yellow-700',
    in_progress: 'bg-red-100 text-red-700',
    resolved: 'bg-green-100 text-green-700',
  }[s] || 'bg-gray-100 text-gray-700');

  // Tab-based filter — subset of the full list for each tab
  const visibleList = (() => {
    if (tab === 'step1') return list.filter(c => c.status === 'open' && !c.step1_assigned_to);
    if (tab === 'step2') return list.filter(c => (c.status === 'open' || c.status === 'in_progress') && c.step1_assigned_to && !c.service_report);
    if (tab === 'resolved') return list.filter(c => c.status === 'resolved' || c.status === 'closed');
    return list;
  })();
  const tabCount = (id) => {
    if (id === 'step1') return list.filter(c => c.status === 'open' && !c.step1_assigned_to).length;
    if (id === 'step2') return list.filter(c => (c.status === 'open' || c.status === 'in_progress') && c.step1_assigned_to && !c.service_report).length;
    if (id === 'resolved') return list.filter(c => c.status === 'resolved' || c.status === 'closed').length;
    if (id === 'all') return list.length;
    return null;
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <h1 className="text-xl font-bold text-gray-800">Complaint Register</h1>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={<FiList />} label="Total" value={stats.total} color="slate" />
        <StatCard icon={<FiAlertCircle />} label="Open" value={stats.open} color="yellow" />
        <StatCard icon={<FiClock />} label="In Progress" value={stats.inProgress} color="blue" />
        <StatCard icon={<FiCheckCircle />} label="Resolved" value={stats.resolved} color="green" />
      </div>

      {/* Tabs — same design as Indent to Dispatch. Each tab is a workflow
          stage; count badge shows how many rows that tab contains. */}
      <div className="flex flex-wrap gap-2">
        {TABS.map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); if (t.id === 'register') setShowAdd(true); }}
            className={`px-4 py-2 rounded-lg font-semibold text-sm border transition-all ${tab === t.id && t.id !== 'register' ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
            {t.label}
            {tabCount(t.id) !== null && <span className={`ml-2 text-xs ${tab === t.id && t.id !== 'register' ? 'opacity-90' : 'text-gray-400'}`}>({tabCount(t.id)})</span>}
          </button>
        ))}
      </div>

      {/* Search / status / category — shown on every tab except the register
          tab (which opens the create modal directly). */}
      {tab !== 'register' && (
      <div className="bg-white rounded-xl p-3 flex flex-wrap gap-2 border">
        <div className="relative flex-1 min-w-[200px]">
          <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input placeholder="Search client / mobile / number / company" value={q.search}
            onChange={e => setQ({ ...q, search: e.target.value })}
            className="w-full pl-9 pr-3 py-2 border rounded-lg text-sm" />
        </div>
        {tab === 'all' && (
          <>
            <select value={q.status} onChange={e => setQ({ ...q, status: e.target.value })} className="border rounded-lg px-3 py-2 text-sm">
              <option value="">All Statuses</option>
              <option value="open">Open</option>
              <option value="in_progress">In Progress</option>
              <option value="resolved">Resolved</option>
            </select>
            <select value={q.category} onChange={e => setQ({ ...q, category: e.target.value })} className="border rounded-lg px-3 py-2 text-sm">
              <option value="">All Categories</option>
              {CATEGORY_OPTIONS.map(c => <option key={c}>{c}</option>)}
            </select>
          </>
        )}
      </div>
      )}

      {/* Per-tab intro banner explaining what this stage means */}
      {tab === 'step1' && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
          <b>Step 1 — Assign:</b> CRM assigns these complaints to the right technical team (LV / Electrical / Fire Fighting etc.) within 1 day. Click a row to open and set the assignee + planned date.
        </div>
      )}
      {tab === 'step2' && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-800">
          <b>Step 2 — Resolve:</b> Assigned person visits / calls the client, resolves the issue, and uploads a service report within 3 days. Click a row to open and submit resolution.
        </div>
      )}
      {tab === 'resolved' && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs text-emerald-800">
          <b>Resolved:</b> Complaints that have been fully closed with a service report.
        </div>
      )}

      <div className="bg-white rounded-xl border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 text-xs uppercase">
            <tr>
              <th className="text-left px-3 py-2">Complaint #</th>
              <th className="text-left px-3 py-2">Client</th>
              <th className="text-left px-3 py-2">Mobile</th>
              <th className="text-left px-3 py-2">Category</th>
              <th className="text-left px-3 py-2">Type</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">S1 Delay</th>
              <th className="text-left px-3 py-2">S2 Delay</th>
              <th className="text-left px-3 py-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {visibleList.map(c => (
              <tr key={c.id} className="border-t hover:bg-slate-50">
                <td className="px-3 py-2 font-mono text-xs">{c.complaint_number}</td>
                <td className="px-3 py-2">{c.client_name}<div className="text-xs text-gray-500">{c.company_name}</div></td>
                <td className="px-3 py-2">{c.mobile_number}</td>
                <td className="px-3 py-2">{c.category}</td>
                <td className="px-3 py-2">{c.complaint_type}</td>
                <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded text-xs ${badge(c.status)}`}>{c.status}</span></td>
                <td className="px-3 py-2">{c.step1_time_delay ?? '-'} d</td>
                <td className="px-3 py-2">{c.step2_time_delay ?? '-'} d</td>
                <td className="px-3 py-2">
                  <button onClick={() => setViewing({ ...c })} className="text-red-600 hover:text-red-800"><FiEye /></button>
                </td>
              </tr>
            ))}
            {visibleList.length === 0 && <tr><td colSpan="9" className="text-center text-gray-400 py-8">
              {tab === 'step1' ? 'No complaints waiting for assignment — all set!'
                : tab === 'step2' ? 'No complaints in resolution — team is caught up.'
                : tab === 'resolved' ? 'No resolved complaints yet.'
                : 'No complaints found.'}
            </td></tr>}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <Modal onClose={() => { setShowAdd(false); setTab('all'); }} title="Complaint Register Form">
          <form onSubmit={create} className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Client Name *"><input required value={form.client_name} onChange={e=>setForm({...form, client_name:e.target.value})} className="inp" /></Field>
            <Field label="Company Name *"><input required value={form.company_name} onChange={e=>setForm({...form, company_name:e.target.value})} className="inp" /></Field>
            <Field label="Mobile Number *"><input required value={form.mobile_number} onChange={e=>setForm({...form, mobile_number:e.target.value})} className="inp" /></Field>
            <Field label="Category *">
              <select required value={form.category} onChange={e=>setForm({...form, category:e.target.value})} className="inp">
                <option value="">Select</option>
                {CATEGORY_OPTIONS.map(c => <option key={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="State *"><input required value={form.state} onChange={e=>setForm({...form, state:e.target.value})} className="inp" placeholder="e.g. Maharashtra" /></Field>
            <Field label="EMP Name"><input value={form.emp_name} onChange={e=>setForm({...form, emp_name:e.target.value})} className="inp" placeholder="Who received the complaint" /></Field>
            <Field label="Complaint Type *">
              <div className="flex gap-2">
                {COMPLAINT_TYPES.map(t => (
                  <label key={t} className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 border rounded text-sm cursor-pointer ${form.complaint_type===t?'border-red-500 bg-red-50 text-red-700 font-bold':'border-gray-200 hover:bg-gray-50'}`}>
                    <input type="radio" name="complaint_type" value={t} checked={form.complaint_type===t} onChange={()=>setForm({...form, complaint_type:t})} />
                    {t}
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Customer Type *">
              <div className="flex gap-2">
                {CUSTOMER_TYPES.map(t => (
                  <label key={t} className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 border rounded text-sm cursor-pointer ${form.customer_type===t?'border-red-500 bg-red-50 text-red-700 font-bold':'border-gray-200 hover:bg-gray-50'}`}>
                    <input type="radio" name="customer_type" value={t} checked={form.customer_type===t} onChange={()=>setForm({...form, customer_type:t})} />
                    {t}
                  </label>
                ))}
              </div>
            </Field>
            <div className="md:col-span-2">
              <Field label="Problem Detail *"><textarea required rows="3" value={form.problem_detail} onChange={e=>setForm({...form, problem_detail:e.target.value})} className="inp" placeholder="Describe the issue in detail" /></Field>
            </div>
            <div className="md:col-span-2">
              <Field label="Remarks"><textarea rows="2" value={form.remarks} onChange={e=>setForm({...form, remarks:e.target.value})} className="inp" placeholder="Any additional notes" /></Field>
            </div>
            <div className="md:col-span-2 flex justify-end gap-2">
              <button type="button" onClick={()=>{ setShowAdd(false); setTab('all'); }} className="px-4 py-2 border rounded-lg text-sm">Cancel</button>
              <button className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm">Register Complaint</button>
            </div>
          </form>
        </Modal>
      )}

      {viewing && (
        <Modal onClose={() => setViewing(null)} title={`Complaint ${viewing.complaint_number}`}>
          <div className="space-y-5">
            <Section title="Step 1 – Complaint Register">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label="Client"><input value={viewing.client_name||''} onChange={e=>setViewing({...viewing, client_name:e.target.value})} className="inp" /></Field>
                <Field label="Company"><input value={viewing.company_name||''} onChange={e=>setViewing({...viewing, company_name:e.target.value})} className="inp" /></Field>
                <Field label="Mobile"><input value={viewing.mobile_number||''} onChange={e=>setViewing({...viewing, mobile_number:e.target.value})} className="inp" /></Field>
                <Field label="Category"><input value={viewing.category||''} onChange={e=>setViewing({...viewing, category:e.target.value})} className="inp" /></Field>
                <Field label="Customer Type"><input value={viewing.customer_type||''} onChange={e=>setViewing({...viewing, customer_type:e.target.value})} className="inp" /></Field>
                <Field label="Complaint Type"><input value={viewing.complaint_type||''} onChange={e=>setViewing({...viewing, complaint_type:e.target.value})} className="inp" /></Field>
                <Field label="EMP Name"><input value={viewing.emp_name||''} onChange={e=>setViewing({...viewing, emp_name:e.target.value})} className="inp" /></Field>
                <Field label="Assigned To"><input value={viewing.step1_assigned_to||''} onChange={e=>setViewing({...viewing, step1_assigned_to:e.target.value})} className="inp" /></Field>
                <Field label="Planned Date"><input type="date" value={viewing.step1_planned_date||''} onChange={e=>setViewing({...viewing, step1_planned_date:e.target.value})} className="inp" /></Field>
                <Field label="Actual Date"><input type="date" value={viewing.step1_actual_date||''} onChange={e=>setViewing({...viewing, step1_actual_date:e.target.value})} className="inp" /></Field>
                <Field label="Time Delay (auto)"><input disabled value={`${viewing.step1_time_delay ?? 0} day(s)`} className="inp bg-slate-50" /></Field>
                <div className="md:col-span-2"><Field label="Problem Detail"><textarea rows="2" value={viewing.problem_detail||''} onChange={e=>setViewing({...viewing, problem_detail:e.target.value})} className="inp" /></Field></div>
              </div>
            </Section>

            <Section title="Step 2 – Complaint Resolved">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label="Planned Date"><input type="date" value={viewing.step2_planned_date||''} onChange={e=>setViewing({...viewing, step2_planned_date:e.target.value})} className="inp" /></Field>
                <Field label="Actual Date"><input type="date" value={viewing.step2_actual_date||''} onChange={e=>setViewing({...viewing, step2_actual_date:e.target.value})} className="inp" /></Field>
                <Field label="Time Delay (auto)"><input disabled value={`${viewing.step2_time_delay ?? 0} day(s)`} className="inp bg-slate-50" /></Field>
                <Field label="Assigned To"><input value={viewing.step2_assigned_to||''} onChange={e=>setViewing({...viewing, step2_assigned_to:e.target.value})} className="inp" /></Field>
                <Field label="Status">
                  <select value={viewing.status||'open'} onChange={e=>setViewing({...viewing, status:e.target.value})} className="inp">
                    <option value="open">Open</option><option value="in_progress">In Progress</option><option value="resolved">Resolved</option>
                  </select>
                </Field>
                <div className="md:col-span-2"><Field label="Service Report"><textarea rows="3" value={viewing.service_report||''} onChange={e=>setViewing({...viewing, service_report:e.target.value})} className="inp" /></Field></div>
              </div>
            </Section>

            <div className="flex justify-end gap-2">
              <button onClick={() => setViewing(null)} className="px-4 py-2 border rounded-lg text-sm">Close</button>
              <button onClick={save} className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm">Save</button>
            </div>
          </div>
        </Modal>
      )}

      <style>{`.inp{width:100%;border:1px solid #e5e7eb;border-radius:0.5rem;padding:0.5rem 0.75rem;font-size:0.875rem}`}</style>
    </div>
  );
}

function StatCard({ icon, label, value, color }) {
  const map = { slate:'text-slate-600 bg-slate-100', yellow:'text-yellow-600 bg-yellow-100', blue:'text-red-600 bg-red-100', green:'text-green-600 bg-green-100' };
  return (
    <div className="bg-white rounded-xl p-4 border flex items-center gap-3">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${map[color]}`}>{icon}</div>
      <div>
        <div className="text-xs text-gray-500">{label}</div>
        <div className="text-xl font-bold text-gray-800">{value}</div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (<div><label className="text-xs font-semibold text-gray-600 block mb-1">{label}</label>{children}</div>);
}

function Section({ title, children }) {
  return (
    <div className="border rounded-xl p-4">
      <div className="text-sm font-bold text-gray-700 mb-3 pb-2 border-b">{title}</div>
      {children}
    </div>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center px-5 py-3 border-b sticky top-0 bg-white">
          <div className="font-bold text-gray-800">{title}</div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">✕</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}