import { useEffect, useMemo, useRef, useState, memo } from 'react';
import { FiBold, FiList } from 'react-icons/fi';
import {
  markdownToSafeHtml,
  wrapSelection,
  prefixLines,
} from '../lib/minimalMarkdown';

/**
 * Shared minimal Markdown editor (bold, strike, lists). Saves plain Markdown string.
 *
 * Re-render / caret safety:
 * - Uses a <textarea>, not contentEditable (no caret jump from HTML rewrites).
 * - Typing updates local/controlled value only; does not remount on each key.
 * - Prefer keeping draft in the parent field wrapper (e.g. EditableBlock) so
 *   large pages do not setState on every keystroke until Save.
 * - `value` prop sync does not fight the caret while the textarea is focused
 *   unless `syncWhileFocused` is true (default false).
 */

const MINIMAL_MD_CSS = `
  .minimal-md p { margin: 0 0 0.5rem; }
  .minimal-md p:last-child { margin-bottom: 0; }
  .minimal-md ul { list-style: disc; padding-left: 1.25rem; margin: 0.25rem 0 0.5rem; }
  .minimal-md ol { list-style: decimal; padding-left: 1.25rem; margin: 0.25rem 0 0.5rem; }
  .minimal-md li { margin: 0.15rem 0; }
  .minimal-md strong { font-weight: 600; }
  .minimal-md del { text-decoration: line-through; opacity: 0.75; }
`;

export const MarkdownView = memo(function MarkdownView({
  value,
  emptyText = '—',
  className = '',
  minHeightClass = '',
}) {
  const html = useMemo(() => markdownToSafeHtml(value), [value]);
  if (!String(value || '').trim()) {
    return (
      <div className={`text-sm text-gray-400 ${className} ${minHeightClass}`}>
        {emptyText}
      </div>
    );
  }
  return (
    <>
      <div
        className={`minimal-md text-sm text-gray-800 ${className} ${minHeightClass}`}
        // Safe: markdownToSafeHtml escapes all user text; only allowlisted tags.
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <style>{MINIMAL_MD_CSS}</style>
    </>
  );
});

function ToolBtn({ title, onMouseDown, children }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      // mousedown + preventDefault keeps textarea selection/focus
      onMouseDown={e => {
        e.preventDefault();
        onMouseDown?.();
      }}
      className="p-1.5 leading-none rounded text-gray-600 hover:bg-gray-100 hover:text-gray-900"
    >
      {children}
    </button>
  );
}

export default function MinimalMarkdownEditor({
  value = '',
  onChange,
  maxLength = null,
  clip = null,
  placeholder = '',
  minHeightClass = 'min-h-[110px]',
  className = '',
  autoFocus = false,
  disabled = false,
  /** When false (default), ignore external value updates while focused. */
  syncWhileFocused = false,
}) {
  const taRef = useRef(null);
  const focusedRef = useRef(false);
  const [focused, setFocused] = useState(false);
  const [inner, setInner] = useState(value || '');

  useEffect(() => {
    if (focusedRef.current && !syncWhileFocused) return;
    setInner(value || '');
  }, [value, syncWhileFocused]);

  useEffect(() => {
    if (autoFocus) taRef.current?.focus();
  }, [autoFocus]);

  const applyClip = (text) => {
    const s = String(text ?? '');
    if (clip) return clip(s);
    if (maxLength != null && s.length > maxLength) return s.slice(0, maxLength);
    return s;
  };

  const commit = (next, selection) => {
    const clipped = applyClip(next);
    setInner(clipped);
    onChange?.(clipped);
    if (selection && taRef.current) {
      requestAnimationFrame(() => {
        const el = taRef.current;
        if (!el) return;
        el.focus();
        const max = clipped.length;
        el.setSelectionRange(
          Math.min(selection.selectionStart, max),
          Math.min(selection.selectionEnd, max),
        );
      });
    }
  };

  const onInput = (e) => {
    commit(e.target.value);
  };

  const runWrap = (before, after) => {
    const el = taRef.current;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const result = wrapSelection(inner, start, end, before, after);
    commit(result.value, result);
  };

  const runList = (kind) => {
    const el = taRef.current;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const result = prefixLines(inner, start, end, kind);
    commit(result.value, result);
  };

  return (
    <div
      className={`rounded-xl border bg-white overflow-hidden transition-colors ${
        focused ? 'border-blue-400' : 'border-gray-200'
      } ${className}`}
    >
      <div className="flex items-center gap-0.5 px-1.5 py-1 border-b border-gray-100 bg-gray-50/80">
        <ToolBtn title="Bold" onMouseDown={() => runWrap('**', '**')}>
          <FiBold size={14} />
        </ToolBtn>
        <ToolBtn title="Strikethrough" onMouseDown={() => runWrap('~~', '~~')}>
          <span className="text-[12px] relative -top-0.5 font-semibold leading-none line-through">S</span>
        </ToolBtn>
        <ToolBtn title="Bullet list" onMouseDown={() => runList('ul')}>
          <FiList size={14} />
        </ToolBtn>
        <ToolBtn title="Numbered list" onMouseDown={() => runList('ol')}>
          <span className="text-[11px] font-semibold relative -top-0.5 w-[14px] text-center">1.</span>
        </ToolBtn>
        <span className="ml-auto pr-1.5 text-[10px] text-gray-400 select-none">Markdown</span>
      </div>
      <textarea
        ref={taRef}
        className={`w-full overflow-y-auto input border-0 rounded-none outline-none text-sm focus:!ring-0 ${minHeightClass}`}
        value={inner}
        disabled={disabled}
        maxLength={maxLength || undefined}
        placeholder={placeholder}
        resize="none"
        onChange={onInput}
        onFocus={() => {
          focusedRef.current = true;
          setFocused(true);
        }}
        onBlur={() => {
          focusedRef.current = false;
          setFocused(false);
        }}
      />
    </div>
  );
}
