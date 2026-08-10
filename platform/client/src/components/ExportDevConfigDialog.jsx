import PencilBanner from './PencilBanner.jsx';

export default function ExportDevConfigDialog({ tenant, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-lg rounded-2xl bg-white shadow-xl border border-slate-200 p-6 space-y-4"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-ink">Export dev config</h2>
            <p className="text-sm text-slate-600 mt-1">
              Company: <strong>{tenant.displayName}</strong> · roles, permissions, non-secret settings, entitlements.
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-ink text-sm">
            Close
          </button>
        </div>

        <PencilBanner>
          Download is disabled — no export pipeline yet. Every future pull will be audited.
        </PencilBanner>

        <div className="rounded-lg border border-slate-200 p-3 text-sm space-y-1">
          <p className="font-semibold text-ink text-xs uppercase tracking-wide">Will include</p>
          <p className="text-slate-600">roles · role_permissions · whitelisted app_settings · enabled_modules from platform</p>
        </div>
        <div className="rounded-lg border border-slate-200 p-3 text-sm space-y-1">
          <p className="font-semibold text-ink text-xs uppercase tracking-wide">Will strip</p>
          <p className="text-slate-600">passwords · API keys · JWT · emergency reset · all customer / operational rows</p>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="text-sm px-3 py-1.5 rounded-lg border border-slate-200 text-slate-700"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled
            className="text-sm px-3 py-1.5 rounded-lg bg-slate-200 text-slate-500 cursor-not-allowed"
          >
            Download JSON
          </button>
        </div>

        <p className="text-[11px] text-slate-500">
          Laptop step (not this panel): <code className="bg-slate-50 px-1 rounded">seed-local-tenant &lt;file&gt;</code>
        </p>
      </div>
    </div>
  );
}
