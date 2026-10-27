'use strict';
// Every fixture in tests/fixtures/build-fixtures.js: the committed file must match the generator, and
// loading it must give exactly the documented outcome (see tests/COMPATIBILITY.md).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { test, assert, rejectsWithCode } = require('../support/harness');
const { SWFReader } = require('../support/load-reader');
const { fixtures, buildFixture, FIXTURE_DIR } = require('../fixtures/build-fixtures');

// zlib output may differ between zlib versions, so compressed fixtures are compared by header + inflated content.
function sameFixture(committed, generated) {
  if (Buffer.compare(committed, generated) === 0) return true;
  if (committed.subarray(0, 3).toString('latin1') !== 'CWS' || Buffer.compare(committed.subarray(0, 8), generated.subarray(0, 8)) !== 0) return false;
  const inflate = (b) => zlib.inflateSync(b.subarray(8), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  const a = inflate(committed), b = inflate(generated), n = Math.min(a.length, b.length);
  return n > 0 && Buffer.compare(a.subarray(0, n), b.subarray(0, n)) === 0;
}

for (const fx of fixtures) {
  test('fixture ' + fx.file, async () => {
    const file = path.join(FIXTURE_DIR, fx.file);
    assert.ok(fs.existsSync(file), fx.file + ' is missing; run: node tests/fixtures/build-fixtures.js');
    const committed = fs.readFileSync(file);
    assert.ok(sameFixture(committed, Buffer.from(buildFixture(fx))), fx.file + ' is out of date; run: node tests/fixtures/build-fixtures.js');
    const bytes = new Uint8Array(committed);
    const want = fx.expect;
    if (want.error) {
      await rejectsWithCode(SWFReader.load(bytes), want.error);
      return;
    }
    const movie = await SWFReader.load(bytes);
    for (const key of ['signature', 'version', 'width', 'height', 'fps', 'frameCount', 'actualFrameCount']) {
      if (key in want) assert.strictEqual(movie[key], want[key], key);
    }
    assert.strictEqual(movie.tags.length, want.tags, 'top-level tag count');
    assert.deepStrictEqual(movie.diagnostics.map((d) => d.code).sort(), want.diagnostics, 'diagnostic codes');
    assert.deepStrictEqual(movie.unsupported.map((u) => u.feature).sort(), want.unsupported, 'unsupported features');
  });
}
