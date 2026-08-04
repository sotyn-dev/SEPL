import WasHint, { FieldError, trackAccent } from '../WasHint';

// Compensation pack (Mandatory Field Spec, Module 2, 2026-08-04). Whole tab is
// gated behind employee_salary.can_view server-side (see hr.js's
// redactCompensation) and hidden entirely client-side when !canSeeSalary (see
// EmployeeWorkspaceModal.jsx's NAV filter) — the 14 fields simply never arrive
// in `form` for a non-holder, so this component always assumes they're real.
//
// 5 business groups, in the exact order agreed in the plan's "Business
// Grouping & UX" section — each its own dashed-border subsection, identical
// visual pattern to StatutorySection.jsx. Only 3 fields (Fixed Monthly Gross,
// PF Deduction, ESI Deduction) get a computed-hint caption; every other
// field is a plain input with no helper text, per the plan's "hints are
// minimal and load-bearing only" rule — this is NOT a payroll calculator.
const money = (v) => `₹${Number(v || 0).toLocaleString('en-IN')}`;

export default function CompensationSection({ ws }) {
  const { form, setForm, changedSet, original, revertField } = ws;

  const ctc = Number(form.ctc_annual || 0);
  const basic = Number(form.basic_pay || 0);
  const gross = Number(form.fixed_monthly_gross || 0);
  const fixedGrossHint = ctc > 0 ? money(ctc / 12) : null;
  const pfHint = basic > 0 ? money(basic * 0.12) : null;
  const esiHint = gross > 0
    ? (gross <= 21000 ? money(gross * 0.0075) : 'Not eligible — exceeds ₹21,000 ceiling')
    : null;

  const num = (key) => (e) => setForm({ ...form, [key]: e.target.value === '' ? '' : Number(e.target.value) });

  return (
    <div className="space-y-4">
      <div>
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Salary Structure</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className={trackAccent(changedSet, 'ctc_annual')}>
            <label className="label">CTC Annual (₹)</label>
            <input className="input" type="number" min="0" value={form.ctc_annual ?? ''} onChange={num('ctc_annual')} />
            <WasHint k="ctc_annual" fmt={money} changedSet={changedSet} original={original} revertField={revertField} />
            <FieldError k="ctc_annual" ws={ws} />
          </div>
          <div className={trackAccent(changedSet, 'fixed_monthly_gross')}>
            <label className="label">Fixed Monthly Gross (₹)</label>
            <input className="input" type="number" min="0" value={form.fixed_monthly_gross ?? ''} onChange={num('fixed_monthly_gross')} />
            {fixedGrossHint && <p className="text-[10px] text-gray-400 mt-0.5">Suggested: {fixedGrossHint} (CTC ÷ 12)</p>}
            <WasHint k="fixed_monthly_gross" fmt={money} changedSet={changedSet} original={original} revertField={revertField} />
            <FieldError k="fixed_monthly_gross" ws={ws} />
          </div>
          <div className={trackAccent(changedSet, 'variable_bonus')}>
            <label className="label">Variable / Bonus (₹)</label>
            <input className="input" type="number" min="0" value={form.variable_bonus ?? ''} onChange={num('variable_bonus')} />
            <WasHint k="variable_bonus" fmt={money} changedSet={changedSet} original={original} revertField={revertField} />
          </div>
        </div>
      </div>

      <div className="border-t border-dashed pt-4 !mt-6">
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Salary Components</div>
        <p className="text-[10px] text-gray-400 -mt-1 mb-2">The composite split of Fixed Monthly Gross.</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className={trackAccent(changedSet, 'basic_pay')}>
            <label className="label">Basic (₹)</label>
            <input className="input" type="number" min="0" value={form.basic_pay ?? ''} onChange={num('basic_pay')} />
            <WasHint k="basic_pay" fmt={money} changedSet={changedSet} original={original} revertField={revertField} />
          </div>
          <div className={trackAccent(changedSet, 'hra')}>
            <label className="label">HRA (₹)</label>
            <input className="input" type="number" min="0" value={form.hra ?? ''} onChange={num('hra')} />
            <WasHint k="hra" fmt={money} changedSet={changedSet} original={original} revertField={revertField} />
          </div>
          <div className={trackAccent(changedSet, 'special_allowance')}>
            <label className="label">Special Allowance (₹)</label>
            <input className="input" type="number" min="0" value={form.special_allowance ?? ''} onChange={num('special_allowance')} />
            <WasHint k="special_allowance" fmt={money} changedSet={changedSet} original={original} revertField={revertField} />
          </div>
        </div>
      </div>

      <div className="border-t border-dashed pt-4 !mt-6">
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Statutory Deductions</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className={trackAccent(changedSet, 'pf_deduction')}>
            <label className="label">PF Deduction (₹)</label>
            <input className="input" type="number" min="0" value={form.pf_deduction ?? ''} onChange={num('pf_deduction')} />
            {pfHint && <p className="text-[10px] text-gray-400 mt-0.5">Suggested: {pfHint} (12% of Basic)</p>}
            <WasHint k="pf_deduction" fmt={money} changedSet={changedSet} original={original} revertField={revertField} />
          </div>
          <div className={trackAccent(changedSet, 'esi_deduction')}>
            <label className="label">ESI Deduction (₹)</label>
            <input className="input" type="number" min="0" value={form.esi_deduction ?? ''} onChange={num('esi_deduction')} />
            {esiHint && <p className="text-[10px] text-gray-400 mt-0.5">{esiHint.startsWith('Not eligible') ? esiHint : `Suggested: ${esiHint} (0.75% of gross)`}</p>}
            <WasHint k="esi_deduction" fmt={money} changedSet={changedSet} original={original} revertField={revertField} />
          </div>
          <div className={trackAccent(changedSet, 'professional_tax')}>
            <label className="label">Professional Tax (₹)</label>
            <input className="input" type="number" min="0" value={form.professional_tax ?? ''} onChange={num('professional_tax')} />
            <WasHint k="professional_tax" fmt={money} changedSet={changedSet} original={original} revertField={revertField} />
          </div>
          <div className={trackAccent(changedSet, 'tds_estimated_annual')}>
            <label className="label">TDS Estimated Annual (₹)</label>
            <input className="input" type="number" min="0" value={form.tds_estimated_annual ?? ''} onChange={num('tds_estimated_annual')} />
            <WasHint k="tds_estimated_annual" fmt={money} changedSet={changedSet} original={original} revertField={revertField} />
          </div>
        </div>
      </div>

      <div className="border-t border-dashed pt-4 !mt-6">
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Review & Growth</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className={trackAccent(changedSet, 'bonus_target_pct')}>
            <label className="label">Bonus / Variable Target (%)</label>
            <input className="input" type="number" min="0" max="100" value={form.bonus_target_pct ?? ''} onChange={num('bonus_target_pct')} />
            <WasHint k="bonus_target_pct" fmt={(v) => `${v}%`} changedSet={changedSet} original={original} revertField={revertField} />
            <FieldError k="bonus_target_pct" ws={ws} />
          </div>
          <div className={trackAccent(changedSet, 'last_increment_date')}>
            <label className="label">Last Increment Date</label>
            <input className="input" type="date" max={ws.today} value={form.last_increment_date || ''} onChange={(e) => setForm({ ...form, last_increment_date: e.target.value })} />
            <WasHint k="last_increment_date" changedSet={changedSet} original={original} revertField={revertField} />
            <FieldError k="last_increment_date" ws={ws} />
          </div>
          <div className={trackAccent(changedSet, 'salary_review_cycle')}>
            <label className="label">Salary Review Cycle</label>
            <select className="select" value={form.salary_review_cycle || ''} onChange={(e) => setForm({ ...form, salary_review_cycle: e.target.value })}>
              <option value="">Select…</option>
              <option value="Apr-Mar">Apr-Mar</option>
              <option value="Anniversary">Anniversary</option>
            </select>
            <WasHint k="salary_review_cycle" changedSet={changedSet} original={original} revertField={revertField} />
          </div>
        </div>
      </div>

      <div className="border-t border-dashed pt-4 !mt-6">
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Other Compensation</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className={trackAccent(changedSet, 'reimbursements')}>
            <label className="label">Reimbursements (₹)</label>
            <input className="input" type="number" min="0" value={form.reimbursements ?? ''} onChange={num('reimbursements')} />
            <WasHint k="reimbursements" fmt={money} changedSet={changedSet} original={original} revertField={revertField} />
          </div>
        </div>
      </div>
    </div>
  );
}
