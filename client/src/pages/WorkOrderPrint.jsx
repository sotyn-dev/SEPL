// Print-friendly Work Order page — same "server returns structured data,
// this page formats it for A4 / Save-as-PDF" pattern as IndentPrint.jsx.
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';

const COMPANY = {
  name: 'SECURED ENGINEERS PVT. LTD.',
  head: 'B.K Towers, Janta Nagar, Gill Road, Ludhiana, (PB) 141003',
  corp: '58/A/1, First Floor, Kalu Sarai, New Delhi - 110016',
  email: 'Sales@securedengineers.com',
  website: 'www.securedengineers.com',
};

const money = (n) => 'Rs ' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

export default function WorkOrderPrint() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get(`/indent-labour-payment/work-orders/${id}/print`)
      .then(r => setData(r.data))
      .catch(err => setError(err.response?.data?.error || 'Failed to load'));
  }, [id]);

  if (error) return <div className="p-8 text-red-600">{error}</div>;
  if (!data) return <div className="p-8 text-gray-400">Loading…</div>;

  const wo = data.work_order;
  const labour = data.labour || [];
  const fmtDate = (d) => {
    if (!d) return '—';
    const dt = new Date(d);
    return isNaN(dt) ? d : `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
  };
  const labourTotal = labour.reduce((s, l) => s + (Number(l.amount) || 0) + (Number(l.overtime_amount) || 0), 0);

  return (
    <div className="bg-white min-h-screen">
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 10mm; }
          body { margin: 0; }
          .no-print { display: none !important; }
          .wo-page { box-shadow: none !important; margin: 0 !important; }
          tr { page-break-inside: avoid; }
        }
        @media screen { body { background: #f3f4f6; } }
        .wo-page {
          max-width: 210mm; margin: 16px auto; background: white;
          box-shadow: 0 4px 20px rgba(0,0,0,0.1);
          font-family: 'Times New Roman', Times, serif; color: #111;
        }
        .header {
          display: flex; align-items: center; padding: 14px 24px 10px;
          border-bottom: 3px solid #c00; background: linear-gradient(to right, #fff 60%, #fef2f2);
        }
        .logo {
          width: 80px; height: 60px; flex-shrink: 0; background: white; border: 2px solid #c00;
          border-radius: 6px; display: flex; align-items: center; justify-content: center;
          font-weight: bold; color: #c00; font-size: 20px;
        }
        .name { flex: 1; padding-left: 14px; }
        .name h1 { font-size: 22px; font-weight: bold; color: #c00; margin: 0; letter-spacing: 0.5px; }
        .name p { font-size: 10px; color: #c00; margin: 2px 0 0; }
        .title-bar { background: #c00; color: white; padding: 6px 16px; font-weight: bold; font-size: 14px; letter-spacing: 1px; text-align: center; }
        .meta { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding: 10px 16px; font-size: 11px; border-bottom: 1px solid #ddd; }
        .meta div { background: #fef2f2; padding: 6px 10px; border-radius: 4px; }
        .meta .label { font-size: 9px; color: #888; text-transform: uppercase; }
        .meta .val { font-weight: bold; color: #111; }
        table.items { width: calc(100% - 32px); margin: 12px 16px; border-collapse: collapse; font-size: 11px; }
        table.items th { background: #c00; color: white; padding: 6px 8px; text-align: left; border: 1px solid #a00; }
        table.items td { padding: 5px 8px; border: 1px solid #ddd; vertical-align: top; }
        table.items tr:nth-child(even) td { background: #fafafa; }
        .footer { margin: 16px; padding-top: 8px; border-top: 2px dashed #ddd; display: flex; justify-content: space-between; font-size: 10px; color: #666; }
        .toolbar { position: fixed; top: 12px; right: 12px; z-index: 100; display: flex; gap: 8px; }
        .toolbar button { padding: 8px 14px; background: #dc2626; color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; }
        .toolbar button.secondary { background: #6b7280; }
      `}</style>

      <div className="toolbar no-print">
        <button onClick={() => window.print()}>Print / Save PDF</button>
        <button className="secondary" onClick={() => window.close()}>Close</button>
      </div>

      <div className="wo-page">
        <div className="header">
          <div className="logo">SE</div>
          <div className="name">
            <h1>{COMPANY.name}</h1>
            <p><strong>Head Office:</strong> {COMPANY.head}</p>
            <p><strong>Corporate Office:</strong> {COMPANY.corp}</p>
          </div>
        </div>

        <div className="title-bar">WORK ORDER</div>

        <div className="meta">
          <div><div className="label">WO Number</div><div className="val">{wo.wo_number || '—'}</div></div>
          <div><div className="label">Project</div><div className="val">{wo.project_name || '—'}</div></div>
          <div><div className="label">Status</div><div className="val">{(wo.status || '').replace('_', ' ').toUpperCase()}</div></div>
          <div><div className="label">Sub-Contractor</div><div className="val">{wo.sub_contractor_name || '—'}</div></div>
          <div><div className="label">Planned Start</div><div className="val">{fmtDate(wo.planned_start)}</div></div>
          <div><div className="label">Planned End</div><div className="val">{fmtDate(wo.planned_end)}</div></div>
          <div><div className="label">WO Value</div><div className="val">{money(wo.planned_value)}</div></div>
          <div><div className="label">Amount Paid</div><div className="val">{money(wo.amount_paid)}</div></div>
          <div><div className="label">Balance</div><div className="val">{money((wo.planned_value || 0) - (wo.amount_paid || 0))}</div></div>
        </div>

        {wo.scope && (
          <div style={{ padding: '10px 16px', fontSize: 12 }}>
            <strong>Scope of Work:</strong> {wo.scope}
          </div>
        )}

        {labour.length > 0 && (
          <table className="items">
            <thead>
              <tr>
                <th>Category</th><th>Trade</th><th>Rate</th><th>Labourers</th><th>Days</th><th>OT Hrs</th><th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {labour.map(l => (
                <tr key={l.id}>
                  <td>{l.labour_category}</td>
                  <td>{l.trade || '—'}</td>
                  <td>{money(l.rate_snapshot)}/{l.unit}</td>
                  <td>{l.quantity}</td>
                  <td>{l.days}</td>
                  <td>{l.overtime_hours || 0}</td>
                  <td>{money((Number(l.amount) || 0) + (Number(l.overtime_amount) || 0))}</td>
                </tr>
              ))}
              <tr><td colSpan={6} style={{ textAlign: 'right', fontWeight: 'bold' }}>Total Labour Cost</td><td style={{ fontWeight: 'bold' }}>{money(labourTotal)}</td></tr>
            </tbody>
          </table>
        )}

        <div className="footer">
          <div>{COMPANY.email} · {COMPANY.website}</div>
          <div>Generated {new Date().toLocaleDateString('en-IN')}</div>
        </div>
      </div>
    </div>
  );
}
