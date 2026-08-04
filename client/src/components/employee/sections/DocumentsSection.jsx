import { DOC_SLOTS } from '../useEmployeeForm';

// KYC (Aadhar/PAN) moved to StatutorySection.jsx (2026-08-04) — this section
// is now just the qualification certificate, the one upload with no
// statutory/compliance angle.
const QUALIFICATION_SLOT = DOC_SLOTS.find((d) => d.key === 'qualification_file');

export default function DocumentsSection({ ws }) {
  const { form, setForm } = ws;
  const { key, slot, label } = QUALIFICATION_SLOT;
  return (
    <div className="border rounded-md px-3 py-4 bg-amber-50/40 border-amber-400 space-y-4 !shadow-none">
      <div className="text-xs font-semibold text-amber-800 uppercase tracking-wide">Documents</div>
      <div className={form[slot] ? 'border-l-4 border-blue-400 pl-2' : ''}>
        <label className="label">{label} <span className="text-gray-400 font-normal text-[10px]">(PDF / JPG / PNG, max 10 MB)</span></label>
        <input
          className="input"
          type="file"
          accept=".pdf,.jpg,.jpeg,.png"
          onChange={(e) => setForm({ ...form, [slot]: e.target.files?.[0] || null })}
        />
        {form[key] && !form[slot] && (
          <p className="text-[10px] text-emerald-600 mt-0.5">
            Existing: <a href={form[key]} target="_blank" rel="noreferrer" className="underline">view file</a> · upload to replace
          </p>
        )}
        {form[slot] && (
          <p className="text-[10px] text-blue-600 mt-0.5 flex items-center gap-1.5">
            Selected: {form[slot].name}
            <button type="button" onClick={() => setForm({ ...form, [slot]: null })} className="underline hover:text-blue-900">revert</button>
          </p>
        )}
      </div>
    </div>
  );
}
