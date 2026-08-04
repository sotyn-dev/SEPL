import { DOC_SLOTS } from '../useEmployeeForm';

// Linked-login lives in the Workspace header now, not here (2026-08-04) —
// see EmployeeWorkspaceModal's UserLinkBar. This section is KYC docs only.
export default function DocumentsSection({ ws }) {
  const { form, setForm } = ws;
  return (
    <div className="card p-3 bg-amber-50/40 border-l-4 border-amber-400 space-y-3 !shadow-none">
      <div className="text-xs font-semibold text-amber-800 uppercase tracking-wide">KYC documents</div>
      {DOC_SLOTS.map(({ key, slot, label }) => (
        <div key={key} className={form[slot] ? 'border-l-4 border-blue-400 pl-2' : ''}>
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
      ))}
    </div>
  );
}
