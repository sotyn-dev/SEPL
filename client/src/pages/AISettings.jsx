import { useState, useEffect } from 'react';
import api from '../api';
import toast from 'react-hot-toast';

// AI Settings (admin only). Pastes the AI API key (Anthropic or Google Gemini)
// into the SOTYN.AI itself — no SSH, no .env edit. Stored server-side in
// app_settings. The key is never sent back to the browser; GET only returns a
// masked version so the page can show "configured" vs "not configured".
export default function AISettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState({ api_key_set: false });
  const [form, setForm] = useState({ provider: 'anthropic', model: 'claude-opus-4-7', api_key: '' });
  // Model list comes from the SERVER, which asks the provider what this key can
  // actually call (mam 2026-08-21: the old hardcoded Gemini options had all been
  // retired by Google, so every choice 404'd and there was no way to type a live
  // one). source==='live' means it came from the provider, 'static' is a fallback.
  const [models, setModels] = useState({ source: 'static', list: [] });
  const [modelsLoading, setModelsLoading] = useState(false);
  // Bumped by save(). status.api_key_set is a BOOLEAN, so saving a new key
  // over an existing one never changed it and the list was never refetched
  // (audit 2026-08-21) — which is exactly mam's flow: an Anthropic key is
  // already stored, so the first Gemini probe runs with the WRONG key, comes
  // back empty, and the dropdown stayed on the static fallback until a remount.
  const [keyRev, setKeyRev] = useState(0);

  useEffect(() => {
    api.get('/ai-agent/settings').then(r => {
      setStatus(r.data);
      setForm(f => ({ ...f, provider: r.data.provider, model: r.data.model }));
    }).catch(e => toast.error(e.response?.data?.error || 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  // Refresh the list whenever the provider changes, and after every save —
  // a freshly pasted key can offer a completely different set of models.
  useEffect(() => {
    let dead = false;
    setModelsLoading(true);
    api.get('/ai-agent/settings/models', { params: { provider: form.provider } })
      .then(r => {
        if (dead) return;
        setModels({ source: r.data.source, list: r.data.models || [] });
        // If the stored model isn't offered any more, move to the first live
        // one so she isn't left staring at a dead selection.
        setForm(f => (r.data.models?.length && !r.data.models.some(m => m.id === f.model)
          ? { ...f, model: r.data.default || r.data.models[0].id } : f));
      })
      .catch(() => { if (!dead) setModels({ source: 'static', list: [] }); })
      .finally(() => { if (!dead) setModelsLoading(false); });
    return () => { dead = true; };
  }, [form.provider, keyRev]);

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = { provider: form.provider, model: form.model };
      if (form.api_key.trim()) payload.api_key = form.api_key.trim();
      await api.put('/ai-agent/settings', payload);
      toast.success('AI settings saved');
      const fresh = await api.get('/ai-agent/settings').then(r => r.data);
      setStatus(fresh);
      setForm(f => ({ ...f, api_key: '' }));
      setKeyRev(v => v + 1);   // re-probe the provider with the key just saved
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  // One-click probe (mam 2026-08-21) — tests the key currently TYPED when
  // there is one, otherwise the stored one, so she never has to save a bad
  // key to find out it's bad. The server never persists what's posted here.
  const runTest = async () => {
    setTesting(true);
    try {
      const payload = { provider: form.provider, model: form.model };
      if (form.api_key.trim()) payload.api_key = form.api_key.trim();
      const r = await api.post('/ai-agent/settings/test', payload);
      toast.success(`${r.data.provider} · ${r.data.model} responded — key works`);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Test failed');
    } finally {
      setTesting(false);
    }
  };

  if (loading) return <div className="text-sm text-gray-500">Loading…</div>;

  return (
    <div className="max-w-2xl space-y-4">
      <div className="card p-4 space-y-3">
        <h3 className="font-semibold text-gray-800">AI Agent — API Key</h3>
        <p className="text-sm text-gray-600">
          Paste your API key here to enable the floating "Ask SOTYN.AI" chat bubble across the system,
          and the AI market rates on Vendor Rates, DPR photo head-count, quotation matching and the procurement schedule.
          The key is stored in the SOTYN.AI database (not in any file), and never sent back to a browser.
          {form.provider === 'gemini'
            ? <> Get a <b>free</b> Gemini key at <a className="text-red-600 hover:underline" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">aistudio.google.com</a> → <b>Get API key</b>. (Free tier has rate limits and may use data to improve Google's products — avoid for highly sensitive queries.)</>
            : <> Get a key at <a className="text-red-600 hover:underline" href="https://console.anthropic.com" target="_blank" rel="noreferrer">console.anthropic.com</a> → Settings → API Keys.</>}
        </p>

        <div className={`text-sm px-3 py-2 rounded ${status.api_key_set ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-yellow-50 text-yellow-800 border border-yellow-200'}`}>
          {status.api_key_set
            ? <>Configured · current key: <span className="font-mono">{status.api_key_masked}</span></>
            : <>Not configured yet — chatbot is disabled until you paste a key below.</>}
        </div>

        <form onSubmit={save} className="space-y-3">
          <div>
            <label className="label">API Key {status.api_key_set && <span className="text-xs text-gray-500 font-normal">(leave blank to keep current)</span>}</label>
            <input
              className="input font-mono text-sm"
              type="password"
              placeholder={form.provider === 'gemini' ? 'AIza...' : 'sk-ant-...'}
              value={form.api_key}
              onChange={e => setForm({ ...form, api_key: e.target.value })}
              autoComplete="off"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Provider</label>
              <select className="select" value={form.provider} onChange={e => {
                const p = e.target.value;
                // Switch the model default to match the provider so a Claude
                // model id isn't sent to Gemini (or vice-versa).
                setForm(f => ({ ...f, provider: p, model: '' }));
              }}>
                <option value="anthropic">Anthropic (Claude) — most capable, paid</option>
                <option value="gemini">Google Gemini — free tier</option>
              </select>
            </div>
            <div>
              <label className="label">Model</label>
              <select className="select" value={form.model} disabled={modelsLoading}
                onChange={e => setForm({ ...form, model: e.target.value })}>
                {modelsLoading && <option value="">Loading models…</option>}
                {/* The stored model may no longer be offered — keep it listed so
                    the box never renders blank while she reads the warning. */}
                {!modelsLoading && form.model && !models.list.some(m => m.id === form.model) &&
                  <option value={form.model}>{form.model} (not available)</option>}
                {models.list.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
              <p className="text-[11px] text-gray-500 mt-1">
                {modelsLoading ? 'Asking the provider which models your key can use…'
                  : models.source === 'live' ? `${models.list.length} model(s) your key can use, newest first.`
                  : status.api_key_set ? 'Could not reach the provider — showing known models.'
                  : 'Save your API key to see the models it can use.'}
              </p>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-secondary" disabled={testing} onClick={runTest}>{testing ? 'Testing…' : 'Test connection'}</button>
            <button type="submit" disabled={saving} className="btn btn-primary">{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      </div>

      <div className="card p-4 text-sm text-gray-600 space-y-2">
        <h4 className="font-semibold text-gray-800">How to use the chatbot</h4>
        <ul className="list-disc pl-5 space-y-1">
          <li>Once configured, every user sees a small chat bubble in the bottom-right corner of every page.</li>
          <li>It can answer questions about leads, customers, items, quotations, POs, payments, DPR, attendance — whatever the data shows.</li>
          <li>Example questions: <span className="italic">"what rate did we give L&T for 1.5T AC last time?"</span> · <span className="italic">"which customers haven't paid in 60 days?"</span> · <span className="italic">"top 5 items by quote volume this quarter"</span></li>
          <li>The chatbot can only READ data — it cannot edit, delete, or send anything.</li>
        </ul>
      </div>
    </div>
  );
}
