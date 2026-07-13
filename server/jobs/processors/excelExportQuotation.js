// Processor for `excel-export-quotation` (Workstream 1-B). Runs as a BullMQ
// SANDBOXED processor — i.e. in a separate child process from the API — so the
// CPU-heavy workbook build happens off the API event loop and off the API's V8
// heap. The finished .xlsx is written to GENERATED_DIR and its path returned;
// the route (runFileJob) reads that file, streams it to the browser, and deletes
// it — so from the user's side the export behaves exactly as the old inline one.
//
// IMPORTANT: this file must stay DB-free and Redis-free. It requires only the
// workbook builder + the dependency-free ./paths module (NOT ../queue), so the
// child fork never opens a Redis connection. That is what keeps it fallback-safe
// by construction — a child can't fail on Redis it never touches.
const path = require('path');
const fs = require('fs');
const { buildQuotationBuffer } = require('../lib/quotationExcel');
const { GENERATED_DIR } = require('../paths');

module.exports = async function excelExportQuotation(job) {
  const buf = await buildQuotationBuffer(job.data);
  if (!fs.existsSync(GENERATED_DIR)) fs.mkdirSync(GENERATED_DIR, { recursive: true });
  const file = path.join(GENERATED_DIR, `${job.id}-quotation.xlsx`);
  await fs.promises.writeFile(file, buf);
  return { file };
};
