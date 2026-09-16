import EmployeeProfessionalTax from './EmployeeProfessionalTax';
import { STATES } from '../data/indiaLocations';

const MONEY_FIELDS = [
  ['tds_estimated_annual', 'TDS Estimated Annual (Rs/year)'],
  ['ctc_annual', 'CTC Annual (Rs/year)'], ['variable_bonus', 'Variable / Bonus (Rs/year)'],
  ['basic_salary', 'Basic (Rs/month)'], ['hra', 'HRA (Rs/month)'], ['special_allowance', 'Special Allowance (Rs/month)'],
  ['pf_deduction', 'PF Deduction (Rs/month)'], ['esi_deduction', 'ESI Deduction (Rs/month)'],
];

export default function EmployeeDetailsFields({ form, setForm, canSeeSalary, scorecard, optionsLoaded }) {
  const change = (key, value) => setForm(previous => {
    const next = { ...previous, [key]: value };
    if (next.same_as_permanent) {
      next.current_address = next.permanent_address || null;
      next.current_pin = next.permanent_pin || null;
    }
    return next;
  });
  return <>
    <div>
      <label className="label" htmlFor="blood-group">Blood Group</label>
      <select id="blood-group" className="select" value={form.blood_group || ''} onChange={e => change('blood_group', e.target.value || null)}>
        <option value="">Select blood group</option>
        {['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map(group => <option key={group} value={group}>{group}</option>)}
      </select>
    </div>
    <fieldset className="rounded-xl border border-gray-200 p-4 space-y-4">
      <legend className="px-1 text-sm font-semibold text-gray-800">Addresses</legend>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={!!form.same_as_permanent} onChange={e => change('same_as_permanent', e.target.checked ? 1 : 0)} />
        Current address same as permanent address
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {['permanent', 'current'].map(kind => {
          const copied = kind === 'current' && !!form.same_as_permanent;
          const source = copied ? 'permanent' : kind;
          return <div key={kind} className="space-y-3">
            <div><label className="label" htmlFor={`${kind}-address`}>{kind === 'permanent' ? 'Permanent Address' : 'Current Address'}</label>
              <textarea id={`${kind}-address`} rows={3} maxLength={2000} className="input disabled:bg-gray-100" disabled={copied}
                value={form[`${source}_address`] || ''} onChange={e => change(`${kind}_address`, e.target.value || null)} /></div>
            <div><label className="label" htmlFor={`${kind}-pin`}>PIN Code</label>
              <input id={`${kind}-pin`} className="input disabled:bg-gray-100" inputMode="numeric" pattern="[1-9][0-9]{5}" maxLength={6}
                disabled={copied} placeholder="6-digit PIN code" value={form[`${source}_pin`] || ''}
                onChange={e => change(`${kind}_pin`, e.target.value.replace(/\D/g, '') || null)} /></div>
          </div>;
        })}
      </div>
    </fieldset>
    <fieldset className="rounded-xl border border-gray-200 p-4">
      <legend className="px-1 text-sm font-semibold text-gray-800">PF, ESI and Professional Tax</legend>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {[['pf_number', 'PF Number'], ['esi_number', 'ESI Number']].map(([key, label]) => <div key={key}>
          <label className="label" htmlFor={key}>{label}</label>
          <input id={key} className="input" maxLength={100} value={form[key] || ''} onChange={e => change(key, e.target.value || null)} />
        </div>)}
        <div><label className="label" htmlFor="pt-state">Professional Tax (PT) State</label>
          <select id="pt-state" className="select" value={form.pt_state || ''} onChange={e => change('pt_state', e.target.value || null)}>
            <option value="">Select state</option><option value="Not applicable">Not applicable</option>
            {STATES.map(state => <option key={state} value={state}>{state}</option>)}
          </select>
        </div>
      </div>
    </fieldset>
    <fieldset className="rounded-xl border border-gray-200 p-4">
      <legend className="px-1 text-sm font-semibold text-gray-800">Declarations and nominations</legend>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {[['form11_file', 'Form 11 (PF Self Declaration)'], ['form_f_file', 'Form F (Gratuity Nomination)']].map(([key, label]) => <div key={key}>
          <label className="label" htmlFor={key}>{label}</label>
          <input id={key} type="file" className="input" accept=".pdf,.jpg,.jpeg,.png" onChange={e => change(`_${key}`, e.target.files?.[0] || null)} />
          <p className="text-xs text-gray-500 mt-1">PDF / JPG / PNG, max 10 MB</p>
          {form[key] && <a href={form[key]} target="_blank" rel="noreferrer" className="text-xs text-blue-700 underline">View saved document</a>}
          {form[`_${key}`] && <p className="text-xs text-blue-700 mt-1">Selected: {form[`_${key}`].name}</p>}
        </div>)}
      </div>
    </fieldset>
    {canSeeSalary && <fieldset className="rounded-xl border border-gray-200 p-4">
      <legend className="px-1 text-sm font-semibold text-gray-800">Compensation and deductions</legend>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="label" htmlFor="last-increment-date">Last Increment Date</label>
          <input id="last-increment-date" type="date" className="input" value={form.last_increment_date || ''}
            onChange={e => change('last_increment_date', e.target.value || null)} />
        </div>
        <div><label className="label" htmlFor="salary-review-cycle">Salary Review Cycle</label>
          <select id="salary-review-cycle" className="select" value={form.salary_review_cycle || ''} onChange={e => change('salary_review_cycle', e.target.value || null)}>
            <option value="">Select review cycle</option><option value="apr_mar">Apr–Mar</option><option value="joining_anniversary">Joining Anniversary</option>
          </select>
        </div>
        {MONEY_FIELDS.map(([key, label]) => <div key={key}>
          <label className="label" htmlFor={key}>{label}</label>
          <input id={key} type="number" min="0" step="0.01" className="input" readOnly={key === 'ctc_annual'} value={key === 'ctc_annual' ? (form.salary === '' || form.salary == null ? '' : Math.round(Number(form.salary) * 1200) / 100) : form[key] ?? ''}
            onChange={e => change(key, e.target.value === '' ? null : Number(e.target.value))} />
          {key === 'ctc_annual' && <p className="text-xs text-gray-500 mt-1">Calculated automatically: Salary (Rs) × 12.</p>}
          {key === 'variable_bonus' && <div className="mt-3">
            <label className="label" htmlFor="bonus-target-pct">Bonus / Variable Target (%)</label>
            <input id="bonus-target-pct" className="input" type="number" min="0" max="100" step="0.01" value={form.bonus_target_pct ?? ''}
              onChange={e => change('bonus_target_pct', e.target.value === '' ? null : Number(e.target.value))} />
            <p className="text-xs text-gray-500 mt-1">{!optionsLoaded ? 'Scorecard information unavailable or loading.' : scorecard ? `Linked scorecard: ${scorecard.name}` : 'Link a login user with an assigned scorecard before setting a positive target.'}</p>
            <p className="text-xs text-gray-500 mt-1">Target for the assigned scorecard; entering it does not trigger a payment.</p>
          </div>}
        </div>)}
        <EmployeeProfessionalTax state={form.pt_state} salary={form.salary} />
      </div>
      <p className="text-xs text-gray-500 mt-3">CTC is calculated from Salary × 12. Bonus and estimated TDS are annual; basic, HRA, special allowance and deductions are monthly.</p>
    </fieldset>}
    {canSeeSalary && <fieldset className="rounded-xl border border-gray-200 p-4">
      <legend className="px-1 text-sm font-semibold text-gray-800">Reimbursements — Annual Entitlements</legend>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[['reimbursement_lta_annual', 'LTA'], ['reimbursement_medical_annual', 'Medical'], ['reimbursement_phone_annual', 'Phone']].map(([key, label]) => <div key={key}>
          <label className="label" htmlFor={key}>{label} (Rs/year)</label>
          <input id={key} type="number" min="0" step="0.01" className="input" value={form[key] ?? ''} onChange={e => change(key, e.target.value === '' ? null : Number(e.target.value))} />
        </div>)}
      </div>
      <p className="text-xs text-gray-500 mt-2">Annual entitlement limits. Claims and payments are recorded separately.</p>
    </fieldset>}
  </>;
}
