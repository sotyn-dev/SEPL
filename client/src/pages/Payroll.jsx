import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiSettings, FiDollarSign, FiEye, FiLock, FiUnlock, FiSave } from 'react-icons/fi';
import { LuIndianRupee } from 'react-icons/lu';

const monthNow = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const SETTING_FIELDS = [
  { key: 'late_after_time', label: 'Late After Time', help: 'Punch-in after this counts as a late mark', type: 'time' },
  { key: 'half_day_after_time', label: 'Half-Day After Time', help: 'Punch-in after this = half day deduction', type: 'time' },
  { key: 'min_hours_full_day', label: 'Min Hours for Full Day', help: 'Worked less than this = half day', type: 'number', step: 0.5 },
  { key: 'min_hours_half_day', label: 'Min Hours for Half Day', help: 'Worked less than this = absent', type: 'number', step: 0.5 },
  { key: 'skip_half_day_if_short_leave', label: 'Skip Half-Day if Short Leave Applied', help: '1 = yes, 0 = no', type: 'bool' },
  { key: 'lates_to_absent', label: 'Late Marks → 1 Absent', help: 'How many lates equal 1 absent', type: 'number' },
  { key: 'working_days_per_month', label: 'Working Days per Month', help: 'Divisor for per-day rate (26 / 30)', type: 'number' },
  { key: 'sundays_paid', label: 'Sundays Paid?', help: '1 = paid (monthly staff), 0 = unpaid (daily wage)', type: 'bool' },
  { key: 'cl_per_month', label: 'Casual Leave / Month', help: 'Paid CL allowance', type: 'number', step: 0.5 },
  { key: 'sl_per_month', label: 'Sick Leave / Month', help: 'Paid SL allowance', type: 'number', step: 0.5 },
  { key: 'pl_per_month', label: 'Privilege/Earned Leave / Month', help: 'Paid PL/EL allowance', type: 'number', step: 0.5 },
  { key: 'short_leave_per_month', label: 'Short Leaves / Month', help: 'Allowed short-leave count', type: 'number' },
  { key: 'ot_threshold_hours', label: 'OT After (hours)', help: 'Hours/day before OT pay starts', type: 'number', step: 0.5 },
  { key: 'ot_rate_multiplier', label: 'OT Rate Multiplier', help: 'OT pay = normal × this (1.5 / 2)', type: 'number', step: 0.1 },
];

const LABEL_PILL = {
  present: 'bg-emerald-100 text-emerald-700',
  late: 'bg-amber-100 text-amber-700',
  half_day_late: 'bg-orange-100 text-orange-700',
  half_day_low_hours: 'bg-orange-100 text-orange-700',
  absent_no_punch: 'bg-red-100 text-red-700',
  absent_low_hours: 'bg-red-100 text-red-700',
  sunday_paid: 'bg-blue-100 text-blue-700',
  sunday_unpaid: 'bg-gray-100 text-gray-500',
  paid_casual_leave: 'bg-purple-100 text-purple-700',
  paid_sick_leave: 'bg-purple-100 text-purple-700',
  paid_earned_leave: 'bg-purple-100 text-purple-700',
  unpaid_casual_leave: 'bg-rose-100 text-rose-700',
  unpaid_sick_leave: 'bg-rose-100 text-rose-700',
  unpaid_earned_leave: 'bg-rose-100 text-rose-700',
};

