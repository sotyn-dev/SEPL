// Processor for `excel-export-quotation` (Workstream 1-B), run in the worker
// process. The CPU-heavy workbook build happens here, off the API event loop;
// the finished .xlsx is written to GENERATED_DIR and its path returned. The
// route (runFileJob) reads that file, streams it to the browser, and deletes it
// — so from the user's side the export behaves exactly as the old inline one.
const path = require('path');
const fs = require('fs');
const { buildQuotationBuffer } = require('../lib/quotationExcel');
const { GENERATED_DIR } = require('../queue');

module.exports = async function excelExportQuotation(job) {
  const buf = await buildQuotationBuffer(job.data);
  if (!fs.existsSync(GENERATED_DIR)) fs.mkdirSync(GENERATED_DIR, { recursive: true });
  const file = path.join(GENERATED_DIR, `${job.id}-quotation.xlsx`);
  await fs.promises.writeFile(file, buf);
  return { file };
};
