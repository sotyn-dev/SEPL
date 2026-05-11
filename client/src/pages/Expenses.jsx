import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiTrash2, FiEdit2, FiRotateCcw } from 'react-icons/fi';

export default function Expenses() {
  const { canDelete } = useAuth();
  const [expenses, setExpenses] = useState([]);
  const [modal, setModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({});

  const load = () => api.get('/hr/expenses').then(r => setExpenses(r.data));
  useEffect(() => { load(); }, []);

  const openNew = () => {
    setEditingId(null);
    setForm({ title: '', description: '', amount: 0, category: '', expense_date: new Date().toISOString().split('T')[0] });
    setModal(true);
  };

  const openEdit = (e) => {
    setEditingId(e.id);
    setForm({ title: e.title || '', description: e.description || '', amount: e.amount || 0, category: e.category || '', expense_date: e.expense_date || '' });
    setModal(true);
  };

  const save = async (e) => {
    e.preventDefault();
    try {
      if (editingId) {
        await api.put(`/hr/expenses/${editingId}`, form);
        toast.success('Expense updated');
      } else {
        await api.post('/hr/expenses', form);
        toast.success('Expense submitted');
      }
      setModal(false); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    }
  };

  const updateStatus = async (id, status) => {
    await api.put(`/hr/expenses/${id}`, { status });
    toast.success(`Expense ${status}`);
    load();
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="font-semibold">Expense Management</h3>
        <button onClick={openNew} className="btn btn-primary flex items-center gap-2"><FiPlus /> Submit Expense</button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {[
          { label: 'Pending', filter: 'pending', color: 'text-amber-600' },
          { label: 'Approved', filter: 'approved', color: 'text-red-600' },
          { label: 'Paid', filter: 'paid', color: 'text-emerald-600' },
          { label: 'Rejected', filter: 'rejected', color: 'text-red-600' },
        ].map(s => (
          <div key={s.filter} className="card text-center">
            <div className={`text-2xl font-bold ${s.color}`}>Rs {expenses.filter(e => e.status === s.filter).reduce((sum, e) => sum + e.amount, 0).toLocaleString()}</div>
            <div className="text-sm text-gray-500">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="card p-0 overflow-x-auto"><table>
        <thead><tr><th>Description</th><th>Category</th><th>Amount</th><th>Date</th><th>Submitted By</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
          {expenses.map(e => (
            <tr key={e.id}>
              <td className="max-w-[340px]">
                <div className="font-medium text-sm">{e.title}</div>
                {e.description && (
                  <div className="text-xs text-gray-600 whitespace-normal break-words leading-snug mt-0.5" title={e.description}>{e.description}</div>
                )}
              </td>
              <td><span className="text-[10px] px-2 py-0.5 rounded font-medium bg-blue-100 text-blue-700">{e.category || '—'}</span></td>
              <td className="font-semibold">Rs {e.amount?.toLocaleString()}</td>
              <td>{e.expense_date}</td>
              <td>{e.submitted_by_name}</td>
              <td><StatusBadge status={e.status} /></td>
              <td>
                <div className="flex gap-1 items-center flex-wrap">
                  {e.status === 'pending' && (
                    <>
                      <button onClick={() => updateStatus(e.id, 'approved')} className="btn btn-success text-xs py-1 px-2">Approve</button>
                      <button onClick={() => updateStatus(e.id, 'rejected')} className="btn btn-danger text-xs py-1 px-2">Reject</button>
                    </>
                  )}
                  {e.status === 'approved' && (
                    <button onClick={() => updateStatus(e.id, 'paid')} className="btn btn-primary text-xs py-1 px-2">Mark Paid</button>
                  )}
                  {/* Reverse a wrongly-applied status. "Un-mark Paid" puts the
                      expense back to Approved (clears paid_date). "Re-open"
                      sends a Rejected expense back to Pending so it can be
                      reconsidered. */}
                  {e.status === 'paid' && (
                    <button onClick={() => {
                      if (!confirm(`Un-mark "${e.title}" as paid? It will go back to Approved.`)) return;
                      updateStatus(e.id, 'approved');
                    }} className="btn btn-secondary text-xs py-1 px-2 flex items-center gap-1" title="Un-mark Paid">
                      <FiRotateCcw size={12} /> Un-mark Paid
                    </button>
                  )}
                  {e.status === 'rejected' && (
                    <button onClick={() => updateStatus(e.id, 'pending')} className="btn btn-secondary text-xs py-1 px-2 flex items-center gap-1" title="Re-open">
                      <FiRotateCcw size={12} /> Re-open
                    </button>
                  )}
                  <button onClick={() => openEdit(e)} className="p-1 text-gray-500 hover:text-red-600" title="Edit"><FiEdit2 size={14} /></button>
                  {canDelete('expenses') && <button onClick={async () => {
                    if (!confirm(`Delete expense "${e.title}"?`)) return;
                    try { await api.delete(`/hr/expenses/${e.id}`); toast.success('Deleted'); load(); }
                    catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                  }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}
                </div>
              </td>
            </tr>
          ))}
          {expenses.length === 0 && <tr><td colSpan="7" className="text-center py-8 text-gray-400">No expenses yet</td></tr>}
        </tbody>
      </table></div>

      <Modal isOpen={modal} onClose={() => setModal(false)} title={editingId ? 'Edit Expense' : 'Submit Expense'}>
        <form onSubmit={save} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="label">Category *</label>
              <select className="select" required value={form.category || ''} onChange={e => setForm({...form, category: e.target.value})}>
                <option value="">— pick category —</option>
                <option value="TRAVEL">Travel</option>
                <option value="SITE EXPENSE">Site Expense</option>
                <option value="SITE PURCHASE">Site Purchase</option>
                <option value="COMPANY EXPENSE">Company Expense</option>
                <option value="ADVANCE AGAINST SALARY">Advance Against Salary</option>
                <option value="ADVANCE PAID TO SITE ENGINEER">Advance Paid to Site Engineer</option>
                <option value="FOOD">Food</option>
                <option value="STATIONERY">Stationery</option>
                <option value="REPAIR & MAINTENANCE">Repair & Maintenance</option>
                <option value="OTHER">Other</option>
              </select>
            </div>
            <div>
              <label className="label">Title <span className="text-gray-400 font-normal text-[10px]">(short subject — e.g. who/where)</span></label>
              <input className="input" value={form.title || ''} onChange={e => setForm({...form, title: e.target.value})} placeholder="e.g. Manga - Cylinder purchase" />
            </div>
          </div>
          <div>
            <label className="label">Description *</label>
            <textarea className="input" rows="3" required value={form.description || ''} onChange={e => setForm({...form, description: e.target.value})} placeholder="Full details — paid to whom, what for, which site, etc." />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div><label className="label">Amount (Rs) *</label><input className="input" type="number" required value={form.amount || 0} onChange={e => setForm({...form, amount: +e.target.value})} /></div>
            <div><label className="label">Date *</label><input className="input" type="date" required value={form.expense_date || ''} onChange={e => setForm({...form, expense_date: e.target.value})} /></div>
          </div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">{editingId ? 'Update' : 'Submit'}</button></div>
        </form>
      </Modal>
    </div>
  );
}
