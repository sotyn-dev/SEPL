import { STATES } from '../data/indiaLocations';

const MONEY_FIELDS = [
  ['ctc_annual', 'CTC Annual (Rs/year)'], ['variable_bonus', 'Variable / Bonus (Rs/year)'],
  ['basic_salary', 'Basic (Rs/month)'], ['hra', 'HRA (Rs/month)'],
  ['pf_deduction', 'PF Deduction (Rs/month)'], ['esi_deduction', 'ESI Deduction (Rs/month)'],
];

export default function EmployeeDetailsFields({ form, setForm, canSeeSalary }) {
  const change = (key, value) => setForm(previous => {
    const next = { ...previous, [key]: value };
    if (next.same_as_permanent) {
      next.current_address = next.permanent_address || null;
      next.current_pin = next.permanent_pin || null;
    }
    return next;
  });
  return <>
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
        {MONEY_FIELDS.map(([key, label]) => <div key={key}>
          <label className="label" htmlFor={key}>{label}</label>
          <input id={key} type="number" min="0" step="0.01" className="input" value={form[key] ?? ''}
            onChange={e => change(key, e.target.value === '' ? null : Number(e.target.value))} />
        </div>)}
      </div>
      <p className="text-xs text-gray-500 mt-3">Annual CTC and bonus; monthly basic, HRA and deductions. Amounts are entered manually.</p>
    </fieldset>}
  </>;
}
