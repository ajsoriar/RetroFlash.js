'use strict';
// Loads the browser classic script into Node. When Node lacks DecompressionStream (Node < 18), installs a
// test-only stand-in built on zlib so the reader's real streaming code path still runs. The runtime never
// ships or requires this polyfill.
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

require(path.join(__dirname, '..', '..', 'src', 'swf-reader.js'));

module.exports = { SWFReader: globalThis.SWFReader, decompression };
