// Filesystem paths shared by the jobs layer — deliberately DEPENDENCY-FREE.
//
// This exists so the sandboxed Excel processor (server/jobs/processors/
// excelExportQuotation.js) can learn where to write generated files WITHOUT
// requiring ./queue. queue.js pulls in ioredis + bullmq and opens Redis
// connections on load; a BullMQ sandboxed processor runs in a separate child
// process, and we do NOT want every child fork to spin up its own Redis client.
// Keeping the path constant here (require only `path`) keeps that child lean and
// Redis-free — which is also what makes the fallback ethic hold (a child can
// never fail on Redis because it never touches it).
const path = require('path');

// Where the files worker writes generated artifacts (Excel exports). Shared by
// the worker (writer) and runFileJob (reader). NOT served statically — the
// route streams it and deletes it. Sits next to data/uploads.
const GENERATED_DIR = path.join(__dirname, '..', '..', 'data', 'generated');

module.exports = { GENERATED_DIR };
