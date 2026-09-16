import { useState, useEffect } from 'react';
import api from '../api';
import toast from 'react-hot-toast';

// Email Settings (admin only). SMTP credentials stored in app_settings;
// used by the DPR loss-streak alert (mam: "send notification on mail to
// director@securedengineers.com if one site loss continues three days").
//
// For Gmail: host=smtp.gmail.com, port=587, secure off; user=full email
// address; pass=16-char App Password from Google → Manage your Account →
// Security → 2-Step → App Passwords. A plain Gmail password will NOT work.
// Extra sending mailboxes — Customer Care, Sales, Accounts … Each has its own
// login, and an email trigger picks which one sends it (mam 2026-09-12).
const BLANK_ACCOUNT = { label: '', from_address: '', smtp_host: 'smtp.gmail.com', smtp_port: 587, smtp_secure: false, smtp_user: '', pass: '', active: true };

function MailAccounts() {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(null);      // null = not editing
  const [busy, setBusy] = useState(false);
  const [testTo, setTestTo] = useState('');
  const load = () => api.get('/ai-agent/email-accounts').then(r => setRows(r.data || [])).catch(() => setRows([]));
  useEffect(() => { load(); }, []);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (form.id) await api.put(`/ai-agent/email-accounts/${form.id}`, form);
      else await api.post('/ai-agent/email-accounts', form);
      toast.success('Mail account saved');
      setForm(null); await load();
    } catch (err) { toast.error(err.response?.data?.error || 'Could not save'); }
    finally { setBusy(false); }
  };
  const remove = async (a) => {
    if (!confirm(`Remove the mailbox "${a.label}" (${a.from_address})?`)) return;
    try { await api.delete(`/ai-agent/email-accounts/${a.id}`); toast.success('Removed'); await load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Could not remove'); }
  };
  const test = async (a) => {
    const to = (testTo || '').trim();
    if (!to) return toast.error('Type the address to send the test to');
    try {
      const r = await api.post(`/ai-agent/email-accounts/${a.id}/test`, { to });
      toast.success(r.data?.message || 'Sent');
    } catch (err) { toast.error(err.response?.data?.error || 'Send failed'); }
  };

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="font-bold text-gray-800">Mail accounts</h3>
          <p className="text-xs text-gray-500">Extra mailboxes that can send — Customer Care, Sales, Accounts. Each email trigger picks the one it sends from; the SMTP account above stays the default.</p>
        </div>
        <button type="button" className="btn btn-primary text-sm" onClick={() => setForm({ ...BLANK_ACCOUNT })}>+ Add mailbox</button>
      </div>

      {rows.length === 0 && <p className="text-sm text-gray-400">No extra mailbox yet — every trigger sends from the default account above.</p>}

      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-gray-500 text-xs uppercase border-b"><th className="text-left py-1">Name</th><th className="text-left">From</th><th className="text-left">Login</th><th className="text-left">Password</th><th></th></tr></thead>
            <tbody>
              {rows.map(a => (
                <tr key={a.id} className="border-b last:border-0">
                  <td className="py-1.5 font-semibold">{a.label}{!a.active && <span className="ml-1 text-[10px] text-gray-400">(off)</span>}</td>
                  <td className="text-gray-700">{a.from_address}</td>
                  <td className="text-gray-500 text-xs">{a.smtp_user}<div className="text-[10px] text-gray-400">{a.smtp_host}:{a.smtp_port}</div></td>
                  <td className="text-gray-400 text-xs">{a.pass_masked}</td>
                  <td className="text-right whitespace-nowrap">
                    <button type="button" className="text-xs text-blue-600 hover:underline mr-2" onClick={() => setForm({ ...a, pass: '' })}>Edit</button>
                    <button type="button" className="text-xs text-emerald-700 hover:underline mr-2" onClick={() => test(a)}>Send test</button>
                    <button type="button" className="text-xs text-red-600 hover:underline" onClick={() => remove(a)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex gap-2 items-end mt-2">
            <div className="flex-1 max-w-xs"><label className="label">Test address</label><input className="input" type="email" value={testTo} onChange={e => setTestTo(e.target.value)} placeholder="your@address.com" /></div>
            <p className="text-[11px] text-gray-400 pb-2">Type an address, then press “Send test” on a mailbox.</p>
          </div>
        </div>
      )}

      {form && (
        <form onSubmit={save} className="border rounded-lg p-3 space-y-3 bg-gray-50">
          <div className="font-semibold text-sm">{form.id ? `Edit ${form.label}` : 'New mailbox'}</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><label className="label">Name *</label><input className="input" placeholder="Customer Care" value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} required /></div>
            <div><label className="label">From address *</label><input className="input" type="email" placeholder="customercare@securedengineers.com" value={form.from_address} onChange={e => setForm({ ...form, from_address: e.target.value })} required /></div>
            <div><label className="label">SMTP host *</label><input className="input" value={form.smtp_host} onChange={e => setForm({ ...form, smtp_host: e.target.value })} required /></div>
            <div><label className="label">Port</label><input className="input" type="number" value={form.smtp_port} onChange={e => setForm({ ...form, smtp_port: +e.target.value })} /></div>
            <div><label className="label">Username (full email) *</label><input className="input" value={form.smtp_user} onChange={e => setForm({ ...form, smtp_user: e.target.value })} required /></div>
            <div>
              <label className="label">App password {form.id && <span className="text-xs font-normal text-gray-400">(blank = keep current)</span>}</label>
              <input className="input" type="password" value={form.pass} onChange={e => setForm({ ...form, pass: e.target.value })} placeholder="16-character Gmail App Password" required={!form.id} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-xs cursor-pointer"><input type="checkbox" checked={!!form.smtp_secure} onChange={e => setForm({ ...form, smtp_secure: e.target.checked })} /> Use TLS/SSL (port 465)</label>
            <label className="flex items-center gap-2 text-xs cursor-pointer"><input type="checkbox" checked={form.active !== false} onChange={e => setForm({ ...form, active: e.target.checked })} /> Active</label>
          </div>
          <p className="text-[11px] text-gray-500">Gmail needs an <b>App Password</b> (not the login password), and the From address must be this mailbox or one of its verified aliases.</p>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => setForm(null)}>Cancel</button>
            <button type="submit" disabled={busy} className="btn btn-primary">{busy ? 'Saving…' : 'Save mailbox'}</button>
          </div>
        </form>
      )}
    </div>
  );
}

