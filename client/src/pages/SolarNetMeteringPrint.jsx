// Net-metering application summary — the technical details a DISCOM
// application form asks for, gathered onto one sheet instead of hunted
// across the quotation, project and component records by hand.
//
// Deliberately NOT a specific state's official form: India's DISCOMs each
// have their own form (and none expose a public submission API), so this is
// a generic summary to transcribe from — printed via window.print() like
// every other print page in this app.
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { FiPrinter, FiArrowLeft, FiSun } from 'react-icons/fi';
import api from '../api';
import { num as fmt } from '../lib/solar/format';

const fmtDate = (s) => {
  const d = s ? new Date(s) : new Date();
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

export default function SolarNetMeteringPrint() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [brand, setBrand] = useState({ name: 'Secured Engineers India', logo: '' });

  useEffect(() => {
    api.get(`/solar/projects/${id}/net-metering-print`).then((r) => setData(r.data)).catch((e) => setError(e.response?.data?.error || 'Failed to load'));
    api.get('/solar/settings').then((r) => {
      const rows = r.data || [];
      const val = (k) => (rows.find((x) => x.key === k)?.value || '').trim();
      setBrand({ name: val('company_name') || 'Secured Engineers India', logo: val('logo_url') });
    }).catch(() => {});
  }, [id]);

  if (error) return <div className="min-h-screen flex items-center justify-center text-red-600">{error}</div>;
  if (!data) return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading…</div>;

  const { project: p, engineering: c, inputs: inp, components } = data;
  const hasQuote = Object.keys(c).length > 0;
  const panels = components.filter((x) => x.category === 'panel');
  const inverters = components.filter((x) => x.category === 'inverter');

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="bg-white border-b shadow-sm print:hidden sticky top-0 z-20">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <button onClick={() => window.history.back()} className="btn btn-secondary flex items-center gap-2"><FiArrowLeft size={14} /> Back</button>
          <button onClick={() => window.print()} className="btn btn-primary flex items-center gap-2"><FiPrinter size={14} /> Print / Save as PDF</button>
        </div>
      </div>

      <div className="max-w-3xl mx-auto bg-white shadow-lg my-6 print:my-0 print:shadow-none border-2 border-gray-800 print:border-black text-[12px] text-gray-900">
        <div className="bg-blue-800 text-white py-2 px-4 flex items-center justify-between print:bg-blue-800">
          <span className="font-bold text-[13px] flex items-center gap-2">
            {brand.logo ? <img src={brand.logo} alt={brand.name} className="h-6 object-contain" /> : <><FiSun size={15} /> {brand.name.toUpperCase()}</>}
          </span>
          <span className="font-extrabold tracking-[0.2em] uppercase text-[12px]">Net-Metering Application Summary</span>
        </div>
        <div className="px-4 py-2 text-[10.5px] text-amber-800 bg-amber-50 border-b border-amber-200">
          Reference sheet for filing with the DISCOM — not an official state application form. Transcribe these details into the DISCOM's own form.
        </div>

        <Section title="Consumer Details">
          <Grid>
            <Field k="Client / consumer name" v={p.client_name} />
            <Field k="Consumer / account no." v={p.discom_consumer_no || '—'} />
            <Field k="Site address" v={p.location || '—'} />
            <Field k="State" v={p.state || '—'} />
            <Field k="Connection type" v={!hasQuote ? '—' : inp.conn === 'zeroexport' ? 'Captive / zero-export' : 'Net-metering (export)'} />
          </Grid>
        </Section>

        <Section title="System Technical Details">
          {!hasQuote && <p className="text-[10.5px] text-amber-700 mb-2">No quotation is linked to this project — link one from the deal to fill in system specs automatically.</p>}
          <Grid>
            <Field k="Proposed capacity (AC)" v={hasQuote ? `${fmt(c.kwAC)} kW` : '—'} />
            <Field k="Proposed capacity (DC)" v={hasQuote ? `${fmt(c.realKWp, 2)} kWp` : '—'} />
            <Field k="DC : AC ratio" v={hasQuote ? fmt(c.dcac, 2) : '—'} />
            <Field k="Module make / rating" v={hasQuote ? `${inp.panelmake || '—'} — ${c.wp || '—'} Wp × ${c.nPanels || '—'} nos` : '—'} />
            <Field k="Inverter make" v={hasQuote ? (inp.invmake || '—') : '—'} />
            <Field k="Inverter configuration" v={hasQuote ? (Object.entries(c.invSel || {}).map(([kw, n]) => `${n} × ${kw} kW`).join(' + ') || '—') : '—'} />
            <Field k="Mounting" v={hasQuote ? (inp.mount || '—') : '—'} />
            <Field k="Application type" v="Rooftop / ground-mount solar, grid-interactive" />
          </Grid>
        </Section>

        {(panels.length > 0 || inverters.length > 0) && (
          <Section title="Installed Equipment (Serial Numbers)">
            <table className="w-full text-[10.5px] border-collapse">
              <thead><tr className="bg-gray-100 text-left uppercase text-[9.5px] text-gray-600">
                <th className="border border-gray-400 px-2 py-1">Category</th><th className="border border-gray-400 px-2 py-1">Make / Model</th>
                <th className="border border-gray-400 px-2 py-1">Rating</th><th className="border border-gray-400 px-2 py-1">Serial No.</th><th className="border border-gray-400 px-2 py-1 text-right">Qty</th>
              </tr></thead>
              <tbody>
                {[...inverters, ...panels].map((x) => (
                  <tr key={x.id}>
                    <td className="border border-gray-400 px-2 py-1 capitalize">{x.category}</td>
                    <td className="border border-gray-400 px-2 py-1">{x.make} {x.model}</td>
                    <td className="border border-gray-400 px-2 py-1">{x.rating}</td>
                    <td className="border border-gray-400 px-2 py-1 font-mono">{x.serial_no || '(bulk lot)'}</td>
                    <td className="border border-gray-400 px-2 py-1 text-right">{x.qty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}

        <Section title="Application Status" last>
          <Grid>
            <Field k="Application filed" v={fmtDate(p.discom_application_date)} />
            <Field k="Application ref." v={p.discom_application_ref || '—'} />
            <Field k="Inspection date" v={fmtDate(p.discom_inspection_date)} />
            <Field k="Approval date" v={fmtDate(p.discom_approval_date)} />
            <Field k="Net-meter installed" v={fmtDate(p.net_meter_installed_date)} />
          </Grid>
        </Section>

        <div className="text-center border-t-2 border-blue-800 py-2 text-[10.5px] italic bg-blue-50/60 print:bg-blue-50 text-blue-900">
          Generated {fmtDate()} for project {p.project_no} — {p.client_name}.
        </div>
      </div>

      <style>{`
        @media print {
          @page { size: A4; margin: 8mm; }
          body { background: white !important; }
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          .print\\:hidden { display: none !important; }
          .print\\:my-0 { margin-top: 0 !important; margin-bottom: 0 !important; }
          .print\\:shadow-none { box-shadow: none !important; }
          .print\\:border-black { border-color: black !important; }
          .print\\:bg-blue-800 { background-color: #1e40af !important; color: white !important; }
          .print\\:bg-blue-50 { background-color: #eff6ff !important; }
        }
      `}</style>
    </div>
  );
}

const Section = ({ title, children, last }) => (
  <div className={`px-4 py-3 ${last ? '' : 'border-b border-gray-800 print:border-black'}`}>
    <p className="font-bold text-[11.5px] uppercase tracking-wide text-blue-800 mb-2 border-b border-blue-800/30 pb-1">{title}</p>
    {children}
  </div>
);
const Grid = ({ children }) => <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">{children}</div>;
const Field = ({ k, v }) => <div><span className="text-gray-500">{k}: </span><span className="font-semibold">{v}</span></div>;
