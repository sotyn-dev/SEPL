// Public Employee Self-Fill page — no login required.
//
// Mam (2026-08-17): "i create one link like we share with employee that he
// can fill data and comes to here :- /employees". HR generates a tokenized
// link from the Employee Directory (new-joiner or tied to an existing row),
// shares it on WhatsApp/email, and the employee fills their own details +
// uploads documents. Submission lands straight in the Employees page.
//
// Same trust model as the public offer page: the token IS the identity —
// single-use, 7-day expiry, enforced server-side.

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import axios from 'axios';
import employeeSchema from '../../../shared/employeeMaster.json';
const PERSONAL_KEYS = ['date_of_birth', 'gender', 'blood_group', 'emergency_contact_name', 'emergency_contact_phone', 'guardian_title', 'guardian_relation', 'guardian_name'];
const personalFields = employeeSchema.fields.filter(f => PERSONAL_KEYS.includes(f.key));
const emptyPersonal = Object.fromEntries(PERSONAL_KEYS.map(key => [key, '']));

const COMPANY = { name: 'Secured Engineers Pvt. Ltd.' };

const DOCS = [
  { key: 'aadhar_file', has: 'has_aadhar', label: 'Aadhar Card' },
  { key: 'pan_file', has: 'has_pan', label: 'PAN Card' },
  { key: 'qualification_file', has: 'has_qualification', label: 'Highest Qualification Certificate' },
];

