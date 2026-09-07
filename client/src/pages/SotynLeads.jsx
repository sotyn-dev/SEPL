// Sotyn Leads — the sotyn.ai website enquiry inbox.
//
// Mam (2026-09-07): "generate a new small module which name sotyn lead and
// always automatically fetch."  Nobody imports anything here: the website's
// two forms POST to /api/public/sotyn-lead and the rows appear on this
// screen by themselves — it re-fetches every 30 s, and again the moment the
// tab is brought back to the front, so an enquiry that lands while you are
// looking at the page shows up without a refresh.
//
// A website enquiry is NOT an EPC lead, so nothing here touches the Sales
// Funnel until someone presses Convert — that is the only button that
// creates the SEPL-xxxx row (and it needs leads.create as well).
//
// Every action in the desktop table is mirrored in the `md:hidden` mobile
// card (mobile↔desktop parity rule).

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { fmtDateTime } from '../utils/datetime';
import { exportCsv } from '../utils/exportCsv';
import Pagination, { usePagination } from '../components/PaginationBar';
import {
  FiRefreshCw, FiDownload, FiSearch, FiPhone, FiMail, FiMessageCircle,
  FiCheckCircle, FiTrash2, FiExternalLink, FiUserCheck, FiSlash, FiInbox,
} from 'react-icons/fi';

const POLL_MS = 30000;   // "always automatically fetch"

// The site has THREE forms. Named once here so a new form is one edit, not five.
const FORM = {
  demo:    { short: 'Demo',      long: 'Demo request',          said: 'Asked for a demo / 30-day pilot',      style: 'bg-sky-50 text-sky-700 border-sky-200' },
  magnet:  { short: 'Checklist', long: 'Checklist download',    said: 'Downloaded the 11-point checklist',    style: 'bg-purple-50 text-purple-700 border-purple-200' },
  webinar: { short: 'Webinar',   long: 'Webinar registration',  said: 'Registered for the masterclass',       style: 'bg-rose-50 text-rose-700 border-rose-200' },
};
const formOf = (t) => FORM[t] || FORM.demo;

const TABS = [
  { id: '', label: 'All', icon: FiInbox },
  { id: 'new', label: 'New' },
  { id: 'contacted', label: 'Contacted' },
  { id: 'qualified', label: 'Qualified' },
  { id: 'converted', label: 'Converted' },
  { id: 'junk', label: 'Junk' },
];

const STATUS_STYLE = {
  new: 'bg-blue-50 text-blue-700 border-blue-200',
  contacted: 'bg-amber-50 text-amber-700 border-amber-200',
  qualified: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  converted: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  junk: 'bg-slate-100 text-slate-500 border-slate-300',
};

// Indian mobile → wa.me needs a country code and digits only.
const waLink = (phone, name) => {
  const d = String(phone || '').replace(/\D/g, '');
  if (!d) return null;
  const num = d.length === 10 ? `91${d}` : d;
  const msg = encodeURIComponent(
    `Hello ${name || ''}, this is Secured Engineers / sotyn.ai — thank you for your enquiry on our website.`.replace(/\s+/g, ' ')
  );
  return `https://wa.me/${num}?text=${msg}`;
};

