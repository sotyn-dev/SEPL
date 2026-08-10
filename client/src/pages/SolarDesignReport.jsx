// Engineering / Design Basis Report — composes a saved quotation's sizing
// calc, its linked 3D shadow study (if one was run), and the BOQ into one
// document: what the survey/design stage of the funnel is actually supposed
// to produce, instead of those numbers living scattered across three screens.
//
// Print-route pattern matches VendorPOPrint.jsx: a dedicated page, fetched by
// id, window.print() + @media print rules — no server-side PDF renderer.
//
// Deliberately shows the FROZEN numbers as saved on the quotation record
// (engineering_json / roi_json / boq_json), not a live recompute against
// today's rate book — a design report should describe what was actually
// specified on a dated quotation, not silently drift if rates change later.
import { Fragment, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { FiPrinter, FiArrowLeft, FiSun } from 'react-icons/fi';
import api from '../api';
import { groupBOQ, typeLabel } from '../lib/solar/engine';
import { num as fmt, inr } from '../lib/solar/format';

const fmtDate = (s) => {
  const d = s ? new Date(s) : new Date();
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

const MOUNT_LABEL = { ground: 'Ground-mount', rcc: 'Rooftop RCC', tin: 'Rooftop tin-shed', carport: 'Carport / shed', floating: 'Floating' };
const STANDARDS = [
  'IS 16169 / IEC 61215 — PV module design qualification',
  'IEC 62109 / CEA (Grid Connectivity) Regulations — inverter safety & grid interconnection',
  'IS 3043 — earthing',
  'IS/IEC 62305 — lightning protection',
  'National Building Code — structural / wind loading',
  'CEA Measures for Safety & Electric Supply Regulations — LT/HT protection coordination',
];

export default function SolarDesignReport() {
  const { id } = useParams();
  const [q, setQ] = useState(null);
  const [study, setStudy] = useState(null);
  const [error, setError] = useState(null);
  const [brand, setBrand] = useState({ name: 'Secured Engineers India', logo: '' });

  useEffect(() => {
    api.get('/solar/settings').then((r) => {
      const rows = r.data || [];
      const val = (k) => (rows.find((x) => x.key === k)?.value || '').trim();
      setBrand({ name: val('company_name') || 'Secured Engineers India', logo: val('logo_url') });
    }).catch(() => {});
  }, []);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const { data: quote } = await api.get(`/solar/quotations/${id}`);
        if (dead) return;
        setQ(quote);
        // Best-effort: pull the linked shadow study's summary, if the deal
        // this quote belongs to has one attached. Never blocks the report —
        // the design still prints fine without a 3D study behind it.
        const studyId = quote.deal_id ? await api.get(`/solar/deals/${quote.deal_id}`)
          .then((r) => r.data?.stage_data?.survey?.site_study_id)
          .catch(() => null) : null;
        if (studyId && !dead) {
          await api.get(`/solar-site/studies/${studyId}`).then((r) => { if (!dead) setStudy(r.data); }).catch(() => {});
        }
      } catch (e) {
        if (!dead) setError(e.response?.data?.error || 'Failed to load quotation');
      }
    })();
    return () => { dead = true; };
  }, [id]);

  if (error) return <div className="min-h-screen flex items-center justify-center text-red-600">{error}</div>;
  if (!q) return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading…</div>;

  const inp = q.inputs || {}, c = q.engineering || {}, roi = q.roi || {};
  const subsidy = roi.subsidy || { eligible: false };
  const lines = q.boq || [];
  const grouped = groupBOQ(lines);
  const totSP = lines.reduce((a, l) => a + (l.sp || 0), 0);
  const gstAmt = totSP * (parseFloat(inp.gst) || 0) / 100;
  const grand = totSP + gstAmt + (inp.net && inp.conn !== 'zeroexport' ? (parseFloat(inp.netchg) || 0) : 0);
  const s = study?.result?.summary;

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="bg-white border-b shadow-sm print:hidden sticky top-0 z-20">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <button onClick={() => window.history.back()} className="btn btn-secondary flex items-center gap-2"><FiArrowLeft size={14} /> Back</button>
          <button onClick={() => window.print()} className="btn btn-primary flex items-center gap-2"><FiPrinter size={14} /> Print / Save as PDF</button>
        </div>
      </div>

      <div className="max-w-4xl mx-auto bg-white shadow-lg my-6 print:my-0 print:shadow-none border-2 border-gray-800 print:border-black text-[12px] text-gray-900">
        <div className="bg-blue-800 text-white py-2 px-4 flex items-center justify-between print:bg-blue-800">
          <span className="font-bold text-[13px] flex items-center gap-2">
            {brand.logo ? <img src={brand.logo} alt={brand.name} className="h-6 object-contain" /> : <><FiSun size={15} /> {brand.name.toUpperCase()}</>}
          </span>
          <span className="font-extrabold tracking-[0.25em] uppercase text-[13px]">Design Basis Report</span>
        </div>

        <div className="p-4 border-b border-gray-800 print:border-black grid grid-cols-2 gap-x-6 gap-y-1 text-[11.5px]">
          <div><b>Client:</b> {q.client_name || '—'}</div>
          <div><b>Report date:</b> {fmtDate()}</div>
          <div><b>Site address:</b> {q.address || '—'}</div>
          <div><b>Quotation No:</b> {q.quote_no}</div>
          <div><b>System:</b> {fmt(c.kwAC)} kW {typeLabel(inp.conn)} — {MOUNT_LABEL[inp.mount] || inp.mount}</div>
          <div><b>State:</b> {inp.state}</div>
        </div>

        {/* ── Executive summary — the numbers in plain language, for whoever
             reads only the first page. Every figure here is pulled straight
             from the frozen roi_json, nothing is re-derived or estimated. ── */}
        <div className="p-4 border-b border-gray-800 print:border-black bg-blue-50/40 print:bg-blue-50">
          <p className="font-bold text-[11.5px] uppercase tracking-wide text-blue-800 mb-1.5">Executive Summary</p>
          <p className="text-[11.5px] leading-relaxed text-gray-800">
            This {fmt(c.kwAC)} kW {typeLabel(inp.conn)} solar system is designed to generate approximately{' '}
            <b>{fmt(roi.annualKWh, 0)} kWh</b> per year, cutting the electricity bill by roughly{' '}
            <b>₹{fmt(roi.annualSav, 0)}</b> annually at the current tariff of ₹{fmt(inp.tariff)}/unit.
            {subsidy.eligible && <> A PM Surya Ghar subsidy of <b>{inr(subsidy.totalSubsidy)}</b> applies, bringing the net investment down to <b>{inr(roi.netCost ?? grand)}</b>.</>}
            {' '}At this rate, the system is projected to pay for itself in about <b>{fmt(roi.payback, 1)} years</b> and
            save approximately <b>₹{fmt(roi.sav25 / 1e7, 2)} crore</b> over its 25-year working life, while avoiding an
            estimated <b>{fmt(roi.co2, 1)} tonnes of CO₂</b> emissions every year.
          </p>
        </div>

        {/* ── Hero render, when a 3D shadow study was captured with one ── */}
        {study?.result?.snapshot && (
          <div className="border-b border-gray-800 print:border-black">
            <img src={study.result.snapshot} alt="3D shadow-study render" className="w-full block" style={{ maxHeight: 320, objectFit: 'cover' }} />
            <p className="text-[9.5px] text-gray-500 px-4 py-1 bg-gray-50">3D shadow-study render — {study.name || `study #${study.id}`}</p>
          </div>
        )}

        {/* ── 1. Design basis ── */}
        <Section title="1 · Design Basis">
          <Grid>
            <Field k="DC capacity" v={`${fmt(c.realKWp, 2)} kWp`} />
            <Field k="AC capacity" v={`${fmt(c.kwAC, 1)} kW`} />
            <Field k="DC : AC ratio" v={fmt(c.dcac, 2)} />
            <Field k="Module" v={`${c.wp} Wp ${inp.ptype || ''} — ${inp.panelmake}`} />
            <Field k="Module count" v={`${c.nPanels} nos`} />
            <Field k="Mounting" v={`${MOUNT_LABEL[inp.mount] || inp.mount} — ${inp.structmake}`} />
            <Field k="Design wind speed" v={`${inp.wind} m/s`} />
            <Field k="Specific yield (site)" v={`${fmt(c.yieldKwh, 0)} kWh/kWp/yr`} />
            <Field k="Performance ratio" v="0.80 (assumed)" />
          </Grid>
          <p className="text-[10.5px] text-gray-600 mt-2">
            Applicable codes &amp; standards: {STANDARDS.join(' · ')}.
          </p>
        </Section>

        {/* ── 2. Electrical design ── */}
        <Section title="2 · Electrical Design">
          <Grid>
            <Field k="String configuration" v={`${c.perString} modules/string × ${c.nStrings} strings`} />
            <Field k="String voltage window" v={`Voc-cold ${fmt(c.vocCold, 1)} V (max series ${c.maxSeries}, min ${c.minSeries})`} />
            <Field k="Inverter selection" v={Object.entries(c.invSel || {}).map(([kw, n]) => `${n} × ${kw} kW`).join(' + ') || '—'} />
            <Field k="DC cabling" v={`${c.dcSize}, ${fmt(c.totalDC)} m run, VD ${fmt(c.dcVD, 2)}%`} />
            <Field k="AC cabling" v={`${c.acRuns} run(s), ${fmt(c.totalAC)} m, ${fmt(c.iAC)} A`} />
            <Field k="MC4 connector pairs" v={`${c.nMC4}`} />
            <Field k="Earthing" v={`${c.nPits} pits (IS 3043) · ${fmt(c.earthCable)} m earth cable`} />
            <Field k="Lightning protection" v={`${c.nLA} arrestor(s) — array footprint ≈ ${fmt(c.footprint)} m²`} />
            {inp.conn === 'zeroexport' && <Field k="Export control" v="Zero-export controller + grid CTs" />}
          </Grid>
          {c.isBatt && (
            <div className="mt-2 pt-2 border-t">
              <p className="font-bold text-[11px] mb-1">Battery bank ({inp.conn === 'offgrid' ? 'off-grid' : 'hybrid'})</p>
              <Grid>
                <Field k="Chemistry" v={inp.batterytype} />
                <Field k="Usable capacity" v={`${fmt(c.usableKWh)} kWh`} />
                <Field k="Bank capacity" v={`${fmt(c.bankKWh)} kWh (${inp.dod}% DoD)`} />
                <Field k="Backup load" v={`${inp.backupkw} kW × ${inp.backuphrs} hr`} />
              </Grid>
            </div>
          )}
        </Section>

        {/* ── 3. Shadow analysis (only if a 3D study is linked) ── */}
        {s ? (
          <Section title="3 · Shadow &amp; Yield Analysis">
            <Grid>
              <Field k="Source" v={`3D shadow study${study?.name ? ` — ${study.name}` : ''} (#${study.id})`} />
              <Field k="Panels placed" v={`${s.panelCount}`} />
              <Field k="Modelled annual yield" v={`${fmt(Math.round(s.kwhYear))} kWh/yr`} />
              <Field k="Specific yield (modelled)" v={`${fmt(s.specificYield, 0)} kWh/kWp/yr`} />
              <Field k="Mean panel efficiency" v={`${fmt(s.meanPerfPct, 1)}% of an unshaded optimal module`} />
              <Field k="Annual shading loss" v={`${fmt(s.shadeLossPct, 1)}%`} />
            </Grid>
            <p className="text-[10.5px] text-gray-600 mt-2">
              Efficiency is measured against an unshaded module at the site's optimal tilt/azimuth, from a
              full-year sun-position sweep against the traced/LiDAR site model — not the flat sizing estimate above.
            </p>
          </Section>
        ) : (
          <Section title="3 · Shadow &amp; Yield Analysis">
            <p className="text-[11px] text-amber-700">No 3D shadow study is linked to this deal yet — the yield figures above are the flat sizing-stage estimate, not a shading-verified one. Run the 3D Shadow Analysis tool from the survey stage and apply it to this deal before finalizing.</p>
          </Section>
        )}

        {/* ── 4. Bill of quantities ── */}
        <Section title="4 · Bill of Quantities">
          <table className="w-full text-[10.5px] border-collapse">
            <thead>
              <tr className="bg-gray-100 text-left uppercase text-[9.5px] text-gray-600">
                <th className="border border-gray-400 px-2 py-1 w-10">#</th>
                <th className="border border-gray-400 px-2 py-1">Description</th>
                <th className="border border-gray-400 px-2 py-1 w-16">Unit</th>
                <th className="border border-gray-400 px-2 py-1">Make</th>
                <th className="border border-gray-400 px-2 py-1 w-16 text-right">Qty</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map((cat) => (cat.grouped ? (
                <Fragment key={cat.no}>
                  <tr><td className="border border-gray-400 px-2 py-1 text-center">{cat.no}</td><td className="border border-gray-400 px-2 py-1 font-bold" colSpan={3}>{cat.name}</td><td className="border border-gray-400 px-2 py-1"></td></tr>
                  {cat.items.map((it, j) => (
                    <tr key={`${cat.no}-${j}`}>
                      <td className="border border-gray-400 px-2 py-1 text-center text-gray-500">{String.fromCharCode(97 + j)}</td>
                      <td className="border border-gray-400 px-2 py-1">{it.desc}</td>
                      <td className="border border-gray-400 px-2 py-1 text-center">{it.unit}</td>
                      <td className="border border-gray-400 px-2 py-1">{it.make}</td>
                      <td className="border border-gray-400 px-2 py-1 text-right">{fmt(it.qty)}</td>
                    </tr>
                  ))}
                </Fragment>
              ) : (
                <tr key={cat.no}>
                  <td className="border border-gray-400 px-2 py-1 text-center">{cat.no}</td>
                  <td className="border border-gray-400 px-2 py-1">{cat.items[0]?.desc}</td>
                  <td className="border border-gray-400 px-2 py-1 text-center">{cat.items[0]?.unit}</td>
                  <td className="border border-gray-400 px-2 py-1">{cat.items[0]?.make}</td>
                  <td className="border border-gray-400 px-2 py-1 text-right">{fmt(cat.items[0]?.qty)}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </Section>

        {/* ── 5. Financial summary ── */}
        <Section title="5 · Financial Summary" last>
          <Grid>
            <Field k="Base price (ex-GST)" v={inr(totSP)} />
            <Field k="GST" v={inr(gstAmt)} />
            <Field k="Grand total" v={inr(grand)} />
            <Field k="Annual generation" v={`${fmt(roi.annualKWh, 0)} kWh`} />
            <Field k="Annual bill savings" v={`₹${fmt(roi.annualSav, 0)} @ ₹${fmt(inp.tariff)}/unit`} />
            <Field k="Simple payback" v={`${fmt(roi.payback, 1)} yrs`} />
          </Grid>
          {subsidy.eligible && (
            <p className="text-[11px] text-emerald-700 mt-2">
              PM Surya Ghar subsidy applicable: {inr(subsidy.totalSubsidy)} — net investment {inr(roi.netCost ?? grand)}.
            </p>
          )}
        </Section>

        <div className="grid grid-cols-3 gap-4 px-4 py-6 border-t border-gray-800 print:border-black text-[11px]">
          {['Prepared by', 'Checked by', 'Approved by'].map((role) => (
            <div key={role}>
              <div className="h-10 border-b border-gray-400"></div>
              <p className="text-gray-500 mt-1">{role}</p>
            </div>
          ))}
        </div>

        <div className="text-center border-t-2 border-blue-800 py-2 text-[10.5px] italic bg-blue-50/60 print:bg-blue-50 text-blue-900">
          This design basis report is generated from Quotation {q.quote_no} — assumptions and sizing are subject to final site survey confirmation.
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
const Grid = ({ children }) => <div className="grid grid-cols-3 gap-x-4 gap-y-1.5">{children}</div>;
const Field = ({ k, v }) => (
  <div><span className="text-gray-500">{k}: </span><span className="font-semibold">{v}</span></div>
);