export default function PublicEmployeeFill() {
  const { token } = useParams();
  const [mode, setMode] = useState(null);          // 'create' | 'update'
  const [prefill, setPrefill] = useState(null);    // tied-link employee snapshot
  const [err, setErr] = useState(null);
  const [form, setForm] = useState({ ...emptyPersonal, name: '', phone: '', email: '', designation: '', department: '', join_date: '', permanent_address: '', permanent_pin: '', current_address: '', current_pin: '', same_as_permanent: false, aadhaar_last4: '', pan_number: '', bank_ifsc: '', bank_name: '', bank_branch: '', bank_account_no: '' });
  const [files, setFiles] = useState({});          // key -> File
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [ifscStatus, setIfscStatus] = useState('');

  // Bare axios (NOT the auth-aware api instance) — this page runs with no login.
  useEffect(() => {
    axios.get(`/api/public/employee-fill/${token}`)
      .then(r => {
        setMode(r.data.mode);
        const e = r.data.employee;
        setPrefill(e || null);
        if (e) setForm({
          ...Object.fromEntries(PERSONAL_KEYS.map(key => [key, e[key] || ''])),
          name: e.name || '', phone: e.phone || '', email: e.email || '',
          designation: e.designation || '', department: e.department || '', join_date: e.join_date || '',
          permanent_address: e.permanent_address || '', permanent_pin: e.permanent_pin || '',
          current_address: e.current_address || '', current_pin: e.current_pin || '', same_as_permanent: !!e.same_as_permanent,
          aadhaar_last4: '', pan_number: '', bank_ifsc: '', bank_name: '', bank_branch: '', bank_account_no: '',
        });
      })
      .catch(e => setErr(e.response?.data?.error || 'Failed to open this link'));
  }, [token]);

  useEffect(() => {
    const code = form.bank_ifsc;
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(code)) {
      setIfscStatus('Enter an 11-character IFSC to fill bank and branch automatically.');
      return;
    }
    const controller = new AbortController();
    setIfscStatus('Looking up bank and branch…');
    const timer = setTimeout(async () => {
      try {
        const { data } = await axios.get(`/api/public/employee-fill/${token}/ifsc/${code}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setForm(old => old.bank_ifsc === code ? { ...old, bank_name: data.bank || '', bank_branch: data.branch || '' } : old);
        setIfscStatus('Bank and branch filled. Please verify the details.');
      } catch (error) {
        if (!controller.signal.aborted) setIfscStatus(error.response?.data?.error || 'Lookup unavailable. Enter bank and branch manually.');
      }
    }, 400);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [form.bank_ifsc, token]);

  const set = (k) => (e) => setForm(f => {
    const next = { ...f, [k]: ['pan_number', 'bank_ifsc'].includes(k) ? e.target.value.toUpperCase() : e.target.value };
    if (k === 'bank_ifsc') { next.bank_ifsc = next.bank_ifsc.trim(); next.bank_name = ''; next.bank_branch = ''; }
    if (next.same_as_permanent) { next.current_address = next.permanent_address; next.current_pin = next.permanent_pin; }
    return next;
  });
  const setFile = (k) => (e) => setFiles(f => ({ ...f, [k]: e.target.files?.[0] || null }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return setErr('Please enter your full name');
    setErr(null);
    setSubmitting(true);
    try {
      // 1. upload any attached documents through the token-scoped endpoint
      const payload = { ...form };
      for (const d of DOCS) {
        const file = files[d.key];
        if (!file) continue;
        const fd = new FormData();
        fd.append('file', file);
        const r = await axios.post(`/api/public/employee-upload/${token}`, fd,
          { headers: { 'Content-Type': 'multipart/form-data' } });
        payload[d.key] = r.data?.url;
      }
      // 2. submit the details
      await axios.post(`/api/public/employee-fill/${token}`, payload);
      setDone(true);
    } catch (ex) {
      setErr(ex.response?.data?.error || 'Failed to submit — please try again or contact HR');
    } finally {
      setSubmitting(false);
    }
  };

  if (err && !mode) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
        <div className="max-w-md bg-white shadow-lg rounded-lg p-6 text-center">
          <div className="text-5xl mb-3">⚠️</div>
          <h2 className="text-xl font-bold text-red-700 mb-2">Cannot open this link</h2>
          <p className="text-gray-600 text-sm">{err}</p>
          <p className="text-gray-400 text-xs mt-4">If you believe this is a mistake, please contact{' '}
            <a className="text-blue-700" href="mailto:hr@securedengineers.com">hr@securedengineers.com</a>.
          </p>
        </div>
      </div>
    );
  }
  if (!mode) return <div className="min-h-screen flex items-center justify-center text-gray-500">Loading…</div>;

  if (done) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
        <div className="max-w-md bg-white shadow-lg rounded-lg p-8 text-center">
          <div className="text-6xl mb-4">✅</div>
          <h2 className="text-2xl font-bold mb-2">Details submitted</h2>
          <p className="text-gray-700">
            Thank you, {form.name.trim() || 'friend'}! Your details have reached the HR team at {COMPANY.name}.
          </p>
          <p className="text-gray-400 text-xs mt-6">You can close this page now.</p>
        </div>
      </div>
    );
  }

  const isCreate = mode === 'create';
  return (
    <div className="bg-gray-100 min-h-screen py-6 px-3">
      <div className="max-w-[640px] mx-auto bg-white shadow-lg rounded-lg overflow-hidden">
        <div className="bg-gradient-to-r from-blue-700 to-blue-800 text-white p-6 text-center">
          <div className="text-2xl font-bold tracking-wide">{COMPANY.name.toUpperCase()}</div>
          <div className="text-xs opacity-90 mt-1">Employee Details Form</div>
        </div>

        <form onSubmit={submit} className="p-6 space-y-4">
          <p className="text-sm text-gray-600">
            {isCreate
              ? 'Welcome! Please fill in your details below — HR will use these for your records and payroll setup.'
              : 'Please review and complete your details below. Fields you leave blank will keep their current value.'}
          </p>

          <div className="grid sm:grid-cols-2 gap-3">
            <label className="block sm:col-span-2">
              <span className="text-xs font-semibold text-gray-700">Full Name {isCreate && <span className="text-red-600">*</span>}</span>
              <input className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                value={form.name} onChange={set('name')} placeholder="As per Aadhar" required={isCreate} />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-gray-700">Mobile Number {isCreate && <span className="text-red-600">*</span>}</span>
              <input className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                value={form.phone} onChange={set('phone')} inputMode="tel" placeholder="10-digit mobile" required={isCreate} />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-gray-700">Email</span>
              <input className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                value={form.email} onChange={set('email')} type="email" placeholder="you@example.com" />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-gray-700">Designation / Role</span>
              <input className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                value={form.designation} onChange={set('designation')} placeholder="e.g. Site Engineer" />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-gray-700">Department</span>
              <input className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                value={form.department} onChange={set('department')} placeholder="e.g. Projects" />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-gray-700">Joining Date</span>
              <input className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                value={form.join_date} onChange={set('join_date')} type="date" />
            </label>
          </div>

          <fieldset className="border-t border-gray-100 pt-4 space-y-3">
            <legend className="text-sm font-bold text-gray-800 pt-4">Personal and emergency details</legend>
            <div className="grid sm:grid-cols-2 gap-3">
              {personalFields.map(field => <label className="block" key={field.key}>
                <span className="text-xs font-semibold text-gray-700">{field.label}</span>
                {field.options ? <select className="input mt-1" value={form[field.key]} onChange={set(field.key)}>
                  <option value="">Select…</option>
                  {field.options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select> : <input className="input mt-1" type={field.type} value={form[field.key]} onChange={set(field.key)} maxLength={field.type === 'tel' ? 10 : 200} pattern={field.type === 'tel' ? '[0-9]{10}' : undefined} title={field.type === 'tel' ? 'Enter a 10-digit mobile number' : undefined} />}
              </label>)}
            </div>
          </fieldset>

          <fieldset className="border-t border-gray-100 pt-4 space-y-3">
            <legend className="text-sm font-bold text-gray-800 pt-4">Address</legend>
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="block"><span className="text-xs font-semibold text-gray-700">Permanent address</span><textarea className="input mt-1" rows={3} maxLength={2000} value={form.permanent_address} onChange={set('permanent_address')} placeholder="House, street, locality, city and state" /></label>
              <label className="block"><span className="text-xs font-semibold text-gray-700">Permanent PIN code</span><input className="input mt-1" inputMode="numeric" pattern="[1-9][0-9]{5}" maxLength={6} title="Enter a six-digit PIN code that does not start with zero" value={form.permanent_pin} onChange={set('permanent_pin')} /></label>
              <label className="sm:col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={form.same_as_permanent} onChange={e => setForm(f => ({ ...f, same_as_permanent: e.target.checked, ...(e.target.checked ? { current_address: f.permanent_address, current_pin: f.permanent_pin } : {}) }))} />Current address same as permanent address</label>
              <label className="block"><span className="text-xs font-semibold text-gray-700">Current address</span><textarea className="input mt-1 disabled:bg-gray-100" rows={3} maxLength={2000} disabled={form.same_as_permanent} value={form.current_address} onChange={set('current_address')} /></label>
              <label className="block"><span className="text-xs font-semibold text-gray-700">Current PIN code</span><input className="input mt-1 disabled:bg-gray-100" inputMode="numeric" pattern="[1-9][0-9]{5}" maxLength={6} title="Enter a six-digit PIN code that does not start with zero" disabled={form.same_as_permanent} value={form.current_pin} onChange={set('current_pin')} /></label>
            </div>
          </fieldset>

          <fieldset className="border-t border-gray-100 pt-4 space-y-3">
            <legend className="text-sm font-bold text-gray-800 pt-4">Salary bank account</legend>
            <p className="text-xs text-gray-500">Enter details as printed in your bank passbook. {prefill?.has_bank_details ? 'Bank details are already on file. Leave these fields blank to keep them.' : 'HR will review these for payroll setup.'}</p>
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="block"><span className="text-xs font-semibold text-gray-700">IFSC code</span><input className="input mt-1" value={form.bank_ifsc} onChange={set('bank_ifsc')} pattern="[A-Z]{4}0[A-Z0-9]{6}" maxLength={11} title="Enter a valid 11-character IFSC code" placeholder="e.g. SBIN0001234" /><small className="block mt-1 text-gray-500" aria-live="polite">{ifscStatus}</small></label>
              <label className="block"><span className="text-xs font-semibold text-gray-700">Bank name</span><input className="input mt-1" value={form.bank_name} onChange={set('bank_name')} maxLength={200} /></label>
              <label className="block"><span className="text-xs font-semibold text-gray-700">Bank branch</span><input className="input mt-1" value={form.bank_branch} onChange={set('bank_branch')} maxLength={200} /></label>
              <label className="block"><span className="text-xs font-semibold text-gray-700">Bank account number</span><input className="input mt-1" inputMode="numeric" value={form.bank_account_no} onChange={set('bank_account_no')} pattern="[0-9]{6,20}" maxLength={20} title="Enter 6 to 20 digits" autoComplete="off" /></label>
            </div>
          </fieldset>

          <div className="border-t border-gray-100 pt-4 space-y-3">
            <div className="text-sm font-bold text-gray-800">Documents {isCreate && <span className="text-xs font-normal text-gray-500">(all three required)</span>}</div>
            {DOCS.map(d => (
              <div key={d.key} className="rounded-lg border border-gray-200 p-3 space-y-3">
                {d.key === 'aadhar_file' && <label className="block"><span className="text-xs font-semibold text-gray-700">Aadhaar number — last 4 digits only</span><input className="input mt-1" value={form.aadhaar_last4} onChange={set('aadhaar_last4')} inputMode="numeric" pattern="[0-9]{4}" maxLength={4} title="Enter only the last four digits" autoComplete="off" /><p className="text-xs text-gray-500 mt-1">The full Aadhaar number is not stored. {prefill?.has_aadhaar_number ? 'Already on file; leave blank to keep it.' : ''}</p></label>}
                {d.key === 'pan_file' && <label className="block"><span className="text-xs font-semibold text-gray-700">PAN number</span><input className="input mt-1" value={form.pan_number} onChange={set('pan_number')} pattern="[A-Z]{5}[0-9]{4}[A-Z]" maxLength={10} title="Five letters, four digits and one letter" placeholder="ABCDE1234F" autoComplete="off" />{prefill?.has_pan_number && <p className="text-xs text-gray-500 mt-1">Already on file; leave blank to keep it.</p>}</label>}
              <label className="block">
                <span className="text-xs font-semibold text-gray-700">
                  {d.label} {isCreate && <span className="text-red-600">*</span>}
                  {!isCreate && prefill?.[d.has] && <span className="ml-2 text-[10px] text-emerald-700 font-normal">✓ already on file — upload only to replace</span>}
                </span>
                <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={setFile(d.key)}
                  required={isCreate}
                  className="mt-1 block w-full text-xs text-gray-600 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-blue-50 file:text-blue-700 file:text-xs file:font-semibold hover:file:bg-blue-100" />
              </label>
              </div>
            ))}
            <p className="text-[11px] text-gray-400">JPG / PNG / WEBP photos or PDF, up to 20 MB each. A clear phone photo is fine.</p>
          </div>

          {err && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</div>}

          <button type="submit" disabled={submitting}
            className="w-full py-3 rounded-lg font-bold text-white bg-blue-700 hover:bg-blue-800 transition disabled:opacity-50">
            {submitting ? 'Submitting…' : 'Submit My Details'}
          </button>
          <p className="text-[11px] text-gray-500 text-center">
            This link works once. Your details go directly to the HR team at {COMPANY.name}.
          </p>
        </form>
      </div>
    </div>
  );
}
