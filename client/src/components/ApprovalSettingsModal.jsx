// ⚙ Approval Settings — the ONE place that says who may act at each approval
// gate of the Indent → Dispatch flow, and which gates are switched on.
//
// Deliberately separate from ⚙ Responsible (RACI): RACI is per-record reporting
// / SLA tracking; this is flow control. Nothing here writes RACI; the approval
// path no longer reads RACI.
//
// Cards are grouped into two sections — the INDENT approval chain (L1/L2/CRM) and
// the VENDOR PO chain (PO L1/L2 + the stand-in). They are distinct sub-flows on
// distinct documents; grouping also gives the PO stand-in an unambiguous home,
// since it applies to the whole PO group rather than to either level.
import { useState, useEffect, useMemo } from 'react';
import Modal from './Modal';
import api from '../api';
import toast from 'react-hot-toast';

// The gate catalogue — one entry per approval gate, declared once.
// `togglable` shows the stage ON/OFF pill; `conflictsWith` is the
// second-pair-of-eyes rule (the same person can't sign both).
//
// Only L2 carries a switch here. CRM's stage ON/OFF deliberately does NOT:
// skipping CRM isn't just skipping an approval — it also drops the CRM funnel
// lead created at raise time and the billable po_items row added on CRM
// approval, so the revenue side of a client-billable Extra never opens. That
// switch stays on the "CRM Approval" step in ⚙ Responsible, which is also the
// only place the raise flow reads it from. A second switch for the same
// behaviour means one of them is lying.
const GATES = [
  {
    key: 'l1',
    label: 'Indent — L1 Approval',
    group: 'indent',
    hint: 'First sign-off. Final approval while L2 is off.',
  },
  {
    key: 'l2',
    label: 'Indent — L2 Approval',
    group: 'indent',
    hint: 'Second sign-off. Off means L1 is final.',
    togglable: true,
    conflictsWith: 'l1',
  },
  {
    key: 'crm',
    label: 'CRM Approval (billable Extra indents)',
    group: 'indent',
    hint: 'Signs off billable Extra indents before L1. Always on.',
    // CRM already admits anyone with crm_funnel access and the Client PO's own CRM
    // person; naming here ADDS to them. Said on the card so it doesn't read as the
    // only way in.
    extra: 'CRM-module users and the Client PO’s CRM person already qualify.',
  },
  // ONE approver each — the PO rule has always been a single named person per
  // level. A list would widen who can commit money on a PO. No conflictsWith:
  // the PO flow has never required two different signatures (and production has
  // never had one), so claiming it here would advertise a rule that isn't kept.
  {
    key: 'po_l1',
    label: 'Vendor PO — L1 Approval',
    group: 'po',
    hint: 'First sign-off on the vendor PO.',
    single: true,
    exclusiveWith: 'po_l2',
  },
  {
    key: 'po_l2',
    label: 'Vendor PO — L2 Approval',
    group: 'po',
    hint: 'Second sign-off. The PO goes live after this.',
    single: true,
    exclusiveWith: 'po_l1',
  },
  // No 'revoke' card: undoing a closed indent (re-approve / re-reject / reset a
  // store issue) is NOT a separately-assignable gate. It follows the current
  // final signer automatically — L2 approvers when L2 is on, L1 when it's off —
  // so naming people here would be a dead list nothing reads.
];

const SECTIONS = [
  { key: 'indent', title: 'Indent approval', note: 'CRM → L1 → L2 on the indent itself.' },
  { key: 'po', title: 'Vendor PO approval', note: 'Two sign-offs on the vendor PO before it goes live.' },
];

const emptyState = () => {
  const s = {};
  for (const g of GATES) s[g.key] = { users: [], enabled: true };
  return s;
};

