'use strict';
// Development tool: prints what SWFReader reports for any SWF. Usage: node tests/inspect.js file.swf [--tags]
const fs = require('fs');
const { SWFReader, decompression } = require('./support/load-reader');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node tests/inspect.js file.swf [--tags]');
  process.exit(2);
}

SWFReader.load(new Uint8Array(fs.readFileSync(file))).then((movie) => {
  console.log(`${file} (DecompressionStream: ${decompression})`);
  console.log(`${movie.signature} SWF ${movie.version} · ${movie.compression} · ${movie.declaredLength} bytes declared, ${movie.sourceLength} on disk`);
  console.log(`stage ${movie.width} × ${movie.height} px · ${movie.fps} fps · frames ${movie.actualFrameCount}/${movie.frameCount}`);
  console.log(`tags ${movie.tags.length} top-level, ${movie.totalTagCount} total · sprites ${movie.spriteCount} · ` +
    `AVM1 ${movie.codeTags.avm1} · AVM2 ${movie.codeTags.avm2} · clip actions ${movie.codeTags.clipActions}`);
  const status = {};
  movie.walkTags((t) => { status[t.status] = (status[t.status] || 0) + 1; });
  console.log('tag status:', status);
  console.log(`\ndiagnostics (${movie.diagnostics.length}):`);
  for (const d of movie.diagnostics.slice(0, 50)) console.log(`  ${d.level} ${d.code}${d.path ? ' @' + d.path : ''}: ${d.message}`);
  if (movie.diagnostics.length > 50) console.log(`  … ${movie.diagnostics.length - 50} more`);
  console.log(`\nunsupported (${movie.unsupported.length}):`);
  for (const u of movie.unsupported) console.log(`  ${u.feature} ×${u.count} (first @${u.firstPath}): ${u.reason}`);
  if (process.argv.includes('--tags')) {
    console.log('\ntags:');
    movie.walkTags((t) => console.log(`  ${'  '.repeat(t.level)}${t.path} f${t.frame} ${t.name} [${t.status}] ${t.length}B` +
      (t.fields ? ' ' + JSON.stringify(t.fields) : '')));
  }
}, (err) => {
  console.error(`${err.name} ${err.code || ''}: ${err.message}`);
  process.exitCode = 1;
});
