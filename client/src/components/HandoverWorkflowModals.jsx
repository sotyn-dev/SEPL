// SOP-15 Workflow Modals
// S1: Start Handover & Lock Costs
// S2: Joint Snag Walk Registration
// S5: Handover Certificate Creator

import { useState } from 'react';
import api from '../api';
import toast from 'react-hot-toast';
import Modal from './Modal';
import { FiLock, FiCalendar, FiUser, FiFileText, FiShield, FiCheckCircle } from 'react-icons/fi';

// ─── S1: Start Handover & Enforce Cost Lock ────────────────────────────
export function StartHandoverModal({ site, raci, onClose, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/snags/sop15/start-handover', {
        site_id: site.id,
        notes,
      });
      toast.success(`Handover started and costs locked on "${site.name}" (SOP-15.1)`);
      if (onSaved) onSaved();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to start handover');
    } finally {
      setBusy(false);
    }
  };

  const authorityName = raci?.s1_cost_lock?.assigned_name || raci?.sop_owner?.assigned_name || 'Project Manager';

  return (
    <Modal isOpen onClose={onClose} title={`SOP-15.1 · Start Handover & Lock Costs (${site?.name})`}>
      <form onSubmit={submit} className="space-y-4">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800 space-y-1">
          <div className="font-semibold flex items-center gap-1.5 text-amber-900">
            <FiLock size={13} /> Immediate Cost-Booking Lock (SOP-15.1):
          </div>
          <p>
            When work reaches 100%, new cost bookings and indents for <strong>{site?.name}</strong> are immediately locked to prevent cost leakage.
          </p>
          <div className="text-[11px] text-amber-700 pt-1">
            Handover Authority: <strong>{authorityName}</strong>
          </div>
        </div>

        <div>
          <label className="label text-xs">Handover Remarks / Milestone Notes</label>
          <textarea
            className="input text-xs w-full h-20"
            placeholder="e.g. Physical MEPF installation work 100% completed. Ready for joint snag walk with client."
            value={notes}
            onChange={e => setNotes(e.target.value)}
          />
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t">
          <button type="button" onClick={onClose} className="btn btn-secondary text-sm">Cancel</button>
          <button type="submit" disabled={busy} className="btn btn-primary text-sm flex items-center gap-1.5 shadow-sm bg-amber-600 hover:bg-amber-700 text-white border-0">
            <FiLock size={13} /> {busy ? 'Locking & Starting…' : 'Declare 100% & Lock Costs (S1)'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ─── S2: Joint Snag Walk with Client ───────────────────────────────────
export function ClientWalkModal({ site, raci, onClose, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    walk_date: new Date().toISOString().slice(0, 10),
    client_rep_name: site?.client_rep_name || '',
    client_rep_phone: site?.client_rep_phone || '',
    notes: '',
  });

  const submit = async (e) => {
    e.preventDefault();
    if (!form.client_rep_name.trim()) {
      toast.error('Client representative name is required');
      return;
    }
    setBusy(true);
    try {
      await api.post('/snags/sop15/client-walk', {
        site_id: site.id,
        ...form,
      });
      toast.success(`Joint snag walk recorded for "${site.name}" (SOP-15.2)`);
      if (onSaved) onSaved();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to record walk');
    } finally {
      setBusy(false);
    }
  };

  const leadName = raci?.s2_snag_walk?.assigned_name || 'Site Engineer';

  return (
    <Modal isOpen onClose={onClose} title={`SOP-15.2 · Joint Snag Walk With Client (${site?.name})`}>
      <form onSubmit={submit} className="space-y-4 text-xs">
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-blue-900 space-y-1">
          <div className="font-semibold flex items-center gap-1.5">
            <FiUser size={13} /> Joint Client Punch-List Walk (SOP-15.2):
          </div>
          <p>
            Site Engineer (<strong>{leadName}</strong>) walks the site together with the client representative. Every snag noted is logged under the Client Walk tag.
          </p>
        </div>

        <div>
          <label className="label">Date of Joint Walk *</label>
          <input
            type="date"
            className="input w-full"
            value={form.walk_date}
            onChange={e => setForm({ ...form, walk_date: e.target.value })}
            required
          />
        </div>

        <div>
          <label className="label">Client Representative Name *</label>
          <input
            type="text"
            className="input w-full"
            placeholder="e.g. Mr. Sharma (Client Project Lead)"
            value={form.client_rep_name}
            onChange={e => setForm({ ...form, client_rep_name: e.target.value })}
            required
          />
        </div>

        <div>
          <label className="label">Client Representative Phone / Contact</label>
          <input
            type="text"
            className="input w-full"
            placeholder="e.g. +91 98765 43210"
            value={form.client_rep_phone}
            onChange={e => setForm({ ...form, client_rep_phone: e.target.value })}
          />
        </div>

        <div>
          <label className="label">Walk Summary / Scope Notes</label>
          <textarea
            className="input w-full h-16"
            placeholder="e.g. Walk completed across Basement & Ground floor. Client identified 4 touch-up items."
            value={form.notes}
            onChange={e => setForm({ ...form, notes: e.target.value })}
          />
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t">
          <button type="button" onClick={onClose} className="btn btn-secondary text-sm">Cancel</button>
          <button type="submit" disabled={busy} className="btn btn-primary text-sm flex items-center gap-1.5 shadow-sm">
            <FiCheckCircle size={14} /> {busy ? 'Saving…' : 'Record Client Walk (S2)'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ─── S5: Generate Handover Certificate ─────────────────────────────────
export function GenerateCertificateModal({ site, raci, onClose, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    handover_date: new Date().toISOString().slice(0, 10),
    client_signatory: site?.client_rep_name || 'Client Representative',
    company_signatory: raci?.s5_handover_cert?.assigned_name || (raci?.sop_owner?.assigned_name ? `${raci.sop_owner.assigned_name} / Lovely (CRM)` : 'Project Manager / Lovely (CRM)'),
    retention_pct: 5.0,
    notes: '',
  });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.post('/snags/sop15/generate-certificate', {
        site_id: site.id,
        ...form,
      });
      toast.success(`Handover Certificate ${res.data.certificate_number} generated successfully!`);
      if (onSaved) onSaved();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to generate certificate');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`SOP-15.5 · Issue Handover Certificate (${site?.name})`}>
      <form onSubmit={submit} className="space-y-4 text-xs">
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-emerald-900 space-y-1">
          <div className="font-semibold flex items-center gap-1.5">
            <FiCheckCircle size={13} /> 100% Snags Resolved — Ready for Certificate:
          </div>
          <p>
            All punch-list defects are resolved and verified. Generating this certificate assigns sequential number <strong>HC-YYYY-XXXX</strong> and prepares the retention and warranty schedule.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Handover Date *</label>
            <input
              type="date"
              className="input w-full"
              value={form.handover_date}
              onChange={e => setForm({ ...form, handover_date: e.target.value })}
              required
            />
          </div>
          <div>
            <label className="label">Retention Percentage (%)</label>
            <input
              type="number"
              step="0.5"
              min="0"
              max="20"
              className="input w-full"
              value={form.retention_pct}
              onChange={e => setForm({ ...form, retention_pct: Number(e.target.value) })}
              required
            />
          </div>
        </div>

        <div>
          <label className="label">Client Signatory (Name / Designation) *</label>
          <input
            type="text"
            className="input w-full"
            value={form.client_signatory}
            onChange={e => setForm({ ...form, client_signatory: e.target.value })}
            required
          />
        </div>

        <div>
          <label className="label">Company Signatory (Secured Engineers) *</label>
          <input
            type="text"
            className="input w-full"
            value={form.company_signatory}
            onChange={e => setForm({ ...form, company_signatory: e.target.value })}
            required
          />
        </div>

        <div>
          <label className="label">Certificate Notes / Inclusions</label>
          <textarea
            className="input w-full h-16"
            placeholder="e.g. Certificate issued following successful commissioning & 100% snag rectification."
            value={form.notes}
            onChange={e => setForm({ ...form, notes: e.target.value })}
          />
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t">
          <button type="button" onClick={onClose} className="btn btn-secondary text-sm">Cancel</button>
          <button type="submit" disabled={busy} className="btn btn-primary text-sm flex items-center gap-1.5 shadow-sm bg-emerald-600 hover:bg-emerald-700 text-white border-0">
            <FiFileText size={14} /> {busy ? 'Generating…' : 'Generate Certificate (S5)'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
