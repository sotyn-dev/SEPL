export default function PencilBanner({ children }) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 text-amber-950 px-3 py-2 text-sm">
      <span className="font-semibold uppercase tracking-wide text-[10px] text-amber-800 mr-2">
        Pencil · not wired
      </span>
      {children || 'UI walkthrough only — no agent / Docker / persistence for this control.'}
    </div>
  );
}
