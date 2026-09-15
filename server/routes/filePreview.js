// Online file preview (mam 2026-08-27): "which we download file if want to
// view... need to open online like next tab". Browsers render PDFs and images
// natively, but Excel/Word always force a download — this endpoint converts
// them to HTML server-side so the /file-view page can show them in a tab.
// Whole-ERP coverage comes from a global link interceptor in Layout.jsx.
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

const MAX_BYTES = 15 * 1024 * 1024;   // beyond this, tell the user to download

router.get('/preview', async (req, res) => {
  try {
    const src = String(req.query.src || '');
    // basename() guards against path traversal and strips any host/query.
    const filename = path.basename(src.split('?')[0]);
    if (!filename) return res.status(400).json({ error: 'src required' });
    const filePath = path.join(__dirname, '..', '..', 'data', 'uploads', filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on this server' });
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_BYTES) return res.status(413).json({ error: 'File is too big for online view — please download it' });

    const ext = path.extname(filename).toLowerCase();
    if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') {
      const wb = XLSX.readFile(filePath, { cellDates: true });
      const sheets = wb.SheetNames.map(name => ({
        name,
        // sheet_to_html escapes cell values, so uploaded content can't inject markup.
        html: XLSX.utils.sheet_to_html(wb.Sheets[name], { header: '', footer: '' }),
      }));
      return res.json({ name: filename, kind: 'sheets', sheets });
    }
    if (ext === '.docx') {
      const mammoth = require('mammoth');
      const out = await mammoth.convertToHtml({ path: filePath });
      return res.json({ name: filename, kind: 'doc', html: out.value });
    }
    return res.status(415).json({ error: `Online view is not available for ${ext || 'this'} files — please download` });
  } catch (err) {
    console.error('file preview error', err);
    res.status(500).json({ error: 'Could not render this file — please download it instead' });
  }
});

module.exports = router;