export default function EmailSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [data, setData] = useState({ pass_set: false });
  const [form, setForm] = useState({ host: '', port: '587', secure: false, user: '', pass: '', from: '', director_to: '' });
  const [testTo, setTestTo] = useState('');

  useEffect(() => {
    api.get('/ai-agent/email-settings').then(r => {
      setData(r.data);
      setForm(f => ({ ...f, host: r.data.host || '', port: r.data.port || '587', secure: !!r.data.secure, user: r.data.user || '', from: r.data.from || '', director_to: r.data.director_to || '' }));
      setTestTo(r.data.director_to || '');
    }).catch(e => toast.error(e.response?.data?.error || 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = { ...form };
      if (!payload.pass) delete payload.pass; // blank keeps current
      await api.put('/ai-agent/email-settings', payload);
      toast.success('Email settings saved');
      const fresh = await api.get('/ai-agent/email-settings').then(r => r.data);
      setData(fresh); setForm(f => ({ ...f, pass: '' }));
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    } finally { setSaving(false); }
  };

  const sendTest = async () => {
    if (!testTo.trim()) { toast.error('Enter a test recipient'); return; }
    setTesting(true);
    try {
      const { data } = await api.post('/ai-agent/email-test', { to: testTo.trim() });
      toast.success(data.message || 'Test email sent');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Test failed');
    } finally { setTesting(false); }
  };

  if (loading) return <div className="text-sm text-gray-500">Loading…</div>;

  return (
    <div className="max-w-2xl space-y-4">
      <div className="card p-4 space-y-3">
        <h3 className="font-semibold text-gray-800">Email Alerts — SMTP</h3>
        <p className="text-sm text-gray-600">
          Used by the DPR loss-streak alert (auto-emails the director when any site has loss for 3+ consecutive days).
          For Gmail: host <code>smtp.gmail.com</code>, port <code>587</code>, user = your full email, password = a 16-character
          App Password from Google (regular passwords will not work).
        </p>

        <div className={`text-sm px-3 py-2 rounded ${data.pass_set ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-yellow-50 text-yellow-800 border border-yellow-200'}`}>
          {data.pass_set
            ? <>SMTP configured · password ending: <span className="font-mono">{data.pass_masked}</span></>
            : 'SMTP not configured — loss-streak alerts are stored but not emailed until you set this up.'}
        </div>

        <form onSubmit={save} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><label className="label">SMTP Host</label><input className="input" placeholder="smtp.gmail.com" value={form.host} onChange={e => setForm({ ...form, host: e.target.value })} /></div>
            <div><label className="label">Port</label><input className="input" placeholder="587" value={form.port} onChange={e => setForm({ ...form, port: e.target.value })} /></div>
            <div className="flex items-center gap-2 mt-7">
              <input id="secure" type="checkbox" checked={form.secure} onChange={e => setForm({ ...form, secure: e.target.checked })} className="w-4 h-4" />
              <label htmlFor="secure" className="text-sm">Use TLS/SSL (port 465)</label>
            </div>
            <div><label className="label">Username (full email)</label><input className="input" placeholder="dme@securedengineers.com" value={form.user} onChange={e => setForm({ ...form, user: e.target.value })} /></div>
            <div className="sm:col-span-2"><label className="label">Password / App Password {data.pass_set && <span className="text-xs text-gray-400 font-normal">(leave blank to keep current)</span>}</label><input className="input font-mono text-sm" type="password" placeholder="•••••••• (Gmail App Password is 16 chars)" value={form.pass} onChange={e => setForm({ ...form, pass: e.target.value })} autoComplete="off" /></div>
            <div><label className="label">From address <span className="text-xs text-gray-400 font-normal">(optional)</span></label><input className="input" placeholder="SOTYN.AI <dme@securedengineers.com>" value={form.from} onChange={e => setForm({ ...form, from: e.target.value })} /></div>
            <div><label className="label">Director email (recipient)</label><input className="input" type="email" placeholder="director@securedengineers.com" value={form.director_to} onChange={e => setForm({ ...form, director_to: e.target.value })} /></div>
          </div>
          <div className="flex justify-end">
            <button type="submit" disabled={saving} className="btn btn-primary">{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </form>

        <div className="border-t pt-3 space-y-2">
          <h4 className="font-semibold text-sm text-gray-800">Test</h4>
          <div className="flex gap-2 items-end">
            <div className="flex-1"><label className="label">Send test email to</label><input className="input" type="email" value={testTo} onChange={e => setTestTo(e.target.value)} /></div>
            <button onClick={sendTest} disabled={testing || !data.pass_set} className="btn btn-secondary">{testing ? 'Sending…' : 'Send test'}</button>
          </div>
          {!data.pass_set && <p className="text-xs text-gray-400">Save your SMTP settings before testing.</p>}
        </div>
      </div>

      <MailAccounts />
    </div>
  );
}
