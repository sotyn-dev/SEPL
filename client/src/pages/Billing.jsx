import { useState, useEffect } from 'react';
import api from '../api';
import { useUrlTab } from '../hooks/useUrlTab';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiTrash2, FiDownload } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';

// Stateless pagination bar shared by all 5 tabs — takes a paginate()
// result plus the page/pageSize setters for whichever tab is rendering it.
// Kept at module scope (not defined inside Billing()) so it isn't recreated
// on every render.
function PgBar({ pg, pageSize, setPage, setPageSize }) {
  return (
    <div className="card p-3">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
          <p className="text-xs text-gray-500">
            Showing <span className="font-semibold text-gray-700">{pg.total === 0 ? 0 : pg.from + 1}</span>–<span className="font-semibold text-gray-700">{pg.to}</span> of <span className="font-semibold text-gray-700">{pg.total}</span> records
          </p>
          <label className="flex items-center gap-1.5 text-xs text-gray-500">
            Rows per page:
            <select
              className="select text-xs py-1 px-2 w-auto"
              value={pageSize}
              onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }}
            >
              {[10, 25, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap justify-center sm:justify-end">
          <button
            type="button"
            onClick={() => setPage(pg.curPage - 1)}
            disabled={pg.curPage <= 1}
            className="btn btn-secondary text-xs px-3 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Previous
          </button>
          {pg.pageNumbers.map((n, idx) => {
            const prevN = pg.pageNumbers[idx - 1];
            const gap = prevN != null && n - prevN > 1;
            return (
              <span key={n} className="flex items-center gap-1.5">
                {gap && <span className="text-gray-300 text-xs px-0.5">…</span>}
                <button
                  type="button"
                  onClick={() => setPage(n)}
                  className={`min-w-[30px] px-2.5 py-1.5 rounded-xl text-xs font-semibold transition-all ${
                    n === pg.curPage
                      ? 'bg-gradient-to-r from-blue-800 to-blue-900 text-white shadow-sm shadow-blue-300'
                      : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50 hover:border-gray-300'
                  }`}
                >
                  {n}
                </button>
              </span>
            );
          })}
          <button
            type="button"
            onClick={() => setPage(pg.curPage + 1)}
            disabled={pg.curPage >= pg.totalPages}
            className="btn btn-secondary text-xs px-3 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Billing() {
  const { canDelete } = useAuth();
  const [tab, setTab] = useUrlTab('sales');
  const [salesBills, setSalesBills] = useState([]);
  const [raBills, setRaBills] = useState([]);
  const [mbBills, setMbBills] = useState([]);
  const [instBills, setInstBills] = useState([]);
  const [testing, setTesting] = useState([]);
  const [pos, setPos] = useState([]);
  const [installations, setInstallations] = useState([]);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({});
  // Pagination — one page/pageSize pair per tab, since each is an
  // independent table with its own record set.
  const [salesPage, setSalesPage] = useState(1);
  const [salesPageSize, setSalesPageSize] = useState(10);
  const [raPage, setRaPage] = useState(1);
  const [raPageSize, setRaPageSize] = useState(10);
  const [mbPage, setMbPage] = useState(1);
  const [mbPageSize, setMbPageSize] = useState(10);
  const [instPage, setInstPage] = useState(1);
  const [instPageSize, setInstPageSize] = useState(10);
  const [testingPage, setTestingPage] = useState(1);
  const [testingPageSize, setTestingPageSize] = useState(10);

  const load = () => {
    api.get('/procurement/sales-bills').then(r => setSalesBills(r.data));
    api.get('/installation/ra-bills').then(r => setRaBills(r.data));
    api.get('/installation/mb-bills').then(r => setMbBills(r.data));
    api.get('/installation/inst-bills').then(r => setInstBills(r.data));
    api.get('/installation/testing').then(r => setTesting(r.data));
    api.get('/orders/po').then(r => setPos(r.data));
    api.get('/installation').then(r => setInstallations(r.data));
  };
  useEffect(() => { load(); }, []);

  const saveSalesBill = async (e) => { e.preventDefault(); await api.post('/procurement/sales-bills', form); toast.success('Created'); setModal(false); load(); };
  const saveRaBill = async (e) => { e.preventDefault(); await api.post('/installation/ra-bills', form); toast.success('Created'); setModal(false); load(); };
  const saveMbBill = async (e) => { e.preventDefault(); await api.post('/installation/mb-bills', form); toast.success('Created'); setModal(false); load(); };
  const saveInstBill = async (e) => { e.preventDefault(); await api.post('/installation/inst-bills', form); toast.success('Created'); setModal(false); load(); };
  const saveTest = async (e) => { e.preventDefault(); await api.post('/installation/testing', form); toast.success('Created'); setModal(false); load(); };

  const tabs = [
    { id: 'sales', label: 'Sales Bills' },
    { id: 'ra', label: 'RA Bills' },
    { id: 'mb', label: 'MB Bills' },
    { id: 'inst', label: 'Installation Bills' },
    { id: 'testing', label: 'Testing & Commissioning' },
  ];

  // Client-side pagination — one derivation per tab's table, all following
  // the same shape: total/totalPages/curPage/from/to/pagedRows/pageNumbers.
  const paginate = (rows, page, pageSize) => {
    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const curPage = Math.min(page, totalPages);
    const from = total === 0 ? 0 : (curPage - 1) * pageSize;
    const to = Math.min(from + pageSize, total);
    const pagedRows = rows.slice(from, to);
    const pageNumbers = totalPages <= 7
      ? Array.from({ length: totalPages }, (_, i) => i + 1)
      : [...new Set([1, 2, totalPages - 1, totalPages, curPage - 1, curPage, curPage + 1])]
          .filter(n => n >= 1 && n <= totalPages)
          .sort((a, b) => a - b);
    return { total, totalPages, curPage, from, to, pagedRows, pageNumbers };
  };
  const salesPg = paginate(salesBills, salesPage, salesPageSize);
  const raPg = paginate(raBills, raPage, raPageSize);
  const mbPg = paginate(mbBills, mbPage, mbPageSize);
  const instPg = paginate(instBills, instPage, instPageSize);
  const testingPg = paginate(testing, testingPage, testingPageSize);

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap items-center justify-between">
        <div className="flex gap-2 flex-wrap">{tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`btn ${tab === t.id ? 'btn-primary' : 'btn-secondary'}`}>{t.label}</button>
        ))}</div>
        <button onClick={() => {
          if (tab === 'sales')   exportCsv('sales-bills',   ['Bill No','PO','Date','Amount','GST','Total','Payment'], salesBills.map(b => [b.bill_number, b.po_number, b.bill_date, b.amount, b.gst_amount, b.total_amount, b.payment_status]));
          if (tab === 'ra')      exportCsv('ra-bills',      ['Bill No','Date','Work Done','Previous','Current','Status'], raBills.map(b => [b.bill_number, b.bill_date, b.work_done_amount, b.previous_amount, b.current_amount, b.status]));
          if (tab === 'mb')      exportCsv('mb-bills',      ['Bill No','Amount','Status'], mbBills.map(b => [b.bill_number, b.total_amount, b.status]));
          if (tab === 'inst')    exportCsv('inst-bills',    ['Bill No','Amount','Payment'], instBills.map(b => [b.bill_number, b.amount, b.payment_status]));
          if (tab === 'testing') exportCsv('testing',       ['Date','Type','Result','Tested By','Notes'], testing.map(t => [t.test_date, t.test_type, t.result, t.tested_by_name, t.notes]));
        }} className="btn btn-secondary flex items-center gap-2 text-sm"><FiDownload /> Export Excel</button>
      </div>

      {tab === 'sales' && (
        <>
          <div className="flex justify-between items-center">
            <h3 className="font-semibold">Sales Bills (to Client)</h3>
            <button onClick={() => { setForm({ po_id: '', bill_date: '', amount: 0, gst_amount: 0, total_amount: 0 }); setModal('sales'); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Create Bill</button>
          </div>
          <div className="card p-0"><table className="freeze-head">
            <thead><tr><th>Bill No</th><th>PO</th><th>Date</th><th>Amount</th><th>GST</th><th>Total</th><th>Payment</th><th>Actions</th></tr></thead>
            <tbody>
              {salesPg.pagedRows.map(b => (<tr key={b.id}><td className="font-medium">{b.bill_number}</td><td>{b.po_number}</td><td>{b.bill_date}</td><td>Rs {b.amount?.toLocaleString()}</td><td>Rs {b.gst_amount?.toLocaleString()}</td><td className="font-semibold">Rs {b.total_amount?.toLocaleString()}</td><td><StatusBadge status={b.payment_status} /></td><td>{(canDelete('billing') || canDelete('procurement')) && <button onClick={async () => {
                if (!confirm(`Delete sales bill "${b.bill_number}"?`)) return;
                try { await api.delete(`/procurement/sales-bills/${b.id}`); toast.success('Deleted'); load(); }
                catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
              }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}</td></tr>))}
              {salesBills.length === 0 && <tr><td colSpan="8" className="text-center py-8 text-gray-400">No sales bills</td></tr>}
            </tbody>
          </table></div>
          <PgBar pg={salesPg} pageSize={salesPageSize} setPage={setSalesPage} setPageSize={setSalesPageSize} />
        </>
      )}

      {tab === 'ra' && (
        <>
          <div className="flex justify-between items-center">
            <h3 className="font-semibold">RA Bills (Running Account)</h3>
            <button onClick={() => { setForm({ installation_id: '', bill_number: '', bill_date: '', work_done_amount: 0, previous_amount: 0, current_amount: 0 }); setModal('ra'); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Create RA Bill</button>
          </div>
          <div className="card p-0"><table className="freeze-head">
            <thead><tr><th>Bill No</th><th>Date</th><th>Work Done</th><th>Previous</th><th>Current</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {raPg.pagedRows.map(b => (<tr key={b.id}><td className="font-medium">{b.bill_number}</td><td>{b.bill_date}</td><td>Rs {b.work_done_amount?.toLocaleString()}</td><td>Rs {b.previous_amount?.toLocaleString()}</td><td className="font-semibold">Rs {b.current_amount?.toLocaleString()}</td><td><StatusBadge status={b.status} /></td><td>{(canDelete('billing') || canDelete('installation')) && <button onClick={async () => {
                if (!confirm(`Delete RA bill "${b.bill_number}"?`)) return;
                try { await api.delete(`/installation/ra-bills/${b.id}`); toast.success('Deleted'); load(); }
                catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
              }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}</td></tr>))}
              {raBills.length === 0 && <tr><td colSpan="7" className="text-center py-8 text-gray-400">No RA bills</td></tr>}
            </tbody>
          </table></div>
          <PgBar pg={raPg} pageSize={raPageSize} setPage={setRaPage} setPageSize={setRaPageSize} />
        </>
      )}

      {tab === 'mb' && (
        <>
          <div className="flex justify-between items-center">
            <h3 className="font-semibold">MB Bills (Measurement Book)</h3>
            <button onClick={() => { setForm({ installation_id: '', bill_number: '', measurements: '', total_amount: 0 }); setModal('mb'); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Create MB Bill</button>
          </div>
          <div className="card p-0"><table className="freeze-head">
            <thead><tr><th>Bill No</th><th>Amount</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {mbPg.pagedRows.map(b => (<tr key={b.id}><td className="font-medium">{b.bill_number}</td><td className="font-semibold">Rs {b.total_amount?.toLocaleString()}</td><td><StatusBadge status={b.status} /></td><td>{(canDelete('billing') || canDelete('installation')) && <button onClick={async () => {
                if (!confirm(`Delete MB bill "${b.bill_number}"?`)) return;
                try { await api.delete(`/installation/mb-bills/${b.id}`); toast.success('Deleted'); load(); }
                catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
              }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}</td></tr>))}
              {mbBills.length === 0 && <tr><td colSpan="4" className="text-center py-8 text-gray-400">No MB bills</td></tr>}
            </tbody>
          </table></div>
          <PgBar pg={mbPg} pageSize={mbPageSize} setPage={setMbPage} setPageSize={setMbPageSize} />
        </>
      )}

      {tab === 'inst' && (
        <>
          <div className="flex justify-between items-center">
            <h3 className="font-semibold">Installation Bills</h3>
            <button onClick={() => { setForm({ installation_id: '', bill_number: '', amount: 0 }); setModal('inst'); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Create Bill</button>
          </div>
          <div className="card p-0"><table className="freeze-head">
            <thead><tr><th>Bill No</th><th>Amount</th><th>Payment</th><th>Actions</th></tr></thead>
            <tbody>
              {instPg.pagedRows.map(b => (<tr key={b.id}><td className="font-medium">{b.bill_number}</td><td className="font-semibold">Rs {b.amount?.toLocaleString()}</td><td><StatusBadge status={b.payment_status} /></td><td>{(canDelete('billing') || canDelete('installation')) && <button onClick={async () => {
                if (!confirm(`Delete installation bill "${b.bill_number}"?`)) return;
                try { await api.delete(`/installation/inst-bills/${b.id}`); toast.success('Deleted'); load(); }
                catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
              }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}</td></tr>))}
              {instBills.length === 0 && <tr><td colSpan="4" className="text-center py-8 text-gray-400">No installation bills</td></tr>}
            </tbody>
          </table></div>
          <PgBar pg={instPg} pageSize={instPageSize} setPage={setInstPage} setPageSize={setInstPageSize} />
        </>
      )}

      {tab === 'testing' && (
        <>
          <div className="flex justify-between items-center">
            <h3 className="font-semibold">Testing & Commissioning</h3>
            <button onClick={() => { setForm({ installation_id: '', test_date: '', test_type: '', result: 'pass', notes: '' }); setModal('test'); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Add Test</button>
          </div>
          <div className="card p-0"><table className="freeze-head">
            <thead><tr><th>Date</th><th>Type</th><th>Result</th><th>Tested By</th><th>Notes</th><th>Actions</th></tr></thead>
            <tbody>
              {testingPg.pagedRows.map(t => (<tr key={t.id}><td>{t.test_date}</td><td>{t.test_type}</td><td><StatusBadge status={t.result} /></td><td>{t.tested_by_name}</td><td className="max-w-xs truncate">{t.notes}</td><td>{(canDelete('billing') || canDelete('installation')) && <button onClick={async () => {
                if (!confirm(`Delete test record "${t.test_type}"?`)) return;
                try { await api.delete(`/installation/testing/${t.id}`); toast.success('Deleted'); load(); }
                catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
              }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}</td></tr>))}
              {testing.length === 0 && <tr><td colSpan="6" className="text-center py-8 text-gray-400">No tests yet</td></tr>}
            </tbody>
          </table></div>
          <PgBar pg={testingPg} pageSize={testingPageSize} setPage={setTestingPage} setPageSize={setTestingPageSize} />
        </>
      )}

      {/* Modals */}
      <Modal isOpen={modal === 'sales'} onClose={() => setModal(false)} title="Create Sales Bill">
        <form onSubmit={saveSalesBill} className="space-y-4">
          <div><label className="label">Purchase Order</label><select className="select" value={form.po_id} onChange={e => setForm({...form, po_id: e.target.value})}><option value="">Select</option>{pos.map(p => <option key={p.id} value={p.id}>{p.po_number}</option>)}</select></div>
          <div><label className="label">Bill Date</label><input className="input" type="date" value={form.bill_date} onChange={e => setForm({...form, bill_date: e.target.value})} /></div>
          <div className="grid grid-cols-3 gap-4">
            <div><label className="label">Amount</label><input className="input" type="number" value={form.amount} onChange={e => setForm({...form, amount: +e.target.value, total_amount: +e.target.value + (form.gst_amount||0)})} /></div>
            <div><label className="label">GST</label><input className="input" type="number" value={form.gst_amount} onChange={e => setForm({...form, gst_amount: +e.target.value, total_amount: (form.amount||0) + +e.target.value})} /></div>
            <div><label className="label">Total</label><input className="input" type="number" value={form.total_amount} readOnly /></div>
          </div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Create</button></div>
        </form>
      </Modal>

      <Modal isOpen={modal === 'ra'} onClose={() => setModal(false)} title="Create RA Bill">
        <form onSubmit={saveRaBill} className="space-y-4">
          <div><label className="label">Installation</label><select className="select" value={form.installation_id} onChange={e => setForm({...form, installation_id: e.target.value})}><option value="">Select</option>{installations.map(i => <option key={i.id} value={i.id}>#{i.id} - {i.site_address}</option>)}</select></div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="label">Bill Number</label><input className="input" value={form.bill_number} onChange={e => setForm({...form, bill_number: e.target.value})} /></div>
            <div><label className="label">Bill Date</label><input className="input" type="date" value={form.bill_date} onChange={e => setForm({...form, bill_date: e.target.value})} /></div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div><label className="label">Work Done</label><input className="input" type="number" value={form.work_done_amount} onChange={e => setForm({...form, work_done_amount: +e.target.value, current_amount: +e.target.value - (form.previous_amount||0)})} /></div>
            <div><label className="label">Previous</label><input className="input" type="number" value={form.previous_amount} onChange={e => setForm({...form, previous_amount: +e.target.value, current_amount: (form.work_done_amount||0) - +e.target.value})} /></div>
            <div><label className="label">Current</label><input className="input" type="number" value={form.current_amount} readOnly /></div>
          </div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Create</button></div>
        </form>
      </Modal>

      <Modal isOpen={modal === 'mb'} onClose={() => setModal(false)} title="Create MB Bill">
        <form onSubmit={saveMbBill} className="space-y-4">
          <div><label className="label">Installation</label><select className="select" value={form.installation_id} onChange={e => setForm({...form, installation_id: e.target.value})}><option value="">Select</option>{installations.map(i => <option key={i.id} value={i.id}>#{i.id} - {i.site_address}</option>)}</select></div>
          <div><label className="label">Bill Number</label><input className="input" value={form.bill_number} onChange={e => setForm({...form, bill_number: e.target.value})} /></div>
          <div><label className="label">Measurements</label><textarea className="input" rows="3" value={form.measurements} onChange={e => setForm({...form, measurements: e.target.value})} /></div>
          <div><label className="label">Total Amount</label><input className="input" type="number" value={form.total_amount} onChange={e => setForm({...form, total_amount: +e.target.value})} /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Create</button></div>
        </form>
      </Modal>

      <Modal isOpen={modal === 'inst'} onClose={() => setModal(false)} title="Create Installation Bill">
        <form onSubmit={saveInstBill} className="space-y-4">
          <div><label className="label">Installation</label><select className="select" value={form.installation_id} onChange={e => setForm({...form, installation_id: e.target.value})}><option value="">Select</option>{installations.map(i => <option key={i.id} value={i.id}>#{i.id} - {i.site_address}</option>)}</select></div>
          <div><label className="label">Bill Number</label><input className="input" value={form.bill_number} onChange={e => setForm({...form, bill_number: e.target.value})} /></div>
          <div><label className="label">Amount</label><input className="input" type="number" value={form.amount} onChange={e => setForm({...form, amount: +e.target.value})} /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Create</button></div>
        </form>
      </Modal>

      <Modal isOpen={modal === 'test'} onClose={() => setModal(false)} title="Add Test Record">
        <form onSubmit={saveTest} className="space-y-4">
          <div><label className="label">Installation</label><select className="select" value={form.installation_id} onChange={e => setForm({...form, installation_id: e.target.value})}><option value="">Select</option>{installations.map(i => <option key={i.id} value={i.id}>#{i.id} - {i.site_address}</option>)}</select></div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="label">Test Date</label><input className="input" type="date" value={form.test_date} onChange={e => setForm({...form, test_date: e.target.value})} /></div>
            <div><label className="label">Test Type</label><input className="input" value={form.test_type} onChange={e => setForm({...form, test_type: e.target.value})} /></div>
          </div>
          <div><label className="label">Result</label><select className="select" value={form.result} onChange={e => setForm({...form, result: e.target.value})}><option value="pass">Pass</option><option value="fail">Fail</option><option value="partial">Partial</option></select></div>
          <div><label className="label">Notes</label><textarea className="input" rows="3" value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Save</button></div>
        </form>
      </Modal>
    </div>
  );
}
