import { useEffect, useState } from 'react';
import api from '../api';

export default function EmployeeProfessionalTax({ state, salary }) {
  const [month, setMonth] = useState(() => new Date(Date.now() + 19800000).toISOString().slice(0, 7));
  const [result, setResult] = useState({ amount: null, note: 'Calculating…' });
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      setResult({ amount: null, note: 'Calculating…' });
      api.get('/hr/professional-tax-preview', { params: { state: state || '', salary: salary ?? '', month } })
        .then(r => { if (active) setResult(r.data); })
        .catch(e => { if (active) setResult({ amount: null, note: e.response?.data?.error || 'Could not calculate PT. Please retry.' }); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [state, salary, month]);
  return <div className="sm:col-span-2 rounded-lg bg-blue-50 p-3">
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div><label className="label" htmlFor="employee-pt-month">PT Calculation Month</label>
        <input id="employee-pt-month" type="month" className="input" value={month} onChange={e => setMonth(e.target.value)} /></div>
      <div><label className="label" htmlFor="employee-pt-amount">Professional Tax (Rs/month)</label>
        <input id="employee-pt-amount" className="input" readOnly value={result.amount == null ? '' : result.amount.toFixed(2)} placeholder="Not calculated" /></div>
    </div>
    <p className="text-xs text-gray-600 mt-2" role="status">{result.note}</p>
    <p className="text-xs text-gray-500 mt-1">Estimate for the selected month. This does not change payroll deductions.</p>
  </div>;
}
