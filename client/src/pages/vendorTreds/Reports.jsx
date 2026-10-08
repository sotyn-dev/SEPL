import SerialNumber from '../../components/SerialNumber';
import NumberedTable from '../../components/NumberedTable';
import { useState } from 'react';
import { FiDownload, FiPrinter } from 'react-icons/fi';
import toast from 'react-hot-toast';
import api from '../../api';
import { fmtDate, fmtDateTime } from '../../utils/datetime';
import { Filters, LoadState, Value } from '../../components/vendorTreds/Common';
import { useDebounced, useDesktop, useRemote } from '../../components/vendorTreds/hooks';
import { ServerPager } from '../../components/vendorTreds/Records';
import { BASE, REPORTS, contentFilename, definition, downloadBlob, entityFilterVisibility, errorMessage, fieldsFor, filterParams, label, money } from '../../components/vendorTreds/model';

const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
function printable(value, column, row) {
  if (value == null || value === '') return '—';
  if (['money_paise', 'paise'].includes(column.type) || column.unit === 'paise' || /_paise$/.test(column.key) || (column.type === 'metric' && row.unit === 'paise')) return money(value, true);
  if (column.type === 'date') return fmtDate(value);
  if (column.type === 'datetime' || /_at$/.test(column.key)) return fmtDateTime(value);
  if (column.type === 'boolean') return value === true || value === 1 || value === '1' ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export default function Reports({ options, filters, onFilters, revision, page, limit, onPage }) {
  const catalog = options.reports || REPORTS.map(([key, title]) => ({ key, label: title }));
  const [kind, setKind] = useState(catalog[0]?.key || catalog[0]?.kind || REPORTS[0][0]);
  const [busy, setBusy] = useState('');
  const search = useDebounced(filters.search || '');
  const appliedFilters = { ...filters, search };
  const { data, loading, error } = useRemote(`${BASE}/reports/${kind}`, { ...appliedFilters, page, limit }, revision);
  const desktop = useDesktop();
  const columns = (data?.columns || []).map(column => typeof column === 'string' ? { key: column, label: label(column) } : column);
  const rows = data?.rows || [];
  const title = catalog.find(item => (item.key || item.kind) === kind)?.label || label(kind);
  const reportEntity = catalog.find(item => (item.key || item.kind) === kind)?.entity;
  const exportXlsx = async () => {
    setBusy('excel');
    try { const response = await api.get(`${BASE}/reports/${kind}/export`, { params: filterParams(appliedFilters), responseType: 'blob' }); downloadBlob(response.data, contentFilename(response, `${kind}.xlsx`)); toast.success('Excel report downloaded'); }
    catch (err) { toast.error(errorMessage(err)); } finally { setBusy(''); }
  };
  const print = async () => {
    const preview = window.open('', '_blank');
    if (!preview) { toast.error('Allow a new tab to open the PDF report.'); return; }
    preview.opener = null; preview.document.write('<p>Preparing report…</p>'); setBusy('pdf');
    try {
      const response = await api.get(`${BASE}/reports/${kind}`, { params: { ...filterParams(appliedFilters), all: 1, page: 1, limit: 10000 } });
      const report = response.data; const reportRows = report.rows || [];
      if (report.total > reportRows.length) throw new Error('This report is too large to print completely. Narrow the filters or use Excel export.');
      const printColumns = (report.columns || columns).map(column => typeof column === 'string' ? { key: column, label: label(column) } : column);
      const filterText = Object.entries(filterParams(appliedFilters)).map(([key, value]) => `${label(key)}: ${value}`).join(' · ');
      preview.document.open();
      preview.document.write(`<!doctype html><html><head><meta charset="UTF-8"><title>${escape(title)}</title><style>body{font:12px Arial,sans-serif;color:#1e293b;margin:24px}h1{font-size:20px;color:#1d4ed8}p{font-size:11px;color:#475569}table{width:100%;border-collapse:collapse;font-size:10px}td,th{padding:6px;border:1px solid #cbd5e1;text-align:left;overflow-wrap:anywhere}th{background:#eff6ff}tr{break-inside:avoid}.toolbar{margin-bottom:16px}button{padding:10px 16px;margin-right:8px;background:#1d4ed8;color:white;border:0;border-radius:6px}@media print{@page{size:A4 landscape;margin:10mm}body{margin:0}.toolbar{display:none}thead{display:table-header-group}}</style></head><body><div class="toolbar"><button onclick="window.print()">Print / Save PDF</button><button onclick="window.close()">Close</button></div><h1>Vendor &amp; TReDS Management — ${escape(title)}</h1><p>${escape(filterText || 'All authorized records')}</p><p>${escape(report.definition || '')}</p><table><thead><tr>${printColumns.map(column => `<th>${escape(column.label)}</th>`).join('')}</tr></thead><tbody>${reportRows.length ? reportRows.map(row => `<tr>${printColumns.map(column => `<td>${escape(printable(row[column.key], column, row))}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${printColumns.length}">No records match these filters.</td></tr>`}</tbody></table><p>${escape(report.total ?? reportRows.length)} records · Generated ${escape(new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))}</p></body></html>`);
      preview.document.close();
    } catch (err) { preview.close(); toast.error(errorMessage(err)); } finally { setBusy(''); }
  };
  return <section className="space-y-4">
    <div className="flex flex-wrap items-end gap-3"><label className="flex-1 min-w-52"><span className="label">Report</span><select className="select" value={kind} onChange={event => { setKind(event.target.value); onPage({ page: 1 }); }}>{catalog.map(item => <option key={item.key || item.kind} value={item.key || item.kind}>{item.label}</option>)}</select></label><button disabled={!!busy} className="btn btn-secondary inline-flex gap-2 items-center" onClick={exportXlsx}><FiDownload />{busy === 'excel' ? 'Exporting…' : 'Excel'}</button><button disabled={!!busy} className="btn btn-secondary inline-flex gap-2 items-center" onClick={print}><FiPrinter />{busy === 'pdf' ? 'Preparing…' : 'Print / Save PDF'}</button></div>
    <Filters value={filters} onChange={onFilters} statuses={definition(options, reportEntity).statuses || []} visibility={entityFilterVisibility(reportEntity)} sourceOptions={fieldsFor(definition(options, reportEntity)).find(field => field.key === 'source')?.options || []} tredsStatuses={definition(options, 'accounts').statuses || []} />
    {data?.definition && <p className="text-xs text-slate-500">{data.definition}</p>}
    <LoadState loading={loading} error={error} empty={!loading && !error && !rows.length} />
    {!loading && !error && rows.length > 0 && <>{desktop ? <div className="card p-0 overflow-x-auto"><NumberedTable start={(page - 1) * limit + 1} className="w-full text-xs"><thead><tr>{columns.map(column => <th key={column.key} className="px-3 py-3 text-left whitespace-nowrap">{column.label}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={row.id || index}>{columns.map(column => <td key={column.key} className="px-3 py-3"><Value value={row[column.key]} field={column.type === 'metric' && row.unit === 'paise' ? { ...column, type: 'paise' } : column} fieldKey={column.key} /></td>)}</tr>)}</tbody></NumberedTable></div> : <div className="space-y-3">{rows.map((row, index) => <dl key={row.id || index} className="card p-3 grid grid-cols-2 gap-3"><div className="col-span-2"><SerialNumber value={(page - 1) * limit + index + 1} /></div>{columns.map(column => <div key={column.key}><dt className="text-[11px] text-slate-500">{column.label}</dt><dd className="text-xs mt-1"><Value value={row[column.key]} field={column.type === 'metric' && row.unit === 'paise' ? { ...column, type: 'paise' } : column} fieldKey={column.key} /></dd></div>)}</dl>)}</div>}<ServerPager page={page} limit={limit} total={data.total || 0} onChange={onPage} /></>}
  </section>;
}
