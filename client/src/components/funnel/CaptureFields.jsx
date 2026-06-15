// Per-stage capture inputs for the manual funnel steps (6–11). Mounted ONLY by
// NextActionCard in capture mode for the current stage — never by the progress
// rail — so future/locked stages can never leak live-looking form fields.

import { FiUpload } from 'react-icons/fi';

export default function CaptureFields({ stageKey, cap, setCap }) {
  switch (stageKey) {
    case 'PAYMENT_CONFIRMED':
      return (
        <>
          <div className="grid grid-cols-2 gap-2">
            <CaptureInput k="payment_amount" label="Amount received" type="number" cap={cap} setCap={setCap} />
            <CaptureInput k="payment_ref" label="Payment reference" cap={cap} setCap={setCap} />
          </div>
          <UploadSlot label="Upload payment proof" />
        </>
      );
    case 'PO_DRAFTED':
      return <CaptureInput k="po_amount" label="PO amount" type="number" cap={cap} setCap={setCap} />;
    case 'DISPATCH_CONFIRMED':
      return (
        <>
          <CaptureInput k="dispatch_ref" label="Dispatch reference" cap={cap} setCap={setCap} />
          <UploadSlot label="Upload dispatch photo" />
        </>
      );
    case 'PURCHASE_BILL':
      return (
        <>
          <CaptureInput k="purchase_bill_number" label="Purchase bill #" cap={cap} setCap={setCap} />
          <UploadSlot label="Upload bill scan" />
        </>
      );
    case 'SALES_BILL':
      return (
        <>
          <div className="grid grid-cols-2 gap-2">
            <CaptureInput k="sales_bill_number" label="Sales bill #" cap={cap} setCap={setCap} />
            <CaptureInput k="sales_bill_amount" label="Sales bill amount" type="number" cap={cap} setCap={setCap} />
          </div>
          <UploadSlot label="Upload bill scan" />
        </>
      );
    case 'RECEIPT':
      return (
        <>
          <div className="grid grid-cols-2 gap-2">
            <CaptureInput k="receipt_amount" label="Receipt amount" type="number" cap={cap} setCap={setCap} />
            <CaptureInput k="receipt_date" label="Receipt date" type="date" cap={cap} setCap={setCap} />
          </div>
          <UploadSlot label="Upload receipt" />
        </>
      );
    default:
      return null;
  }
}

function CaptureInput({ k, label, type = 'text', cap, setCap }) {
  return (
    <div>
      <label className="text-[10px] text-gray-500 block mb-0.5">{label}</label>
      <input
        type={type}
        className="input input-sm w-full"
        value={cap[k] ?? ''}
        onChange={e => setCap({ ...cap, [k]: e.target.value })}
      />
    </div>
  );
}

// Image upload is designed but not wired yet — disabled with a "Coming soon" hint.
function UploadSlot({ label }) {
  return (
    <button
      type="button"
      disabled
      title="Coming soon"
      className="flex items-center gap-1.5 text-[11px] text-gray-400 border border-dashed border-gray-300 rounded px-2 py-1.5 w-full justify-center cursor-not-allowed"
    >
      <FiUpload size={11} /> {label}
    </button>
  );
}
