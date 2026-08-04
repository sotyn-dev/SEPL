import { FieldError } from '../WasHint';
import { DOC_SLOTS } from '../useEmployeeForm';

// The number field that pairs with a doc slot, if any — the file is the
// proof, the number is the searchable/verifiable data. Only Aadhar/PAN have
// one; qualification has no equivalent government number.
const NUMBER_FIELD = {
  aadhar_file: { key: 'aadhar_number', label: 'Aadhar Number', placeholder: '12-digit number', maxLength: 12, digitsOnly: true },
  pan_file: { key: 'pan_number', label: 'PAN Number', placeholder: 'ABCDE1234F', maxLength: 10, uppercase: true },
};

// Linked-login lives in the Workspace header now, not here (2026-08-04) —
// see EmployeeWorkspaceModal's UserLinkBar. This section is KYC docs only.
export default function DocumentsSection({ ws }) {
  const { form, setForm } = ws;
  return (
    <div className="border rounded-md px-3 py-4 bg-amber-50/40 border-amber-400 space-y-4 !shadow-none">
      <div className="text-xs font-semibold text-amber-800 uppercase tracking-wide">KYC documents</div>
      {DOC_SLOTS.map(({ key, slot, label }) => {
        const numberField = NUMBER_FIELD[key];
        return (
          <div key={key} className={form[slot] ? 'border-l-4 border-blue-400 pl-2' : ''}>
            {numberField && (
              <div className="mb-2">
                <label className="label">{numberField.label}</label>
                <input
                  className="input"
                  maxLength={numberField.maxLength}
                  value={form[numberField.key] || ''}
                  placeholder={numberField.placeholder}
                  onChange={(e) => {
                    let v = e.target.value;
                    if (numberField.digitsOnly) v = v.replace(/\D/g, '');
                    if (numberField.uppercase) v = v.toUpperCase();
                    setForm({ ...form, [numberField.key]: v.slice(0, numberField.maxLength) });
                  }}
                />
                <FieldError k={numberField.key} ws={ws} />
              </div>
            )}
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
        );
      })}
    </div>
  );
}