export default function Payroll() {
  const { user, canApprove } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [tab, setTab] = useState('monthly');
  const [month, setMonth] = useState(monthNow());
  const [settings, setSettings] = useState(null);
  const [savedSettings, setSavedSettings] = useState(null);
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState(null);

  const loadSettings = useCallback(() => {
    api.get('/payroll/settings').then(r => { setSettings(r.data); setSavedSettings(r.data); }).catch(() => {});
  }, []);

  const loadMonth = useCallback(() => {
    setLoading(true);
    api.get(`/payroll/calculate?month=${month}`)
      .then(r => setList(r.data.employees || []))
      .catch(err => toast.error(err.response?.data?.error || 'Failed'))
      .finally(() => setLoading(false));
  }, [month]);

  useEffect(() => { loadSettings(); }, [loadSettings]);
  useEffect(() => { if (tab === 'monthly') loadMonth(); }, [tab, loadMonth]);

  const saveSettings = async () => {
    try {
      const res = await api.put('/payroll/settings', settings);
      setSavedSettings(res.data.settings);
      toast.success('Payroll rules saved — calculations will use these from next refresh');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
  };

  const finaliseMonth = async () => {
    if (!confirm(`Finalise payroll for ${month}? After this, attendance edits won't change the slips for this month.`)) return;
    try {
      const res = await api.post('/payroll/finalise', { month });
      toast.success(res.data.message);
      loadMonth();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const unlockMonth = async () => {
    if (!confirm(`Unlock ${month}? Slips will recalc from live attendance.`)) return;
    try {
      await api.post('/payroll/unlock', { month });
      toast.success('Unlocked');
      loadMonth();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const viewSlip = async (employeeId) => {
    try {
      const { data } = await api.get(`/payroll/calculate/${employeeId}?month=${month}`);
      setDetail(data);
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const fmt = (n) => `Rs ${(Math.round(n || 0)).toLocaleString('en-IN')}`;

  const total = list.reduce((s, r) => s + (r.net_pay || 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><LuIndianRupee className="text-emerald-600" /> Payroll</h1>
          <p className="text-sm text-gray-500">Auto-calculate monthly salary from attendance + leaves using your custom rules</p>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        <button onClick={() => setTab('monthly')} className={`btn ${tab === 'monthly' ? 'btn-primary' : 'btn-secondary'} text-sm flex items-center gap-1`}>
          <FiDollarSign size={14} /> Monthly Payroll
        </button>
        {isAdmin && (
          <button onClick={() => setTab('settings')} className={`btn ${tab === 'settings' ? 'btn-primary' : 'btn-secondary'} text-sm flex items-center gap-1`}>
            <FiSettings size={14} /> Rules / Settings
          </button>
        )}
      </div>

      {/* Monthly Payroll Tab */}
      {tab === 'monthly' && (
        <>
          <div className="card p-4 flex flex-wrap items-center gap-3">
            <div>
              <label className="label">Pay Month</label>
              <input type="month" className="input" value={month} onChange={e => setMonth(e.target.value)} />
            </div>
            <div className="flex-1" />
            <div className="text-right">
              <p className="text-xs text-gray-500">Total Net Payout</p>
              <p className="text-2xl font-bold text-emerald-600">{fmt(total)}</p>
            </div>
            {canApprove && canApprove('payroll') && (
              <button onClick={finaliseMonth} className="btn btn-success text-sm flex items-center gap-1">
                <FiLock size={14} /> Finalise Month
              </button>
            )}
            {isAdmin && (
              <button onClick={unlockMonth} className="btn btn-secondary text-sm flex items-center gap-1">
                <FiUnlock size={14} /> Unlock
              </button>
            )}
          </div>

          <div className="card p-0 overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Dept</th>
                  <th className="text-right">Base</th>
                  <th className="text-right">Paid Days</th>
                  <th className="text-center">Half</th>
                  <th className="text-center">Absent</th>
                  <th className="text-center">Late</th>
                  <th className="text-center">Leaves</th>
                  <th className="text-right">OT</th>
                  <th className="text-right">Net Pay</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan="11" className="text-center py-8 text-gray-400">Calculating…</td></tr>}
                {!loading && list.length === 0 && <tr><td colSpan="11" className="text-center py-8 text-gray-400">No active employees with salary set. Open HR → Employees and set monthly salary.</td></tr>}
                {!loading && list.map(r => (
                  <tr key={r.employee_id} className={r.locked ? 'bg-emerald-50/30' : ''}>
                    <td className="font-medium">{r.employee_name} {r.locked && <FiLock size={11} className="inline text-emerald-600" title="Finalised" />}</td>
                    <td className="text-xs text-gray-500">{r.department || '-'}</td>
                    <td className="text-right">{fmt(r.base_salary)}</td>
                    <td className="text-right font-semibold">{r.paid_days}</td>
                    <td className="text-center">{r.half_days || 0}</td>
                    <td className="text-center text-red-600">{r.absent_days || 0}</td>
                    <td className="text-center text-amber-600">{r.late_marks || 0}{r.lates_converted_absent ? ` (-${r.lates_converted_absent})` : ''}</td>
                    <td className="text-center text-purple-600">{(r.paid_leaves || 0) + (r.unpaid_leaves || 0)}</td>
                    <td className="text-right text-blue-600">{r.ot_hours || 0}h{r.ot_pay ? ` (+${fmt(r.ot_pay)})` : ''}</td>
                    <td className="text-right font-bold text-emerald-700">{fmt(r.net_pay)}</td>
                    <td><button onClick={() => viewSlip(r.employee_id)} className="btn btn-secondary text-xs">View Slip</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Settings Tab */}
      {tab === 'settings' && settings && (
        <div className="card p-6 space-y-4 max-w-3xl">
          <div className="flex items-center justify-between border-b pb-2">
            <h3 className="font-bold text-lg">Payroll Calculation Rules</h3>
            <button onClick={saveSettings} className="btn btn-primary flex items-center gap-1"><FiSave size={14} /> Save Rules</button>
          </div>
          <p className="text-xs text-gray-500">Tune each rule to match your company policy. Saving applies to all future calculations. Already-finalised months stay locked.</p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {SETTING_FIELDS.map(f => (
              <div key={f.key} className="p-3 bg-gray-50 rounded">
                <label className="label text-sm">{f.label}</label>
                {f.type === 'bool' ? (
                  <select className="select" value={settings[f.key]} onChange={e => setSettings(s => ({ ...s, [f.key]: +e.target.value }))}>
                    <option value={1}>Yes (1)</option>
                    <option value={0}>No (0)</option>
                  </select>
                ) : f.type === 'time' ? (
                  <input type="time" className="input" value={settings[f.key] || ''} onChange={e => setSettings(s => ({ ...s, [f.key]: e.target.value }))} />
                ) : (
                  <input type="number" step={f.step || 1} className="input" value={settings[f.key] ?? 0} onChange={e => setSettings(s => ({ ...s, [f.key]: +e.target.value }))} />
                )}
                <p className="text-[10px] text-gray-500 mt-1">{f.help}</p>
              </div>
            ))}
          </div>

          {savedSettings?.updated_at && (
            <p className="text-[11px] text-gray-400 pt-2 border-t">Last updated: {savedSettings.updated_at}</p>
          )}
        </div>
      )}

      {/* Slip Detail Modal */}
      <Modal isOpen={!!detail} onClose={() => setDetail(null)} title={`Salary Slip — ${detail?.employee_name} (${month})`} wide>
        {detail && (
          <div className="space-y-4 max-h-[75vh] overflow-y-auto">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Base Salary" value={fmt(detail.base_salary)} color="text-gray-700" />
              <Stat label="Per-Day Rate" value={fmt(detail.per_day_rate)} color="text-gray-700" />
              <Stat label="Paid Days" value={detail.paid_days} color="text-emerald-700" />
              <Stat label="Net Pay" value={fmt(detail.net_pay)} color="text-emerald-700 font-bold" />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Half Days" value={detail.half_days} color="text-orange-600" />
              <Stat label="Absent" value={detail.absent_days} color="text-red-600" />
              <Stat label="Late Marks" value={`${detail.late_marks}${detail.lates_converted_absent ? ` (-${detail.lates_converted_absent} day)` : ''}`} color="text-amber-600" />
              <Stat label="OT" value={`${detail.ot_hours} h (+${fmt(detail.ot_pay)})`} color="text-blue-600" />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="CL Used" value={`${detail.cl_used} / ${detail.settings?.cl_per_month ?? '?'}`} color="text-purple-600" />
              <Stat label="SL Used" value={`${detail.sl_used} / ${detail.settings?.sl_per_month ?? '?'}`} color="text-purple-600" />
              <Stat label="PL Used" value={`${detail.pl_used} / ${detail.settings?.pl_per_month ?? '?'}`} color="text-purple-600" />
              <Stat label="Short Leave" value={detail.short_leave_used} color="text-purple-600" />
            </div>

            <div>
              <h5 className="font-semibold text-sm mb-2">Day-by-Day Breakdown</h5>
              <div className="overflow-x-auto border rounded">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-left p-2">Date</th>
                      <th className="text-left p-2">Day</th>
                      <th className="text-left p-2">Status</th>
                      <th className="text-left p-2">Punch In</th>
                      <th className="text-right p-2">Hrs</th>
                      <th className="text-right p-2">Pay</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.breakdown?.map((d, i) => (
                      <tr key={i} className="border-t">
                        <td className="p-2">{d.date}</td>
                        <td className="p-2">{d.day}</td>
                        <td className="p-2"><span className={`text-[10px] px-1.5 py-0.5 rounded ${LABEL_PILL[d.label] || 'bg-gray-100'}`}>{d.label.replace(/_/g, ' ')}</span></td>
                        <td className="p-2">{d.punch_in ? new Date(d.punch_in).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '-'}</td>
                        <td className="p-2 text-right">{d.hours || '-'}</td>
                        <td className="p-2 text-right font-semibold">{d.pay}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-3 border-t">
              <button onClick={() => window.print()} className="btn btn-secondary text-sm">Print Slip</button>
              <button onClick={() => setDetail(null)} className="btn btn-primary text-sm">Close</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div className="p-3 bg-gray-50 rounded">
      <p className="text-[10px] text-gray-500 uppercase">{label}</p>
      <p className={`text-base ${color || 'text-gray-700'}`}>{value}</p>
    </div>
  );
}
