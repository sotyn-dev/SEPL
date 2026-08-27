// Print-friendly Labour Rate Master — same window.print()/Save-as-PDF
// pattern as IndentPrint.jsx / WorkOrderPrint.jsx.
import { useEffect, useState } from 'react';
import api from '../api';

const COMPANY = { name: 'SECURED ENGINEERS PVT. LTD.', email: 'Sales@securedengineers.com', website: 'www.securedengineers.com' };
const money = (n) => 'Rs ' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

export default function LabourRateMasterPrint() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/labour-rate-master', { params: { status: 'active' } })
      .then(r => setRows(r.data || []))
      .catch(err => setError(err.response?.data?.error || 'Failed to load'));
  }, []);

  if (error) return <div className="p-8 text-red-600">{error}</div>;
  if (!rows) return <div className="p-8 text-gray-400">Loading…</div>;

  return (
    <div className="bg-white min-h-screen">
      <style>{`
        @media print { @page { size: A4 portrait; margin: 10mm; } body { margin: 0; } .no-print { display: none !important; } .pg { box-shadow: none !important; margin: 0 !important; } tr { page-break-inside: avoid; } }
        @media screen { body { background: #f3f4f6; } }
        .pg { max-width: 210mm; margin: 16px auto; background: white; box-shadow: 0 4px 20px rgba(0,0,0,0.1); font-family: Arial, sans-serif; color: #111; }
        .header { padding: 14px 24px; border-bottom: 3px solid #c00; background: linear-gradient(to right, #fff 60%, #fef2f2); }
        .header h1 { font-size: 20px; font-weight: bold; color: #c00; margin: 0; }
        .title-bar { background: #c00; color: white; padding: 6px 16px; font-weight: bold; font-size: 13px; letter-spacing: 1px; text-align: center; }
        table { width: calc(100% - 32px); margin: 12px 16px; border-collapse: collapse; font-size: 11px; }
        th { background: #c00; color: white; padding: 6px 8px; text-align: left; border: 1px solid #a00; }
        td { padding: 5px 8px; border: 1px solid #ddd; }
        tr:nth-child(even) td { background: #fafafa; }
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
        <div className="title-bar">LABOUR RATE MASTER — ACTIVE RATES</div>
        <table>
          <thead><tr><th>Category</th><th>Trade</th><th>Department</th><th>Skill</th><th>Unit</th><th>Standard Rate</th><th>Overtime Rate</th><th>Effective From</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td>{r.labour_category}</td><td>{r.trade || '—'}</td><td>{r.department || '—'}</td>
                <td>{r.skill_level || '—'}</td><td>{r.unit}</td><td>{money(r.standard_rate)}</td>
                <td>{money(r.overtime_rate)}</td><td>{r.effective_from}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} style={{ textAlign: 'center', color: '#999' }}>No active rates</td></tr>}
          </tbody>
        </table>
        <div className="footer"><div>{COMPANY.email} · {COMPANY.website}</div><div>Generated {new Date().toLocaleDateString('en-IN')}</div></div>
      </div>
    </div>
  );
}
