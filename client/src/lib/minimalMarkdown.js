/**
 * Tiny Markdown helpers for MinimalMarkdownEditor.
 * Supported: paragraphs, line breaks, **bold**, ~~strike~~, - bullets, 1. numbered lists.
 * No headers, links, images, or raw HTML.
 */

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Inline: **bold** and ~~strike~~ (after HTML escape). */
export function formatInline(escaped) {
  return escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>');
}

/**
 * Convert minimal Markdown → safe HTML (escaped text + allowlisted tags).
 */
export function markdownToSafeHtml(md) {
  const src = String(md ?? '').replace(/\r\n/g, '\n').trim();
  if (!src) return '';

  const lines = src.split('\n');
  const parts = [];
  let i = 0;
  const para = [];

  const flushParagraph = () => {
    if (!para.length) return;
    const inner = formatInline(escapeHtml(para.join('\n'))).replace(/\n/g, '<br/>');
    parts.push(`<p>${inner}</p>`);
    para.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*[-*] .+/.test(line)) {
      flushParagraph();
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*[-*] (.+)$/);
        if (!m) break;
        items.push(`<li>${formatInline(escapeHtml(m[1]))}</li>`);
        i += 1;
      }
      parts.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    if (/^\s*\d+\. .+/.test(line)) {
      flushParagraph();
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*\d+\. (.+)$/);
        if (!m) break;
        items.push(`<li>${formatInline(escapeHtml(m[1]))}</li>`);
        i += 1;
      }
      parts.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      i += 1;
      continue;
    }

    para.push(line);
    i += 1;
  }

  flushParagraph();
  return parts.join('');
}

/** Wrap current textarea selection with a marker (e.g. **bold**). */
export function wrapSelection(value, start, end, before, after = before) {
  const v = String(value ?? '');
  const selected = v.slice(start, end) || 'text';
  const next = v.slice(0, start) + before + selected + after + v.slice(end);
  const selStart = start + before.length;
  const selEnd = selStart + selected.length;
  return { value: next, selectionStart: selStart, selectionEnd: selEnd };
}

/** Prefix each selected line (or current line) for lists. */
export function prefixLines(value, start, end, kind) {
  const v = String(value ?? '');
  const lineStart = v.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = v.indexOf('\n', end);
  if (lineEnd === -1) lineEnd = v.length;

  const block = v.slice(lineStart, lineEnd);
  const lines = block.length ? block.split('\n') : [''];
  const nextLines = lines.map((line, idx) => {
    const stripped = line.replace(/^\s*([-*] |\d+\. )/, '');
    if (kind === 'ul') return `- ${stripped || 'item'}`;
    return `${idx + 1}. ${stripped || 'item'}`;
  });
  const inserted = nextLines.join('\n');
  const next = v.slice(0, lineStart) + inserted + v.slice(lineEnd);
  return {
    value: next,
    selectionStart: lineStart,
    selectionEnd: lineStart + inserted.length,
  };
}
