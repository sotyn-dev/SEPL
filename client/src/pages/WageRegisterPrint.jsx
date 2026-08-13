// Print-friendly Wage Register — same pattern as the other print pages.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api';

const COMPANY = { name: 'SECURED ENGINEERS PVT. LTD.', email: 'Sales@securedengineers.com', website: 'www.securedengineers.com' };
const money = (n) => 'Rs ' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

export default function WageRegisterPrint() {
  const [params] = useSearchParams();
  const from = params.get('from') || '';
  const to = params.get('to') || '';
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/labour-master/wage-register', { params: { from, to } })
      .then(r => setData(r.data))
      .catch(err => setError(err.response?.data?.error || 'Failed to load'));
  }, [from, to]);

  if (error) return <div className="p-8 text-red-600">{error}</div>;
  if (!data) return <div className="p-8 text-gray-400">Loading…</div>;

  return (
    <div className="bg-white min-h-screen">
      <style>{`
        @media print { @page { size: A4 portrait; margin: 10mm; } body { margin: 0; } .no-print { display: none !important; } .pg { box-shadow: none !important; margin: 0 !important; } tr { page-break-inside: avoid; } }
        @media screen { body { background: #f3f4f6; } }
        .pg { max-width: 210mm; margin: 16px auto; background: white; box-shadow: 0 4px 20px rgba(0,0,0,0.1); font-family: Arial, sans-serif; color: #111; }
        .header { padding: 14px 24px; border-bottom: 3px solid #c00; background: linear-gradient(to right, #fff 60%, #fef2f2); }
        .header h1 { font-size: 20px; font-weight: bold; color: #c00; margin: 0; }
        .title-bar { background: #c00; color: white; padding: 6px 16px; font-weight: bold; font-size: 13px; letter-spacing: 1px; text-align: center; }
        .meta { padding: 8px 16px; font-size: 11px; color: #666; }
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
        <div className="title-bar">WAGE REGISTER</div>
        <div className="meta">Period: {from || 'All'} to {to || 'All'}</div>
        <table>
          <thead><tr><th>Code</th><th>Name</th><th>Days Present</th><th>Days Absent</th><th>OT Hours</th><th>Wage Due</th><th>OT Due</th><th>Total Due</th></tr></thead>
          <tbody>
            {(data.rows || []).map(r => (
              <tr key={r.labour_id}>
                <td>{r.labour_code}</td><td>{r.name}</td><td>{r.days_present}</td><td>{r.days_absent}</td>
                <td>{r.overtime_hours}</td><td>{money(r.wage_due)}</td><td>{money(r.overtime_due)}</td><td style={{ fontWeight: 'bold' }}>{money(r.total_due)}</td>
              </tr>
            ))}
            {(!data.rows || data.rows.length === 0) && <tr><td colSpan={8} style={{ textAlign: 'center', color: '#999' }}>No attendance in this range</td></tr>}
            {data.rows?.length > 0 && <tr><td colSpan={7} style={{ textAlign: 'right', fontWeight: 'bold' }}>Total</td><td style={{ fontWeight: 'bold' }}>{money(data.total_due)}</td></tr>}
          </tbody>
        </table>
        <div className="footer"><div>{COMPANY.email} · {COMPANY.website}</div><div>Generated {new Date().toLocaleDateString('en-IN')}</div></div>
      </div>
    </div>
  );
}
