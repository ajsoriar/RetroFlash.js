'use strict';
// Bitmap headers and pixel decoding (lossless, JPEG table merging) and the AVM1 timeline-control subset.
// Browser-only steps (createImageBitmap, Canvas drawing) are checked with demo/player.html.
const fs = require('fs');
const path = require('path');
const { test, assert } = require('../support/harness');
const { SWFReader, RetroFlash } = require('../support/load-reader');
const { FIXTURE_DIR } = require('../fixtures/build-fixtures');
const { JPEG } = require('../fixtures/bitmaps');
const { splitJpeg } = require('../support/swf-builder');

const I = RetroFlash.internals;
const load = (name) => SWFReader.load(new Uint8Array(fs.readFileSync(path.join(FIXTURE_DIR, name))));
const byId = (swf, id) => swf.tags.find((t) => t.fields && t.fields.characterId === id);

async function pixelsOf(swf, id) {
  const tag = byId(swf, id), f = tag.fields;
  const data = await SWFReader.inflate(swf.getTagData(tag).subarray(f.dataStart), I.losslessByteLength(f));
  const img = I.decodeLossless(f, data);
  return (x, y) => Array.from(img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
}
const near = (actual, expected, tolerance, label) =>
  assert.ok(actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance), `${label}: ${actual} ≉ ${expected}`);

test('bitmap tags: decoded headers with image/alpha/data offsets', async () => {
  const swf = await load('valid/fws-bitmaps.swf');
  const jpeg2 = byId(swf, 100).fields;
  assert.deepStrictEqual(jpeg2, { characterId: 100, imageStart: 2, imageEnd: 2 + JPEG.length, imageFormat: 'jpeg' });
  const jpeg3 = byId(swf, 101).fields;
  assert.strictEqual(jpeg3.imageFormat, 'jpeg');
  assert.strictEqual(jpeg3.imageEnd - jpeg3.imageStart, JPEG.length);
  assert.strictEqual(jpeg3.alphaStart, jpeg3.imageEnd);
  assert.strictEqual(byId(swf, 102).fields.imageFormat, 'jpeg');
  assert.strictEqual(byId(swf, 103).fields.imageFormat, 'png');
  assert.deepStrictEqual(byId(swf, 104).fields, { characterId: 104, losslessVersion: 1, bitmapFormat: 3, width: 6, height: 6, colorTableSize: 4, dataStart: 8 });
  assert.strictEqual(byId(swf, 107).fields.losslessVersion, 2);
  assert.ok(swf.tags.some((t) => t.code === 8 && t.status === 'decoded'), 'JPEGTables indexed and decoded');
  const alpha = await SWFReader.inflate(swf.getTagData(byId(swf, 101)).subarray(jpeg3.alphaStart), 32 * 32);
  assert.strictEqual(alpha.length, 1024);
  assert.deepStrictEqual([alpha[0], alpha[16 * 32 + 16]], [0, 255]);
});

test('lossless pixels: colour-mapped with padded rows, PIX15, PIX24, premultiplied ARGB and RGBA palettes', async () => {
  const swf = await load('valid/fws-bitmaps.swf');
  const palette = [[30, 41, 59, 255], [56, 189, 248, 255], [250, 204, 21, 255], [244, 63, 94, 255]];
  const p104 = await pixelsOf(swf, 104);
  for (const [x, y] of [[0, 0], [5, 0], [0, 1], [5, 5], [3, 4]]) assert.deepStrictEqual(p104(x, y), palette[(x + y) % 4], `fmt3 (${x},${y})`);
  const p105 = await pixelsOf(swf, 105);
  assert.deepStrictEqual(p105(7, 0), [231, 0, 24, 255], 'PIX15 expands 5-bit channels');
  assert.deepStrictEqual(p105(0, 7), [0, 231, 255, 255]);
  const p106 = await pixelsOf(swf, 106);
  assert.deepStrictEqual(p106(3, 2), [96, 191, 128, 255]);
  const p107 = await pixelsOf(swf, 107);
  assert.deepStrictEqual(p107(7, 4), [34, 197, 94, 255]);
  assert.deepStrictEqual(p107(0, 0), [0, 0, 0, 0]);
  near(p107(3, 0), [34, 197, 94, 109], 2, 'premultiplied ARGB is un-premultiplied');
  const p108 = await pixelsOf(swf, 108);
  assert.deepStrictEqual(p108(0, 0), [255, 255, 255, 255]);
  assert.deepStrictEqual(p108(1, 0), [0, 0, 0, 0]);
});

test('lossless: indices past the colour table are transparent; short data is rejected', () => {
  const f = { width: 2, height: 1, bitmapFormat: 3, colorTableSize: 1, losslessVersion: 1 };
  const img = I.decodeLossless(f, Uint8Array.from([10, 20, 30, 0, 5, 0, 0]));
  assert.deepStrictEqual(Array.from(img.rgba), [10, 20, 30, 255, 0, 0, 0, 0]);
  assert.throws(() => I.decodeLossless(f, Uint8Array.from([1, 2])), (err) => err.code === 'BITMAP_TRUNCATED');
});

