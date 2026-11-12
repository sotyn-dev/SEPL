import { useState, useEffect } from 'react';
import {
  FiCheckCircle, FiUploadCloud, FiPaperclip, FiBriefcase,
  FiMapPin, FiMail, FiPhone, FiFileText, FiShield, FiCheck,
  FiAlertCircle, FiPrinter, FiExternalLink, FiUser
} from 'react-icons/fi';
import { LuBadgeCheck, LuBuilding2 } from 'react-icons/lu';
import { STATES, DISTRICTS_BY_STATE } from '../data/indiaLocations';

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const GST_STATE_CODES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '25': 'Daman and Diu', '26': 'Dadra and Nagar Haveli',
  '27': 'Maharashtra', '28': 'Andhra Pradesh', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh',
  '38': 'Ladakh'
};

const CATEGORIES = [
  { id: 'FF', label: 'Fire Fighting (Hydrant, Sprinkler, Alarm, Gas Suppression)' },
  { id: 'ELE', label: 'Electrical (Panels, Cables, Transformers, HT/LT)' },
  { id: 'LV', label: 'LV & Automation (CCTV, FAS, PA System, Networking)' },
  { id: 'Solar', label: 'Solar Division (Modules, Inverters, Structures)' },
  { id: 'HVAC', label: 'HVAC & Ventilation (Ducting, Chillers, VRF, Fans)' },
  { id: 'Plumbing', label: 'Plumbing & PHE (Pipes, Pumps, Valves, Fittings)' },
  { id: 'INTERIOR', label: 'Civil, Finishing & Interior Works' },
  { id: 'OTHER', label: 'Safety PPE & General Consumables' }
];

const VENDOR_TYPES = [
  'Authorized Distributor',
  'Stockist / Dealer',
  'Direct Manufacturer / OEM',
  'Trader',
  'Fabricator',
  'Specialized Contractor / Service Provider'
];

