import { useState, useEffect } from 'react';
import api from '../../../api';
import WasHint, { FieldError, trackAccent } from '../WasHint';
import { DOC_SLOTS } from '../useEmployeeForm';

// PT State / Bank Name catalogs — server data (org_pt_states / org_banks),
// fetched once and cached at module scope. Same pattern as EmploymentSection's
// fetchGrades().
let ptStatesCache = null, ptStatesPromise = null;
function fetchPtStates() {
  if (ptStatesCache) return Promise.resolve(ptStatesCache);
  if (!ptStatesPromise) ptStatesPromise = api.get('/hr/pt-states').then((r) => { ptStatesCache = r.data; return ptStatesCache; });
  return ptStatesPromise;
}
let banksCache = null, banksPromise = null;
function fetchBanks() {
  if (banksCache) return Promise.resolve(banksCache);
  if (!banksPromise) banksPromise = api.get('/hr/banks').then((r) => { banksCache = r.data; return banksCache; });
  return banksPromise;
}

// Aadhar has NO entry here — unlike PAN, its number is sensitive/masked and
// gets its own dedicated editor further down (the "Aadhaar" block, via
// SensitiveField) rather than a plain inline text box next to the upload.
const NUMBER_FIELD = {
  pan_file: { key: 'pan_number', label: 'PAN Number', placeholder: 'ABCDE1234F', maxLength: 10, uppercase: true },
};

