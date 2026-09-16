const { getDb } = require('../db/schema');

module.exports = async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(code)) return res.status(400).json({ error: 'Not a valid IFSC format' });
  const db = getDb();
  try {
    const hit = db.prepare('SELECT * FROM ifsc_cache WHERE ifsc=?').get(code);
    if (hit) return res.json({ ifsc: code, bank: hit.bank, branch: hit.branch, city: hit.city, state: hit.state, source: 'cache' });
  } catch (_) {}
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(`https://ifsc.razorpay.com/${code}`, { signal: ctl.signal });
    if (r.status === 404) return res.status(404).json({ error: 'IFSC not found in the bank directory — check the code, or type the bank and branch by hand' });
    if (!r.ok) return res.status(502).json({ error: 'Bank directory is not answering right now — type the bank and branch by hand' });
    const j = await r.json();
    const out = { ifsc: code, bank: j.BANK || null, branch: j.BRANCH || null, city: j.CITY || null, state: j.STATE || null };
    try {
      db.prepare('INSERT OR REPLACE INTO ifsc_cache (ifsc, bank, branch, city, state) VALUES (?,?,?,?,?)')
        .run(code, out.bank, out.branch, out.city, out.state);
    } catch (_) {}
    res.json({ ...out, source: 'live' });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach the bank directory — type the bank and branch by hand' });
  } finally { clearTimeout(timer); }
};
