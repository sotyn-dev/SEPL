import { useEffect, useMemo, useRef, useState } from 'react';
import { FiPaperclip } from 'react-icons/fi';
import { AttachmentLinks } from './AttachmentsPanel';
import {
  COMMENT_HARD_LIMIT, commentLengthHint, clipToLimit,
} from './constants';
import { fmtDateTime } from '../../utils/datetime';

const BUSINESS_SOURCES = new Set(['business_reject', 'business_clarify']);

export function authorLabel(comment) {
  const name = comment.author_name || 'User';
  if (BUSINESS_SOURCES.has(comment.source)) {
    return `${name} (business approver)`;
  }
  return name;
}

/** Highlight @Name tokens that match known people. */
export function CommentBody({ body, mentionNames = [] }) {
  if (!body) return null;
  if (!mentionNames.length) {
    return <div className="text-sm text-gray-800 whitespace-pre-wrap">{body}</div>;
  }
  const sorted = [...mentionNames].filter(Boolean).sort((a, b) => b.length - a.length);
  const escaped = sorted.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(^|[\\s])(@(?:${escaped.join('|')}))(?=\\s|$|[.,!?;:])`, 'gi');
  const parts = [];
  let last = 0;
  let m;
  const text = body;
  while ((m = re.exec(text))) {
    const start = m.index + m[1].length;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <span key={start} className="text-red-700 font-medium">{m[2]}</span>
    );
    last = start + m[2].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <div className="text-sm text-gray-800 whitespace-pre-wrap">{parts}</div>;
}

export function MentionComposer({
  value,
  onChange,
  mentionUsers = [],
  selfId,
  placeholder,
  onPost,
  pendingFiles,
  onPickFiles,
  onRemovePending,
  posting,
}) {
  const [mention, setMention] = useState(null);
  const taRef = useRef(null);

  const candidates = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return mentionUsers
      .filter(u => u.id !== selfId && u.name && u.name.toLowerCase().includes(q))
      .slice(0, 6);
  }, [mention, mentionUsers, selfId]);

  const onTextChange = (e) => {
    const val = clipToLimit(e.target.value, COMMENT_HARD_LIMIT);
    onChange(val);
    const pos = e.target.selectionStart ?? val.length;
    const m = val.slice(0, pos).match(/(?:^|\s)@([^\s@]*)$/);
    setMention(m ? { query: m[1], start: pos - m[1].length - 1 } : null);
  };

  const pickMention = (name) => {
    if (!mention) return;
    const before = value.slice(0, mention.start);
    const after = value.slice(taRef.current?.selectionStart ?? value.length);
    const next = `${before}@${name} ${after}`;
    onChange(clipToLimit(next, COMMENT_HARD_LIMIT));
    setMention(null);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const hint = commentLengthHint(value);

  return (
    <div className="space-y-2 relative">
      <textarea
        ref={taRef}
        className="input w-full min-h-[70px]"
        value={value}
        maxLength={COMMENT_HARD_LIMIT}
        onChange={onTextChange}
        placeholder={placeholder || 'Add a comment… Use @ to mention'}
      />
      <p className={`text-[11px] !mt-0.5 ${hint.tone === 'warn' ? 'text-amber-700' : 'text-gray-400'}`}>{hint.text}</p>
      {candidates.length > 0 && (
        <ul className="absolute z-20 left-0 right-12 bottom-full mb-1 max-h-40 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg text-sm">
          {candidates.map(u => (
            <li key={u.id}>
              <button
                type="button"
                className="w-full text-left px-3 py-2 hover:bg-gray-50"
                onMouseDown={e => e.preventDefault()}
                onClick={() => pickMention(u.name)}
              >
                {u.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {pendingFiles?.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {pendingFiles.map((f, i) => (
            <span key={`${f.name}-${i}`} className="inline-flex items-center gap-1 text-xs bg-gray-100 rounded-full px-2 py-1">
              {f.name}
              <button type="button" className="text-gray-500 hover:text-red-600" onClick={() => onRemovePending?.(i)}>×</button>
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex items-center gap-1 px-2 py-1.5 text-xs rounded-lg border border-gray-300 cursor-pointer hover:bg-gray-50">
          <FiPaperclip size={12} /> Attachment
          <input
            type="file"
            multiple
            className="hidden"
            onChange={e => {
              // Copy before clearing — FileList is live and empties when value is reset
              const list = Array.from(e.target.files || []);
              e.target.value = '';
              if (list.length) onPickFiles?.(list);
            }}
          />
        </label>
        <button
          type="button"
          disabled={posting || (!value.trim() && !(pendingFiles?.length))}
          onClick={onPost}
          className="ml-auto px-3 py-1.5 text-sm rounded-lg bg-gray-900 text-white disabled:opacity-50"
        >
          {posting ? 'Posting…' : 'Post'}
        </button>
      </div>
    </div>
  );
}

export default function CommentsCard({
  requirementId,
  comments = [],
  mentionUsers = [],
  selfId,
  isAdmin,
  canEditAttachments,
  onRefresh,
  addComment,
  saveComment,
  removeComment,
  canManageComment,
}) {
  const [body, setBody] = useState('');
  const [pendingFiles, setPendingFiles] = useState([]);
  const [posting, setPosting] = useState(false);
  const [editingCommentId, setEditingCommentId] = useState(null);
  const [editingCommentBody, setEditingCommentBody] = useState('');

  const mentionNames = useMemo(
    () => mentionUsers.map(u => u.name).filter(Boolean),
    [mentionUsers],
  );

  useEffect(() => {
    setEditingCommentId(null);
  }, [requirementId]);

  const post = async () => {
    let text = body.trim();
    if (!text && !pendingFiles.length) return;
    if (!text && pendingFiles.length) text = 'Attachment';
    setPosting(true);
    try {
      const comment = await addComment(text);
      if (comment?.id && pendingFiles.length) {
        const { default: api } = await import('../../api');
        const { default: toast } = await import('react-hot-toast');
        for (const file of pendingFiles) {
          const fd = new FormData();
          fd.append('file', file);
          fd.append('comment_id', String(comment.id));
          try {
            await api.post(`/system-requirements/${requirementId}/attachments`, fd);
          } catch (e) {
            toast.error(e.response?.data?.error || `Failed: ${file.name}`);
          }
        }
      }
      setBody('');
      setPendingFiles([]);
      await onRefresh?.();
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="card p-4 space-y-4">
      <h3 className="text-sm font-semibold text-gray-900">Comments</h3>
      <div className="space-y-3 max-h-[50vh] overflow-y-auto">
        {comments.length === 0 && <p className="text-sm text-gray-400">No comments yet.</p>}
        {comments.map(c => {
          const mine = canManageComment?.(c);
          const editing = editingCommentId === c.id;
          const systemBiz = BUSINESS_SOURCES.has(c.source);
          return (
            <div key={c.id} className="border border-gray-100 rounded-lg p-3">
              <div className="flex items-start justify-between gap-2 mb-1">
                <div className="text-xs text-gray-500">
                  <span className={systemBiz ? 'text-amber-800 font-medium' : ''}>{authorLabel(c)}</span>
                  {' · '}{fmtDateTime(c.created_at)}
                  {c.updated_at && c.updated_at !== c.created_at ? ' · edited' : ''}
                </div>
                {mine && !editing && !systemBiz && (
                  <div className="flex gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => { setEditingCommentId(c.id); setEditingCommentBody(c.body || ''); }}
                      className="text-xs font-medium text-red-700 hover:underline"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => removeComment(c)}
                      className="text-xs font-medium text-gray-500 hover:text-red-600 hover:underline"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
              {editing ? (
                <div className="space-y-2">
                  <textarea
                    className="input w-full min-h-[70px]"
                    value={editingCommentBody}
                    maxLength={COMMENT_HARD_LIMIT}
                    onChange={e => setEditingCommentBody(clipToLimit(e.target.value, COMMENT_HARD_LIMIT))}
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={async () => {
                        await saveComment(c.id, editingCommentBody);
                        setEditingCommentId(null);
                      }}
                      className="px-3 py-1.5 text-sm rounded-lg bg-gray-900 text-white"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingCommentId(null)}
                      className="px-3 py-1.5 text-sm rounded-lg border border-gray-300"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <CommentBody body={c.body} mentionNames={mentionNames} />
                  <AttachmentLinks
                    requirementId={requirementId}
                    attachments={c.attachments || []}
                    canDelete={canEditAttachments || (mine && !systemBiz)}
                    onDelete={async (att) => {
                      const { default: api } = await import('../../api');
                      await api.delete(`/system-requirements/${requirementId}/attachments/${att.id}`);
                      await onRefresh?.();
                    }}
                  />
                </>
              )}
            </div>
          );
        })}
      </div>
      <MentionComposer
        value={body}
        onChange={setBody}
        mentionUsers={mentionUsers}
        selfId={selfId}
        pendingFiles={pendingFiles}
        onPickFiles={(files) => setPendingFiles(prev => [...prev, ...files])}
        onRemovePending={(i) => setPendingFiles(prev => prev.filter((_, idx) => idx !== i))}
        onPost={post}
        posting={posting}
      />
    </div>
  );
}
