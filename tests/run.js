'use strict';
// Runs every tests/unit/*.test.js with the built-in harness. Usage: node tests/run.js (Node 16+).
const fs = require('fs');
const path = require('path');
const { run, group } = require('./support/harness');
const { SWFReader, decompression } = require('./support/load-reader');

console.log(`SWFReader ${SWFReader.version} · Node ${process.version} · DecompressionStream: ${decompression}\n`);

const unitDir = path.join(__dirname, 'unit');
for (const file of fs.readdirSync(unitDir).filter((f) => f.endsWith('.test.js')).sort()) {
  group(file);
  require(path.join(unitDir, file));
}

run().then((failed) => { process.exitCode = failed ? 1 : 0; });
