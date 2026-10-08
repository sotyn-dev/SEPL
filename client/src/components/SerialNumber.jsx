/** Display position only; the application's persistent record number stays separate. */
export default function SerialNumber({ value }) {
  return <span className="inline-flex shrink-0 items-center rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-slate-600" aria-label={`Serial number ${value}`}>S.No. {value}</span>;
}