export default function ApprovalSettingsModal({ open, onClose }) {
  const [users, setUsers] = useState([]);
  const [cfg, setCfg] = useState(emptyState);
  // Vendor PO stand-in (role mailbox). `matches` is the server's live resolution
  // of the pattern → users, shown as "currently matches". `editing` gates the
  // text field so the pattern isn't changed by a stray keystroke.
  const [standin, setStandin] = useState({ email: '', enabled: true, matches: [] });
  const [editingStandin, setEditingStandin] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load the active user list + the saved gate config each time the modal opens,
  // so it never shows a stale picture after someone else edits it.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setEditingStandin(false);
    Promise.all([
      api.get('/auth/users'),
      api.get('/procurement/approval-settings'),
    ]).then(([u, s]) => {
      if (cancelled) return;
      setUsers((u.data || []).filter(x => x.active !== 0));
      const gates = s.data?.gates || {};
      setCfg(prev => {
        const next = { ...prev };
        for (const g of GATES) {
          const srv = gates[g.key];
          if (!srv) continue;
          next[g.key] = {
            users: (srv.users || []).map(x => x.id),
            enabled: srv.enabled !== false,
          };
        }
        return next;
      });
      const so = s.data?.standin || {};
      setStandin({ email: so.email || '', enabled: so.enabled !== false, matches: so.matches || [] });
    }).catch(e => {
      if (!cancelled) toast.error(e.response?.data?.error || 'Could not load approval settings');
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  // A togglable stage switched ON with nobody named is admin-only — every indent
  // would then park at that stage waiting on an admin. Block the save (the server
  // enforces the same, but catch it here so the admin sees why without a round-
  // trip). Mirrors the writeAll guard in indentToDispatchGates.js.
  const gatesMissingApprover = GATES.filter(
    g => g.togglable && cfg[g.key]?.enabled && (cfg[g.key]?.users?.length || 0) === 0
  );

  const save = async () => {
    if (gatesMissingApprover.length) {
      toast.error(`Name an approver for "${gatesMissingApprover[0].label}" before turning it on.`);
      return;
    }
    setSaving(true);
    try {
      // `enabled` is sent only for gates that actually own a switch here (L2).
      const gates = {};
      for (const g of GATES) {
        gates[g.key] = {
          users: cfg[g.key].users,
          ...(g.togglable ? { enabled: cfg[g.key].enabled } : {}),
        };
      }
      const { data } = await api.put('/procurement/approval-settings', {
        gates,
        standin: { email: standin.email, enabled: standin.enabled },
      });
      // Refresh the live "currently matches" from the server's re-resolution.
      if (data?.standin) setStandin(s => ({ ...s, matches: data.standin.matches || [] }));
      toast.success('Approval settings saved');
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Save failed');
    } finally { setSaving(false); }
  };

  const nameOf = useMemo(() => {
    const m = {};
    for (const u of users) m[u.id] = u.name;
    return id => m[id] || `#${id}`;
  }, [users]);

  const addUser = (gate, id) =>
    setCfg(c => (!id || c[gate].users.includes(id)
      ? c
      : { ...c, [gate]: { ...c[gate], users: [...c[gate].users, id] } }));

  // Single-approver gates: pick REPLACES, empty clears. Kept as its own setter so
  // the stored shape is still a list (one entry) and nothing downstream special-cases.
  const setOnlyUser = (gate, id) =>
    setCfg(c => ({ ...c, [gate]: { ...c[gate], users: id ? [id] : [] } }));

  // Is this person already holding the mutually-exclusive partner gate? The two
  // Vendor PO levels must be different people — one non-admin must never be able
  // to carry a whole PO. Mirrors the writeAll guard; the server is the authority.
  const takenByOther = (g, userId) =>
    !!g.exclusiveWith && (cfg[g.exclusiveWith]?.users || []).includes(userId);

  const dropUser = (gate, id) =>
    setCfg(c => ({ ...c, [gate]: { ...c[gate], users: c[gate].users.filter(x => x !== id) } }));

  const toggle = gate =>
    setCfg(c => ({ ...c, [gate]: { ...c[gate], enabled: !c[gate].enabled } }));

  return (
    <Modal isOpen={open} onClose={onClose} title="⚙ Approval Settings — Indent to Dispatch">
      <div className="space-y-3">
        <p className="text-xs text-gray-500">
          Name who may approve at each step — <b>active</b> users only. An <b>admin</b> can
          always act. The current final signer (L2 when on, else L1) can also revoke or
          re-approve a closed indent.
        </p>

        {/* No inner scroll — the Modal shell already scrolls (max-h-90vh), and a
            second scroller here gave the card list its own bar inside the modal's.
            Grouped into sections; each card is rendered by renderCard below. */}
        <div className="space-y-4">
          {SECTIONS.map(sec => (
            <div key={sec.key} className="space-y-2">
              <div className="flex items-baseline gap-2 border-b border-slate-200 pb-1">
                <h3 className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{sec.title}</h3>
                <span className="text-[10px] text-slate-400">{sec.note}</span>
              </div>
              {GATES.filter(g => g.group === sec.key).map(g => renderCard(g))}
              {sec.key === 'po' && renderStandin()}
            </div>
          ))}
        </div>

        {/* Sticky footer — pulled out to the modal body's edges so it spans full
            width and covers the cards scrolling underneath it. */}
        <div className="sticky bottom-0 z-10 bg-white border-t flex justify-end items-center gap-2
                        -mx-3 sm:-mx-5 px-3 sm:px-5 pt-2 pb-3 sm:pb-5 -mb-3 sm:-mb-5">
          {loading && <span className="text-[11px] text-slate-400 mr-auto">Loading…</span>}
          {!loading && gatesMissingApprover.length > 0 && (
            <span className="text-[11px] text-rose-600 mr-auto">
              Name an approver for {gatesMissingApprover.map(g => g.label).join(', ')} or turn it off.
            </span>
          )}
          <button onClick={onClose} className="btn btn-secondary ml-auto">Cancel</button>
          <button onClick={save} disabled={saving || loading || gatesMissingApprover.length > 0} className="btn btn-primary">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );

  // ── Card renderer — one approval gate ───────────────────────────────────────
  function renderCard(g) {
            const st = cfg[g.key];
            const on = st.enabled;
            const dimmed = g.togglable && !on;
            const available = users.filter(u => !st.users.includes(u.id));
            return (
              <div key={g.key} className={`border rounded-lg p-3 bg-white ${dimmed ? 'opacity-60' : ''}`}>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="font-semibold text-sm text-gray-800">
                    {g.label}
                    {dimmed && <span className="ml-2 text-[10px] font-normal text-rose-500">(OFF — skipped in flow)</span>}
                  </div>
                  {g.togglable && (
                    <button
                      type="button"
                      onClick={() => toggle(g.key)}
                      title="Turn this approval stage on/off — OFF skips it in the real flow"
                      className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold border transition ${on ? 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700' : 'bg-white text-slate-500 border-slate-300 hover:bg-slate-100'}`}>
                      <span className={`inline-block w-1.5 h-1.5 rounded-full ${on ? 'bg-white' : 'bg-slate-400'}`} />
                      {on ? 'ON' : 'OFF'}
                    </button>
                  )}
                </div>

                <div className="text-[11px] text-slate-500 mb-2">{g.hint}</div>

                {/* SINGLE-approver gates (the PO levels) get a plain picker bound to
                    the one selection — picking someone REPLACES them. Multi gates
                    keep the add-then-chip flow. Two affordances because the two
                    rules genuinely differ; a chip list on a single gate would imply
                    you can add a second person and then reject the save. */}
                {g.single ? (
                  <>
                    <label className="label text-[10px] text-emerald-600">Approver</label>
                    <select
                      className="input text-xs w-full"
                      value={st.users[0] ?? ''}
                      onChange={e => setOnlyUser(g.key, e.target.value ? +e.target.value : null)}>
                      <option value="">— not set (admin only) —</option>
                      {users.map(u => {
                        // The person holding the OTHER PO level can't hold this one too —
                        // shown disabled rather than hidden, so it's clear why they're
                        // unavailable instead of them silently missing from the list.
                        const taken = takenByOther(g, u.id);
                        return (
                          <option key={u.id} value={u.id} disabled={taken}>
                            {u.name}{taken ? '  — already PO ' + (g.exclusiveWith === 'po_l2' ? 'L2' : 'L1') : ''}
                          </option>
                        );
                      })}
                    </select>
                  </>
                ) : (
                  <>
                    <label className="label text-[10px] text-emerald-600">Approvers</label>
                    <select className="input text-xs w-full" value="" onChange={e => addUser(g.key, e.target.value ? +e.target.value : null)}>
                      <option value="">+ add approver…</option>
                      {available.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>

                    {/* Named approvers only. "Admin always" is NOT a chip here — it is
                        not stored, and as a chip it sat in the same row as removable
                        people and read like one of them. It lives in the card footer. */}
                    <div className="flex flex-wrap items-center gap-1.5 mt-2">
                      {st.users.map(id => (
                        <span key={id} className="inline-flex items-center gap-1 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 px-2 py-0.5 text-[11px] font-medium">
                          {nameOf(id)}
                          <button type="button" onClick={() => dropUser(g.key, id)} title="Remove"
                            className="text-emerald-600 hover:text-rose-600 font-bold leading-none">×</button>
                        </span>
                      ))}
                      {st.users.length === 0 && !(g.togglable && on) && (
                        <span className="text-[11px] text-slate-400 italic">Nobody named — admin only</span>
                      )}
                    </div>
                  </>
                )}

                {/* A togglable stage ON with no approver = admin-only → the queue
                    parks on an admin. Hard-flag it and block Save. */}
                {g.togglable && on && st.users.length === 0 && (
                  <div className="mt-2 rounded border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] text-rose-700">
                    <b>ON with no approver.</b> Only an admin could act and every indent
                    would wait here. Add an approver, or switch it off.
                  </div>
                )}

                {/* Card footer — the standing facts about this gate, separated from
                    the editable part above so they don't read as removable entries. */}
                <div className="mt-2.5 pt-2 border-t border-slate-100 text-[10px] leading-relaxed text-slate-400">
                  Admin can always act here.
                  {/* Full label, not the short tail — "L1 Approval" alone reads as the
                      INDENT's L1 when shown on a Vendor PO card. */}
                  {g.conflictsWith && (
                    <> · Cannot be the same person as <b className="font-semibold">
                      {GATES.find(x => x.key === g.conflictsWith)?.label}</b> on one record.</>
                  )}
                  {g.exclusiveWith && (
                    <> · Must be a different person from <b className="font-semibold">
                      {GATES.find(x => x.key === g.exclusiveWith)?.label}</b> — one person
                      must not carry a whole PO. (An admin can still act at both.)</>
                  )}
                  {g.extra && <> · {g.extra}</>}
                </div>
              </div>
            );
  }

  // ── Vendor PO stand-in ──────────────────────────────────────────────────────
  // A role MAILBOX (e.g. coo@…) whose current holder may act at EITHER PO level.
  // Belongs to the PO GROUP, not to either card, because it applies to both. The
  // email is edit-guarded (pencil) so the pattern isn't changed by a stray
  // keystroke; the checkbox applies/removes the rule instantly without touching
  // the field. "Currently matches" is the server's live resolution.
  function renderStandin() {
    const locked = !editingStandin;
    return (
      <div className="border border-slate-200 rounded-lg p-3 bg-slate-50/60">
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="font-semibold text-sm text-gray-800">Vendor PO — Stand-in</div>
          <label className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-600 cursor-pointer select-none">
            <input type="checkbox" checked={standin.enabled}
              onChange={e => setStandin(s => ({ ...s, enabled: e.target.checked }))} />
            Apply
          </label>
        </div>
        <div className="text-[11px] text-slate-500 mb-2">
          A role mailbox — whoever currently holds it may approve or reject at <b>both</b> PO
          levels. Matches the start of a user’s <b>email</b>; follows the role as the person changes.
        </div>

        <label className="label text-[10px] text-emerald-600">Stand-in email</label>
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            className={`input text-xs w-full ${locked ? 'bg-slate-100 text-slate-500' : ''}`}
            value={standin.email}
            readOnly={locked}
            placeholder="e.g. coo@yourcompany.com"
            onChange={e => setStandin(s => ({ ...s, email: e.target.value }))}
          />
          <button type="button" title={locked ? 'Edit — change carefully' : 'Done editing'}
            onClick={() => setEditingStandin(v => !v)}
            className={`shrink-0 rounded border px-2 py-1 text-xs ${locked ? 'border-slate-300 text-slate-500 hover:bg-slate-100' : 'border-emerald-500 text-emerald-700 bg-emerald-50'}`}>
            {locked ? '✎' : '✓'}
          </button>
        </div>

        <div className="mt-2 text-[11px]">
          {!standin.enabled ? (
            <span className="text-slate-400 italic">Off — only the named PO approvers and admins act.</span>
          ) : standin.matches.length ? (
            <span className="text-slate-500">Currently matches: <b className="text-slate-700">
              {standin.matches.map(u => u.name).join(', ')}</b></span>
          ) : (
            <span className="text-amber-700">On, but no active user’s email matches this pattern yet.</span>
          )}
        </div>

        <div className="mt-2.5 pt-2 border-t border-slate-200/70 text-[10px] leading-relaxed text-slate-400">
          Applies to Vendor PO L1 &amp; L2 · approve and reject. Separate from the two approver
          cards above — it is an exception, not a signing level. Saved value shows here after Save.
        </div>
      </div>
    );
  }
}
