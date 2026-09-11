// Fuzzy word-match between free text (a client BOQ line, a vendor quotation
// line) and an item name. Moved unchanged out of routes/quotations.js so the
// Vendor Rates quotation reader (lib/quoteRateMatch.js) uses the same rules.

const STOP = new Set(['of','in','the','and','for','with','as','to','a','an','or','on','at','by','is','be','all','any','from','up','its','shall','etc','per','no','nos','each','including','include','included','complete','work','works','type','make','suitable','required','approved','rate','item','sqm','rmt']);

function tokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter(t => t && t.length >= 2 && !STOP.has(t));
}

// Score 0..1 for how well an Item Master item matches a BOQ line. Coverage of
// the item's tokens, BUT weighted down hard for thin evidence: a single common
// material word (e.g. "cement" mentioned inside "construct brick masonry
// manhole") must NOT score high. Real confidence needs several matched
// keywords. An LLM pass makes the final call when configured.
function scoreMatch(lineSet, itemTokens) {
  if (!itemTokens.length) return 0;
  let hit = 0;
  for (const t of itemTokens) if (lineSet.has(t)) hit++;
  if (hit === 0) return 0;
  let score = hit / itemTokens.length;
  if (lineSet.has(itemTokens[0])) score += 0.1;
  // Specificity: scale by matched-keyword count (need ~3 for full weight),
  // and cap matches resting on 0–1 keywords to a weak score.
  score *= Math.min(1, hit / 3);
  if (hit < 2) score = Math.min(score, 0.25);
  return Math.min(1, score);
}

module.exports = { STOP, tokens, scoreMatch };