function StatusPill({ status }) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border capitalize ${STATUS_STYLE[status] || ''}`}>
      {status}
    </span>
  );
}

// Defined at module level, NOT inside the page component (audit 2026-09-07).
// A component declared in the render body is a NEW type on every render, so
// React unmounts and remounts every row's buttons on each 30-second poll and
// on every keystroke in the search box. Rendered by both the desktop table and
// the mobile card, so the two can never drift apart.
function LeadActions({ l, compact, perms, onStatus, onConvert, onRemove }) {
  const wa = waLink(l.phone, l.name);
  return (
    <div className={`flex items-center gap-1 ${compact ? 'flex-wrap' : 'justify-end'}`}>
      {wa && (
        <a href={wa} target="_blank" rel="noreferrer" aria-label={`WhatsApp ${l.name}`}
           className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded" title="WhatsApp">
          <FiMessageCircle size={14} />
        </a>
      )}
      {l.phone && (
        <a href={`tel:${l.phone}`} aria-label={`Call ${l.name}`}
           className="p-1.5 text-blue-600 hover:bg-blue-50 rounded" title="Call"><FiPhone size={14} /></a>
      )}
      {l.email && (
        <a href={`mailto:${l.email}`} aria-label={`Email ${l.name}`}
           className="p-1.5 text-slate-600 hover:bg-slate-100 rounded" title="Email"><FiMail size={14} /></a>
      )}
      {perms.edit && l.status !== 'converted' && l.status !== 'contacted' && (
        <button onClick={() => onStatus(l, 'contacted')} aria-label={`Mark ${l.name} contacted`}
                className="p-1.5 text-amber-600 hover:bg-amber-50 rounded" title="Mark contacted"><FiUserCheck size={14} /></button>
      )}
      {perms.edit && l.status !== 'converted' && l.status !== 'qualified' && (
        <button onClick={() => onStatus(l, 'qualified')} aria-label={`Mark ${l.name} qualified`}
                className="p-1.5 text-indigo-600 hover:bg-indigo-50 rounded" title="Mark qualified"><FiCheckCircle size={14} /></button>
      )}
      {/* Convert needs BOTH permissions — the server demands leads.create too,
          so showing it on sotyn_leads.create alone just serves a 403. */}
      {perms.convert && !l.converted_lead_id && (
        <button onClick={() => onConvert(l)}
                className="px-2 py-1 text-[11px] font-semibold bg-emerald-600 text-white rounded hover:bg-emerald-700">
          Convert
        </button>
      )}
      {l.converted_lead_no && (
        <Link to="/leads" title={`Open the Sales Funnel — this enquiry became ${l.converted_lead_no}`}
              className="px-2 py-1 text-[11px] font-semibold text-emerald-700 hover:underline inline-flex items-center gap-1">
          {l.converted_lead_no} <FiExternalLink size={11} />
        </Link>
      )}
      {perms.edit && l.status !== 'junk' && l.status !== 'converted' && (
        <button onClick={() => onStatus(l, 'junk')} aria-label={`Mark ${l.name} junk`}
                className="p-1.5 text-slate-400 hover:bg-slate-100 rounded" title="Mark junk"><FiSlash size={14} /></button>
      )}
      {perms.remove && !l.converted_lead_id && (
        <button onClick={() => onRemove(l)} aria-label={`Delete enquiry from ${l.name}`}
                className="p-1.5 text-red-600 hover:bg-red-50 rounded" title="Delete"><FiTrash2 size={14} /></button>
      )}
    </div>
  );
}

export default function SotynLeads() {
  const { canCreate, canEdit, canDelete } = useAuth();
  const M = 'sotyn_leads';

  const [tab, setTab] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({});
  const [stats, setStats] = useState(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [lastSync, setLastSync] = useState(null);
  const [convert, setConvert] = useState(null);      // lead being converted
  // WhatsApp ingestion (mam 2026-09-07). Until the site's WEBHOOK constant is
  // filled in, every enquiry lands in WhatsApp instead of here — this is how
  // those get in. Preview first, write only on a second, deliberate click.
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importPreview, setImportPreview] = useState(null);
  const [importBusy, setImportBusy] = useState(false);
  const [cForm, setCForm] = useState({});
  const [saving, setSaving] = useState(false);
  const seenTop = useRef(null);                       // highest id seen, for the "new lead" toast
  const reqSeq = useRef(0);                           // stale-response guard for the poll

  // Text search refetches after a typing pause, never per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    // Stale-response guard: a slow poll for the tab you just LEFT must not
    // paint its rows over the tab you are now on. Only the newest request in
    // flight is allowed to write state (audit 2026-09-07).
    const seq = ++reqSeq.current;
    try {
      const params = new URLSearchParams();
      if (tab) params.set('status', tab);
      if (debounced) params.set('q', debounced);
      const [list, s] = await Promise.all([
        api.get(`/sotyn-leads?${params}`),
        api.get('/sotyn-leads/stats'),
      ]);
      if (seq !== reqSeq.current) return;      // a newer request already answered
      const fetched = list.data?.rows || [];
      setRows(fetched);
      setCounts(list.data?.counts || {});
      setTotal(list.data?.total || 0);
      setStats(s.data || null);
      setLoadError('');
      setLastSync(new Date());

      // Announce anything that landed since the last poll — the whole point
      // of a self-filling inbox is that you notice without watching it.
      const top = fetched.length ? Math.max(...fetched.map(r => r.id)) : 0;
      if (quiet && seenTop.current !== null && top > seenTop.current) {
        const fresh = fetched.filter(r => r.id > seenTop.current).length;
        toast.success(`${fresh} new website ${fresh === 1 ? 'lead' : 'leads'} from sotyn.ai`, { icon: '🔔' });
      }
      if (seenTop.current === null || top > seenTop.current) seenTop.current = top;
    } catch (e) {
      // Never swallow the failure — a silently empty inbox reads as "no
      // leads", which is the most expensive lie this screen could tell.
      if (seq === reqSeq.current) {
        setLoadError(e?.response?.data?.error || e.message || 'Could not load leads');
      }
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [tab, debounced]);

  useEffect(() => { load(); }, [load]);

  // Switching tab or searching swaps the list under the user: the 'N new leads'
  // baseline is a max(id) over the PREVIOUS filter, so keeping it would fire a
  // false alert (or swallow a real one) on the next poll. Reset both it and the
  // page number, so you land on page 1 of the list you just asked for.
  useEffect(() => { seenTop.current = null; }, [tab, debounced]);

  // Auto-fetch: every 30 s while the tab is visible, and immediately when the
  // user comes back to it. Paused while hidden so a backgrounded tab is not
  // polling the server all day.
  useEffect(() => {
    let timer = null;
    const start = () => { stop(); timer = setInterval(() => load(true), POLL_MS); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVisible = () => {
      if (document.visibilityState === 'visible') { load(true); start(); } else stop();
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible); };
  }, [load]);

  const setStatus = async (lead, status) => {
    try {
      await api.patch(`/sotyn-leads/${lead.id}`, { status });
      toast.success(`Marked ${status}`);
      load(true);
    } catch (e) { toast.error(e?.response?.data?.error || 'Could not update'); }
  };

  const remove = async (lead) => {
    if (!confirm(`Delete the enquiry from ${lead.name}? This cannot be undone.`)) return;
    try {
      await api.delete(`/sotyn-leads/${lead.id}`);
      toast.success('Deleted');
      load(true);
    } catch (e) { toast.error(e?.response?.data?.error || 'Could not delete'); }
  };

  const openConvert = (lead) => {
    setConvert(lead);
    setCForm({
      client_name: lead.name || '',
      company_name: lead.company || '',
      project_name: `SOTYN ERP — ${lead.company || lead.name || ''}`,
      city: lead.city || '',
      remarks: '',
    });
  };

  const doConvert = async () => {
    if (!cForm.client_name?.trim()) { toast.error('Customer name is required'); return; }
    setSaving(true);
    try {
      const r = await api.post(`/sotyn-leads/${convert.id}/convert`, cForm);
      toast.success(r.data?.message || 'Converted');
      setConvert(null);
      load(true);
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Could not convert');
    } finally { setSaving(false); }
  };

  // Excel and Sheets execute a cell that opens with = + - or @. Until this
  // module, every CSV source in the ERP was staff-entered; a website form is
  // the first one an anonymous stranger can type into, so the value is defused
  // here on the way out (audit 2026-09-07).
  // The hyphen is ESCAPED and last on purpose: [=+-@] is a RANGE from "+" to
  // "@" that swallows every digit — it would put an apostrophe in front of
  // every phone number in the file.
  const csvSafe = (v) => (v === null || v === undefined ? '' :
    /^[=+@\t\r\-]/.test(String(v)) ? "'" + String(v) : v);

  // ── WhatsApp import ────────────────────────────────────────────────
  // Nothing is written until the second button. `commit:false` asks the server
  // what it WOULD do; the same text is then sent back with commit:true.
  const runImport = async (commit) => {
    if (!importText.trim()) { toast.error('Paste a WhatsApp message or an exported chat first'); return; }
    setImportBusy(true);
    try {
      const r = await api.post('/sotyn-leads/import', { text: importText, commit });
      if (commit) {
        toast.success(`${r.data.inserted} lead${r.data.inserted === 1 ? '' : 's'} imported`);
        setImportOpen(false);
        setImportText('');
        setImportPreview(null);
        load();
      } else {
        setImportPreview(r.data);
        if (!r.data.found) toast('No lead messages found in that text');
      }
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Import failed');
    } finally { setImportBusy(false); }
  };

  // Scan the sales@ mailbox — the other place a historical enquiry can still be,
  // since every page links mailto:sales@securedengineers.com. Same two-step
  // contract as the paste: preview first, write only on the second press.
  const runMailboxScan = async (commit) => {
    setImportBusy(true);
    try {
      const r = await api.post('/sotyn-leads/scan-mailbox', { commit });
      if (commit) {
        toast.success(`${r.data.inserted} lead${r.data.inserted === 1 ? '' : 's'} imported from the mailbox`);
        setImportOpen(false);
        setImportPreview(null);
        load();
      } else {
        setImportPreview({ ...r.data, fromMailbox: true });
        if (!r.data.found) toast(`Scanned ${r.data.scanned || 0} emails — no enquiries found`);
      }
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Could not read the mailbox');
    } finally { setImportBusy(false); }
  };

  // A chat export is a .txt — read it in the browser and reuse the same paste
  // path, so the server needs no upload route and no file ever lands on disk.
  const readExportFile = (file) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast.error('That file is larger than 5 MB — export a shorter date range'); return; }
    const fr = new FileReader();
    fr.onload = () => { setImportText(String(fr.result || '')); setImportPreview(null); };
    fr.onerror = () => toast.error('Could not read that file');
    fr.readAsText(file);
  };

  const exportRows = async () => {
    // Export what the filter says, not merely what is on screen — the list
    // endpoint is capped at 200 rows by default and silently exporting that
    // slice reads as a complete file.
    let all = rows;
    try {
      const params = new URLSearchParams();
      if (tab) params.set('status', tab);
      if (debounced) params.set('q', debounced);
      params.set('limit', '1000');
      const r = await api.get(`/sotyn-leads?${params}`);
      all = r.data?.rows || rows;
      if ((r.data?.total || 0) > all.length) {
        toast('Exported the newest ' + all.length + ' of ' + r.data.total + ' — narrow the filter for the rest');
      }
    } catch { /* fall back to what is already on screen rather than export nothing */ }
    exportCsv(
      'sotyn-website-leads',
      ['Received', 'Name', 'Company', 'Phone', 'Email', 'City', 'Trade', 'Team', 'Turnover', 'Event', 'Form', 'Magnet', 'Page', 'Campaign', 'Status', 'Funnel Lead', 'Owner', 'Remarks'],
      all.map(r => [
        fmtDateTime(r.created_at), r.name, r.company, r.phone, r.email, r.city, r.trade, r.team,
        r.turnover, r.event, formOf(r.form_type).long, r.magnet, r.page, r.utm_campaign,
        r.status, r.converted_lead_no, r.owner_name, r.remarks,
      ].map(csvSafe))
    );
  };
  // Convert writes a real Sales Funnel lead, so the button is shown only when
  // the user can create BOTH — otherwise it renders and then 403s.
  const perms = useMemo(() => ({
    edit: canEdit(M),
    remove: canDelete(M),
    create: canCreate(M),                       // import: writes only to this inbox
    convert: canCreate(M) && canCreate('leads'), // convert: writes a funnel lead too
  }), [canEdit, canDelete, canCreate]);

  const pager = usePagination(rows, { initialPerPage: 15 });
  const tiles = useMemo(() => ([
    { label: 'Total enquiries', value: stats?.total ?? '—', tone: 'text-slate-800' },
    { label: 'New / unworked', value: stats?.new_count ?? '—', tone: 'text-blue-700' },
    { label: 'Last 7 days', value: stats?.week ?? '—', tone: 'text-indigo-700' },
    { label: 'Converted', value: `${stats?.converted ?? '—'}${stats ? ` · ${stats.conversion_pct}%` : ''}`, tone: 'text-emerald-700' },
  ]), [stats]);

  return (
    <div className="p-3 sm:p-5 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-slate-800">Sotyn Leads</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Enquiries from the sotyn.ai website — they arrive here on their own.
            {lastSync && <span className="ml-2 inline-flex items-center gap-1 text-emerald-600">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Live · updated {lastSync.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
            </span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => load()} className="px-3 py-1.5 text-sm border rounded-lg hover:bg-slate-50 inline-flex items-center gap-1.5">
            <FiRefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button onClick={exportRows} className="px-3 py-1.5 text-sm border rounded-lg hover:bg-slate-50 inline-flex items-center gap-1.5">
            <FiDownload size={14} /> Export
          </button>
          {perms.create && (
            <button onClick={() => { setImportOpen(true); setImportText(''); setImportPreview(null); }}
                    className="px-3 py-1.5 text-sm border rounded-lg hover:bg-emerald-50 border-emerald-300 text-emerald-700 inline-flex items-center gap-1.5">
              <FiMessageCircle size={14} /> Import from WhatsApp
            </button>
          )}
        </div>
      </div>

      {/* Tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {tiles.map(t => (
          <div key={t.label} className="bg-white border rounded-xl p-3 shadow-sm">
            <div className="text-[11px] uppercase tracking-wide text-slate-500">{t.label}</div>
            <div className={`text-xl font-bold mt-1 ${t.tone}`}>{t.value}</div>
          </div>
        ))}
      </div>

      {/* Tabs + search */}
      <div className="flex flex-wrap items-center gap-2">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg border ${tab === t.id ? 'bg-slate-800 text-white border-slate-800' : 'bg-white hover:bg-slate-50'}`}>
            {t.label}
            {t.id && counts[t.id] ? <span className="ml-1.5 opacity-70">{counts[t.id]}</span> : null}
          </button>
        ))}
        <div className="relative ml-auto">
          <FiSearch className="absolute left-2.5 top-2.5 text-slate-400" size={14} />
          <input value={search} onChange={e => setSearch(e.target.value)}
                 placeholder="Name, company, phone, city…"
                 className="pl-8 pr-3 py-1.5 text-sm border rounded-lg w-full sm:w-64" />
        </div>
      </div>

      {loadError && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3">
          Could not load the inbox: {loadError}
        </div>
      )}

      {/* Desktop table */}
      <div className="hidden md:block bg-white border rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr className="text-left">
                <th className="px-3 py-2 font-semibold">Received</th>
                <th className="px-3 py-2 font-semibold">Who</th>
                <th className="px-3 py-2 font-semibold">Contact</th>
                <th className="px-3 py-2 font-semibold">Business</th>
                <th className="px-3 py-2 font-semibold">Came from</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {pager.pageItems.map(l => (
                <tr key={l.id} className="border-t hover:bg-slate-50/60 align-top">
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-slate-500">
                    {fmtDateTime(l.created_at)}
                    {l.submissions > 1 && <span className="ml-1 text-[10px] text-amber-600">×{l.submissions}</span>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-semibold text-slate-800">{l.name}</div>
                    {l.company && <div className="text-xs text-slate-500">{l.company}</div>}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <div>{l.phone}</div>
                    {l.email && <div className="text-slate-500">{l.email}</div>}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600">
                    {[l.city, l.trade, l.team && `${l.team} team`, l.turnover].filter(Boolean).join(' · ') || '—'}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">
                    <span className={`px-1.5 py-0.5 rounded border text-[10px] ${formOf(l.form_type).style}`}>
                      {formOf(l.form_type).short}
                    </span>
                    {l.event && <div className="mt-0.5 text-rose-700">{l.event}</div>}
                    {l.utm_campaign && <div className="mt-0.5">{l.utm_campaign}</div>}
                    {l.page && <div className="text-slate-400">{l.page}</div>}
                  </td>
                  <td className="px-3 py-2"><StatusPill status={l.status} /></td>
                  <td className="px-3 py-2"><LeadActions l={l} perms={perms} onStatus={setStatus} onConvert={openConvert} onRemove={remove} /></td>
                </tr>
              ))}
              {!pager.pageItems.length && (
                <tr><td colSpan={7} className="px-3 py-10 text-center text-slate-400 text-sm">
                  {loading ? 'Loading…' : loadError ? 'Could not load the inbox — see the message above.' : 'No website enquiries yet. They will appear here by themselves.'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile cards — same actions as the table */}
      <div className="md:hidden space-y-2">
        {pager.pageItems.map(l => (
          <div key={l.id} className="bg-white border rounded-xl p-3 shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-semibold text-slate-800">{l.name}</div>
                {l.company && <div className="text-xs text-slate-500">{l.company}</div>}
              </div>
              <StatusPill status={l.status} />
            </div>
            <div className="mt-1.5 text-xs text-slate-600 space-y-0.5">
              <div>{l.phone}{l.email ? ` · ${l.email}` : ''}</div>
              <div>{[l.city, l.trade, l.team && `${l.team} team`, l.turnover].filter(Boolean).join(' · ') || '—'}</div>
              <div className="text-slate-400">
                {fmtDateTime(l.created_at)} · {formOf(l.form_type).short}
                {l.submissions > 1 ? ` · ×${l.submissions}` : ''}
              </div>
            </div>
            <div className="mt-2 pt-2 border-t"><LeadActions l={l} compact perms={perms} onStatus={setStatus} onConvert={openConvert} onRemove={remove} /></div>
          </div>
        ))}
        {!pager.pageItems.length && (
          <div className="bg-white border rounded-xl p-8 text-center text-slate-400 text-sm">
            {loading ? 'Loading…' : loadError ? 'Could not load the inbox.' : 'No website enquiries yet.'}
          </div>
        )}
      </div>

      <Pagination {...pager} />
      {total > rows.length && (
        <p className="text-xs text-slate-400 text-center">
          Showing the {rows.length} most recent of {total} — narrow with a filter or search to see older ones.
        </p>
      )}

      {/* Import from WhatsApp — preview, then commit */}
      <Modal isOpen={importOpen} onClose={() => setImportOpen(false)} title="Import leads from WhatsApp" xwide>
        <div className="space-y-3">
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900">
            The sotyn.ai forms currently send every enquiry to WhatsApp instead of the ERP,
            because the website's webhook address was left blank. Until that one line is fixed,
            paste those messages here.
            <div className="mt-1.5 text-amber-800">
              <b>One lead:</b> copy the message in WhatsApp and paste it below.
              <br />
              <b>All of them:</b> in WhatsApp open the chat → ⋮ → More → Export chat → <i>Without media</i>,
              then pick that .txt file. Re-importing the same file is safe — anything already
              here is skipped.
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input type="file" accept=".txt,text/plain"
                   onChange={(e) => readExportFile(e.target.files?.[0])}
                   className="text-xs file:mr-2 file:px-3 file:py-1.5 file:rounded-lg file:border file:border-slate-300 file:bg-white file:text-sm" />
            {importText && <span className="text-xs text-slate-500">{importText.length.toLocaleString()} characters loaded</span>}
          </div>

          <textarea
            value={importText}
            onChange={(e) => { setImportText(e.target.value); setImportPreview(null); }}
            rows={8}
            placeholder={'Webinar registration\nName: Monika Devi\nPhone: 919501890918\nCompany: Secured engineer Pvt Ltd\nTurnover: ₹10–50 Cr\nEvent: Contractor’s Profit Masterclass'}
            className="w-full border rounded-lg px-3 py-2 text-xs font-mono" />

          {importPreview && (
            <div className="border rounded-lg overflow-hidden">
              <div className="px-3 py-2 bg-slate-50 border-b text-xs flex flex-wrap gap-x-4 gap-y-1">
                <span><b className="text-slate-800">{importPreview.found}</b> lead message{importPreview.found === 1 ? '' : 's'} found</span>
                <span className="text-emerald-700"><b>{importPreview.importable}</b> new</span>
                <span className="text-amber-700"><b>{importPreview.duplicates}</b> already here</span>
                <span className="text-slate-500"><b>{importPreview.skipped}</b> unusable</span>
              </div>
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-white sticky top-0">
                    <tr className="text-left text-slate-500 border-b">
                      <th className="px-2 py-1.5 font-semibold">Form</th>
                      <th className="px-2 py-1.5 font-semibold">Name</th>
                      <th className="px-2 py-1.5 font-semibold">Phone</th>
                      <th className="px-2 py-1.5 font-semibold">Received</th>
                      <th className="px-2 py-1.5 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(importPreview.rows || []).map((r, i) => (
                      <tr key={i} className={`border-b last:border-0 ${r.duplicate || r.skipped ? 'bg-slate-50 text-slate-400' : ''}`}>
                        <td className="px-2 py-1.5">
                          <span className={`px-1.5 py-0.5 rounded border text-[10px] ${formOf(r.form_type).style}`}>
                            {formOf(r.form_type).short}
                          </span>
                        </td>
                        <td className="px-2 py-1.5">
                          {r.name || <span className="italic">no name</span>}
                          {r.company && <span className="text-slate-400"> · {r.company}</span>}
                        </td>
                        <td className="px-2 py-1.5">{r.phone || '—'}</td>
                        <td className="px-2 py-1.5">{r.at ? fmtDateTime(r.at) : '—'}</td>
                        <td className="px-2 py-1.5">
                          {r.skipped ? <span className="text-slate-500">skipped — {r.skipped}</span>
                            : r.duplicate ? <span className="text-amber-700">already in the inbox</span>
                            : <span className="text-emerald-700 font-semibold">will be imported</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {importPreview.found > (importPreview.rows || []).length && (
                <div className="px-3 py-1.5 text-[11px] text-slate-500 border-t">
                  Showing the first {(importPreview.rows || []).length} of {importPreview.found}. All of them import.
                </div>
              )}
            </div>
          )}

          <div className="border-t pt-3">
            <div className="text-xs text-slate-600 mb-2">
              <b>Or search the sales mailbox.</b> Every page on the site links
              sales@securedengineers.com, so enquiries that came by email are there.
              This only reads — it never deletes, moves or marks anything.
            </div>
            <button onClick={() => runMailboxScan(false)} disabled={importBusy}
                    className="px-3 py-1.5 text-sm border rounded-lg hover:bg-slate-50 inline-flex items-center gap-1.5 disabled:opacity-50">
              <FiMail size={14} /> {importBusy ? 'Working…' : 'Scan sales@ mailbox'}
            </button>
          </div>

          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <button onClick={() => setImportOpen(false)} className="px-4 py-2 text-sm border rounded-lg hover:bg-slate-50">Cancel</button>
            {!importPreview?.fromMailbox && (
              <button onClick={() => runImport(false)} disabled={importBusy || !importText.trim()}
                      className="px-4 py-2 text-sm border rounded-lg hover:bg-slate-50 disabled:opacity-50">
                {importBusy && !importPreview ? 'Checking…' : 'Check what is in there'}
              </button>
            )}
            <button onClick={() => (importPreview?.fromMailbox ? runMailboxScan(true) : runImport(true))}
                    disabled={importBusy || !importPreview || !importPreview.importable}
                    className="px-4 py-2 text-sm font-semibold bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50">
              {importPreview ? `Import ${importPreview.importable} lead${importPreview.importable === 1 ? '' : 's'}` : 'Import'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Convert → Sales Funnel */}
      <Modal isOpen={!!convert} onClose={() => setConvert(null)} title="Convert to Sales Funnel lead" wide>
        {convert && (
          <div className="space-y-3">
            <div className="bg-slate-50 border rounded-lg p-3 text-xs text-slate-600">
              <b className="text-slate-800">{convert.name}</b>
              {convert.company ? ` · ${convert.company}` : ''} · {convert.phone}
              {convert.email ? ` · ${convert.email}` : ''}
              <div className="mt-1">
                {formOf(convert.form_type).said}
                {convert.turnover ? ` · ${convert.turnover}` : ''}{convert.trade ? ` · ${convert.trade}` : ''}{convert.team ? ` · ${convert.team} team` : ''}
                {convert.city ? ` · ${convert.city}` : ''}
              </div>
              <div className="mt-1 text-slate-400">
                This creates a real SEPL-xxxx lead at Stage 1 and links it back to this enquiry.
              </div>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="text-xs font-semibold text-slate-600">
                Customer name *
                <input value={cForm.client_name || ''} onChange={e => setCForm({ ...cForm, client_name: e.target.value })}
                       className="mt-1 w-full border rounded-lg px-3 py-2 text-sm font-normal" />
              </label>
              <label className="text-xs font-semibold text-slate-600">
                Company
                <input value={cForm.company_name || ''} onChange={e => setCForm({ ...cForm, company_name: e.target.value })}
                       className="mt-1 w-full border rounded-lg px-3 py-2 text-sm font-normal" />
              </label>
              <label className="text-xs font-semibold text-slate-600">
                Project name
                <input value={cForm.project_name || ''} onChange={e => setCForm({ ...cForm, project_name: e.target.value })}
                       className="mt-1 w-full border rounded-lg px-3 py-2 text-sm font-normal" />
              </label>
              <label className="text-xs font-semibold text-slate-600">
                City
                <input value={cForm.city || ''} onChange={e => setCForm({ ...cForm, city: e.target.value })}
                       className="mt-1 w-full border rounded-lg px-3 py-2 text-sm font-normal" />
              </label>
            </div>
            <label className="text-xs font-semibold text-slate-600 block">
              Remark to carry into the funnel
              <textarea value={cForm.remarks || ''} onChange={e => setCForm({ ...cForm, remarks: e.target.value })}
                        rows={2} className="mt-1 w-full border rounded-lg px-3 py-2 text-sm font-normal" />
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setConvert(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-slate-50">Cancel</button>
              <button onClick={doConvert} disabled={saving}
                      className="px-4 py-2 text-sm font-semibold bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50">
                {saving ? 'Converting…' : 'Create funnel lead'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