function UploadField({ ws, docSlot }) {
  const { form, setForm } = ws;
  const { key, slot, label } = docSlot;
  const numberField = NUMBER_FIELD[key];
  return (
    <div className={form[slot] ? 'border-l-4 border-blue-400 pl-2' : ''}>
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
}

// Aadhaar and Bank Account Number are always masked — a change is entered
// into a separate shadow key (see useEmployeeForm.js's SENSITIVE_EDIT_SLOT),
// never bound directly to the masked display string. Bank Account additionally
// shows the REAL value as a normal editable input for employee_statutory.can_view
// holders (form.bank_account_number is only ever present for them — see
// redactStatutory in server/routes/hr.js).
function SensitiveField({ ws, label, maskedKey, editKey, placeholder, maxLength, errorKey }) {
  const { form, setForm } = ws;
  return (
    <div>
      <label className="label">{label}</label>
      <input className="input bg-gray-50 text-gray-500" value={form[maskedKey] || 'Not set'} disabled />
      <input
        className="input mt-1.5"
        placeholder={`Enter new ${label.toLowerCase()} to change…`}
        maxLength={maxLength}
        value={form[editKey] || ''}
        onChange={(e) => setForm({ ...form, [editKey]: e.target.value.replace(/\D/g, '').slice(0, maxLength) })}
      />
      {errorKey && <FieldError k={errorKey} ws={ws} />}
    </div>
  );
}

export default function StatutorySection({ ws }) {
  const { form, setForm, changedSet, original, revertField } = ws;
  const [ptStates, setPtStates] = useState(ptStatesCache || []);
  const [banks, setBanks] = useState(banksCache || []);
  useEffect(() => { fetchPtStates().then(setPtStates); fetchBanks().then(setBanks); }, []);

  const bankIsKnown = !form.bank_name || banks.some((b) => b.name === form.bank_name);
  const [bankOther, setBankOther] = useState(!bankIsKnown);

  const canEditBankFull = form.bank_account_number !== undefined;

  return (
    <div className="space-y-4">
      <div>
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">KYC</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <UploadField ws={ws} docSlot={DOC_SLOTS.find((d) => d.key === 'aadhar_file')} />
          <UploadField ws={ws} docSlot={DOC_SLOTS.find((d) => d.key === 'pan_file')} />
        </div>
      </div>

      <div className="border-t border-dashed pt-4 !mt-6">
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">PF / ESI</div>
        <p className="text-[10px] text-gray-400 -mt-1 mb-2">UAN is due within 30 days of joining; PF/ESI numbers are assigned after the first salary run — none of these block Activation.</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className={trackAccent(changedSet, 'uan_number')}>
            <label className="label">UAN</label>
            <input className="input" maxLength={12} value={form.uan_number || ''} onChange={(e) => setForm({ ...form, uan_number: e.target.value.replace(/\D/g, '').slice(0, 12) })} placeholder="12-digit number" />
            <WasHint k="uan_number" changedSet={changedSet} original={original} revertField={revertField} />
            <FieldError k="uan_number" ws={ws} />
          </div>
          <div className={trackAccent(changedSet, 'pf_number')}>
            <label className="label">PF Number</label>
            <input className="input" value={form.pf_number || ''} onChange={(e) => setForm({ ...form, pf_number: e.target.value })} />
            <WasHint k="pf_number" changedSet={changedSet} original={original} revertField={revertField} />
          </div>
          <div className={trackAccent(changedSet, 'esi_number')}>
            <label className="label">ESI Number</label>
            <input className="input" value={form.esi_number || ''} onChange={(e) => setForm({ ...form, esi_number: e.target.value })} />
            <WasHint k="esi_number" changedSet={changedSet} original={original} revertField={revertField} />
          </div>
        </div>
      </div>

      <div className="border-t border-dashed pt-4 !mt-6">
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Bank Details</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className={trackAccent(changedSet, 'bank_name')}>
            <label className="label">Bank Name</label>
            {bankOther ? (
              <>
                <input className="input" value={form.bank_name || ''} onChange={(e) => setForm({ ...form, bank_name: e.target.value })} placeholder="Bank name" />
                <button type="button" onClick={() => { setBankOther(false); setForm({ ...form, bank_name: '' }); }} className="text-[10px] text-gray-400 underline mt-0.5">pick from list instead</button>
              </>
            ) : (
              <select
                className="select"
                value={form.bank_name || ''}
                onChange={(e) => {
                  if (e.target.value === '__other__') { setBankOther(true); setForm({ ...form, bank_name: '' }); }
                  else setForm({ ...form, bank_name: e.target.value });
                }}>
                <option value="">Select…</option>
                {banks.map((b) => <option key={b.id} value={b.name}>{b.name}</option>)}
                <option value="__other__">Other…</option>
              </select>
            )}
            <WasHint k="bank_name" changedSet={changedSet} original={original} revertField={revertField} />
          </div>
          <div className={trackAccent(changedSet, 'bank_branch')}>
            <label className="label">Bank Branch</label>
            <input className="input" value={form.bank_branch || ''} onChange={(e) => setForm({ ...form, bank_branch: e.target.value })} />
            <WasHint k="bank_branch" changedSet={changedSet} original={original} revertField={revertField} />
          </div>
          <div className={trackAccent(changedSet, 'ifsc_code')}>
            <label className="label">IFSC Code</label>
            <input className="input" maxLength={11} value={form.ifsc_code || ''} onChange={(e) => setForm({ ...form, ifsc_code: e.target.value.toUpperCase() })} placeholder="ABCD0123456" />
            <WasHint k="ifsc_code" changedSet={changedSet} original={original} revertField={revertField} />
            <FieldError k="ifsc_code" ws={ws} />
          </div>
          <div className={trackAccent(changedSet, 'pt_state')}>
            <label className="label">PT State</label>
            <select className="select" value={form.pt_state || ''} onChange={(e) => setForm({ ...form, pt_state: e.target.value })}>
              <option value="">Select…</option>
              {ptStates.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
            </select>
            <WasHint k="pt_state" changedSet={changedSet} original={original} revertField={revertField} />
          </div>
          {canEditBankFull ? (
            <div className={trackAccent(changedSet, 'bank_account_number')}>
              <label className="label">Bank Account Number</label>
              <input className="input" value={form.bank_account_number || ''} onChange={(e) => setForm({ ...form, bank_account_number: e.target.value.replace(/\D/g, '').slice(0, 18) })} />
              <WasHint k="bank_account_number" changedSet={changedSet} original={original} revertField={revertField} />
              <FieldError k="bank_account_number" ws={ws} />
            </div>
          ) : (
            <SensitiveField
              ws={ws} label="Bank Account Number"
              maskedKey="bank_account_masked" editKey="_bank_account_number_edit"
              maxLength={18} errorKey="bank_account_number"
            />
          )}
        </div>
      </div>

      <div className="border-t border-dashed pt-4 !mt-6">
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Aadhaar</div>
        <p className="text-[10px] text-gray-400 -mt-1 mb-2">Stored encrypted; only the last 4 digits are ever shown.</p>
        <SensitiveField
          ws={ws} label="Aadhaar Number"
          maskedKey="aadhar_masked" editKey="_aadhar_number_edit"
          maxLength={12} errorKey="aadhar_number"
        />
      </div>

      <div className="border-t border-dashed pt-4 !mt-6">
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">PF / Gratuity Forms</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <UploadField ws={ws} docSlot={DOC_SLOTS.find((d) => d.key === 'form11_file')} />
          <UploadField ws={ws} docSlot={DOC_SLOTS.find((d) => d.key === 'formf_file')} />
        </div>
      </div>
    </div>
  );
}
