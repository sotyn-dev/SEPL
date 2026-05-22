// Print-ready Offer Letter for a hired candidate.
//
// Mam (2026-05-22) shared her reference offer letter (Bhanu Pratap
// Rana · AI Engineer) and asked to match its format.  Layout below
// mirrors that template exactly:
//   • "PRIVATE AND CONFIDENTIAL" pill, top-right
//   • Date / Name / Address / Email / Subject / Mobile block
//   • Dear [First Name]
//   • Standard opening paragraph
//   • CTC (With complete break-up) — 3-col table
//   • Date of Joining / Probationary Period / Notice Period sections
//   • Confidentiality paragraph
//   • With Regards · Secured Engineers Pvt. Ltd. · Signature
//
// Same HTML→Ctrl+P→Save as PDF pattern as VendorPOPrint /
// IndentPrint / SalarySlipPrint.
//
// Route: /hr/candidates/:id/offer-letter

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';

const COMPANY = {
  name: 'Secured Engineers Pvt. Ltd.',
  short: 'SEPL',
  email: 'hr@securedengineers.com',
  website: 'www.securedengineers.com',
};

const fmtINR = (n) => Number(n || 0).toLocaleString('en-IN');
const fmtDateLong = (iso) => {
  if (!iso) return '___________';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
};

