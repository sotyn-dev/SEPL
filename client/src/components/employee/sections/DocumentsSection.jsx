import { DOC_SLOTS } from '../useEmployeeForm';

// The ONE repository of uploaded files (dme 2026-08-04) — every upload
// control lives here, regardless of which business area it supports.
// Statutory's KYC/Bank fields reference these files with a read-only "View"
// link, but never render an upload control of their own — one source of
// truth for files, one for data.
function UploadField({ ws, docSlot }) {
  const { form, setForm } = ws;
  const { key, slot, label } = docSlot;
  return (
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
  );
}

const slot = (key) => DOC_SLOTS.find((d) => d.key === key);

export default function DocumentsSection({ ws }) {
  return (
    <div className="space-y-4">
      <div>
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">KYC</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <UploadField ws={ws} docSlot={slot('aadhar_file')} />
          <UploadField ws={ws} docSlot={slot('pan_file')} />
          <UploadField ws={ws} docSlot={slot('qualification_file')} />
        </div>
      </div>

      <div className="border-t border-dashed pt-4 !mt-6">
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Statutory Forms</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <UploadField ws={ws} docSlot={slot('form11_file')} />
          <UploadField ws={ws} docSlot={slot('formf_file')} />
        </div>
      </div>
    </div>
  );
}
