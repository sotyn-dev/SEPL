// Room Rental management — track rented properties (staff
// accommodation), rooms within them, who's currently occupying which
// room, and monthly rent payments to each landlord. Dashboard surfaces
// monthly burn, occupancy, expiring agreements.

import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiHome, FiPlus, FiEdit2, FiTrash2, FiSearch, FiAlertCircle, FiUserCheck, FiLogOut, FiCalendar, FiUsers, FiDollarSign } from 'react-icons/fi';
import { LuIndianRupee } from 'react-icons/lu';

const STATUS_PILL = {
  active: 'bg-emerald-100 text-emerald-700',
  expired: 'bg-amber-100 text-amber-700',
  terminated: 'bg-red-100 text-red-700',
  available: 'bg-emerald-100 text-emerald-700',
  occupied: 'bg-blue-100 text-blue-700',
  maintenance: 'bg-amber-100 text-amber-700',
  reserved: 'bg-purple-100 text-purple-700',
  completed: 'bg-gray-200 text-gray-600',
  cancelled: 'bg-red-100 text-red-700',
};

const fmtRs = (n) => `Rs ${(Math.round(n || 0)).toLocaleString('en-IN')}`;
const monthNow = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export default function Rentals() {
  const { canCreate, canEdit, canDelete, isAdmin } = useAuth();
  const [tab, setTab] = useState('dashboard');
  const [stats, setStats] = useState(null);
  const [properties, setProperties] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [payments, setPayments] = useState([]);
  const [users, setUsers] = useState([]);
  const [sites, setSites] = useState([]);
  const [filters, setFilters] = useState({ status: '', search: '', city: '' });
  const [propModal, setPropModal] = useState(null);
  const [propForm, setPropForm] = useState({});
  const [propDetail, setPropDetail] = useState(null);
  const [bookingModal, setBookingModal] = useState(false);
  const [bookingForm, setBookingForm] = useState({});
  const [paymentModal, setPaymentModal] = useState(false);
  const [paymentForm, setPaymentForm] = useState({ period_month: monthNow(), paid_via: 'Bank' });
  const [roomModal, setRoomModal] = useState(false);
  const [roomForm, setRoomForm] = useState({});

  const loadStats = () => api.get('/rentals/stats').then(r => setStats(r.data)).catch(() => {});
  const loadProperties = useCallback(() => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => v && params.set(k, v));
    api.get(`/rentals/properties?${params}`).then(r => setProperties(r.data)).catch(() => {});
  }, [filters]);
  const loadBookings = () => api.get('/rentals/bookings').then(r => setBookings(r.data)).catch(() => {});
  const loadPayments = () => api.get('/rentals/payments').then(r => setPayments(r.data)).catch(() => {});

  useEffect(() => {
    loadStats();
    api.get('/auth/users').then(r => setUsers((r.data || []).filter(u => u.active !== 0))).catch(() => {});
    api.get('/dpr/sites?all=1').then(r => setSites(r.data)).catch(() => {});
  }, []);

  useEffect(() => {
    if (tab === 'properties') loadProperties();
    if (tab === 'bookings') loadBookings();
    if (tab === 'payments') loadPayments();
  }, [tab, loadProperties]);

  const saveProp = async (e) => {
    e.preventDefault();
    try {
      if (propForm.id) {
        await api.put(`/rentals/properties/${propForm.id}`, propForm);
        toast.success('Updated');
      } else {
        await api.post('/rentals/properties', propForm);
        toast.success('Property added');
      }
      setPropModal(null); setPropForm({});
      loadProperties(); loadStats();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const delProp = async (p) => {
    if (!confirm(`Delete "${p.name}" and all its rooms / bookings / payments?`)) return;
    try { await api.delete(`/rentals/properties/${p.id}`); toast.success('Deleted'); loadProperties(); loadStats(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const openDetail = async (p) => {
    try { const r = await api.get(`/rentals/properties/${p.id}`); setPropDetail(r.data); }
    catch (err) { toast.error('Failed'); }
  };
  const reloadDetail = () => { if (propDetail) openDetail(propDetail); };

  const addRoom = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/rentals/properties/${propDetail.id}/rooms`, roomForm);
      toast.success('Room added');
      setRoomModal(false); setRoomForm({});
      reloadDetail();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const saveBooking = async (e) => {
    e.preventDefault();
    try {
      await api.post('/rentals/bookings', bookingForm);
      toast.success('Booked');
      setBookingModal(false); setBookingForm({});
      loadStats(); loadBookings(); reloadDetail();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const checkOut = async (b) => {
    if (!confirm(`Check out ${b.occupant_name || b.occupant_user_name || 'this occupant'}?`)) return;
    try {
      await api.post(`/rentals/bookings/${b.id}/check-out`, {});
      toast.success('Checked out');
      loadStats(); loadBookings(); reloadDetail();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const savePayment = async (e) => {
    e.preventDefault();
    try {
      await api.post('/rentals/payments', paymentForm);
      toast.success('Payment recorded');
      setPaymentModal(false); setPaymentForm({ period_month: monthNow(), paid_via: 'Bank' });
      loadPayments(); reloadDetail();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><FiHome className="text-orange-600" /> Room Rentals</h1>
          <p className="text-sm text-gray-500">Staff accommodation — properties, rooms, bookings, monthly rent payments.</p>
        </div>
        {canCreate('rentals') && tab === 'properties' && (
          <button onClick={() => { setPropForm({ status: 'active', bedrooms: 1, total_capacity: 1 }); setPropModal('add'); }} className="btn btn-primary flex items-center gap-1"><FiPlus size={14} /> Add Property</button>
        )}
        {canCreate('rentals') && tab === 'bookings' && (
          <button onClick={() => { setBookingForm({ check_in_date: new Date().toISOString().slice(0, 10) }); setBookingModal(true); }} className="btn btn-primary flex items-center gap-1"><FiPlus size={14} /> New Booking</button>
        )}
        {canCreate('rentals') && tab === 'payments' && (
          <button onClick={() => { setPaymentForm({ period_month: monthNow(), paid_via: 'Bank' }); setPaymentModal(true); }} className="btn btn-primary flex items-center gap-1"><FiPlus size={14} /> Record Payment</button>
        )}
      </div>

      <div className="flex gap-2 flex-wrap text-sm">
        {['dashboard', 'properties', 'bookings', 'payments'].map(t => (
          <button key={t} onClick={() => setTab(t)} className={`btn ${tab === t ? 'btn-primary' : 'btn-secondary'}`}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* DASHBOARD */}
      {tab === 'dashboard' && stats && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="card p-4 border-l-4 border-orange-500"><p className="text-xs text-gray-500">Active Properties</p><p className="text-2xl font-bold">{stats.total_properties}</p></div>
            <div className="card p-4 border-l-4 border-blue-500">
              <p className="text-xs text-gray-500">Occupancy</p>
              <p className="text-xl font-bold">{stats.occupied_rooms} <span className="text-sm text-gray-400">/ {stats.total_rooms}</span></p>
              <p className="text-[10px] text-gray-500">{stats.vacant_rooms} vacant rooms</p>
            </div>
            <div className="card p-4 border-l-4 border-red-500">
              <p className="text-xs text-gray-500">Monthly Burn</p>
              <p className="text-xl font-bold text-red-700">{fmtRs(stats.monthly_burn)}</p>
            </div>
            <div className="card p-4 border-l-4 border-purple-500">
              <p className="text-xs text-gray-500">Deposit Locked</p>
              <p className="text-xl font-bold text-purple-700">{fmtRs(stats.total_deposit_locked)}</p>
            </div>
            <div className="card p-4 border-l-4 border-amber-500">
              <p className="text-xs text-gray-500">Active Bookings</p>
              <p className="text-2xl font-bold text-amber-600">{stats.active_bookings}</p>
            </div>
            <div className="card p-4 border-l-4 border-red-500">
              <p className="text-xs text-gray-500">Agreements Expiring (30 days)</p>
              <p className="text-2xl font-bold text-red-700">{stats.agreements_expiring_30d}</p>
            </div>
          </div>
        </>
      )}

      {/* PROPERTIES */}
      {tab === 'properties' && (
        <>
          <div className="card p-3 flex flex-wrap gap-2 items-end">
            <div className="relative flex-1 min-w-[200px]">
              <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
              <input className="input pl-9 text-sm" placeholder="Search by name, address, landlord…" value={filters.search} onChange={e => setFilters(f => ({ ...f, search: e.target.value }))} />
            </div>
            <input className="input text-sm w-40" placeholder="City" value={filters.city} onChange={e => setFilters(f => ({ ...f, city: e.target.value }))} />
            <select className="select text-sm w-32" value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}>
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="expired">Expired</option>
              <option value="terminated">Terminated</option>
            </select>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {properties.length === 0 && <div className="col-span-full card p-6 text-center text-gray-400 text-sm">No properties yet — click "Add Property" to start</div>}
            {properties.map(p => (
              <div key={p.id} className="card p-4 hover:shadow-md transition cursor-pointer relative" onClick={() => openDetail(p)}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-bold text-base truncate">{p.name}</h3>
                    <p className="text-xs text-gray-500 truncate">{[p.city, p.state].filter(Boolean).join(', ') || '—'}</p>
                  </div>
                  <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${STATUS_PILL[p.status]}`}>{p.status}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
                  <div><span className="text-gray-400">Landlord:</span> <span className="font-medium">{p.landlord_name || '—'}</span></div>
                  <div><span className="text-gray-400">Phone:</span> <span className="font-medium">{p.landlord_phone || '—'}</span></div>
                  <div><span className="text-gray-400">Rent:</span> <span className="font-bold text-red-700">{fmtRs(p.monthly_rent)}/mo</span></div>
                  <div><span className="text-gray-400">Deposit:</span> <span className="font-medium">{fmtRs(p.deposit_paid)}</span></div>
                  <div className="col-span-2"><span className="text-gray-400">Rooms:</span> <span className="font-bold text-blue-700">{p.occupied_count} / {p.room_count} occupied</span></div>
                  {p.agreement_end_date && (
                    <div className="col-span-2 text-[10px] flex items-center gap-1">
                      <FiCalendar size={10} /> <span className="text-gray-500">Agreement ends:</span> <span className={`font-bold ${new Date(p.agreement_end_date) < new Date(Date.now() + 30*86400000) ? 'text-red-700' : 'text-gray-700'}`}>{p.agreement_end_date}</span>
                    </div>
                  )}
                </div>
                {canEdit('rentals') && (
                  <button onClick={(e) => { e.stopPropagation(); setPropForm(p); setPropModal('add'); }} className="absolute top-2 right-2 mt-6 text-gray-400 hover:text-blue-600 p-1"><FiEdit2 size={12} /></button>
                )}
                {canDelete('rentals') && (
                  <button onClick={(e) => { e.stopPropagation(); delProp(p); }} className="absolute bottom-2 right-2 text-gray-400 hover:text-red-600 p-1"><FiTrash2 size={12} /></button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* BOOKINGS */}
      {tab === 'bookings' && (
        <div className="card p-0 overflow-x-auto">
          <table>
            <thead><tr><th>Status</th><th>Occupant</th><th>Property / Room</th><th>City</th><th>Site</th><th>Check-in</th><th>Check-out</th><th>Rent Share</th><th>Actions</th></tr></thead>
            <tbody>
              {bookings.length === 0 && <tr><td colSpan="9" className="text-center py-8 text-gray-400">No bookings yet</td></tr>}
              {bookings.map(b => (
                <tr key={b.id}>
                  <td><span className={`text-[10px] px-2 py-0.5 rounded font-bold ${STATUS_PILL[b.status]}`}>{b.status}</span></td>
                  <td className="font-medium">{b.occupant_user_name || b.occupant_name}{b.occupant_phone && <div className="text-[10px] text-gray-500">{b.occupant_phone}</div>}</td>
                  <td className="text-xs">{b.property_name} <span className="text-gray-400">/</span> {b.room_name}</td>
                  <td className="text-xs">{b.city || '—'}</td>
                  <td className="text-xs">{b.site_name || '—'}</td>
                  <td className="text-xs">{b.check_in_date}</td>
                  <td className="text-xs">{b.actual_checkout_date || (b.check_out_date ? `Plan: ${b.check_out_date}` : '—')}</td>
                  <td className="text-right text-xs">{fmtRs(b.rent_share)}</td>
                  <td>
                    {b.status === 'active' && canEdit('rentals') && (
                      <button onClick={() => checkOut(b)} className="btn btn-secondary text-[10px] px-2 py-1 flex items-center gap-1"><FiLogOut size={10} /> Check out</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* PAYMENTS */}
      {tab === 'payments' && (
        <div className="card p-0 overflow-x-auto">
          <table>
            <thead><tr><th>Period</th><th>Property</th><th>Landlord</th><th className="text-right">Amount</th><th>Paid Date</th><th>Mode</th><th>Ref</th><th>Receipt</th><th>Notes</th></tr></thead>
            <tbody>
              {payments.length === 0 && <tr><td colSpan="9" className="text-center py-8 text-gray-400">No payments recorded yet</td></tr>}
              {payments.map(p => (
                <tr key={p.id}>
                  <td className="font-bold text-blue-700">{p.period_month}</td>
                  <td>{p.property_name}</td>
                  <td className="text-xs">{p.landlord_name || '—'}</td>
                  <td className="text-right font-bold text-red-700">{fmtRs(p.amount_paid)}</td>
                  <td className="text-xs">{p.paid_date || '—'}</td>
                  <td className="text-xs">{p.paid_via || '—'}</td>
                  <td className="text-xs">{p.transaction_ref || '—'}</td>
                  <td>{p.receipt_url ? <a href={p.receipt_url} target="_blank" rel="noreferrer" className="text-blue-600 underline text-xs">📎</a> : <span className="text-gray-300 text-xs">—</span>}</td>
                  <td className="text-xs text-gray-500 max-w-xs truncate">{p.notes || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* PROPERTY DETAIL MODAL */}
      <Modal isOpen={!!propDetail} onClose={() => setPropDetail(null)} title={propDetail?.name || 'Property'} wide>
        {propDetail && (
          <div className="space-y-4 max-h-[75vh] overflow-y-auto">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div className="card p-2"><p className="text-[10px] text-gray-500">Monthly Rent</p><p className="font-bold text-red-700">{fmtRs(propDetail.monthly_rent)}</p></div>
              <div className="card p-2"><p className="text-[10px] text-gray-500">Deposit</p><p className="font-bold">{fmtRs(propDetail.deposit_paid)}</p></div>
              <div className="card p-2"><p className="text-[10px] text-gray-500">Agreement End</p><p className="font-bold text-xs">{propDetail.agreement_end_date || '—'}</p></div>
              <div className="card p-2"><p className="text-[10px] text-gray-500">Landlord</p><p className="font-bold text-xs">{propDetail.landlord_name || '—'}<br/><span className="text-gray-500">{propDetail.landlord_phone || ''}</span></p></div>
            </div>

            {/* Rooms */}
            <div className="border rounded p-3">
              <div className="flex items-center justify-between mb-2">
                <h5 className="font-semibold text-sm">Rooms ({propDetail.rooms?.length || 0})</h5>
                {canCreate('rentals') && <button onClick={() => { setRoomForm({ status: 'available', capacity: 1 }); setRoomModal(true); }} className="btn btn-primary text-xs">+ Room</button>}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                {propDetail.rooms?.map(r => (
                  <div key={r.id} className="border rounded p-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-bold">{r.room_name}</span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded ${STATUS_PILL[r.status]}`}>{r.status}</span>
                    </div>
                    <div className="text-[10px] text-gray-500 mt-1">Capacity: {r.capacity} · Occupants: {r.occupant_count}</div>
                    {canCreate('rentals') && r.status !== 'maintenance' && (
                      <button onClick={() => { setBookingForm({ room_id: r.id, check_in_date: new Date().toISOString().slice(0, 10), rent_share: Math.round((propDetail.monthly_rent || 0) / Math.max(1, propDetail.total_capacity || 1)) }); setBookingModal(true); }}
                              className="text-[10px] text-blue-600 underline mt-1">Book</button>
                    )}
                  </div>
                ))}
                {(!propDetail.rooms || propDetail.rooms.length === 0) && <p className="text-xs text-gray-400 col-span-full">No rooms yet</p>}
              </div>
            </div>

            {/* Bookings */}
            <div className="border rounded p-3">
              <h5 className="font-semibold text-sm mb-2">Bookings ({propDetail.bookings?.length || 0})</h5>
              <div className="space-y-1 text-xs">
                {propDetail.bookings?.map(b => (
                  <div key={b.id} className="flex items-center justify-between border-b pb-1 last:border-0">
                    <div>
                      <span className="font-medium">{b.occupant_user_name || b.occupant_name}</span>
                      <span className="text-gray-400 mx-1">·</span>
                      <span className="text-gray-500">{b.room_name}</span>
                      <span className="text-gray-400 mx-1">·</span>
                      <span className="text-gray-500">{b.check_in_date} → {b.actual_checkout_date || b.check_out_date || 'ongoing'}</span>
                    </div>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded ${STATUS_PILL[b.status]}`}>{b.status}</span>
                  </div>
                ))}
                {(!propDetail.bookings || propDetail.bookings.length === 0) && <p className="text-gray-400">No bookings yet</p>}
              </div>
            </div>

            {/* Payments */}
            <div className="border rounded p-3">
              <h5 className="font-semibold text-sm mb-2">Rent Payments ({propDetail.payments?.length || 0})</h5>
              <div className="space-y-1 text-xs">
                {propDetail.payments?.map(p => (
                  <div key={p.id} className="flex items-center justify-between border-b pb-1 last:border-0">
                    <div>
                      <span className="font-bold text-blue-700">{p.period_month}</span>
                      <span className="text-gray-400 mx-1">·</span>
                      <span className="text-gray-500">{p.paid_date || 'Pending'}</span>
                      {p.paid_via && <span className="text-gray-400 ml-1">({p.paid_via})</span>}
                    </div>
                    <span className="font-bold text-red-700">{fmtRs(p.amount_paid)}</span>
                  </div>
                ))}
                {(!propDetail.payments || propDetail.payments.length === 0) && <p className="text-gray-400">No payments yet</p>}
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* PROPERTY ADD/EDIT MODAL */}
      <Modal isOpen={!!propModal} onClose={() => { setPropModal(null); setPropForm({}); }} title={propForm.id ? 'Edit Property' : 'Add Property'} wide>
        <form onSubmit={saveProp} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2"><label className="label">Name *</label><input className="input" required value={propForm.name || ''} onChange={e => setPropForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Andheri Mumbai 3BHK Flat" /></div>
            <div className="col-span-2"><label className="label">Address</label><input className="input" value={propForm.address || ''} onChange={e => setPropForm(f => ({ ...f, address: e.target.value }))} /></div>
            <div><label className="label">City</label><input className="input" value={propForm.city || ''} onChange={e => setPropForm(f => ({ ...f, city: e.target.value }))} /></div>
            <div><label className="label">State</label><input className="input" value={propForm.state || ''} onChange={e => setPropForm(f => ({ ...f, state: e.target.value }))} /></div>
            <div><label className="label">Pincode</label><input className="input" value={propForm.pincode || ''} onChange={e => setPropForm(f => ({ ...f, pincode: e.target.value }))} /></div>
            <div>
              <label className="label">Linked Site (optional)</label>
              <SearchableSelect options={sites} value={propForm.site_id || null} valueKey="id" displayKey="name" placeholder="Pick site…" onChange={(s) => setPropForm(f => ({ ...f, site_id: s?.id || '' }))} />
            </div>
            <div className="col-span-2 border-t pt-3 mt-1"><h5 className="font-bold text-sm">Landlord</h5></div>
            <div><label className="label">Name</label><input className="input" value={propForm.landlord_name || ''} onChange={e => setPropForm(f => ({ ...f, landlord_name: e.target.value }))} /></div>
            <div><label className="label">Phone</label><input className="input" value={propForm.landlord_phone || ''} onChange={e => setPropForm(f => ({ ...f, landlord_phone: e.target.value }))} /></div>
            <div className="col-span-2"><label className="label">Email</label><input className="input" type="email" value={propForm.landlord_email || ''} onChange={e => setPropForm(f => ({ ...f, landlord_email: e.target.value }))} /></div>
            <div className="col-span-2 border-t pt-3 mt-1"><h5 className="font-bold text-sm">Agreement</h5></div>
            <div><label className="label">Monthly Rent (Rs)</label><input type="number" className="input" value={propForm.monthly_rent || 0} onChange={e => setPropForm(f => ({ ...f, monthly_rent: +e.target.value }))} /></div>
            <div><label className="label">Deposit Paid (Rs)</label><input type="number" className="input" value={propForm.deposit_paid || 0} onChange={e => setPropForm(f => ({ ...f, deposit_paid: +e.target.value }))} /></div>
            <div><label className="label">Start Date</label><input type="date" className="input" value={propForm.agreement_start_date || ''} onChange={e => setPropForm(f => ({ ...f, agreement_start_date: e.target.value }))} /></div>
            <div><label className="label">End Date</label><input type="date" className="input" value={propForm.agreement_end_date || ''} onChange={e => setPropForm(f => ({ ...f, agreement_end_date: e.target.value }))} /></div>
            <div><label className="label">Bedrooms</label><input type="number" className="input" value={propForm.bedrooms || 1} onChange={e => setPropForm(f => ({ ...f, bedrooms: +e.target.value }))} /></div>
            <div><label className="label">Total Capacity (beds)</label><input type="number" className="input" value={propForm.total_capacity || 1} onChange={e => setPropForm(f => ({ ...f, total_capacity: +e.target.value }))} /></div>
            <div className="col-span-2"><label className="label">Amenities</label><input className="input" value={propForm.amenities || ''} onChange={e => setPropForm(f => ({ ...f, amenities: e.target.value }))} placeholder="AC, Wifi, Geyser, Furnished…" /></div>
            <div className="col-span-2"><label className="label">Agreement file URL</label><input className="input" value={propForm.agreement_file_url || ''} onChange={e => setPropForm(f => ({ ...f, agreement_file_url: e.target.value }))} placeholder="https://… (upload separately and paste link)" /></div>
            <div>
              <label className="label">Status</label>
              <select className="select" value={propForm.status || 'active'} onChange={e => setPropForm(f => ({ ...f, status: e.target.value }))}>
                <option>active</option><option>expired</option><option>terminated</option>
              </select>
            </div>
            <div className="col-span-2"><label className="label">Notes</label><textarea className="input" rows="2" value={propForm.notes || ''} onChange={e => setPropForm(f => ({ ...f, notes: e.target.value }))} /></div>
          </div>
          <div className="flex justify-end gap-2 pt-3 border-t">
            <button type="button" onClick={() => { setPropModal(null); setPropForm({}); }} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">{propForm.id ? 'Save' : 'Add'}</button>
          </div>
        </form>
      </Modal>

      {/* ROOM ADD MODAL */}
      <Modal isOpen={roomModal} onClose={() => { setRoomModal(false); setRoomForm({}); }} title={`Add room — ${propDetail?.name}`}>
        <form onSubmit={addRoom} className="space-y-3">
          <div><label className="label">Room Name *</label><input className="input" required value={roomForm.room_name || ''} onChange={e => setRoomForm(f => ({ ...f, room_name: e.target.value }))} placeholder="e.g. Master Bedroom" /></div>
          <div><label className="label">Capacity (beds)</label><input type="number" className="input" value={roomForm.capacity || 1} onChange={e => setRoomForm(f => ({ ...f, capacity: +e.target.value }))} /></div>
          <div>
            <label className="label">Status</label>
            <select className="select" value={roomForm.status || 'available'} onChange={e => setRoomForm(f => ({ ...f, status: e.target.value }))}>
              <option>available</option><option>occupied</option><option>maintenance</option><option>reserved</option>
            </select>
          </div>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setRoomModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Add</button></div>
        </form>
      </Modal>

      {/* BOOKING MODAL */}
      <Modal isOpen={bookingModal} onClose={() => { setBookingModal(false); setBookingForm({}); }} title="New Booking" wide>
        <form onSubmit={saveBooking} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {!bookingForm.room_id && (
              <div className="col-span-2">
                <label className="label">Pick Room *</label>
                <select className="select" required value={bookingForm.room_id || ''} onChange={e => setBookingForm(f => ({ ...f, room_id: +e.target.value }))}>
                  <option value="">— pick a room —</option>
                  {properties.flatMap(p =>
                    (p.room_count > 0 ? [{ optgroup: p.name, propId: p.id }] : []).concat([])
                  )}
                  {properties.map(p => (
                    <optgroup key={p.id} label={p.name}>
                      {/* We can't fetch all rooms upfront, so this is a hint to open detail */}
                    </optgroup>
                  ))}
                </select>
                <p className="text-[10px] text-gray-500 mt-0.5">Tip: easier to start a booking from the property detail page → click "Book" on any available room.</p>
              </div>
            )}
            <div>
              <label className="label">Occupant (employee)</label>
              <SearchableSelect options={users.map(u => ({ ...u, label: u.name + (u.department ? ` — ${u.department}` : '') }))} value={bookingForm.occupant_user_id || null} valueKey="id" displayKey="label" placeholder="Pick user…" onChange={(u) => setBookingForm(f => ({ ...f, occupant_user_id: u?.id || '', occupant_name: u?.name || '' }))} />
            </div>
            <div><label className="label">Or type name (non-employee)</label><input className="input" value={bookingForm.occupant_name || ''} onChange={e => setBookingForm(f => ({ ...f, occupant_name: e.target.value }))} /></div>
            <div><label className="label">Phone</label><input className="input" value={bookingForm.occupant_phone || ''} onChange={e => setBookingForm(f => ({ ...f, occupant_phone: e.target.value }))} /></div>
            <div>
              <label className="label">Project Site (optional)</label>
              <SearchableSelect options={sites} value={bookingForm.site_id || null} valueKey="id" displayKey="name" placeholder="Pick site…" onChange={(s) => setBookingForm(f => ({ ...f, site_id: s?.id || '' }))} />
            </div>
            <div><label className="label">Check-in *</label><input type="date" className="input" required value={bookingForm.check_in_date || ''} onChange={e => setBookingForm(f => ({ ...f, check_in_date: e.target.value }))} /></div>
            <div><label className="label">Planned Check-out</label><input type="date" className="input" value={bookingForm.check_out_date || ''} onChange={e => setBookingForm(f => ({ ...f, check_out_date: e.target.value }))} /></div>
            <div><label className="label">Rent Share (Rs)</label><input type="number" className="input" value={bookingForm.rent_share || 0} onChange={e => setBookingForm(f => ({ ...f, rent_share: +e.target.value }))} /></div>
            <div><label className="label">Deposit Collected</label><input type="number" className="input" value={bookingForm.deposit_collected || 0} onChange={e => setBookingForm(f => ({ ...f, deposit_collected: +e.target.value }))} /></div>
            <div className="col-span-2"><label className="label">Notes</label><textarea className="input" rows="2" value={bookingForm.notes || ''} onChange={e => setBookingForm(f => ({ ...f, notes: e.target.value }))} /></div>
          </div>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setBookingModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Book</button></div>
        </form>
      </Modal>

      {/* PAYMENT MODAL */}
      <Modal isOpen={paymentModal} onClose={() => setPaymentModal(false)} title="Record Rent Payment">
        <form onSubmit={savePayment} className="space-y-3">
          <div>
            <label className="label">Property *</label>
            <SearchableSelect options={properties.filter(p => p.status === 'active').map(p => ({ ...p, label: `${p.name} — ${fmtRs(p.monthly_rent)}/mo` }))} value={paymentForm.property_id || null} valueKey="id" displayKey="label" placeholder="Pick property…" onChange={(p) => setPaymentForm(f => ({ ...f, property_id: p?.id || '', amount_paid: f.amount_paid || p?.monthly_rent || 0 }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Period (YYYY-MM) *</label><input className="input" required value={paymentForm.period_month} onChange={e => setPaymentForm(f => ({ ...f, period_month: e.target.value }))} placeholder="2026-05" /></div>
            <div><label className="label">Amount Paid *</label><input type="number" required className="input" value={paymentForm.amount_paid || 0} onChange={e => setPaymentForm(f => ({ ...f, amount_paid: +e.target.value }))} /></div>
            <div><label className="label">Paid Date</label><input type="date" className="input" value={paymentForm.paid_date || ''} onChange={e => setPaymentForm(f => ({ ...f, paid_date: e.target.value }))} /></div>
            <div>
              <label className="label">Mode</label>
              <select className="select" value={paymentForm.paid_via || 'Bank'} onChange={e => setPaymentForm(f => ({ ...f, paid_via: e.target.value }))}>
                <option>Bank</option><option>UPI</option><option>Cash</option><option>Cheque</option>
              </select>
            </div>
            <div className="col-span-2"><label className="label">Transaction Ref</label><input className="input" value={paymentForm.transaction_ref || ''} onChange={e => setPaymentForm(f => ({ ...f, transaction_ref: e.target.value }))} /></div>
            <div className="col-span-2"><label className="label">Receipt URL</label><input className="input" value={paymentForm.receipt_url || ''} onChange={e => setPaymentForm(f => ({ ...f, receipt_url: e.target.value }))} placeholder="https://… (upload separately and paste link)" /></div>
            <div className="col-span-2"><label className="label">Notes</label><textarea className="input" rows="2" value={paymentForm.notes || ''} onChange={e => setPaymentForm(f => ({ ...f, notes: e.target.value }))} /></div>
          </div>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setPaymentModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Save</button></div>
        </form>
      </Modal>
    </div>
  );
}
