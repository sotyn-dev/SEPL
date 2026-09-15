// Delivery Bill audit print (mam 2026-09-11: "show here delivery bill pdf so
// that i can audit"). The Indent to Dispatch list shows one number per indent —
// Billable × Against-Delivery %. This page shows how that number was built:
// every line's client sale rate and where it came from, qty and unit against
// the BOQ, which order and whose %, then the totals. Same data the list uses
// (server/lib/indentDeliveryBill.js). A4 / Save-as-PDF, like IndentPrint.

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

const RATE_SOURCE = {
  po_item: 'Linked BOQ line',
  boq_description: 'BOQ description match',
  not_billed: 'FOC / RGP — not billed',
  none: 'No BOQ rate found',
};
const ORDER_SOURCE = {
  planning: 'from Order Planning',
  po_item: "from the indent's linked BOQ line",
  site: 'matched by site name',
};
const PCT_SOURCE = {
  planning: "Order Planning's order",
  business_book: 'Business Book of the order',
};

const inr = (n) => `₹${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  return isNaN(dt) ? d : `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
};
const sameUnit = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

export default function DeliveryBillPrint() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get(`/procurement/indents/${id}/delivery-bill`)
      .then(r => setData(r.data))
      .catch(err => setError(err.response?.data?.error || 'Failed to load'));
  }, [id]);

  if (error) return <div className="p-8 text-red-600">{error}</div>;
  if (!data) return <div className="p-8 text-gray-400">Loading…</div>;

  const i = data.indent;
  const order = data.order;
  const lines = data.lines || [];
  const unpriced = lines.filter(l => l.rate_source === 'none').length;
  const unitMismatch = lines.filter(l => l.boq_unit && l.unit && !sameUnit(l.unit, l.boq_unit)).length;

  return (
    <div className="bg-white min-h-screen">
      <style>{`
        @media print {
          @page { size: A4 landscape; margin: 8mm; }
          body { margin: 0; }
          .no-print { display: none !important; }
          .db-page { box-shadow: none !important; margin: 0 !important; }
          tr { page-break-inside: avoid; }
          * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
        @media screen { body { background: #f3f4f6; } }
        .db-page { max-width: 280mm; margin: 16px auto; background: white; box-shadow: 0 4px 20px rgba(0,0,0,0.1);
          font-family: 'Times New Roman', Times, serif; color: #111; }
        .header { display: flex; align-items: center; padding: 14px 24px 10px; border-bottom: 3px solid #c00;
          background: linear-gradient(to right, #fff 60%, #fef2f2); }
        .logo { width: 80px; height: 60px; flex-shrink: 0; background: white; border: 2px solid #c00; border-radius: 6px;
          display: flex; align-items: center; justify-content: center; font-weight: bold; color: #c00; font-size: 20px; }
        .name { flex: 1; padding-left: 14px; }
        .name h1 { font-size: 22px; font-weight: bold; color: #c00; margin: 0; letter-spacing: 0.5px; }
        .name p { font-size: 10px; color: #c00; margin: 2px 0 0; }
        .title-bar { background: #c00; color: white; padding: 6px 16px; font-weight: bold; font-size: 14px; letter-spacing: 1px; text-align: center; }
        .meta { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; padding: 10px 16px; font-size: 11px; border-bottom: 1px solid #ddd; }
        .meta div.cell { background: #fef2f2; padding: 6px 10px; border-radius: 4px; }
        .meta .label { font-size: 9px; color: #888; text-transform: uppercase; }
        .meta .val { font-weight: bold; color: #111; }
        .meta .sub { font-size: 9px; color: #666; font-weight: normal; }
        .warn { margin: 10px 16px 0; padding: 6px 10px; border: 1px solid #f59e0b; background: #fffbeb; color: #92400e; font-size: 11px; border-radius: 4px; }
        table.lines { width: calc(100% - 32px); margin: 12px 16px; border-collapse: collapse; font-size: 11px; }
        table.lines th { background: #c00; color: white; padding: 6px 8px; font-size: 11px; text-align: left; border: 1px solid #a00; }
        table.lines td { padding: 5px 8px; border: 1px solid #ddd; vertical-align: top; }
        table.lines td.num, table.lines th.num { text-align: right; white-space: nowrap; }
        table.lines tr.none td { background: #fef2f2; }
        table.lines tr.free td { color: #6b7280; }
        .flag { display: inline-block; margin-top: 2px; font-size: 9px; color: #b45309; }
        .src { font-size: 9px; color: #666; }
        table.totals { margin: 4px 16px 12px auto; border-collapse: collapse; font-size: 12px; min-width: 320px; }
        table.totals td { padding: 5px 10px; border: 1px solid #ddd; }
        table.totals td.num { text-align: right; font-weight: bold; white-space: nowrap; }
        table.totals tr.grand td { background: #ecfdf5; color: #065f46; font-size: 14px; }
        .note { margin: 0 16px 12px; font-size: 10px; color: #555; line-height: 1.5; }
        .footer { margin: 16px; padding-top: 8px; border-top: 2px dashed #ddd; display: flex; justify-content: space-between; font-size: 10px; color: #666; }
        .toolbar { position: fixed; top: 12px; right: 12px; z-index: 100; display: flex; gap: 8px; }
        .toolbar button { padding: 8px 14px; background: #dc2626; color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; }
        .toolbar button.secondary { background: #6b7280; }
      `}</style>

      <div className="toolbar no-print">
        <button onClick={() => window.print()}>Print / Save PDF</button>
        <button className="secondary" onClick={() => window.close()}>Close</button>
      </div>

      <div className="db-page">
        <div className="header">
          <div className="logo">SE</div>
          <div className="name">
            <h1>{COMPANY.name}</h1>
            <p><strong>Head Office:</strong> {COMPANY.head}</p>
            <p><strong>Corporate Office:</strong> {COMPANY.corp}</p>
          </div>
        </div>

        <div className="title-bar">DELIVERY BILL — WORKING FOR AUDIT</div>

        <div className="meta">
          <div className="cell"><div className="label">Indent No</div><div className="val">{i.indent_number}</div></div>
          <div className="cell"><div className="label">Indent Date</div><div className="val">{fmtDate(i.indent_date || i.created_at)}</div></div>
          <div className="cell"><div className="label">Site</div><div className="val">{i.site_name || i.client_name || '—'}</div></div>
          <div className="cell"><div className="label">Status</div><div className="val">{(i.status || '').replace(/_/g, ' ').toUpperCase()}</div></div>
          <div className="cell"><div className="label">Raised By</div><div className="val">{i.raised_by_name || i.created_by_name || '—'}</div></div>
          <div className="cell">
            <div className="label">Order (sale rates from)</div>
            <div className="val">{order ? `${order.lead_no || ''} ${order.project_name || order.company_name || order.client_name || ''}`.trim() : 'No order found'}</div>
            {data.bb_source && <div className="sub">{ORDER_SOURCE[data.bb_source]}</div>}
          </div>
          <div className="cell">
            <div className="label">Against-Delivery %</div>
            <div className="val">{data.pct ? `${data.pct}%` : 'Not set'}</div>
            {data.pct_source && <div className="sub">{PCT_SOURCE[data.pct_source]}</div>}
          </div>
          <div className="cell"><div className="label">Lines</div><div className="val">{lines.length}</div></div>
        </div>

        {(unpriced > 0 || unitMismatch > 0 || !data.pct) && (
          <div className="warn">
            {unpriced > 0 && <div>⚠ {unpriced} line{unpriced === 1 ? '' : 's'} had no BOQ sale rate — counted as ₹0.</div>}
            {unitMismatch > 0 && <div>⚠ {unitMismatch} line{unitMismatch === 1 ? '' : 's'} have a different unit on the indent than on the BOQ — check the quantity before trusting the amount.</div>}
            {!data.pct && <div>⚠ The order has no Against-Delivery % — the Delivery Bill is ₹0.</div>}
          </div>
        )}

        <table className="lines">
          <thead>
            <tr>
              <th style={{ width: '3%' }}>#</th>
              <th style={{ width: '31%' }}>BoQ Description</th>
              <th style={{ width: '16%' }}>Sub-Item (Item Master)</th>
              <th style={{ width: '6%' }}>Type</th>
              <th className="num" style={{ width: '8%' }}>Qty</th>
              <th style={{ width: '8%' }}>Unit (Indent / BOQ)</th>
              <th className="num" style={{ width: '10%' }}>Sale Rate</th>
              <th style={{ width: '8%' }}>Rate From</th>
              <th className="num" style={{ width: '10%' }}>Billable</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, idx) => {
              const mismatch = l.boq_unit && l.unit && !sameUnit(l.unit, l.boq_unit);
              return (
                <tr key={l.id} className={l.rate_source === 'none' ? 'none' : l.rate_source === 'not_billed' ? 'free' : ''}>
                  <td>{idx + 1}</td>
                  <td>
                    {l.boq_description || l.description || '—'}
                    {l.boq_description && l.description && l.boq_description !== l.description && (
                      <div className="src">Indent text: {l.description}</div>
                    )}
                  </td>
                  <td>
                    {l.item_code && <div className="src">[{l.item_code}]</div>}
                    {l.master_name || '—'}
                  </td>
                  <td>{l.item_type || '—'}</td>
                  <td className="num">{l.quantity}</td>
                  <td>
                    {l.unit || '—'}{l.boq_unit ? ` / ${l.boq_unit}` : ''}
                    {mismatch && <div className="flag">⚠ unit differs</div>}
                  </td>
                  <td className="num">{l.rate ? inr(l.rate) : '—'}</td>
                  <td><span className="src">{RATE_SOURCE[l.rate_source] || l.rate_source}</span></td>
                  <td className="num">{inr(l.billable)}</td>
                </tr>
              );
            })}
            {lines.length === 0 && (
              <tr><td colSpan="9" style={{ textAlign: 'center', padding: '24px', color: '#999' }}>No items in this indent</td></tr>
            )}
          </tbody>
        </table>

        <table className="totals">
          <tbody>
            <tr><td>Billable (Σ sale rate × qty)</td><td className="num">{inr(data.billable)}</td></tr>
            <tr><td>× Against-Delivery %</td><td className="num">{data.pct ? `${data.pct}%` : '0%'}</td></tr>
            <tr className="grand"><td>Delivery Bill</td><td className="num">{inr(data.delivery)}</td></tr>
          </tbody>
        </table>

        <div className="note">
          Sale rate: the indent line's linked BOQ line first; if it has none, a BOQ line of the same order with the same
          description. FOC and RGP lines are not billed. Budget (item-master purchase rate) is a separate figure and is
          not used here.
        </div>

        <div className="footer">
          <div>Generated from SOTYN.AI · {new Date().toLocaleString('en-IN')}</div>
          <div>{COMPANY.email} · {COMPANY.website}</div>
        </div>
      </div>
    </div>
  );
}
