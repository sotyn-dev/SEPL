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
  const [form, setForm] = useState({ name: '', phone: '', email: '', designation: '', department: '', join_date: '' });
  const [files, setFiles] = useState({});          // key -> File
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  // Bare axios (NOT the auth-aware api instance) — this page runs with no login.
  useEffect(() => {
    axios.get(`/api/public/employee-fill/${token}`)
      .then(r => {
        setMode(r.data.mode);
        const e = r.data.employee;
        setPrefill(e || null);
        if (e) setForm({
          name: e.name || '', phone: e.phone || '', email: e.email || '',
          designation: e.designation || '', department: e.department || '', join_date: e.join_date || '',
        });
      })
      .catch(e => setErr(e.response?.data?.error || 'Failed to open this link'));
  }, [token]);

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));
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

          <div className="border-t border-gray-100 pt-4 space-y-3">
            <div className="text-sm font-bold text-gray-800">Documents {isCreate && <span className="text-xs font-normal text-gray-500">(all three required)</span>}</div>
            {DOCS.map(d => (
              <label key={d.key} className="block">
                <span className="text-xs font-semibold text-gray-700">
                  {d.label} {isCreate && <span className="text-red-600">*</span>}
                  {!isCreate && prefill?.[d.has] && <span className="ml-2 text-[10px] text-emerald-700 font-normal">✓ already on file — upload only to replace</span>}
                </span>
                <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={setFile(d.key)}
                  required={isCreate}
                  className="mt-1 block w-full text-xs text-gray-600 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-blue-50 file:text-blue-700 file:text-xs file:font-semibold hover:file:bg-blue-100" />
              </label>
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
