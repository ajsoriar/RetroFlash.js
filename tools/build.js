'use strict';
/* Builds dist/retroflash.min.js and its source map: every script of src/modules.json (the reader and the
   player), in order, minified with terser into one self-contained classic script. Usage: npm install, then
   npm run build. terser is a development dependency only; the bundle itself has no dependencies.
   The sources and the bundle are each loaded once in an isolated context, so a broken build never lands. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { minify } = require('terser');

const root = path.join(__dirname, '..');
const files = require(path.join(root, 'src', 'modules.json'));

// Runs a script the way a page would, in a fresh global object, and returns the globals it defined.
function load(code, filename) {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox, { filename });
  const { RetroFlash, SWFReader } = sandbox;
  if (!RetroFlash || !SWFReader || typeof RetroFlash.Player !== 'function' || 'RetroFlashModules' in sandbox) {
    throw new Error('build: ' + filename + ' does not define RetroFlash and SWFReader');
  }
  return { RetroFlash, SWFReader };
}

async function build() {
  const sources = {};
  files.forEach((file) => { sources['src/' + file] = fs.readFileSync(path.join(root, 'src', file), 'utf8'); });
  const { RetroFlash, SWFReader } = load(Object.values(sources).join('\n'), 'sources');

  const header = '/*! RetroFlash.js ' + RetroFlash.version + ' (SWFReader ' + SWFReader.version + ') | MIT License | ' +
    'Copyright (c) 2026 ajsoriar | https://github.com/ajsoriar/RetroFlash.js */';
  const result = await minify(sources, {
    compress: { passes: 2 },
    mangle: true,
    format: { preamble: header, comments: false },
    sourceMap: { filename: 'retroflash.min.js', url: 'retroflash.min.js.map', root: '../', includeSources: true }
  });
  load(result.code, 'retroflash.min.js');
  return { code: result.code + '\n', map: result.map, sourceBytes: Object.values(sources).reduce((sum, s) => sum + Buffer.byteLength(s), 0) };
}

if (require.main === module) {
  build().then(({ code, map, sourceBytes }) => {
    const dist = path.join(root, 'dist');
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'retroflash.min.js'), code);
    fs.writeFileSync(path.join(dist, 'retroflash.min.js.map'), map);
    const kb = (bytes) => (bytes / 1024).toFixed(1) + ' KiB';
    console.log('dist/retroflash.min.js: ' + files.length + ' scripts, ' + kb(sourceBytes) + ' -> ' + kb(Buffer.byteLength(code)) + ' (+ source map)');
  }, (err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { build };
