'use strict';
// Loads the browser classic script into Node. When Node lacks DecompressionStream (Node < 18), installs a
// test-only stand-in built on zlib so the reader's real streaming code path still runs. The runtime never
// ships or requires this polyfill.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let decompression = 'native';

if (typeof globalThis.DecompressionStream !== 'function') {
  const { TransformStream } = require('stream/web');
  decompression = 'zlib polyfill (tests only)';
  globalThis.DecompressionStream = class DecompressionStream {
    constructor(format) {
      if (format !== 'deflate') throw new TypeError('Unsupported format: ' + format);
      const chunks = [];
      const transform = new TransformStream({
        transform(chunk) { chunks.push(Buffer.from(chunk)); },
        flush(controller) { controller.enqueue(new Uint8Array(zlib.inflateSync(Buffer.concat(chunks)))); }
      });
      this.readable = transform.readable;
      this.writable = transform.writable;
    }
  };
}

// The source scripts in the order of src/modules.json or, with `--dist`, the bundle built by tools/build.js.
const root = path.join(__dirname, '..', '..');
const useDist = process.argv.includes('--dist');
const pkg = require(path.join(root, 'package.json'));
const bundleName = 'retroflash-' + pkg.version + '.min.js';
const scripts = useDist ? [path.join(root, 'dist', bundleName)]
  : require(path.join(root, 'src', 'modules.json')).map((file) => path.join(root, 'src', file));
if (useDist && !fs.existsSync(scripts[0])) throw new Error('dist/' + bundleName + ' not found: run npm install and npm run build first');
scripts.forEach((file) => require(file));

module.exports = { SWFReader: globalThis.SWFReader, RetroFlash: globalThis.RetroFlash, decompression, source: useDist ? 'dist/' + bundleName : 'src' };