export default function OfferLetterPrint() {
  const { id } = useParams();
  const [c, setC] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.get(`/hr/candidates/${id}`)
      .then(r => setC(r.data))
      .catch(e => setErr(e.response?.data?.error || 'Failed to load candidate'));
  }, [id]);

  if (err) return <div className="p-6 text-red-700">{err}</div>;
  if (!c)   return <div className="p-6 text-gray-500">Loading…</div>;

  const today        = fmtDateLong(new Date().toISOString().slice(0, 10));
  const offeredPos   = c.offered_position || c.position || '___________';
  const monthly      = +c.offered_salary || 0;
  const annual       = monthly * 12;
  const joiningStr   = fmtDateLong(c.joining_date);
  const firstName    = (c.name || '').split(' ')[0] || c.name || '';

  return (
    <div className="bg-gray-100 min-h-screen py-6 print:bg-white print:py-0">
      {/* On-screen action bar — hidden in print */}
      <div className="max-w-[800px] mx-auto mb-4 flex justify-between items-center print:hidden">
        <a href="/hr" className="text-sm text-blue-700 hover:underline">← Back to HR &amp; Hiring</a>
        <button onClick={() => window.print()} className="btn btn-primary text-sm flex items-center gap-1.5">
          🖨️ Print / Save as PDF
        </button>
      </div>

      {/* Letter — A4 width, white card */}
      <div className="max-w-[800px] mx-auto bg-white shadow-lg print:shadow-none p-10 print:p-12 text-[12.5px] leading-relaxed text-gray-900" style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}>
        {/* PRIVATE AND CONFIDENTIAL */}
        <div className="text-right text-[10.5px] italic font-bold tracking-widest text-gray-700 mb-8">
          PRIVATE AND CONFIDENTIAL
        </div>

        {/* Header block — Date / Name / Address / Email / Subject / Mobile */}
        <div className="space-y-0.5 text-[12.5px]">
          <div><strong>Date:</strong> {today}</div>
          <div><strong>Name:</strong> {c.name}</div>
          {c.address && <div><strong>Address:</strong> {c.address}</div>}
          {c.email && <div><strong>Email:</strong> {c.email}</div>}
          <div><strong>Subject –</strong> Offer Letter</div>
          {c.phone && <div><strong>Mobile no -</strong> {c.phone}</div>}
        </div>

        {/* Salutation */}
        <p className="mt-6 mb-3"><strong>Dear {firstName}</strong>,</p>

        {/* Opening paragraph */}
        <p className="mb-5 text-justify">
          On behalf of {COMPANY.name}, we are pleased to extend you an offer of
          employment as a <strong>{offeredPos}</strong> in our organization. We urge
          you to read this letter carefully, since it contains certain important
          details pertaining to your employment.
        </p>

        {/* CTC table */}
        <p className="font-bold mb-2">CTC (With complete break-up):</p>
        <table className="w-full border-collapse text-[11.5px] mb-5">
          <thead>
            <tr className="bg-gray-100">
              <th className="border border-gray-700 px-2 py-1.5 text-left">EARNINGS</th>
              <th className="border border-gray-700 px-2 py-1.5 text-right">AMOUNT</th>
              <th className="border border-gray-700 px-2 py-1.5 text-right">NET ANNUAL AMOUNT</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border border-gray-700 px-2 py-1.5">Basic Pay</td>
              <td className="border border-gray-700 px-2 py-1.5 text-right tabular-nums">{monthly ? fmtINR(monthly) : '___________'}</td>
              <td className="border border-gray-700 px-2 py-1.5 text-right tabular-nums">{annual ? fmtINR(annual) : '___________'}</td>
            </tr>
            <tr>
              <td className="border border-gray-700 px-2 py-1.5">Conveyance Allowance</td>
              <td className="border border-gray-700 px-2 py-1.5 text-right italic text-gray-700">As per actual</td>
              <td className="border border-gray-700 px-2 py-1.5 text-right italic text-gray-700">As per actual</td>
            </tr>
            <tr>
              <td className="border border-gray-700 px-2 py-1.5">House Rent Allowance</td>
              <td className="border border-gray-700 px-2 py-1.5 text-right italic text-gray-700">Provided by company</td>
              <td className="border border-gray-700 px-2 py-1.5 text-right italic text-gray-700">Provided by company</td>
            </tr>
            <tr>
              <td className="border border-gray-700 px-2 py-1.5">Adhoc Allowance</td>
              <td className="border border-gray-700 px-2 py-1.5 text-right italic text-gray-700">N/A</td>
              <td className="border border-gray-700 px-2 py-1.5 text-right italic text-gray-700">N/A</td>
            </tr>
            <tr>
              <td className="border border-gray-700 px-2 py-1.5">Miscellaneous Allowance</td>
              <td className="border border-gray-700 px-2 py-1.5 text-right italic text-gray-700">As applicable</td>
              <td className="border border-gray-700 px-2 py-1.5 text-right italic text-gray-700">As applicable</td>
            </tr>
            <tr className="font-bold bg-gray-50">
              <td className="border border-gray-700 px-2 py-1.5">Total Earnings</td>
              <td className="border border-gray-700 px-2 py-1.5 text-right tabular-nums">{monthly ? fmtINR(monthly) : '___________'}</td>
              <td className="border border-gray-700 px-2 py-1.5 text-right tabular-nums">{annual ? fmtINR(annual) : '___________'}</td>
            </tr>
          </tbody>
        </table>

        {/* Date of Joining */}
        <p className="mb-3 text-justify">
          <strong>Date of Joining:</strong> Your date of joining would be{' '}
          <strong>{joiningStr}</strong>. If joining does not take place on the given
          date then the offer letter will be considered invalid.
        </p>

        {/* Probationary Period */}
        <p className="mb-3 text-justify">
          <strong>Probationary Period:</strong> The probationary period of 3 months
          needs to be served by the candidate after joining the job.
        </p>

        {/* Notice Period */}
        <p className="mb-3 text-justify">
          <strong>Notice Period:</strong> If the employee desires to leave the
          company, he / she needs to serve the notice period of 15 days. If the
          performance is not good then the employee can be terminated even during
          the probation period and all salary clearance will be done after 45 days
          even if the employee is terminated.
        </p>

        {/* Confidentiality + sign-off */}
        <p className="mb-6 text-justify">
          Please note that the contents of this letter are confidential and should
          not be used as a bargaining tool for negotiating employment terms with
          any other organization. If you have any queries, please feel free to
          contact us.  We look forward to working with you.
        </p>

        <div className="mt-10">
          <div><strong>With Regards,</strong></div>
          <div><strong>{COMPANY.name}</strong></div>
          <div className="mt-10 text-gray-700">Signature</div>
          <div className="border-t border-gray-500 w-48 mt-1" />
        </div>
      </div>

      <style>{`
        @media print {
          @page { size: A4; margin: 18mm; }
          body { background: white !important; }
        }
      `}</style>
    </div>
  );
}