export default function PublicVendorRegistration() {
  const [form, setForm] = useState({
    firm_name: '',
    contact_person: '',
    phone: '',
    email: '',
    gst_number: '',
    pan_number: '',
    msme_number: '',
    state: 'Punjab',
    district: '',
    address: '',
    pincode: '',
    type: 'Authorized Distributor',
    category: 'FF',
    deals_in: '',
    makes: '',
    payment_terms: '30 Days Credit',
    credit_days: '30',
    bank_name: '',
    account_number: '',
    confirm_account: '',
    ifsc_code: '',
    account_type: 'Current',
    gst_doc_url: '',
    cheque_doc_url: '',
    msme_doc_url: '',
    catalog_doc_url: ''
  });

  const [uploadingField, setUploadingField] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successData, setSuccessData] = useState(null);
  const [declared, setDeclared] = useState(false);

  // Auto-fill state & PAN when GST is entered
  const handleGstChange = (val) => {
    const cleanGst = val.toUpperCase().trim();
    const update = { gst_number: cleanGst };
    if (cleanGst.length >= 2) {
      const code = cleanGst.slice(0, 2);
      if (GST_STATE_CODES[code]) update.state = GST_STATE_CODES[code];
    }
    if (cleanGst.length >= 12 && GSTIN_RE.test(cleanGst)) {
      update.pan_number = cleanGst.slice(2, 12);
    }
    setForm(f => ({ ...f, ...update }));
  };

  const uploadDoc = async (file, fieldKey) => {
    if (!file) return;
    setUploadingField(fieldKey);
    setErrorMsg('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/public/vendor-registration/upload', {
        method: 'POST',
        body: fd
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setForm(f => ({ ...f, [fieldKey]: data.url }));
    } catch (err) {
      setErrorMsg(err.message || 'File upload failed');
    } finally {
      setUploadingField(null);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErrorMsg('');

    if (!form.firm_name.trim()) return setErrorMsg('Please enter your firm / company name.');
    if (!form.contact_person.trim()) return setErrorMsg('Please enter the contact person name.');
    if (!form.phone.trim() || form.phone.replace(/[^0-9]/g, '').length < 10) {
      return setErrorMsg('Please enter a valid 10-digit mobile number.');
    }
    if (!form.email.trim() || !form.email.includes('@')) {
      return setErrorMsg('Please enter a valid email address.');
    }
    if (form.gst_number && !GSTIN_RE.test(form.gst_number.trim())) {
      return setErrorMsg('Invalid GSTIN format. It must be 15 alphanumeric characters.');
    }
    if (form.account_number && form.confirm_account && form.account_number !== form.confirm_account) {
      return setErrorMsg('Bank account numbers do not match.');
    }
    if (!declared) {
      return setErrorMsg('Please check the declaration box before submitting.');
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/public/vendor-registration/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registration submission failed');
      setSuccessData(data);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setErrorMsg(err.message || 'Error submitting registration');
    } finally {
      setSubmitting(false);
    }
  };

  if (successData) {
    return (
      <div className="min-h-screen bg-slate-50 py-10 px-4 sm:px-6 flex items-center justify-center">
        <div className="max-w-xl w-full bg-white rounded-2xl shadow-xl border border-slate-200 p-8 sm:p-10 text-center">
          <div className="w-16 h-16 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-4">
            <FiCheckCircle size={36} />
          </div>
          <span className="inline-block text-xs uppercase tracking-wider font-bold text-emerald-700 bg-emerald-50 px-3 py-1 rounded-full border border-emerald-200 mb-2">
            Registration Successful
          </span>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 mb-2">
            Welcome, {successData.firm_name}!
          </h1>
          <p className="text-slate-600 text-sm mb-6 leading-relaxed">
            {successData.message}
          </p>

          <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-left space-y-2 mb-6">
            <div className="flex justify-between items-center text-xs text-slate-500 border-b pb-2">
              <span>Vendor Code</span>
              <span className="font-mono font-bold text-slate-800 text-sm">{successData.vendor_code}</span>
            </div>
            <div className="flex justify-between items-center text-xs text-slate-500 border-b pb-2">
              <span>Firm Name</span>
              <span className="font-semibold text-slate-800">{successData.firm_name}</span>
            </div>
            <div className="flex justify-between items-center text-xs text-slate-500 border-b pb-2">
              <span>Contact Person</span>
              <span className="font-semibold text-slate-800">{form.contact_person}</span>
            </div>
            <div className="flex justify-between items-center text-xs text-slate-500">
              <span>Phone / WhatsApp</span>
              <span className="font-semibold text-slate-800">{form.phone}</span>
            </div>
          </div>

          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-xs text-blue-900 text-left mb-6 leading-relaxed">
            <strong>Next Steps:</strong>
            <ul className="list-disc ml-4 mt-1 space-y-1">
              <li>Our Purchase & Procurement team has received your registration in SOTYN ERP.</li>
              <li>You will receive RFQ (Request for Quotations) and inquiries via email and WhatsApp.</li>
              <li>Please keep your quotation responses prompt with competitive pricing and delivery timelines.</li>
            </ul>
          </div>

          <button
            onClick={() => window.print()}
            className="w-full btn bg-slate-800 hover:bg-slate-900 text-white flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold shadow-sm"
          >
            <FiPrinter size={16} /> Print Confirmation
          </button>
        </div>
      </div>
    );
  }

  const districts = form.state && DISTRICTS_BY_STATE[form.state] ? DISTRICTS_BY_STATE[form.state] : [];

  return (
    <div className="min-h-screen bg-slate-100 py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-3xl mx-auto">
        {/* Header Branding */}
        <div className="bg-gradient-to-r from-slate-900 via-blue-950 to-slate-900 text-white rounded-2xl p-6 sm:p-8 shadow-xl mb-6 relative overflow-hidden">
          <div className="absolute right-0 top-0 translate-x-8 -translate-y-8 w-48 h-48 bg-blue-500/10 rounded-full blur-2xl"></div>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 bg-red-600 rounded-lg flex items-center justify-center font-black text-xl shadow-md">
              SE
            </div>
            <div>
              <h2 className="text-lg font-bold tracking-tight">SECURED ENGINEERS PVT. LTD.</h2>
              <p className="text-[11px] text-blue-200 font-medium">ISO 9001:2015 Certified · Turnkey MEP & Solar EPC Contractor</p>
            </div>
          </div>
          <div className="mt-4 border-t border-slate-700/60 pt-4">
            <h1 className="text-2xl sm:text-3xl font-black text-white flex items-center gap-2.5">
              <LuBadgeCheck className="text-emerald-400" /> Vendor Empanelment & Registration
            </h1>
            <p className="mt-1 text-xs sm:text-sm text-slate-300">
              Welcome! Please complete this one-time registration form. Your firm will be directly empanelled in our ERP system for RFQs, quotations, and purchase orders.
            </p>
          </div>
        </div>

        {errorMsg && (
          <div className="mb-6 bg-red-50 border border-red-300 rounded-xl p-4 flex items-center gap-3 text-sm text-red-800 shadow-sm animate-shake">
            <FiAlertCircle size={20} className="text-red-600 flex-shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Section 1: Firm Profile */}
          <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200 space-y-4">
            <div className="flex items-center gap-2 text-slate-900 font-bold border-b pb-3">
              <LuBuilding2 className="text-blue-600" size={18} />
              <span>1. Business & Firm Details</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Firm / Company Legal Name *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Apex Electricals & Hardware Pvt Ltd"
                  value={form.firm_name}
                  onChange={e => setForm({ ...form, firm_name: e.target.value })}
                  className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Business Entity Type *
                </label>
                <select
                  value={form.type}
                  onChange={e => setForm({ ...form, type: e.target.value })}
                  className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  {VENDOR_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Primary Trade / Category *
                </label>
                <select
                  value={form.category}
                  onChange={e => setForm({ ...form, category: e.target.value })}
                  className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  {CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Brands / Makes Represented or Supplied
                </label>
                <input
                  type="text"
                  placeholder="e.g. Tata, Polycab, Havells, Audco, Astral, Schneider, Siemens..."
                  value={form.makes}
                  onChange={e => setForm({ ...form, makes: e.target.value })}
                  className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Key Products & Materials Dealt In
                </label>
                <textarea
                  rows={2}
                  placeholder="e.g. GI Pipes, Butterfly Valves, Fire Hydrant Valves, Armoured Cables, Switchgear, GI Cable Trays..."
                  value={form.deals_in}
                  onChange={e => setForm({ ...form, deals_in: e.target.value })}
                  className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            </div>
          </div>

          {/* Section 2: Contact & Address */}
          <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200 space-y-4">
            <div className="flex items-center gap-2 text-slate-900 font-bold border-b pb-3">
              <FiUser className="text-blue-600" size={18} />
              <span>2. Contact Person & Office Address</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Contact Person Name *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Rajesh Kumar"
                  value={form.contact_person}
                  onChange={e => setForm({ ...form, contact_person: e.target.value })}
                  className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Mobile / WhatsApp Number *
                </label>
                <div className="relative">
                  <span className="absolute left-3.5 top-2.5 text-sm text-slate-400 font-medium">+91</span>
                  <input
                    type="tel"
                    required
                    maxLength={10}
                    placeholder="9876543210"
                    value={form.phone}
                    onChange={e => setForm({ ...form, phone: e.target.value.replace(/[^0-9]/g, '') })}
                    className="w-full pl-12 pr-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Official Email Address (for Purchase Orders & RFQs) *
                </label>
                <input
                  type="email"
                  required
                  placeholder="sales@yourcompany.com"
                  value={form.email}
                  onChange={e => setForm({ ...form, email: e.target.value })}
                  className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Registered Address *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Plot / Shop No, Industrial Area / Street, City"
                  value={form.address}
                  onChange={e => setForm({ ...form, address: e.target.value })}
                  className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">State *</label>
                <select
                  value={form.state}
                  onChange={e => setForm({ ...form, state: e.target.value, district: '' })}
                  className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  {STATES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">District / City</label>
                {districts.length > 0 ? (
                  <select
                    value={form.district}
                    onChange={e => setForm({ ...form, district: e.target.value })}
                    className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  >
                    <option value="">Select district</option>
                    {districts.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                ) : (
                  <input
                    type="text"
                    placeholder="District name"
                    value={form.district}
                    onChange={e => setForm({ ...form, district: e.target.value })}
                    className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                )}
              </div>
            </div>
          </div>

          {/* Section 3: Statutory & Banking Details */}
          <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200 space-y-4">
            <div className="flex items-center gap-2 text-slate-900 font-bold border-b pb-3">
              <FiShield className="text-blue-600" size={18} />
              <span>3. Tax, Statutory & Bank Details</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  GSTIN (GST Number)
                </label>
                <input
                  type="text"
                  maxLength={15}
                  placeholder="03AAAAA0000A1Z5"
                  value={form.gst_number}
                  onChange={e => handleGstChange(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm uppercase font-mono rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                <span className="text-[10px] text-slate-400 mt-0.5 block">Auto-detects State & PAN</span>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  PAN Number
                </label>
                <input
                  type="text"
                  maxLength={10}
                  placeholder="AAAAA0000A"
                  value={form.pan_number}
                  onChange={e => setForm({ ...form, pan_number: e.target.value.toUpperCase() })}
                  className="w-full px-3.5 py-2.5 text-sm uppercase font-mono rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  MSME / Udyam Number (Optional)
                </label>
                <input
                  type="text"
                  placeholder="UDYAM-PB-00-0000000"
                  value={form.msme_number}
                  onChange={e => setForm({ ...form, msme_number: e.target.value.toUpperCase() })}
                  className="w-full px-3.5 py-2.5 text-sm uppercase rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Payment Terms Offered
                </label>
                <select
                  value={form.payment_terms}
                  onChange={e => setForm({ ...form, payment_terms: e.target.value })}
                  className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  <option value="30 Days Credit">30 Days Credit</option>
                  <option value="45 Days Credit">45 Days Credit</option>
                  <option value="60 Days Credit">60 Days Credit</option>
                  <option value="15 Days Credit">15 Days Credit</option>
                  <option value="Against Delivery / PDC">Against Delivery / PDC</option>
                  <option value="Advance against PI">Advance against PI</option>
                </select>
              </div>

              {/* Bank fields */}
              <div className="sm:col-span-2 pt-2 border-t">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">Bank Details for Vendor POs & RTGS Payments</h4>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Bank Name</label>
                <input
                  type="text"
                  placeholder="e.g. HDFC Bank / State Bank of India"
                  value={form.bank_name}
                  onChange={e => setForm({ ...form, bank_name: e.target.value })}
                  className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">IFSC Code</label>
                <input
                  type="text"
                  maxLength={11}
                  placeholder="HDFC0001234"
                  value={form.ifsc_code}
                  onChange={e => setForm({ ...form, ifsc_code: e.target.value.toUpperCase() })}
                  className="w-full px-3.5 py-2.5 text-sm uppercase font-mono rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Account Number</label>
                <input
                  type="password"
                  placeholder="Account Number"
                  value={form.account_number}
                  onChange={e => setForm({ ...form, account_number: e.target.value })}
                  className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Confirm Account Number</label>
                <input
                  type="text"
                  placeholder="Re-enter Account Number"
                  value={form.confirm_account}
                  onChange={e => setForm({ ...form, confirm_account: e.target.value })}
                  className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            </div>
          </div>

          {/* Section 4: Document Uploads */}
          <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200 space-y-4">
            <div className="flex items-center gap-2 text-slate-900 font-bold border-b pb-3">
              <FiUploadCloud className="text-blue-600" size={18} />
              <span>4. Document Proofs (Recommended)</span>
            </div>

            <p className="text-xs text-slate-500">
              Upload clear PDF or Image copies of your documents. You can also upload them later.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* GST Doc */}
              <div className="border border-dashed border-slate-300 rounded-xl p-3.5 text-center hover:bg-slate-50 transition">
                <span className="block text-xs font-bold text-slate-800 mb-1">GST Certificate</span>
                {form.gst_doc_url ? (
                  <div className="flex items-center justify-center gap-1.5 text-xs text-emerald-600 font-semibold">
                    <FiCheckCircle size={14} /> Uploaded
                  </div>
                ) : (
                  <label className="cursor-pointer inline-flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-800 font-semibold py-1">
                    <FiPaperclip size={13} /> {uploadingField === 'gst_doc_url' ? 'Uploading...' : 'Choose File'}
                    <input
                      type="file"
                      className="hidden"
                      accept=".pdf,image/*"
                      disabled={uploadingField !== null}
                      onChange={e => uploadDoc(e.target.files?.[0], 'gst_doc_url')}
                    />
                  </label>
                )}
              </div>

              {/* Cheque Doc */}
              <div className="border border-dashed border-slate-300 rounded-xl p-3.5 text-center hover:bg-slate-50 transition">
                <span className="block text-xs font-bold text-slate-800 mb-1">Cancelled Cheque</span>
                {form.cheque_doc_url ? (
                  <div className="flex items-center justify-center gap-1.5 text-xs text-emerald-600 font-semibold">
                    <FiCheckCircle size={14} /> Uploaded
                  </div>
                ) : (
                  <label className="cursor-pointer inline-flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-800 font-semibold py-1">
                    <FiPaperclip size={13} /> {uploadingField === 'cheque_doc_url' ? 'Uploading...' : 'Choose File'}
                    <input
                      type="file"
                      className="hidden"
                      accept=".pdf,image/*"
                      disabled={uploadingField !== null}
                      onChange={e => uploadDoc(e.target.files?.[0], 'cheque_doc_url')}
                    />
                  </label>
                )}
              </div>

              {/* MSME Doc */}
              <div className="border border-dashed border-slate-300 rounded-xl p-3.5 text-center hover:bg-slate-50 transition">
                <span className="block text-xs font-bold text-slate-800 mb-1">MSME / Udyam Certificate</span>
                {form.msme_doc_url ? (
                  <div className="flex items-center justify-center gap-1.5 text-xs text-emerald-600 font-semibold">
                    <FiCheckCircle size={14} /> Uploaded
                  </div>
                ) : (
                  <label className="cursor-pointer inline-flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-800 font-semibold py-1">
                    <FiPaperclip size={13} /> {uploadingField === 'msme_doc_url' ? 'Uploading...' : 'Choose File'}
                    <input
                      type="file"
                      className="hidden"
                      accept=".pdf,image/*"
                      disabled={uploadingField !== null}
                      onChange={e => uploadDoc(e.target.files?.[0], 'msme_doc_url')}
                    />
                  </label>
                )}
              </div>

              {/* Catalog Doc */}
              <div className="border border-dashed border-slate-300 rounded-xl p-3.5 text-center hover:bg-slate-50 transition">
                <span className="block text-xs font-bold text-slate-800 mb-1">Company Profile / Catalog</span>
                {form.catalog_doc_url ? (
                  <div className="flex items-center justify-center gap-1.5 text-xs text-emerald-600 font-semibold">
                    <FiCheckCircle size={14} /> Uploaded
                  </div>
                ) : (
                  <label className="cursor-pointer inline-flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-800 font-semibold py-1">
                    <FiPaperclip size={13} /> {uploadingField === 'catalog_doc_url' ? 'Uploading...' : 'Choose File'}
                    <input
                      type="file"
                      className="hidden"
                      accept=".pdf,image/*"
                      disabled={uploadingField !== null}
                      onChange={e => uploadDoc(e.target.files?.[0], 'catalog_doc_url')}
                    />
                  </label>
                )}
              </div>
            </div>
          </div>

          {/* Section 5: Declaration & Submit */}
          <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200 space-y-4">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={declared}
                onChange={e => setDeclared(e.target.checked)}
                className="mt-1 h-4 w-4 rounded text-blue-600 focus:ring-blue-500 border-slate-300"
              />
              <span className="text-xs text-slate-600 leading-relaxed">
                I hereby declare that the details, tax registrations, and bank information furnished above are true, complete, and accurate. I authorize Secured Engineers Pvt. Ltd. to register our firm as a vendor for inquiries, quotations, and purchase orders.
              </span>
            </label>

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-3.5 bg-gradient-to-r from-blue-700 to-indigo-800 hover:from-blue-800 hover:to-indigo-900 text-white font-bold rounded-xl shadow-md transition transform active:scale-[0.99] flex items-center justify-center gap-2 text-base disabled:opacity-50"
            >
              {submitting ? (
                <>Submitting Registration...</>
              ) : (
                <>
                  <FiCheckCircle size={18} /> Submit Vendor Registration
                </>
              )}
            </button>
          </div>
        </form>

        {/* Footer */}
        <div className="mt-8 text-center text-xs text-slate-400 pb-8">
          Secured Engineers Pvt. Ltd. · SOTYN ERP Systems · All rights reserved.
        </div>
      </div>
    </div>
  );
}

