import { useState } from 'react';
import { FiPaperclip, FiTrash2 } from 'react-icons/fi';
import api from '../../api';
import toast from 'react-hot-toast';
import ConfirmDialog from '../../components/ConfirmDialog';

const VIEW_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf']);
const ZIP_EXT = new Set(['.zip', '.rar', '.7z']);

function extOf(name = '') {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

/** image/PDF → new tab; zip + everything else → download */
export function attachmentOpenMode(att) {
  const mime = (att?.mime_type || '').toLowerCase();
  const ext = extOf(att?.original_filename);
  if (mime.startsWith('image/') || mime === 'application/pdf' || VIEW_EXT.has(ext)) {
    return 'view';
  }
  if (
    mime.includes('zip')
    || mime === 'application/x-rar-compressed'
    || mime === 'application/x-7z-compressed'
    || ZIP_EXT.has(ext)
  ) {
    return 'download';
  }
  return 'download';
}

export async function openAttachment(requirementId, att) {
  try {
    const r = await api.get(
      `/system-requirements/${requirementId}/attachments/${att.id}/download`,
      { responseType: 'blob' },
    );
    const blob = r.data instanceof Blob
      ? r.data
      : new Blob([r.data], { type: att.mime_type || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const mode = attachmentOpenMode(att);
    if (mode === 'view') {
      window.open(url, '_blank', 'noopener,noreferrer');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = att.original_filename || 'download';
      a.click();
      URL.revokeObjectURL(url);
    }
  } catch {
    toast.error('Could not open file');
  }
}

/** Compact filename links under a comment / section. */
export function AttachmentLinks({
  requirementId,
  attachments = [],
  canDelete = false,
  onDelete,
}) {
  const [pending, setPending] = useState(null);

  if (!attachments.length) return null;
  return (
    <>
      <ul className="mt-2 space-y-1">
        {attachments.map(att => (
          <li key={att.id} className="flex items-center gap-2 text-sm min-w-0">
            <FiPaperclip className="shrink-0 text-gray-400" size={14} />
            <button
              type="button"
              className="text-red-700 hover:underline truncate text-left"
              onClick={() => openAttachment(requirementId, att)}
              title={attachmentOpenMode(att) === 'view' ? 'Open' : 'Download'}
            >
              {att.original_filename}
            </button>
            {canDelete && (
              <button
                type="button"
                className="shrink-0 p-0.5 text-red-600 hover:text-red-700"
                onClick={() => setPending(att)}
                title="Remove"
                aria-label="Remove attachment"
              >
                <FiTrash2 size={14} />
              </button>
            )}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={!!pending}
        title="Remove attachment?"
        message={
          pending
            ? `Remove “${pending.original_filename}” from this task?\nIt will no longer appear here.`
            : ''
        }
        confirmLabel="Remove"
        cancelLabel="Cancel"
        tone="danger"
        onConfirm={() => {
          const att = pending;
          setPending(null);
          if (att) onDelete?.(att);
        }}
        onCancel={() => setPending(null)}
      />
    </>
  );
}

/** List + optional multi-file add control. */
export default function AttachmentsPanel({
  requirementId,
  attachments = [],
  canEdit = false,
  onChanged,
  /** FormData extras: comment_id or { dev_section: 'development' } */
  uploadFields = null,
  label = 'Attachments',
  emptyText = 'No files yet.',
  compact = false,
}) {
  const upload = async (files) => {
    const list = [...(files || [])];
    if (!list.length) return;
    let ok = 0;
    let fail = 0;
    for (const file of list) {
      try {
        const fd = new FormData();
        fd.append('file', file);
        if (uploadFields?.comment_id) fd.append('comment_id', String(uploadFields.comment_id));
        if (uploadFields?.dev_section) fd.append('dev_section', uploadFields.dev_section);
        await api.post(`/system-requirements/${requirementId}/attachments`, fd);
        ok += 1;
      } catch (e) {
        fail += 1;
        toast.error(e.response?.data?.error || `Failed: ${file.name}`);
      }
    }
    if (ok) toast.success(ok === 1 ? 'File uploaded' : `${ok} files uploaded`);
    if (fail && !ok) { /* toasts already shown */ }
    onChanged?.();
  };

  const remove = async (att) => {
    try {
      await api.delete(`/system-requirements/${requirementId}/attachments/${att.id}`);
      toast.success('Removed');
      onChanged?.();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Remove failed');
    }
  };

  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      {!compact && (
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium text-gray-600 uppercase tracking-wide">{label}</h3>
          {canEdit && (
            <label className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border border-dashed border-gray-300 cursor-pointer hover:bg-gray-50 text-gray-700">
              <FiPaperclip size={12} /> Add files
              <input
                type="file"
                multiple
                className="hidden"
                onChange={e => {
                  upload(e.target.files);
                  e.target.value = '';
                }}
              />
            </label>
          )}
        </div>
      )}
      {compact && canEdit && (
        <label className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border border-dashed border-gray-300 cursor-pointer hover:bg-gray-50 text-gray-700">
          <FiPaperclip size={12} /> Add files
          <input
            type="file"
            multiple
            className="hidden"
            onChange={e => {
              upload(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
      )}
      {attachments.length === 0 ? (
        <p className="text-sm text-gray-400">{emptyText}</p>
      ) : (
        <AttachmentLinks
          requirementId={requirementId}
          attachments={attachments}
          canDelete={canEdit}
          onDelete={remove}
        />
      )}
    </div>
  );
}
