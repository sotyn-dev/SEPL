import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { leadFunnel } from '../api';

// Admin settings for the Lead-to-Dispatch Funnel: keyword include/exclude
// lists, the AI scope prompt, the global margin %, the Twilio template SIDs,
// and the IndiaMART Pull API key (masked, like AISettings). All persisted in
// the funnel DB's l2d_settings — never the main ERP.
const linesToArr = (s) => (s || '').split('\n').map(x => x.trim()).filter(Boolean);
const arrToLines = (json) => { try { const a = JSON.parse(json || '[]'); return Array.isArray(a) ? a.join('\n') : ''; } catch { return ''; } };

export default function L2DIndiamartSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [polling, setPolling] = useState(false);
  const [keyState, setKeyState] = useState({ set: false, masked: null });
  const [form, setForm] = useState({
    keyword_include: '', keyword_exclude: '', ai_scope_prompt: '', margin_pct: '0',
    welcome_priced_template_sid: '', welcome_unpriced_template_sid: '',
    bank_template_sid: '', followup_template_sid: '', indiamart_crm_key: '',
  });

  useEffect(() => {
    leadFunnel.getSettings()
      .then(d => {
        setKeyState({ set: d.indiamart_crm_key_set, masked: d.indiamart_crm_key_masked });
        setForm(f => ({
          ...f,
          keyword_include: arrToLines(d.keyword_include),
          keyword_exclude: arrToLines(d.keyword_exclude),
          ai_scope_prompt: d.ai_scope_prompt || '',
          margin_pct: d.margin_pct || '0',
          welcome_priced_template_sid:   d.welcome_priced_template_sid   || '',
          welcome_unpriced_template_sid: d.welcome_unpriced_template_sid || '',
          bank_template_sid: d.bank_template_sid || '',
          followup_template_sid: d.followup_template_sid || '',
          indiamart_crm_key: '',
        }));
      })
      .catch(e => toast.error(e.response?.data?.error || 'Failed to load settings'))
      .finally(() => setLoading(false));
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        keyword_include: linesToArr(form.keyword_include),
        keyword_exclude: linesToArr(form.keyword_exclude),
        ai_scope_prompt: form.ai_scope_prompt,
        margin_pct: String(form.margin_pct || '0'),
        welcome_priced_template_sid:   form.welcome_priced_template_sid,
        welcome_unpriced_template_sid: form.welcome_unpriced_template_sid,
        bank_template_sid: form.bank_template_sid,
        followup_template_sid: form.followup_template_sid,
      };
      if (form.indiamart_crm_key.trim()) payload.indiamart_crm_key = form.indiamart_crm_key.trim();
      await leadFunnel.saveSettings(payload);
      toast.success('Settings saved');
      const fresh = await leadFunnel.getSettings();
      setKeyState({ set: fresh.indiamart_crm_key_set, masked: fresh.indiamart_crm_key_masked });
      setForm(f => ({ ...f, indiamart_crm_key: '' }));
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    } finally { setSaving(false); }
  };

  const runPoll = async () => {
    setPolling(true);
    try {
      const r = await leadFunnel.runPollNow();
      if (r.skipped === 'no_key') toast('No IndiaMART key configured — poller made no API call.', { icon: 'ℹ️' });
      else if (r.code === 429) toast.error('IndiaMART rate-limited (429). Try again in a few minutes.');
      else if (r.code === 401) toast.error('IndiaMART key invalid/expired (401). Regenerate it.');
      else toast.success(`Poll complete — fetched ${r.fetched ?? 0}, ingested ${r.ingested ?? 0}.`);
    } catch (e) { toast.error(e.response?.data?.error || 'Poll failed'); }
    finally { setPolling(false); }
  };

  if (loading) return <div className="text-sm text-gray-500">Loading…</div>;

  return (
    <div className="max-w-2xl space-y-4">
      <form onSubmit={save} className="card p-4 space-y-4">
        <h3 className="font-semibold text-gray-800">Lead Funnel (IndiaMART) Settings</h3>

        <div>
          <label className="label">IndiaMART Pull API Key (glusr_crm_key) {keyState.set && <span className="text-xs text-gray-500 font-normal">— configured: <span className="font-mono">{keyState.masked}</span> (leave blank to keep)</span>}</label>
          <input className="input font-mono text-sm" type="password" autoComplete="off" placeholder="paste key…"
            value={form.indiamart_crm_key} onChange={e => setForm({ ...form, indiamart_crm_key: e.target.value })} />
          <p className="text-[11px] text-gray-500 mt-1">Polling every 15 min keeps the key alive (it expires after ~7 idle days). No key set → the poller does nothing.</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Keyword include (one per line)</label>
            <textarea className="input h-28" value={form.keyword_include} onChange={e => setForm({ ...form, keyword_include: e.target.value })} placeholder="pump&#10;valve&#10;motor" />
          </div>
          <div>
            <label className="label">Keyword exclude (one per line)</label>
            <textarea className="input h-28" value={form.keyword_exclude} onChange={e => setForm({ ...form, keyword_exclude: e.target.value })} placeholder="job&#10;resume&#10;franchise" />
          </div>
        </div>

        <div>
          <label className="label">AI scope prompt (what we sell — used to judge borderline leads)</label>
          <textarea className="input h-24" value={form.ai_scope_prompt} onChange={e => setForm({ ...form, ai_scope_prompt: e.target.value })}
            placeholder="We supply industrial fire-fighting & plumbing equipment: pumps, valves, sprinklers…" />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Default margin %</label>
            <input className="input" type="number" min="0" value={form.margin_pct} onChange={e => setForm({ ...form, margin_pct: e.target.value })} />
            <p className="text-[11px] text-gray-500 mt-1">Used when an item has no price history: current price + margin.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Welcome template — priced</label>
            <input className="input font-mono text-xs" value={form.welcome_priced_template_sid} onChange={e => setForm({ ...form, welcome_priced_template_sid: e.target.value })} placeholder="HX…" />
            <p className="text-[11px] text-gray-500 mt-1">Scenarios A + C: lead has a price. Shows price + "Confirm Order" + "Expect a Call" buttons.</p>
          </div>
          <div>
            <label className="label">Welcome template — unpriced</label>
            <input className="input font-mono text-xs" value={form.welcome_unpriced_template_sid} onChange={e => setForm({ ...form, welcome_unpriced_template_sid: e.target.value })} placeholder="HX…" />
            <p className="text-[11px] text-gray-500 mt-1">Scenario B: no catalogue match yet. Shows "Expect a Call" only — no price, no Confirm Order.</p>
          </div>
          <div>
            <label className="label">Bank-details template SID</label>
            <input className="input font-mono text-xs" value={form.bank_template_sid} onChange={e => setForm({ ...form, bank_template_sid: e.target.value })} placeholder="HX…" />
          </div>
          <div>
            <label className="label">Follow-up template SID</label>
            <input className="input font-mono text-xs" value={form.followup_template_sid} onChange={e => setForm({ ...form, followup_template_sid: e.target.value })} placeholder="HX…" />
          </div>
        </div>

        <div className="flex justify-between items-center">
          <button type="button" onClick={runPoll} disabled={polling} className="btn btn-secondary">{polling ? 'Polling…' : 'Run poll now'}</button>
          <button type="submit" disabled={saving} className="btn btn-primary">{saving ? 'Saving…' : 'Save settings'}</button>
        </div>
      </form>

      <div className="card p-4 text-sm text-gray-600 space-y-1">
        <h4 className="font-semibold text-gray-800">Notes</h4>
        <ul className="list-disc pl-5 space-y-1 text-[13px]">
          <li>Twilio account SID / auth token / WhatsApp sender live in the server <span className="font-mono">.env</span>, not here.</li>
          <li>Four templates need Meta approval before sends work: <strong>welcome (priced)</strong> with price + two buttons, <strong>welcome (unpriced)</strong> with "Expect a Call" only, <strong>bank details</strong>, and <strong>follow-up</strong>.</li>
          <li>The inbound webhook URL is <span className="font-mono">/api/lead-funnel/whatsapp/webhook</span> — point your Twilio number's "when a message comes in" at it (needs a public URL).</li>
        </ul>
      </div>
    </div>
  );
}
