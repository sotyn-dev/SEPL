const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-numbered-tables-'));
const bundle = path.join(directory, 'tests.cjs');
try {
  esbuild.buildSync({
    entryPoints: [path.resolve(__dirname, '../src/components/NumberedTable.test.jsx')],
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'warning',
  });
  execFileSync(process.execPath, ['--test', bundle], { stdio: 'inherit' });
} finally {
  if (fs.existsSync(bundle)) fs.unlinkSync(bundle);
  fs.rmdirSync(directory);
}