test('JPEG: DefineBits + JPEGTables merge into one stream; erroneous FF D9 FF D8 headers are removed', () => {
  const { tables, image } = splitJpeg(JPEG);
  const merged = I.mergeJpegTables(new Uint8Array(tables), new Uint8Array(image));
  assert.strictEqual(merged.length, JPEG.length);
  assert.deepStrictEqual([merged[0], merged[1], merged[merged.length - 2], merged[merged.length - 1]], [0xff, 0xd8, 0xff, 0xd9]);
  assert.strictEqual(Buffer.from(merged).indexOf(Buffer.from([0xff, 0xd9, 0xff, 0xd8])), -1);
  const erroneous = new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd9, 0xff, 0xd8]), JPEG]));
  assert.deepStrictEqual(Buffer.from(I.cleanJpeg(erroneous)), JPEG);
  assert.strictEqual(I.cleanJpeg(new Uint8Array(JPEG)).length, JPEG.length, 'clean JPEG unchanged');
});

// ---- AVM1 ---------------------------------------------------------------------------------------------------

async function actionsMovie(options) {
  const movie = new I.Movie(await load('valid/fws-actions.swf'));
  const reported = [];
  const env = I.createEnv(movie, (feature, reason, source) => reported.push(feature), options);
  const root = new I.Clip(env, movie.root, 0, null);
  root.gotoFrame(1);
  env.scripts.run();
  const tick = (n = 1) => { for (let i = 0; i < n; i++) { env.scripts.beginUpdate(); root.tick(); env.scripts.run(); } };
  return { root, env, reported, tick, spinner: () => root.displayList.get(1).clip, other: () => root.displayList.get(2).clip };
}

test('AVM1: gotoLabel + play, setTarget + gotoFrame on a named instance, stop', async () => {
  const { root, tick, spinner, reported } = await actionsMovie();
  assert.strictEqual(root.frame, 1);
  tick(2); // root frame 3 runs gotoLabel("five") → frame 5 runs setTarget/gotoFrame(7)/stop
  assert.strictEqual(root.frame, 5, 'frame 4 skipped by the goto');
  assert.strictEqual(root.playing, false, 'stop() in frame 5');
  assert.strictEqual(spinner().frame, 7, 'spinner sent to frame 7 through setTarget');
  assert.strictEqual(spinner().playing, false, 'GotoFrame stops the clip (gotoAndStop), as in Flash Player');
  assert.ok(reported.includes('avm1:GetURL'), 'GetURL reported');
  assert.ok(!reported.includes('avm1:Push') && !reported.includes('avm1:SetVariable'), 'Push and SetVariable are interpreted');
  assert.strictEqual(root.variables.get('x'), '1', 'frame 5 sets x = "1" on the root (SetTarget "" returns to it)');
});

test('AVM1: sprite frame scripts stop their own timeline; a stopped parent keeps children playing', async () => {
  const { root, tick, spinner } = await actionsMovie();
  tick(2);
  tick(3);
  assert.strictEqual(spinner().frame, 7, 'stopped by the GotoFrame');
  spinner().playing = true; // as a play() would
  tick(7); // spinner: 7 → 8, 9, 10, 1, 2, 3, 4
  assert.strictEqual(spinner().frame, 4);
  assert.strictEqual(root.frame, 5, 'root stays stopped');
  tick(1);
  assert.strictEqual(spinner().frame, 5);
  assert.strictEqual(spinner().playing, false, 'stop() in the sprite frame 5');
  tick(3);
  assert.strictEqual(spinner().frame, 5);
});

test('AVM1: a Jump is followed (not reported); its target runs', async () => {
  const { other, reported, tick } = await actionsMovie();
  assert.ok(!reported.includes('avm1:Jump'));
  assert.strictEqual(other().playing, false, 'Jump(0) lands on the stop() right after it');
  tick(1);
  assert.strictEqual(other().frame, 1);
});

test('AVM1: actions can be disabled; scripts queued since a mark can be dropped (scrubbing seek)', async () => {
  const off = await actionsMovie({ actions: false });
  off.tick(5);
  assert.strictEqual(off.root.frame, 6, 'without scripts the root plays straight through');
  assert.strictEqual(off.env.scripts.queue.length, 0, 'nothing is queued when actions are off');
  const on = await actionsMovie();
  const mark = on.env.scripts.mark();
  on.root.gotoFrame(3);
  assert.ok(on.env.scripts.queue.length > mark, 'entering frame 3 queued its script');
  on.env.scripts.dropSince(mark);
  on.env.scripts.run();
  assert.strictEqual(on.root.frame, 3, 'frame 3 script (gotoLabel) not run after a scrubbing seek');
});

test('AVM1: target paths in slash and dot syntax', async () => {
  const { root, spinner } = await actionsMovie();
  const s = spinner();
  for (const p of ['spinner', '/spinner', '_root.spinner', '_level0.spinner', 'SPINNER', 'this.spinner']) {
    assert.strictEqual(I.resolveTarget(root, p), s, p);
  }
  assert.strictEqual(I.resolveTarget(s, '..'), root);
  assert.strictEqual(I.resolveTarget(s, '_parent'), root);
  assert.strictEqual(I.resolveTarget(s, '/'), root);
  assert.strictEqual(I.resolveTarget(root, 'missing'), null);
  assert.strictEqual(I.resolveTarget(root, 'spinner/missing'), null);
});

test('AVM1: action records parse with lengths; truncated records are flagged', () => {
  const list = new I.ActionCode(Uint8Array.from([0x07, 0x81, 2, 0, 4, 0, 0x06, 0x00, 0x07]), 6).list();
  assert.deepStrictEqual(list.map((a) => [a.code, a.offset, a.data.length]), [[0x07, 0, 0], [0x81, 1, 2], [0x06, 6, 0]]);
  assert.strictEqual(list.truncated, false);
  assert.strictEqual(new I.ActionCode(Uint8Array.from([0x81, 9, 0, 1]), 6).list().truncated, true);
});
