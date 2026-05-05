import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiTrash2 } from 'react-icons/fi';

export default function Expenses() {
  const { canDelete } = useAuth();
  const [expenses, setExpenses] = useState([]);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({});

  const load = () => api.get('/hr/expenses').then(r => setExpenses(r.data));
  useEffect(() => { load(); }, []);

  const save = async (e) => {
    e.preventDefault();
    await api.post('/hr/expenses', form);
    toast.success('Expense submitted');
    setModal(false); load();
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
        <button onClick={() => { setForm({ title: '', description: '', amount: 0, category: '', expense_date: new Date().toISOString().split('T')[0] }); setModal(true); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Submit Expense</button>
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
        <thead><tr><th>Title</th><th>Description</th><th>Category</th><th>Amount</th><th>Date</th><th>Submitted By</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
          {expenses.map(e => (
            <tr key={e.id}>
              <td className="font-medium">{e.title}</td>
              <td className="text-xs text-gray-600 max-w-[260px]" title={e.description}>
                {e.description ? (
                  <div className="whitespace-normal break-words leading-snug">{e.description}</div>
                ) : <span className="text-gray-300">—</span>}
              </td>
              <td>{e.category}</td>
              <td className="font-semibold">Rs {e.amount?.toLocaleString()}</td>
              <td>{e.expense_date}</td>
              <td>{e.submitted_by_name}</td>
              <td><StatusBadge status={e.status} /></td>
              <td>
                <div className="flex gap-1 items-center">
                  {e.status === 'pending' && (
                    <>
                      <button onClick={() => updateStatus(e.id, 'approved')} className="btn btn-success text-xs py-1 px-2">Approve</button>
                      <button onClick={() => updateStatus(e.id, 'rejected')} className="btn btn-danger text-xs py-1 px-2">Reject</button>
                    </>
                  )}
                  {e.status === 'approved' && <button onClick={() => updateStatus(e.id, 'paid')} className="btn btn-primary text-xs py-1 px-2">Mark Paid</button>}
                  {canDelete('expenses') && <button onClick={async () => {
                    if (!confirm(`Delete expense "${e.title}"?`)) return;
                    try { await api.delete(`/hr/expenses/${e.id}`); toast.success('Deleted'); load(); }
                    catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                  }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}
                </div>
              </td>
            </tr>
          ))}
          {expenses.length === 0 && <tr><td colSpan="8" className="text-center py-8 text-gray-400">No expenses yet</td></tr>}
        </tbody>
      </table></div>

      <Modal isOpen={modal} onClose={() => setModal(false)} title="Submit Expense">
        <form onSubmit={save} className="space-y-4">
          <div><label className="label">Title *</label><input className="input" value={form.title || ''} onChange={e => setForm({...form, title: e.target.value})} required /></div>
          <div><label className="label">Description</label><textarea className="input" rows="2" value={form.description || ''} onChange={e => setForm({...form, description: e.target.value})} /></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            <div><label className="label">Amount (Rs) *</label><input className="input" type="number" value={form.amount || 0} onChange={e => setForm({...form, amount: +e.target.value})} required /></div>
            <div><label className="label">Category</label><input className="input" value={form.category || ''} onChange={e => setForm({...form, category: e.target.value})} placeholder="Travel, Food, etc." /></div>
            <div><label className="label">Date</label><input className="input" type="date" value={form.expense_date || ''} onChange={e => setForm({...form, expense_date: e.target.value})} /></div>
          </div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Submit</button></div>
        </form>
      </Modal>
    </div>
  );
}
