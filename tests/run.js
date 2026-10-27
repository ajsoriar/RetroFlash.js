'use strict';
// Runs every tests/unit/*.test.js with the built-in harness. Usage: node tests/run.js [--dist] (Node 16+).
// --dist tests the bundle dist/retroflash.min.js (npm run build) instead of the source scripts.
const fs = require('fs');
const path = require('path');
const { run, group } = require('./support/harness');
const { SWFReader, decompression, source } = require('./support/load-reader');

console.log(`SWFReader ${SWFReader.version} · Node ${process.version} · DecompressionStream: ${decompression} · Code: ${source}\n`);

const unitDir = path.join(__dirname, 'unit');
for (const file of fs.readdirSync(unitDir).filter((f) => f.endsWith('.test.js')).sort()) {
  group(file);
  require(path.join(unitDir, file));
}

run().then((failed) => { process.exitCode = failed ? 1 : 0; });
