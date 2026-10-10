import { FiCheck, FiEdit2, FiUpload } from 'react-icons/fi';

// Both master tasks and dated occurrences use the master's proof setting.
export default function ChecklistProofAction({ task, busy, rejected = false, onUpload, onNote }) {
  const type = task.proof_type || 'photo';
  const friendly = task.proof_label?.trim();
  const css = 'btn btn-success text-[11px] px-2 py-1 inline-flex items-center gap-1';
  if (type === 'none') return (
    <button type="button" className={css} disabled={busy} onClick={() => onUpload(null)}>
      <FiCheck size={11} /> {busy ? 'Saving…' : 'Mark Done'}
    </button>
  );
  if (type === 'text') return (
    <button type="button" className={css} disabled={busy} onClick={onNote}>
      <FiEdit2 size={11} /> {friendly ? `Add ${friendly}` : rejected ? 'Resubmit Note' : 'Add Note'}
    </button>
  );
  const name = friendly || (type === 'photo' ? 'Photo' : type === 'pdf' ? 'PDF' : 'File');
  const accept = type === 'photo' ? 'image/*' : type === 'pdf' ? '.pdf,application/pdf' : undefined;
  return (
    <label className={`${css} cursor-pointer ${busy ? 'opacity-60 pointer-events-none' : ''}`} title={`Required: ${name}`}>
      <FiUpload size={11} /> {busy ? 'Saving…' : `${rejected ? 'Re-upload' : 'Upload'} ${name}`}
      <input type="file" accept={accept} disabled={busy} aria-label={`Upload ${name}`} className="hidden"
        onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) onUpload(file); }} />
    </label>
  );
}
