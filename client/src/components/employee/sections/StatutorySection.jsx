import { useState, useEffect } from 'react';
import { FiEdit, FiEdit2, FiExternalLink } from 'react-icons/fi';
import api from '../../../api';
import WasHint, { FieldError, trackAccent } from '../WasHint';

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

// A read-only pointer to the matching upload in Documents — Statutory owns
// the DATA, Documents owns the FILE (dme 2026-08-04), so this is a link, not
// an upload control. `form[fileKey]` is still populated here even though
// aadhar_file/pan_file aren't part of the `statutory` section's own field
// list — `form` carries the whole employee row regardless of which section
// is currently being edited.
function DocLink({ ws, fileKey, label }) {
  const url = ws.form[fileKey];
  return (
    <p className="text-[10px] text-gray-400 mt-1">
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline">
          <FiExternalLink size={10} /> View {label} <span className="text-gray-400">(in Documents)</span>
        </a>
      ) : (
        <>No {label} uploaded yet — add it in the Documents tab.</>
      )}
    </p>
  );
}

// Aadhaar and Bank Account Number are always masked — a change is entered
// into a separate shadow key (see useEmployeeForm.js's SENSITIVE_EDIT_SLOT),
// never bound directly to the masked display string. Bank Account additionally
// shows the REAL value as a normal editable input for employee_statutory.can_view
// holders (form.bank_account_number is only ever present for them — see
// redactStatutory in server/routes/hr.js).
function SensitiveField({ ws, label, maskedKey, editKey, maxLength, errorKey }) {
  const { form, setForm } = ws;
  const [editing, setEditing] = useState(false);
  const cancelEdit = () => {
    setForm({
      ...form,
      [editKey]: '',
    });
    setEditing(false);
  };

  return (
    <div>
      <label className="label">{label}</label>
      <div className="flex items-center gap-2 flex-wrap">
        <input
          className="py-2 bg-transparent border-0 text-gray-500 !text-sm font-semibold w-[120px]"
          value={form[maskedKey] || 'Not set'}
          disabled
        />
        {!editing ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-xs p-1.5 rounded-md border border-gray-200 hover:bg-gray-50"
            onClick={() => setEditing(true)}
          >
            <FiEdit2 width={16} /> Edit
          </button>
        ) : null }
        { editing ? (
          <div className="flex items-center gap-1 max-md:w-full max-md:mb-1">
            <span className="text-gray-500 text-xs shrink-0 max-md:hidden">→</span>
            <input
              className="input !h-9 w-[160px]"
              placeholder="New number…"
              maxLength={maxLength}
              value={form[editKey] || ''}
              onChange={(e) => setForm({ ...form, [editKey]: e.target.value.replace(/\D/g, '').slice(0, maxLength) })}
            />
            <button
              type="button"
              className="text-xs p-1.5 rounded-md border border-gray-200 hover:bg-gray-50"
              onClick={cancelEdit}
            >
              Cancel
            </button>
          </div>
        ): null }
      </div>
      {errorKey && <FieldError k={errorKey} ws={ws} />}
      {editing && (
        <p className="text-[10px] text-gray-400 mt-0.5">Current value shown masked on the left; type a replacement on the right to change it.</p>
      )}
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
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Identity & KYC</div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="lg:col-span-2">
            <SensitiveField ws={ws} label="Aadhaar Number" maskedKey="aadhar_masked" editKey="_aadhar_number_edit" maxLength={12} errorKey="aadhar_number" />
            <p className="text-[10px] text-gray-400 mt-1">Aadhaar is stored encrypted; only the last 4 digits are ever shown.</p>
            <DocLink ws={ws} fileKey="aadhar_file" label="Aadhar Card" />
          </div>
          <div className={trackAccent(changedSet, 'pan_number')}>
            <label className="label">PAN Number</label>
            <input className="input" maxLength={10} value={form.pan_number || ''} onChange={(e) => setForm({ ...form, pan_number: e.target.value.toUpperCase().slice(0, 10) })} placeholder="ABCDE1234F" />
            <WasHint k="pan_number" changedSet={changedSet} original={original} revertField={revertField} />
            <FieldError k="pan_number" ws={ws} />
            <DocLink ws={ws} fileKey="pan_file" label="PAN Card" />
          </div>
        </div>
      </div>

      <div className="border-t border-dashed pt-4 !mt-6">
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Government Registrations</div>
        <p className="text-[10px] text-gray-400 -mt-1 mb-2">UAN is due within 30 days of joining; PF/ESI numbers are assigned after the first salary run — none of these block Activation.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className={trackAccent(changedSet, 'uan_number')}>
            <label className="label">UAN</label>
            <input className="input" maxLength={12} value={form.uan_number || ''} onChange={(e) => setForm({ ...form, uan_number: e.target.value.replace(/\D/g, '').slice(0, 12) })} placeholder="12-digit number" />
            <WasHint k="uan_number" changedSet={changedSet} original={original} revertField={revertField} />
            <FieldError k="uan_number" ws={ws} />
          </div>
          <div className={trackAccent(changedSet, 'pf_number')}>
            <label className="label">PF Number</label>
            <input className="input" value={form.pf_number || ''} onChange={(e) => setForm({ ...form, pf_number: e.target.value.toUpperCase() })} placeholder="RR/OOO/1234567/000/1234567" />
            <WasHint k="pf_number" changedSet={changedSet} original={original} revertField={revertField} />
            <FieldError k="pf_number" ws={ws} />
          </div>
          <div className={trackAccent(changedSet, 'esi_number')}>
            <label className="label">ESI Number</label>
            <input className="input" maxLength={17} value={form.esi_number || ''} onChange={(e) => setForm({ ...form, esi_number: e.target.value.replace(/\D/g, '').slice(0, 17) })} placeholder="17-digit number" />
            <WasHint k="esi_number" changedSet={changedSet} original={original} revertField={revertField} />
            <FieldError k="esi_number" ws={ws} />
          </div>
          <div className={trackAccent(changedSet, 'pt_state')}>
            <label className="label">PT State</label>
            <select className="select" value={form.pt_state || ''} onChange={(e) => setForm({ ...form, pt_state: e.target.value })}>
              <option value="">Select…</option>
              {ptStates.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
            </select>
            <WasHint k="pt_state" changedSet={changedSet} original={original} revertField={revertField} />
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
    </div>
  );
}
