import NumberedTable from './NumberedTable';
import SerialNumber from './SerialNumber';
import { Fragment, useState } from 'react';
import { FiChevronDown, FiChevronRight, FiFileText, FiPrinter, FiUpload, FiPackage } from 'react-icons/fi';
import Pagination from './Pagination';

const dateText = value => value ? String(value).slice(0, 10).split('-').reverse().join('-') : '—';
const fileLink = (file, label) => <a href={file} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-700 hover:text-blue-900 hover:underline"><FiFileText className="shrink-0" />{label}</a>;
const Badge = ({ children, complete = false, muted = false }) => (
  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap ${muted ? 'border-slate-200 bg-slate-50 text-slate-500' : complete ? 'border-emerald-100 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>{children}</span>
);
const actionClass = 'inline-flex items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[10px] font-semibold whitespace-nowrap transition-colors';
const billLabel = status => ({ uploaded: 'Uploaded', not_required: 'Not required', check_items: 'Check item type' }[status] || 'Bill pending');

export default function DispatchDocuments({ rows, loading, pagination, setPerPage,
  filters, onFilter, onPrint, onSalesBill, onReceive, canUpload,
  readyRows = [], readyPagination, readyLoading, onCreateChallan, onReceivePo, setReadyPerPage }) {
  const [expanded, setExpanded] = useState(null);
  const total = pagination?.total ?? rows.length;
  return <section className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h3 className="text-base font-semibold text-slate-900">Dispatch &amp; Receiving <span className="ml-2 rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-500">{total}</span></h3>
        <p className="mt-1 text-xs text-slate-500">Delivery challan, Tally sales bill and signed receiving in one record.</p>
      </div>
      <span className="inline-flex items-center gap-1.5 text-xs text-slate-500"><FiPackage /> Store issues appear directly after approval</span>
    </div>
    <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-900">
      Receiving can be saved while the Tally bill is pending. Store-issued material does not need a purchase bill; a Tally sales bill is required only for PO items.
    </div>
    <div className="rounded-xl border border-slate-200 bg-white p-3 flex flex-wrap items-end gap-3 text-[11px] text-slate-600">
      <label className="flex-1 min-w-[210px] font-medium">Search
        <input className="input mt-1 text-xs" placeholder="PO, challan, indent, site or receiver" value={filters.search} onChange={e => onFilter('search', e.target.value)} />
      </label>
      <label className="font-medium">Sales bill
        <select className="select mt-1 text-xs" value={filters.bill} onChange={e => onFilter('bill', e.target.value)}>
          <option value="all">All</option><option value="pending">Pending</option><option value="uploaded">Uploaded</option>
          <option value="not_required">Not required</option><option value="check_items">Check item type</option>
        </select>
      </label>
      <label className="font-medium">Receiving status
        <select className="select mt-1 text-xs" value={filters.receiving} onChange={e => onFilter('receiving', e.target.value)}>
          <option value="all">All</option><option value="pending">Pending</option><option value="partial">Partially received</option><option value="received">Received</option>
        </select>
      </label>
      <label className="font-medium">Received from<input type="date" className="input mt-1 text-xs" value={filters.from} onChange={e => onFilter('from', e.target.value)} /></label>
      <label className="font-medium">Received to<input type="date" className="input mt-1 text-xs" value={filters.to} onChange={e => onFilter('to', e.target.value)} /></label>
    </div>
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <NumberedTable start={(pagination?.from || 0) + 1} className="w-full min-w-[1280px] text-left text-[11px] leading-relaxed">
          <thead className="bg-slate-50 text-[9px] uppercase tracking-wide text-slate-500 border-b border-slate-200">
            <tr>{['Delivery note no.', 'Type', 'PO / Purchase bill', 'Site / Company', 'Indent by', 'Date', 'File', 'Tally sales bill', 'Received by', 'Received on', 'Proof', 'Status', 'Actions'].map(label => <th key={label} className="px-3 py-3 font-semibold">{label}</th>)}</tr>
          </thead>
          <tbody className="text-slate-700">
            {loading && <tr><td colSpan={13} className="p-8 text-center text-slate-500">Loading dispatches…</td></tr>}
            {!loading && rows.map(row => {
              const store = row.source === 'store';
              const material = row.dispatch_items || [];
              const received = row.receiving_status === 'received';
              const isOpen = expanded === row.id;
              return <Fragment key={row.id}>
                <tr className={`border-b border-slate-100 align-top hover:bg-slate-50/70 ${isOpen ? 'bg-blue-50/40' : ''}`}>
                  <td className="px-3 py-4 min-w-[140px]">
                    <button type="button" className="font-semibold text-blue-800 hover:underline" onClick={() => row.document_type === 'challan' ? onPrint(row) : setExpanded(isOpen ? null : row.id)}>{row.document_number || `#${row.id}`}</button>
                    <div className="mt-1 text-[10px] text-slate-400">#{row.id}</div>
                    {!!material.length && <button type="button" aria-expanded={isOpen} className="mt-2 inline-flex items-center gap-1 text-[10px] text-slate-600 hover:text-blue-800" onClick={() => setExpanded(isOpen ? null : row.id)}>
                      {isOpen ? <FiChevronDown /> : <FiChevronRight />}{material.length} {material.length === 1 ? 'item' : 'items'} · View qty
                    </button>}
                  </td>
                  <td className="px-3 py-4"><span className="inline-flex rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[9px] font-semibold text-blue-700">{row.document_type === 'challan' ? 'CHALLAN' : 'EARLIER BILL'}</span>
                    <div className={`mt-1 text-[10px] font-medium ${store ? 'text-indigo-700' : 'text-slate-400'}`}>{store ? 'From Store' : row.source === 'rgp' ? 'RGP' : 'Vendor'}</div>
                  </td>
                  <td className="px-3 py-4 min-w-[145px]">
                    <div className={`font-medium ${store ? 'text-indigo-700' : 'text-slate-800'}`}>{store ? 'From Store' : row.vendor_po_number || '—'}</div>
                    <div className="mt-1 text-[10px] text-slate-500">{store ? row.from_warehouse_name || 'Office stock' : row.vendor_name}</div>
                    {store ? <div className="mt-2 text-[10px] text-slate-500">Purchase bill not required</div> : (row.purchase_bills || []).map(bill => <div key={bill.id} className="mt-1 text-[10px]">{bill.file_path ? fileLink(bill.file_path, bill.bill_number || `PB #${bill.id}`) : bill.bill_number || `PB #${bill.id}`}</div>)}
                  </td>
                  <td className="px-3 py-4 min-w-[140px] max-w-[190px]"><div className="font-medium text-slate-800">{row.site_name || row.company_name || '—'}</div>
                    {row.company_name && row.company_name !== row.site_name && <div className="mt-1 text-[10px] text-slate-500">{row.company_name}</div>}
                    {row.indent_number && <div className="mt-1 text-[10px] text-slate-500">{row.indent_number}</div>}
                  </td>
                  <td className="px-3 py-4 min-w-[90px]">{row.raised_by_name || '—'}</td>
                  <td className="px-3 py-4 whitespace-nowrap text-slate-500">{dateText(row.delivery_date)}</td>
                  <td className="px-3 py-4">{row.document_type === 'challan' && row.file_path ? fileLink(row.file_path, 'View') : <span className="text-slate-400">—</span>}</td>
                  <td className="px-3 py-4 min-w-[115px]">
                    <Badge complete={row.sales_bill_status === 'uploaded'} muted={row.sales_bill_status === 'not_required'}>{billLabel(row.sales_bill_status)}</Badge>
                    {row.sales_bill_status === 'not_required' && <div className="mt-1 text-[10px] text-slate-400">FOC / RGP only</div>}
                    {(row.sales_bill_documents || []).map(doc => <div key={doc.file_path} className="mt-2 text-[10px]">{fileLink(doc.file_path, doc.number || 'View bill')}</div>)}
                  </td>
                  <td className="px-3 py-4 min-w-[90px]">{row.received_by_name || '—'}</td>
                  <td className="px-3 py-4 whitespace-nowrap text-slate-500">{dateText(row.received_at)}</td>
                  <td className="px-3 py-4">{row.receiving_documents?.length ? row.receiving_documents.map((doc, index) => <div key={doc.file_path} className="mb-1">{fileLink(doc.file_path, row.receiving_documents.length > 1 ? `Proof ${index + 1}` : 'View')}{row.receiving_documents.length > 1 && <div className="text-[9px] text-slate-400">{doc.received_by_name} · {dateText(doc.received_at)}</div>}</div>) : <span className="text-slate-400">—</span>}</td>
                  <td className="px-3 py-4"><Badge complete={received}>{received ? 'Received' : row.receiving_status === 'partial' ? 'Partially received' : 'Pending'}</Badge>
                    {!!row.receiving_history?.length && <div className="mt-1 text-[10px] text-slate-500">{row.receiving_history.length} receiving{row.receiving_history.length === 1 ? '' : 's'}</div>}
                  </td>
                  <td className="px-3 py-4 min-w-[130px]"><div className="flex flex-col items-start gap-1.5">
                    {row.document_type === 'challan' && <button type="button" className={`${actionClass} border-slate-200 bg-white text-slate-600 hover:bg-slate-100`} onClick={() => onPrint(row)}><FiPrinter />Print challan</button>}
                    {canUpload && row.sales_bill_status !== 'not_required' && <button type="button" className={`${actionClass} border-blue-200 bg-blue-50 text-blue-800 hover:bg-blue-100`} onClick={() => onSalesBill(row)}><FiUpload />{row.sales_bill_status === 'uploaded' ? 'Replace Tally bill' : 'Upload Tally bill'}</button>}
                    {canUpload && !received && <button type="button" className={`${actionClass} border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700`} onClick={() => onReceive(row)}><FiUpload />{row.receiving_history?.length ? 'Add another receiving' : 'Upload receiving'}</button>}
                  </div></td>
                </tr>
                {isOpen && <tr className="border-b border-blue-100 bg-slate-50"><td colSpan={13} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-3 mb-3"><h4 className="font-semibold text-slate-800">{store ? 'Approved material issued from store' : 'Dispatched material'}</h4><span className="text-slate-500">{row.indent_number}{store && row.stock_issue_number ? ` · ${row.stock_issue_number}` : ''}</span></div>
                  <NumberedTable className="w-full max-w-3xl text-[11px] bg-white rounded-lg"><thead><tr className="text-[10px] text-slate-500 border-b"><th className="px-3 py-2">Material</th><th className="px-3 py-2">Item type</th><th className="px-3 py-2 text-right">{store ? 'Approved store qty' : 'Dispatch qty'}</th><th className="px-3 py-2 text-right">Received</th><th className="px-3 py-2 text-right">Balance</th><th className="px-3 py-2">Unit</th></tr></thead><tbody>
                    {material.map((item, index) => <tr key={index} className="border-b border-slate-100 last:border-0"><td className="px-3 py-2">{item.description || item.item_name || '—'}{item.item_code && <span className="ml-2 text-[10px] text-slate-400">{item.item_code}</span>}</td><td className="px-3 py-2">{item.item_type || '—'}</td><td className="px-3 py-2 text-right font-semibold">{Number(item.qty ?? item.quantity ?? 0).toLocaleString('en-IN')}</td><td className="px-3 py-2 text-right">{item.received_qty ?? 0}</td><td className="px-3 py-2 text-right font-semibold text-amber-700">{item.remaining_qty ?? item.qty}</td><td className="px-3 py-2">{item.unit || '—'}</td></tr>)}
                  </tbody></NumberedTable>
                  {!!row.receiving_history?.length && <div className="mt-4 space-y-2"><h4 className="font-semibold">Receiving history</h4>{row.receiving_history.map((receipt,index) => <div key={receipt.id} className="rounded-lg border border-slate-200 bg-white p-3">
                    <div className="flex flex-wrap gap-3 items-center"><b>Receiving {index + 1}</b><span>{receipt.received_by_name} · {dateText(receipt.received_at)}</span><Badge complete={receipt.approval_status === 'approved'} muted={!!receipt.legacy}>{receipt.legacy ? 'Earlier record' : receipt.approval_status === 'approved' ? 'Approved' : receipt.approval_status === 'rejected' ? 'Rejected' : 'Awaiting approval'}</Badge>{receipt.files.map((file,i) => <span key={file}>{fileLink(file,`Proof ${i + 1}`)}</span>)}</div>
                    <div className="mt-2 text-slate-600">{receipt.items.filter(it => it.received_qty > 0).map(it => `${it.description}: ${it.received_qty} ${it.unit || ''}`).join(' · ')}</div>
                  </div>)}</div>}
                </td></tr>}
              </Fragment>;
            })}
            {!loading && !rows.length && <tr><td colSpan={13} className="p-8 text-center text-slate-500">No dispatches match these filters.</td></tr>}
          </tbody>
        </NumberedTable>
      </div>
      {pagination && <Pagination pg={pagination} setPerPage={setPerPage} />}
    </div>
    {(readyRows.length > 0 || readyLoading) && <details className="card p-4">
      <summary className="cursor-pointer text-sm font-semibold">Earlier purchase bills without a delivery challan ({readyPagination?.total || readyRows.length})</summary>
      <div className="mt-3 space-y-3">{readyRows.map((po, index) => <div key={po.id} className="flex flex-wrap gap-3 items-center justify-between border-t pt-3 text-sm"><SerialNumber value={(readyPagination?.from || 0) + index + 1} />
        <div>{po.po_number} · {po.indent_site_name || po.vendor_name}</div>
        {canUpload && <div className="flex gap-2">
          <button className="btn btn-secondary text-xs" onClick={() => onCreateChallan(po)}>Create Challan</button>
          <button className="btn btn-success text-xs" onClick={() => onReceivePo(po)}>Upload Receiving</button>
        </div>}
      </div>)}</div>
      {readyPagination && <Pagination pg={readyPagination} setPerPage={setReadyPerPage} />}
    </details>}
  </section>;
}
