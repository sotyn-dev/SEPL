// Single source of truth for showing a person's HR department + designation, resolved from
// the linked employee record (hr_department / hr_designation supplied by the server), with the
// free-text users.department as a MUTED "(note)" fallback and role as last resort. A `⚠ N`
// marker flags a login linked to more than one employee record (a duplicate to reconcile).
// Used across Users list, Locations, Attendance and Champions so the logic lives in ONE place.
//
// Variants:
//   inline  (default) — "Dept · Designation" one-liner for cards/rows (HR-primary + fallback)
//   stacked           — "Dept:/Desig:" two lines with strict "—" for the Users admin list
//
// hrDeptText() — a plain-string helper for <option>/picker labels (no JSX).

export const hrDeptText = (r) => (r && (r.hr_department || r.department)) || '';

export default function HrIdentity({ rec, variant = 'inline', size = 'text-[11px]' }) {
  const r = rec || {};

  if (variant === 'stacked') {
    return (
      <div className={`${size} leading-tight`}>
        <div><span className="text-gray-400">Dept:</span> {r.hr_department || <span className="text-gray-300">—</span>}</div>
        <div><span className="text-gray-400">Desig:</span> {r.hr_designation || <span className="text-gray-300">—</span>}</div>
        {r.hr_record_count > 1 && (
          <div className="mt-0.5 inline-block text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-300" title="This login is linked to more than one employee record">⚠ {r.hr_record_count} records</div>
        )}
      </div>
    );
  }

  // inline — HR-primary, muting decided by SOURCE not text (a real HR "Admin" is never muted)
  const hr = [r.hr_department, r.hr_designation].filter(Boolean).join(' · ');
  const flag = r.hr_record_count > 1
    ? <span className="ml-1 text-amber-600 font-semibold" title="Linked to more than one employee record — reconcile in HR">⚠{r.hr_record_count}</span>
    : null;
  if (hr) return <span className={`${size} text-gray-500`}>{hr}{flag}</span>;
  if (r.department) return <span className={`${size} text-gray-400 italic`}>{r.department} <span className="text-gray-300">(note)</span></span>;
  if (r.role) return <span className={`${size} text-gray-500`}>{r.role}</span>;
  return null;
}
