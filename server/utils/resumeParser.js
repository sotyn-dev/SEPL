// Resume parsing — best-effort extraction of name, email, phone,
// address from a candidate's PDF / DOCX / TXT resume.
//
// Mam (2026-05-22): "when upload resume name, mobile number,
// email-id, address, automatically fill here".  No third-party
// paid API — pdf-parse + mammoth + Indian-tuned regex covers ~85%
// of resumes we see.  Admin can correct any missed field before
// saving the candidate.
//
// Strategy:
//   1. Extract raw text from the file (pdf-parse for PDF,
//      mammoth for DOCX, raw buffer for TXT).
//   2. Run a small set of focused regex passes for the obvious
//      machine-readable fields (email, phone, 6-digit pincode,
//      LinkedIn URL).
//   3. Heuristic for NAME: first non-empty line that looks like a
//      person's name (≤ 5 words, no @, no digits beyond initials).
//   4. Heuristic for ADDRESS: line containing pincode OR a known
//      Indian state name, plus the surrounding line.
//
// Returns { name, email, phone, address, raw_text } — any field
// can be null if not confidently detected.

const fs = require('fs');

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// Indian mobile: 10 digits starting 6-9, optionally with +91, spaces,
// dashes, parens.  Avoid matching 10-digit numbers that are obviously
// not phones (file IDs).
const PHONE_RE = /(?:\+?91[\s.-]?)?[\(]?[6-9]\d{2}[\)]?[\s.-]?\d{3}[\s.-]?\d{4}/g;
const PINCODE_RE = /\b\d{6}\b/g;
const LINKEDIN_RE = /linkedin\.com\/in\/[\w-]+/i;

const INDIAN_STATES = [
  'Andhra Pradesh','Arunachal Pradesh','Assam','Bihar','Chhattisgarh','Goa','Gujarat',
  'Haryana','Himachal Pradesh','Jharkhand','Karnataka','Kerala','Madhya Pradesh',
  'Maharashtra','Manipur','Meghalaya','Mizoram','Nagaland','Odisha','Punjab',
  'Rajasthan','Sikkim','Tamil Nadu','Telangana','Tripura','Uttar Pradesh','Uttarakhand',
  'West Bengal','Delhi','Chandigarh','Pondicherry','Puducherry','Ladakh','Jammu','Kashmir',
];

// ── Text extraction per file type ──────────────────────────────
async function extractText(filePath, mimetype = '') {
  const buf = fs.readFileSync(filePath);
  const lower = (filePath || '').toLowerCase();
  // PDF
  if (mimetype.includes('pdf') || lower.endsWith('.pdf')) {
    try {
      // require lazily so pages without these deps still boot
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(buf);
      return data.text || '';
    } catch (e) {
      console.warn('[resumeParser] pdf-parse failed:', e.message);
      return '';
    }
  }
  // DOCX
  if (mimetype.includes('word') || lower.endsWith('.docx')) {
    try {
      const mammoth = require('mammoth');
      const { value } = await mammoth.extractRawText({ buffer: buf });
      return value || '';
    } catch (e) {
      console.warn('[resumeParser] mammoth failed:', e.message);
      return '';
    }
  }
  // Legacy DOC — mammoth can't read it; tell caller.
  if (lower.endsWith('.doc')) return '';
  // Plain text fallback
  try { return buf.toString('utf-8'); } catch (_) { return ''; }
}

// ── Heuristic NAME extraction ──────────────────────────────────
// Most resumes put the candidate's name on the very first non-blank
// line in a larger font.  We can't see fonts from extracted text,
// but the first line is almost always the name.  Reject anything
// that looks like "Curriculum Vitae", "RESUME", or has @ / digits.
function guessName(lines) {
  const stop = new Set(['curriculum vitae','curriculum-vitae','resume','cv','bio data','biodata','profile']);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.length > 60) continue;
    if (/[@\d]/.test(line)) continue;
    if (stop.has(line.toLowerCase())) continue;
    const words = line.split(/\s+/);
    if (words.length < 1 || words.length > 5) continue;
    // Title case sanity check — at least one word starts with uppercase
    if (!/[A-Z]/.test(line)) continue;
    return line;
  }
  return null;
}

// ── Heuristic ADDRESS extraction ───────────────────────────────
// Find lines containing a pincode or an Indian state name and pull
// the surrounding ±1 line so admin gets the full address chunk.
function guessAddress(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const hasPin = PINCODE_RE.test(line);
    PINCODE_RE.lastIndex = 0;
    const hasState = INDIAN_STATES.some(s => line.toLowerCase().includes(s.toLowerCase()));
    if (hasPin || hasState) {
      // Grab this line + previous if it's short (likely the street).
      const prev = (lines[i - 1] || '').trim();
      const cur  = line.trim();
      const next = (lines[i + 1] || '').trim();
      const chunk = [prev, cur, next].filter(s => s && s.length < 120).join(', ');
      return chunk;
    }
  }
  return null;
}

// ── Master parser ──────────────────────────────────────────────
async function parseResume(filePath, mimetype = '') {
  let text = '';
  try { text = await extractText(filePath, mimetype); }
  catch (e) { console.warn('[resumeParser] extract failed:', e.message); }

  // Normalise — collapse extra whitespace but keep newlines for
  // line-based heuristics.
  const normText = text.replace(/[ \t]+/g, ' ');
  const lines = normText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const emails = normText.match(EMAIL_RE) || [];
  const phones = normText.match(PHONE_RE) || [];

  // Pick the FIRST email / phone — rarely wrong; secondary ones tend
  // to be reference contacts.  Strip spaces / dashes from phone.
  const email = emails[0] || null;
  const phoneRaw = phones[0] || null;
  const phone = phoneRaw ? phoneRaw.replace(/[\s.()-]/g, '').replace(/^(\+?91)?/, '') : null;

  const name = guessName(lines);
  const address = guessAddress(lines);
  const linkedin = (normText.match(LINKEDIN_RE) || [])[0] || null;

  return {
    name, email, phone, address, linkedin,
    confidence: {
      name:    !!name,
      email:   !!email,
      phone:   !!phone,
      address: !!address,
    },
    raw_text_preview: text.slice(0, 500),
  };
}

module.exports = { parseResume, extractText };
