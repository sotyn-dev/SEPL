// Print-ready Offer Letter for a hired candidate.
//
// Mam (2026-05-22): "when here shortlisted & offer send create offer
// letter and show pdf i will share with you format" — first cut is
// a sensible template; mam will share final format and I'll style to
// match.  Same pattern as VendorPOPrint / IndentPrint / SalarySlip:
// HTML page → Ctrl+P → Save as PDF.
//
// Route: /hr/candidates/:id/offer-letter
// Pulls live data from /hr/candidates/:id.

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';
import { fmtDateIST } from '../utils/dateIST';

const COMPANY = {
  name: 'Secured Engineers Private Limited',
  short: 'SEPL',
  head_office: 'B.K Towers, 2480/1, Gill Rd, near Grewal Hospital, Janta Nagar, Ludhiana, Punjab 141003',
  corp_office: '58/A/1, First Floor, Kalu Sarai, New Delhi - 110016',
  email: 'hr@securedengineers.com',
  website: 'www.securedengineers.com',
  cin: 'U74999PB2015PTC040000',
};

const fmtINR = (n) => `Rs ${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

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

  const today = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
  const offeredPos = c.offered_position || c.position || '___________';
  const salaryStr  = c.offered_salary ? fmtINR(c.offered_salary) : '_______________';
  const joiningStr = c.joining_date ? fmtDateIST(c.joining_date) : '_______________';
  const reportingTo = c.reporting_to || '_______________';

  return (
    <div className="bg-gray-100 min-h-screen py-6 print:bg-white print:py-0">
      {/* On-screen action bar — hidden in print */}
      <div className="max-w-[800px] mx-auto mb-4 flex justify-between items-center print:hidden">
        <a href={`/hr`} className="text-sm text-blue-700 hover:underline">← Back to HR & Hiring</a>
        <button onClick={() => window.print()} className="btn btn-primary text-sm flex items-center gap-1.5">
          🖨️ Print / Save as PDF
        </button>
      </div>

      {/* The letter — A4-ish width, white card, print-safe */}
      <div className="max-w-[800px] mx-auto bg-white shadow-lg print:shadow-none p-10 print:p-12 text-[12.5px] leading-relaxed text-gray-900">
        {/* Letterhead */}
        <div className="text-center border-b-2 border-blue-900 pb-3 mb-5">
          <div className="text-[22px] font-extrabold tracking-tight text-blue-900">{COMPANY.name}</div>
          <div className="text-[10px] text-gray-600 mt-1">
            <div><strong>Head Office:</strong> {COMPANY.head_office}</div>
            <div><strong>Corporate Office:</strong> {COMPANY.corp_office}</div>
            <div className="mt-0.5">{COMPANY.email} · {COMPANY.website} · CIN: {COMPANY.cin}</div>
          </div>
        </div>

        {/* Ref + Date */}
        <div className="flex justify-between text-[11px] text-gray-700 mb-6">
          <div><strong>Ref:</strong> SEPL/OL/{new Date().getFullYear()}/{String(c.id).padStart(4, '0')}</div>
          <div><strong>Date:</strong> {today}</div>
        </div>

        {/* Title */}
        <div className="text-center text-[16px] font-bold uppercase tracking-wider mb-5 underline">
          Offer of Employment
        </div>

        {/* To */}
        <div className="mb-4">
          <div><strong>To,</strong></div>
          <div className="font-semibold">{c.name}</div>
          {c.phone && <div>{c.phone}</div>}
          {c.email && <div>{c.email}</div>}
        </div>

        {/* Salutation */}
        <p className="mb-3">Dear {c.name.split(' ')[0]},</p>

        <p className="mb-3">
          We are pleased to offer you the position of <strong>{offeredPos}</strong> at
          {' '}{COMPANY.name} ("the Company"). Based on your interview and discussions
          with our management team, we believe you will be a valuable addition to our
          organisation.
        </p>

        {/* Terms */}
        <div className="mb-4">
          <p className="font-bold mb-2">1. Terms of Employment</p>
          <ul className="list-disc pl-6 space-y-1.5 text-[12px]">
            <li><strong>Position:</strong> {offeredPos}</li>
            <li><strong>Date of Joining:</strong> {joiningStr}</li>
            <li><strong>Reporting To:</strong> {reportingTo}</li>
            <li><strong>Place of Work:</strong> SEPL Office, Ludhiana / Project site as assigned</li>
            <li><strong>Probation Period:</strong> 6 months from date of joining</li>
          </ul>
        </div>

        <div className="mb-4">
          <p className="font-bold mb-2">2. Compensation</p>
          <p>
            Your gross monthly remuneration will be <strong>{salaryStr}</strong>{' '}
            (Rupees in figures), inclusive of all statutory deductions and applicable
            taxes. A detailed salary breakdown will be shared in your appointment letter
            on the date of joining.
          </p>
        </div>

        <div className="mb-4">
          <p className="font-bold mb-2">3. Working Hours &amp; Leave</p>
          <p>
            Standard working hours: 9:30 AM to 6:30 PM, Monday to Saturday (2nd &amp; 4th
            Saturdays off).  Leave entitlement and holidays as per Company policy
            shared during induction.
          </p>
        </div>

        <div className="mb-4">
          <p className="font-bold mb-2">4. Confidentiality</p>
          <p>
            You shall keep confidential all business information, client data,
            drawings, BOQs, rates and intellectual property of the Company both
            during and after your employment.
          </p>
        </div>

        <div className="mb-4">
          <p className="font-bold mb-2">5. Documents Required on Joining</p>
          <ul className="list-disc pl-6 space-y-0.5 text-[12px]">
            <li>Aadhaar Card &amp; PAN Card (copy)</li>
            <li>Last 3 months' salary slips (if applicable)</li>
            <li>Educational certificates (10th, 12th, Graduation)</li>
            <li>Relieving / experience letter from previous employer</li>
            <li>Two passport-size photographs</li>
            <li>Cancelled cheque for salary bank account</li>
          </ul>
        </div>

        <div className="mb-5">
          <p className="font-bold mb-2">6. Acceptance</p>
          <p>
            Kindly confirm your acceptance of this offer by signing and returning a
            scanned copy of this letter to <strong>{COMPANY.email}</strong> within 7
            days of receipt.  Failing acceptance within this period, the offer shall
            stand withdrawn.
          </p>
        </div>

        <p className="mb-6">
          We look forward to welcoming you aboard and wish you a long and successful
          career with {COMPANY.short}.
        </p>

        {/* Signatures */}
        <div className="grid grid-cols-2 gap-8 mt-12">
          <div>
            <div className="border-t border-gray-700 pt-1 text-center">
              <div className="font-semibold">For {COMPANY.short}</div>
              <div className="text-[10px] text-gray-600 mt-0.5">Authorised Signatory · HR</div>
            </div>
          </div>
          <div>
            <div className="border-t border-gray-700 pt-1 text-center">
              <div className="font-semibold">Candidate Signature</div>
              <div className="text-[10px] text-gray-600 mt-0.5">{c.name}</div>
              <div className="text-[10px] text-gray-600">Date: _____________</div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="text-center text-[9px] text-gray-400 border-t border-gray-200 pt-2 mt-10">
          This is a computer-generated offer letter from the SEPL HR System.
          Auto-generated content — review and customise as needed before sending to the candidate.
        </div>
      </div>

      <style>{`
        @media print {
          @page { size: A4; margin: 0; }
          body { background: white !important; }
        }
      `}</style>
    </div>
  );
}
