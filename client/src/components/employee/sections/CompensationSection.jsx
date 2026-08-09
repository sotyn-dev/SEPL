import WasHint, { FieldError, trackAccent } from '../WasHint';
import { proposeCompensation } from '../../../utils/compensationPropose';
import { ESI_GROSS_CEILING } from '../../../constants/employeeValidation';

// Pay & Compensation — live payroll monthly (`salary` on employees) plus the
// Mandatory Field Spec Module 2 CTC pack (employee_compensation). Whole tab is
// gated behind employee_salary.can_view (hr.js redactCompensation + NAV filter).
//
// Propose/check math lives in utils/compensationPropose.js (mirrored on
// server/lib/compensationPropose.js). Captions only — no Apply / auto-write.
const money = (v) => `₹${Number(v || 0).toLocaleString('en-IN')}`;

export default function CompensationSection({ ws }) {
  const { form, setForm, changedSet, original, revertField } = ws;
  const p = proposeCompensation(form);

  const structureHintLabel = p.proposedMonthlySource === 'gross' ? 'Structure gross' : 'From CTC';
  const structureHintSuffix = p.proposedMonthlySource === 'ctc' ? ' (÷12)' : '';
  const fixedGrossHint = p.ctcMonthly != null ? money(p.ctcMonthly) : null;
  const payrollSeedHint = p.payrollSeedMonthly != null ? money(p.payrollSeedMonthly) : null;
  const ctcSeedHint = p.ctcSeedAnnual != null ? money(p.ctcSeedAnnual) : null;
  const pfHint = p.pfSuggested != null ? money(p.pfSuggested) : null;
  const esiHint = p.esiNotEligible
    ? `Not eligible — exceeds ₹${ESI_GROSS_CEILING.toLocaleString('en-IN')} ceiling`
    : (p.esiSuggested != null ? money(p.esiSuggested) : null);

  const num = (key) => (e) => setForm({ ...form, [key]: e.target.value === '' ? '' : Number(e.target.value) });

  return (
    <div className="space-y-4">
      <div>
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Monthly payroll pay</div>
        <p className="text-[10px] text-gray-400 -mt-1 mb-2">Drives payroll. Structure fields below are the CTC pack — hints only, not auto-applied.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className={trackAccent(changedSet, 'salary')}>
            <label className="label">Salary (₹ / month)</label>
            <input className="input" type="number" min="0" value={form.salary || 0} onChange={(e) => setForm({ ...form, salary: +e.target.value })} />
            {p.proposedMonthly != null && (
              <p className="text-[10px] text-gray-400 mt-0.5">
                {structureHintLabel}: {money(p.proposedMonthly)}{structureHintSuffix}
                {p.salaryDiffers ? ' · Differs from structure' : ''}
              </p>
            )}
            <WasHint k="salary" fmt={money} changedSet={changedSet} original={original} revertField={revertField} />
            <FieldError k="salary" ws={ws} />
          </div>
        </div>
      </div>

      <div className="border-t border-dashed pt-4 !mt-6">
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Salary Structure</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className={trackAccent(changedSet, 'ctc_annual')}>
            <label className="label">CTC Annual (₹)</label>
            <input className="input" type="number" min="0" value={form.ctc_annual ?? ''} onChange={num('ctc_annual')} />
            {ctcSeedHint && <p className="text-[10px] text-gray-400 mt-0.5">≈ {ctcSeedHint} if annualising payroll monthly</p>}
            <WasHint k="ctc_annual" fmt={money} changedSet={changedSet} original={original} revertField={revertField} />
            <FieldError k="ctc_annual" ws={ws} />
          </div>
          <div className={trackAccent(changedSet, 'fixed_monthly_gross')}>
            <label className="label">Fixed Monthly Gross (₹)</label>
            <input className="input" type="number" min="0" value={form.fixed_monthly_gross ?? ''} onChange={num('fixed_monthly_gross')} />
            {fixedGrossHint && <p className="text-[10px] text-gray-400 mt-0.5">Suggested: {fixedGrossHint} (CTC ÷ 12)</p>}
            {payrollSeedHint && <p className="text-[10px] text-gray-400 mt-0.5">Payroll monthly today: {payrollSeedHint}</p>}
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
        <p className="text-[10px] text-gray-400 -mt-1 mb-2">
          The composite split of Fixed Monthly Gross.
          {p.gross > 0 && p.splitPartsSet && (
            <> · Sum {money(p.splitSum)}{p.splitDiffers ? ` · Differs from gross ${money(p.gross)}` : ' · Matches gross'}</>
          )}
        </p>
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
