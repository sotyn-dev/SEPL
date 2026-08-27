// Print-friendly Drawing Tracker reports — same window.print() / Save-as-PDF
// pattern as IndentPrint.jsx, routed outside the Layout shell.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api';

const COMPANY = { name: 'SECURED ENGINEERS PVT. LTD.', email: 'Sales@securedengineers.com', website: 'www.securedengineers.com' };

const REPORTS = {
  register: ['Drawing Register', ['Project', 'Site', 'Drawing No', 'Title', 'Discipline', 'Type', 'Current Rev', 'Status', 'Revisions'],
    r => [r.project_name, r.site_name, r.drawing_number, r.title, r.discipline, r.drawing_type, `Rev ${r.current_revision_no ?? '—'}`, r.current_status, r.revision_count]],
  history: ['Revision History', ['Drawing No', 'Title', 'Rev', 'Date', 'Description', 'Reason', 'Status', 'Uploaded By'],
    r => [r.drawing_number, r.title, r.revision_no, r.revision_date, r.revision_description, r.revision_reason, r.status, r.uploaded_by_name]],
  superseded: ['Superseded Drawings', ['Drawing No', 'Title', 'Rev', 'Description', 'Superseded On', 'Uploaded By'],
    r => [r.drawing_number, r.title, r.revision_no, r.revision_description, r.uploaded_at, r.uploaded_by_name]],
  discipline: ['Drawings by Discipline', ['Discipline', 'Drawings', 'Revisions'], r => [r.discipline, r.drawings, r.revisions]],
  project: ['Drawings by Project', ['Project', 'Source', 'Drawings', 'Revisions'], r => [r.project, r.project_source, r.drawings, r.revisions]],
  site: ['Drawings by Site', ['Site', 'Drawings', 'Revisions'], r => [r.site, r.drawings, r.revisions]],
};

export default function DrawingRegisterPrint() {
  const [params] = useSearchParams();
  const kind = params.get('kind') || 'register';
  const def = REPORTS[kind] || REPORTS.register;
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get(`/drawing-tracker/reports/${kind}`)
      .then(r => setRows(r.data || []))
      .catch(e => setError(e.response?.data?.error || 'Failed to load'));
  }, [kind]);

  if (error) return <div className="p-8 text-red-600">{error}</div>;
  if (!rows) return <div className="p-8 text-gray-400">Loading…</div>;

  return (
    <div className="bg-white min-h-screen">
      <style>{`
        @media print { @page { size: A4 landscape; margin: 8mm; } body { margin: 0; } .no-print { display: none !important; } .pg { box-shadow: none !important; margin: 0 !important; } tr { page-break-inside: avoid; } }
        @media screen { body { background: #f3f4f6; } }
        .pg { max-width: 280mm; margin: 16px auto; background: white; box-shadow: 0 4px 20px rgba(0,0,0,0.1); font-family: Arial, sans-serif; color: #111; }
        .header { padding: 14px 24px; border-bottom: 3px solid #c00; background: linear-gradient(to right, #fff 60%, #fef2f2); }
        .header h1 { font-size: 20px; font-weight: bold; color: #c00; margin: 0; }
        .title-bar { background: #c00; color: white; padding: 6px 16px; font-weight: bold; font-size: 13px; letter-spacing: 1px; text-align: center; }
        table { width: calc(100% - 32px); margin: 12px 16px; border-collapse: collapse; font-size: 10px; }
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
        <div className="title-bar">DRAWING TRACKER — {def[0].toUpperCase()}</div>
        <table>
          <thead><tr>{def[1].map(h => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id ?? i}>{def[2](r).map((c, j) => <td key={j}>{c ?? '—'}</td>)}</tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={def[1].length} style={{ textAlign: 'center', color: '#999' }}>Nothing to report</td></tr>}
          </tbody>
        </table>
        <div className="footer">
          <div>{COMPANY.email} · {COMPANY.website}</div>
          <div>{rows.length} row(s) · Generated {new Date().toLocaleDateString('en-IN')}</div>
        </div>
      </div>
    </div>
  );
}
