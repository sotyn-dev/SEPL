import { useState, useEffect } from 'react';
import api from '../../../api';
import WasHint, { FieldError, trackAccent } from '../WasHint';

// Assets pack (Mandatory Field Spec, Module 3, 2026-08-04, spec items
// #41-44). Two stacked blocks per the plan's "Business Grouping & UX"
// section — a plain business form, not a table/dashboard:
//   1. "Currently Issued" — a read-only mirror of the pre-existing Company
//      Assets register (company_assets, keyed to users), fetched from the
//      new GET /hr/employees/:id/company-assets endpoint. Purely a
//      convenience reference for HR while filling in the tag fields below;
//      never written to, never coupled to the 4 columns in Block 2.
//   2. "Employee Asset Details" — the 4 flat, freely-editable tag fields,
//      using the exact same field-row markup/shared helpers as every other
//      Workspace section (StatutorySection.jsx/CompensationSection.jsx).
const fmtIssued = (a) => {
  const parts = [a.category || a.name, a.asset_no].filter(Boolean).join(' — ');
  const since = a.issued_at ? ` (since ${String(a.issued_at).slice(0, 10)})` : '';
  return `${parts}${since}`;
};

export default function AssetsSection({ ws }) {
  const { form, setForm, changedSet, original, revertField } = ws;
  const [issued, setIssued] = useState([]);
  const employeeId = ws.editing?.id;

  useEffect(() => {
    if (!employeeId) return;
    api.get(`/hr/employees/${employeeId}/company-assets`)
      .then((r) => setIssued(r.data || []))
      .catch(() => setIssued([])); // no permission / no linked user / none issued — render nothing
  }, [employeeId]);

  const str = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  return (
    <div className="space-y-4">
      {issued.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Currently Issued (Company Assets)</div>
          {issued.map((a) => (
            <p key={a.id} className="text-[10px] text-gray-400 mt-0.5">{fmtIssued(a)}</p>
          ))}
        </div>
      )}

      <div className={issued.length > 0 ? 'border-t border-dashed pt-4 !mt-6' : ''}>
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Employee Asset Details</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className={trackAccent(changedSet, 'laptop_asset_tag')}>
            <label className="label">Laptop/PC Asset Tag</label>
            <input className="input" value={form.laptop_asset_tag || ''} onChange={str('laptop_asset_tag')} />
            <WasHint k="laptop_asset_tag" changedSet={changedSet} original={original} revertField={revertField} />
            <FieldError k="laptop_asset_tag" ws={ws} />
          </div>
          <div className={trackAccent(changedSet, 'mobile_asset_tag')}>
            <label className="label">Mobile Phone Asset Tag</label>
            <input className="input" value={form.mobile_asset_tag || ''} onChange={str('mobile_asset_tag')} />
            <WasHint k="mobile_asset_tag" changedSet={changedSet} original={original} revertField={revertField} />
            <FieldError k="mobile_asset_tag" ws={ws} />
          </div>
          <div className={trackAccent(changedSet, 'vehicle_allotted')}>
            <label className="label">Vehicle Allotted</label>
            <input className="input" value={form.vehicle_allotted || ''} onChange={str('vehicle_allotted')} />
            <WasHint k="vehicle_allotted" changedSet={changedSet} original={original} revertField={revertField} />
            <FieldError k="vehicle_allotted" ws={ws} />
          </div>
          <div className={trackAccent(changedSet, 'sim_card_number')}>
            <label className="label">SIM Card Number</label>
            <input className="input" value={form.sim_card_number || ''} onChange={str('sim_card_number')} />
            <WasHint k="sim_card_number" changedSet={changedSet} original={original} revertField={revertField} />
            <FieldError k="sim_card_number" ws={ws} />
          </div>
        </div>
      </div>
    </div>
  );
}
