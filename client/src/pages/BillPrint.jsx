// Print-friendly single Bill receipt — same pattern as the other print pages.
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';

const COMPANY = { name: 'SECURED ENGINEERS PVT. LTD.', email: 'Sales@securedengineers.com', website: 'www.securedengineers.com' };
const money = (n) => 'Rs ' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

export default function BillPrint() {
  const { id } = useParams();
  const [bill, setBill] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get(`/bill-verification/bills/${id}`)
      .then(r => setBill(r.data))
      .catch(err => setError(err.response?.data?.error || 'Failed to load'));
  }, [id]);

  if (error) return <div className="p-8 text-red-600">{error}</div>;
  if (!bill) return <div className="p-8 text-gray-400">Loading…</div>;

  return (
    <div className="bg-white min-h-screen">
      <style>{`
        @media print { @page { size: A4 portrait; margin: 10mm; } body { margin: 0; } .no-print { display: none !important; } .pg { box-shadow: none !important; margin: 0 !important; } tr { page-break-inside: avoid; } }
        @media screen { body { background: #f3f4f6; } }
        .pg { max-width: 210mm; margin: 16px auto; background: white; box-shadow: 0 4px 20px rgba(0,0,0,0.1); font-family: Arial, sans-serif; color: #111; }
        .header { padding: 14px 24px; border-bottom: 3px solid #c00; background: linear-gradient(to right, #fff 60%, #fef2f2); }
        .header h1 { font-size: 20px; font-weight: bold; color: #c00; margin: 0; }
        .title-bar { background: #c00; color: white; padding: 6px 16px; font-weight: bold; font-size: 13px; letter-spacing: 1px; text-align: center; }
        .meta { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding: 10px 16px; font-size: 11px; border-bottom: 1px solid #ddd; }
        .meta div { background: #fef2f2; padding: 6px 10px; border-radius: 4px; }
        .meta .label { font-size: 9px; color: #888; text-transform: uppercase; }
        .meta .val { font-weight: bold; color: #111; }
        table { width: calc(100% - 32px); margin: 12px 16px; border-collapse: collapse; font-size: 11px; }
        th { background: #c00; color: white; padding: 6px 8px; text-align: left; border: 1px solid #a00; }
        td { padding: 5px 8px; border: 1px solid #ddd; }
        .footer { margin: 16px; padding-top: 8px; border-top: 2px dashed #ddd; display: flex; justify-content: space-between; font-size: 10px; color: #666; }
        .toolbar { position: fixed; top: 12px; right: 12px; z-index: 100; display: flex; gap: 8px; }
        .toolbar button { padding: 8px 14px; background: #dc2626; color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; }
        .toolbar button.secondary { background: #6b7280; }
      `}</style>
      <div className="toolbar no-print">
        <button onClick={() => window.print()}>Print / Save PDF</button>
        <button className="secondary" onClick={() => window.close()}>Close</button>
      </div>
      <div className="pg">
        <div className="header"><h1>{COMPANY.name}</h1></div>
        <div className="title-bar">CONTRACTOR BILL — {bill.ra_no}</div>
        <div className="meta">
          <div><div className="label">Contractor</div><div className="val">{bill.contractor_name || '—'}</div></div>
          <div><div className="label">Work Order</div><div className="val">{bill.wo_number || '—'}</div></div>
          <div><div className="label">Status</div><div className="val">{(bill.status || '').replace('_', ' ').toUpperCase()}</div></div>
          <div><div className="label">Gross Amount</div><div className="val">{money(bill.gross_amount)}</div></div>
          <div><div className="label">Net Amount</div><div className="val">{money(bill.net_amount)}</div></div>
          <div><div className="label">Invoice #</div><div className="val">{bill.invoice_number || '—'}</div></div>
          <div><div className="label">Payment Mode</div><div className="val">{bill.payment_mode || '—'}</div></div>
          <div><div className="label">Transaction ID</div><div className="val">{bill.transaction_id || '—'}</div></div>
          <div><div className="label">Paid At</div><div className="val">{bill.paid_at ? new Date(bill.paid_at).toLocaleDateString('en-IN') : '—'}</div></div>
        </div>
        {bill.deductions?.length > 0 && (
          <table>
            <thead><tr><th>Deduction</th><th>%</th><th>Amount</th></tr></thead>
            <tbody>{bill.deductions.map(d => <tr key={d.id}><td>{d.label}</td><td>{d.pct}%</td><td>{money(d.amount)}</td></tr>)}</tbody>
          </table>
        )}
        <table>
          <thead><tr><th>Stage</th><th>Action</th><th>By</th><th>When</th><th>Remarks</th></tr></thead>
          <tbody>
            {(bill.stage_log || []).map(l => (
              <tr key={l.id}><td>{l.stage}</td><td>{l.action}</td><td>{l.acted_by_name}</td><td>{new Date(l.acted_at).toLocaleString('en-IN')}</td><td>{l.remarks || '—'}</td></tr>
            ))}
          </tbody>
        </table>
        <div className="footer"><div>{COMPANY.email} · {COMPANY.website}</div><div>Generated {new Date().toLocaleDateString('en-IN')}</div></div>
      </div>
    </div>
  );
}
