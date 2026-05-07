// ERP Mantra Banner — a daily-rotating motivational quote that reinforces
// "use the ERP" culture (TATA Rule: 'If it's not in the ERP, it didn't
// happen'). Mam's ask: encourage employees to log everything in the ERP
// instead of WhatsApp / Excel / verbal updates.
//
// One quote shows per calendar day, picked by date so everyone sees the
// same one — works as a shared talking point in the morning standup.

import { useMemo } from 'react';
import { FiZap } from 'react-icons/fi';

const MANTRAS = [
  { text: 'If it is not in the ERP, it did not happen.', source: 'TATA Rule' },
  { text: 'Single source of truth. Single source of action.', source: 'ERP First' },
  { text: 'Data without entry is data without value.', source: 'SEPL' },
  { text: 'Track it, don’t trust it to memory.', source: 'SEPL' },
  { text: 'Discipline today, dashboards tomorrow.', source: 'SEPL' },
  { text: 'Update once, view forever — enter it in the ERP.', source: 'SEPL' },
  { text: 'WhatsApp forgets. Excel breaks. The ERP remembers.', source: 'SEPL' },
  { text: 'No DPR, no payment. No payment, no progress.', source: 'SEPL' },
  { text: 'Visibility starts where data entry starts.', source: 'SEPL' },
  { text: 'A site is real only when its DPR is filed.', source: 'SEPL' },
  { text: 'Indent in the ERP, dispatch from the ERP, billed by the ERP.', source: 'SEPL' },
  { text: 'You can’t improve what you don’t record.', source: 'Peter Drucker' },
  { text: 'Every minute logged is a minute saved tomorrow.', source: 'SEPL' },
  { text: 'The ERP is not extra work. It IS the work.', source: 'SEPL' },
  { text: 'If you said it on a call — also say it in the ERP.', source: 'SEPL' },
  { text: 'Approval lives in the ERP, not in someone’s memory.', source: 'SEPL' },
  { text: 'A ticket is louder than a complaint. Raise it in the ERP.', source: 'SEPL' },
  { text: 'Today’s entry is tomorrow’s evidence.', source: 'SEPL' },
  { text: 'No record, no recourse.', source: 'SEPL' },
  { text: 'Audit-ready means ERP-ready.', source: 'SEPL' },
  { text: 'Honest data beats nice excuses.', source: 'SEPL' },
  { text: 'Punch in the ERP — the day starts when the system says so.', source: 'SEPL' },
  { text: 'A delegation without proof is a wish, not a task.', source: 'SEPL' },
  { text: 'Every snag closed in the ERP is a customer kept.', source: 'SEPL' },
  { text: 'The best status update is a green badge in the ERP.', source: 'SEPL' },
  { text: 'Your work is invisible until the ERP sees it.', source: 'SEPL' },
];

// Day-of-year index so the same quote shows for everyone on the same day,
// and rotates predictably day after day.
function dayOfYear(d = new Date()) {
  const start = new Date(d.getFullYear(), 0, 0);
  const diff = (d - start) + ((start.getTimezoneOffset() - d.getTimezoneOffset()) * 60 * 1000);
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

export default function ErpMantraBanner() {
  const mantra = useMemo(() => MANTRAS[dayOfYear() % MANTRAS.length], []);
  return (
    <div className="rounded-xl px-4 py-3 bg-gradient-to-r from-orange-50 via-blue-50 to-emerald-50 border border-orange-200 flex items-start gap-3 shadow-sm">
      <div className="shrink-0 mt-0.5 p-2 rounded-lg bg-gradient-to-br from-orange-500 to-red-600 text-white">
        <FiZap size={18} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] font-bold uppercase tracking-wider text-orange-700">Today’s ERP Mantra</p>
        <p className="text-base sm:text-lg font-bold text-gray-800 mt-0.5">&ldquo;{mantra.text}&rdquo;</p>
        <p className="text-xs text-gray-500 mt-1">— {mantra.source}</p>
      </div>
    </div>
  );
}
