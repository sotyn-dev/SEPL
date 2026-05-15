import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiSettings, FiDollarSign, FiEye, FiLock, FiUnlock, FiSave, FiDownload } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import { LuIndianRupee } from 'react-icons/lu';

const monthNow = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

// Grouped settings for the rules tab — clearer than a flat list when there
// are 20+ rules. Each group renders as its own card.
const SETTING_GROUPS = [
  {
    title: 'Attendance Cutoffs',
    fields: [
      { key: 'late_after_time', label: 'Late Zone Start', help: 'Punch-in after this = late mark (e.g. 09:45)', type: 'time' },
      { key: 'half_day_after_time', label: 'Half-Day After Time', help: 'Punch-in after this = half day deduction (e.g. 10:00)', type: 'time' },
      { key: 'min_hours_full_day', label: 'Min Hours for Full Day', help: 'Worked less than this = half day', type: 'number', step: 0.5 },
      { key: 'min_hours_half_day', label: 'Min Hours for Half Day', help: 'Worked less than this = absent', type: 'number', step: 0.5 },
    ]
  },
  {
    title: 'Late Penalty (per-minute model)',
    fields: [
      { key: 'late_grace_count', label: 'Free Late Marks / Month', help: 'First N late punches per month are free', type: 'number' },
      { key: 'late_per_minute_rate', label: 'Penalty per Minute (Rs)', help: 'After grace, deduct ₹/min × (punch-in - late zone start)', type: 'number' },
      { key: 'skip_half_day_if_short_leave', label: 'Skip Penalty if Short Leave Applied', help: '1 = if short leave on that day, no late/half-day deduction', type: 'bool' },
      { key: 'lates_to_absent', label: 'Lates → 1 Absent (legacy)', help: 'Set 0 to disable this alternative model', type: 'number' },
    ]
  },
  {
    title: 'Working Days & Sundays',
    fields: [
      { key: 'working_days_per_month', label: 'Working Days per Month', help: 'Divisor for per-day rate (26 / 30)', type: 'number' },
      { key: 'sundays_paid', label: 'Sundays Paid?', help: '1 = paid (monthly staff), 0 = unpaid (daily wage)', type: 'bool' },
    ]
  },
  {
    title: 'Leave Allowances (Paid up to N / month)',
    fields: [
      { key: 'cl_per_month', label: 'Casual Leave', help: 'Paid CL allowance per month', type: 'number', step: 0.5 },
      { key: 'sl_per_month', label: 'Sick Leave', help: 'Paid SL allowance per month', type: 'number', step: 0.5 },
      { key: 'pl_per_month', label: 'Privilege / Earned Leave', help: 'Paid PL/EL allowance per month', type: 'number', step: 0.5 },
      { key: 'short_leave_per_month', label: 'Short Leaves / Month', help: 'Allowed short-leave count', type: 'number' },
    ]
  },
  {
    title: 'Overtime',
    fields: [
      { key: 'ot_threshold_hours', label: 'OT After (hours/day)', help: 'Hours/day before OT pay starts', type: 'number', step: 0.5 },
      { key: 'ot_rate_multiplier', label: 'OT Rate Multiplier', help: 'OT pay = normal × this (1.5 / 2)', type: 'number', step: 0.1 },
    ]
  },
  {
    title: 'Salary Slip Breakdown (% of gross)',
    fields: [
      { key: 'basic_pct', label: 'Basic Pay %', help: 'e.g. 56.5', type: 'number', step: 0.1 },
      { key: 'conveyance_pct', label: 'Conveyance Allowance %', help: 'e.g. 22.6', type: 'number', step: 0.1 },
      { key: 'hra_pct', label: 'House Rent Allowance %', help: 'e.g. 5.9', type: 'number', step: 0.1 },
      { key: 'adhoc_pct', label: 'Adhoc Allowance %', help: 'e.g. 15.0', type: 'number', step: 0.1 },
      { key: 'misc_pct', label: 'Miscellaneous Allowance %', help: 'Should sum to 100', type: 'number', step: 0.1 },
    ]
  },
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
      <div className="sticky-toolbar">
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
      </div>

      {/* Monthly Payroll Tab */}
      {tab === 'monthly' && (
        <>
          <div className="card p-4 flex flex-wrap items-center gap-3">
            <div>
              <label className="label">Pay Month</label>
              <input type="month" className="input" value={month} onChange={e => setMonth(e.target.value)} />
            </div>
            {/* Friendly notice when viewing the current month — explains why
                paid_days is partial and absent count looks low. Saves mam
                from doubting the engine on the 4th of any month. */}
            {list[0]?.is_current_month && (
              <div className="bg-amber-50 border border-amber-200 px-3 py-2 rounded text-xs text-amber-800">
                Showing salary <strong>earned so far</strong> (day 1 to day {list[0].days_counted}). Future days aren't counted as absent. Final figures land at month-end.
              </div>
            )}
            {list[0]?.is_future_month && (
              <div className="bg-blue-50 border border-blue-200 px-3 py-2 rounded text-xs text-blue-800">
                Future month — nothing to calculate yet.
              </div>
            )}
            <div className="flex-1" />
            <button onClick={() => exportCsv(`payroll-${month}`,
              ['Employee','Dept','Base','Paid Days','Gross','Deductions','Net'],
              list.map(p => [p.employee_name, p.department, p.base_salary, p.paid_days, p.gross, p.total_deductions, p.net_pay]))}
              className="btn btn-secondary text-sm flex items-center gap-1"><FiDownload size={14} /> Export Excel</button>
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

          <div className="card p-0">
            <table className="freeze-head">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Dept</th>
                  <th className="text-right">Base</th>
                  <th className="text-right">Paid Days</th>
                  <th className="text-center">Half</th>
                  <th className="text-center">Absent</th>
                  <th className="text-center">Late</th>
                  <th className="text-right">Late ₹</th>
                  <th className="text-center">Leaves</th>
                  <th className="text-right">OT</th>
                  <th className="text-right">Net Pay</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan="12" className="text-center py-8 text-gray-400">Calculating…</td></tr>}
                {!loading && list.length === 0 && <tr><td colSpan="12" className="text-center py-8 text-gray-400">No active employees with salary set. Open HR → Employees and set monthly salary.</td></tr>}
                {!loading && list.map(r => (
                  <tr key={r.employee_id} className={r.locked ? 'bg-emerald-50/30' : (r.user_linked === false ? 'bg-amber-50/40' : '')}>
                    <td className="font-medium">
                      {r.employee_name}
                      {r.locked && <FiLock size={11} className="inline text-emerald-600 ml-1" title="Finalised" />}
                      {r.user_linked === false && <span className="ml-1 text-[10px] bg-amber-200 text-amber-800 px-1 py-0.5 rounded" title="No login user linked — attendance can't be looked up. Open HR → Employees and set the User for this employee.">⚠ no login</span>}
                    </td>
                    <td className="text-xs text-gray-500">{r.department || '-'}</td>
                    <td className="text-right">{fmt(r.base_salary)}</td>
                    <td className="text-right font-semibold">{r.paid_days}</td>
                    <td className="text-center">{r.half_days || 0}</td>
                    <td className="text-center text-red-600">{r.absent_days || 0}</td>
                    <td className="text-center text-amber-600">{r.late_marks || 0}{r.lates_converted_absent ? ` (-${r.lates_converted_absent})` : ''}</td>
                    <td className="text-right text-amber-700">{r.late_penalty ? fmt(r.late_penalty) : '-'}</td>
                    <td className="text-center text-purple-600">{(r.paid_leaves || 0) + (r.unpaid_leaves || 0)}</td>
                    <td className="text-right text-blue-600">{r.ot_hours || 0}h{r.ot_pay ? ` (+${fmt(r.ot_pay)})` : ''}</td>
                    <td className="text-right font-bold text-emerald-700">{fmt(r.net_pay)}</td>
                    <td className="space-x-1 whitespace-nowrap">
                      <button onClick={() => viewSlip(r.employee_id)} className="btn btn-secondary text-xs">Detail</button>
                      <a href={`/payroll/slip/${r.employee_id}?month=${month}`} target="_blank" rel="noreferrer" className="btn btn-primary text-xs">SEPL Slip</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Settings Tab */}
      {tab === 'settings' && settings && (
        <div className="space-y-4 max-w-4xl">
          <div className="card p-4 flex items-center justify-between border-b-2 border-red-200">
            <div>
              <h3 className="font-bold text-lg">Payroll Calculation Rules</h3>
              <p className="text-xs text-gray-500">Every value below feeds the auto-calc engine. Save to apply to future months. Finalised months stay locked.</p>
            </div>
            <button onClick={saveSettings} className="btn btn-primary flex items-center gap-1"><FiSave size={14} /> Save Rules</button>
          </div>

          {SETTING_GROUPS.map(group => (
            <div key={group.title} className="card p-4">
              <h4 className="font-semibold text-sm mb-3 text-red-700 border-b pb-1">{group.title}</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {group.fields.map(f => (
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
            </div>
          ))}

          {savedSettings?.updated_at && (
            <p className="text-[11px] text-gray-400 pt-2">Last updated: {savedSettings.updated_at}</p>
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
              <Stat label="Late Penalty" value={detail.late_penalty ? fmt(detail.late_penalty) : '0'} color="text-red-600" />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="OT" value={`${detail.ot_hours} h (+${fmt(detail.ot_pay)})`} color="text-blue-600" />
              <Stat label="Gross Earned" value={fmt(detail.gross_earned)} color="text-emerald-700" />
              <Stat label="Total Deductions" value={fmt(detail.total_deductions)} color="text-red-600" />
              <Stat label="Sundays" value={detail.sunday_count} color="text-blue-600" />
            </div>

            {/* Earnings Breakdown — matches the printable slip */}
            <div className="border rounded p-3 bg-emerald-50">
              <h5 className="font-semibold text-sm mb-2 text-emerald-700">Earnings Breakdown</h5>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
                <div className="flex justify-between"><span className="text-gray-500">Basic Pay</span><span className="font-semibold">{fmt(detail.basic_pay)}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Conveyance</span><span className="font-semibold">{fmt(detail.conveyance)}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">HRA</span><span className="font-semibold">{fmt(detail.hra)}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Adhoc</span><span className="font-semibold">{fmt(detail.adhoc)}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Misc</span><span className="font-semibold">{fmt(detail.misc)}</span></div>
                <div className="flex justify-between border-t pt-1 col-span-full sm:col-span-1"><span className="font-bold">Total</span><span className="font-bold text-emerald-700">{fmt(detail.total_earnings)}</span></div>
              </div>
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
              <a href={`/payroll/slip/${detail.employee_id}?month=${month}`} target="_blank" rel="noreferrer" className="btn btn-success text-sm">Open SEPL Salary Slip</a>
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
