// ⚙ Approval Settings — the ONE place that says who may act at each approval
// gate of the Indent → Dispatch flow, and which gates are switched on.
//
// Deliberately separate from ⚙ Responsible (RACI): RACI is per-record reporting
// / SLA tracking; this is flow control. Nothing here writes RACI, and after the
// server side lands nothing in the approval path reads RACI.
//
// PREVIEW BUILD — local state only. Nothing is saved yet; the settings API and
// the resolver land in the next step.
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
    hint: 'First sign-off. Final approval while L2 is off.',
  },
  {
    key: 'l2',
    label: 'Indent — L2 Approval',
    hint: 'Second sign-off. Off means L1 is final.',
    togglable: true,
    conflictsWith: 'l1',
  },
  {
    key: 'crm',
    label: 'CRM Approval (billable Extra indents)',
    hint: 'Signs off billable Extra indents before L1. Always on.',
    // CRM already admits anyone with crm_funnel access and the Client PO's own CRM
    // person; naming here ADDS to them. Said on the card so it doesn't read as the
    // only way in.
    extra: 'CRM-module users and the Client PO’s CRM person already qualify.',
  },
  {
    key: 'po_l1',
    label: 'Vendor PO — L1 Approval',
    hint: 'First sign-off on the vendor PO.',
  },
  {
    key: 'po_l2',
    label: 'Vendor PO — L2 Approval',
    hint: 'Second sign-off. The PO goes live after this.',
    conflictsWith: 'po_l1',
  },
  // No 'revoke' card: undoing a closed indent (re-approve / re-reject / reset a
  // store issue) is NOT a separately-assignable gate. It follows the current
  // final signer automatically — L2 approvers when L2 is on, L1 when it's off —
  // so naming people here would be a dead list nothing reads.
];

const emptyState = () => {
  const s = {};
  for (const g of GATES) s[g.key] = { users: [], enabled: true };
  return s;
};

export default function ApprovalSettingsModal({ open, onClose }) {
  const [users, setUsers] = useState([]);
  const [cfg, setCfg] = useState(emptyState);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load the active user list + the saved gate config each time the modal opens,
  // so it never shows a stale picture after someone else edits it.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
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
      await api.put('/procurement/approval-settings', { gates });
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

  const dropUser = (gate, id) =>
    setCfg(c => ({ ...c, [gate]: { ...c[gate], users: c[gate].users.filter(x => x !== id) } }));

  const toggle = gate =>
    setCfg(c => ({ ...c, [gate]: { ...c[gate], enabled: !c[gate].enabled } }));

  return (
    <Modal isOpen={open} onClose={onClose} title="⚙ Approval Settings — Indent to Dispatch">
      <div className="space-y-3">
        <p className="text-xs text-gray-500">
          Name who may approve at each step — <b>active</b> users only. The current final
          signer (L2 when on, else L1) can also revoke or re-approve a closed indent.
        </p>

        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
          <b>Vendor PO steps are not enforced yet.</b> Indent L1 / L2 / CRM are live — they
          drive the real approval flow. The two <b>Vendor PO</b> cards are stored but not yet
          read by the PO approval gate.
        </div>

        {/* No inner scroll — the Modal shell already scrolls (max-h-90vh), and a
            second scroller here gave the card list its own bar inside the modal's. */}
        <div className="space-y-2">
          {GATES.map(g => {
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
                  {g.extra && <> · {g.extra}</>}
                </div>
              </div>
            );
          })}
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
}
