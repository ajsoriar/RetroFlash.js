'use strict';
// Regression tests for malformed or unusual input around buttons, filters, bitmaps, actions, pointer sequences
// and overlapping loads.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { test, assert, rejectsWithCode } = require('../support/harness');
const { SWFReader, RetroFlash } = require('../support/load-reader');
const B = require('../support/swf-builder');

const I = RetroFlash.internals;
const square = (id) => B.defineShape(id, {
  version: 1, bounds: { xMin: -200, xMax: 200, yMin: -200, yMax: 200 }, fills: [{ color: [255, 0, 0] }],
  records: [{ move: [-200, -200], fill1: 1 }, { to: [200, -200] }, { to: [200, 200] }, { to: [-200, 200] }, { to: [-200, -200] }]
});
const place = (depth, id) => B.tag(B.T.PlaceObject2, B.body((w) => { w.u8(0x02 | 0x04).u16(depth).u16(id); B.matrix(w, { translateX: 1000, translateY: 1000 }); }));
const show = () => B.tag(B.T.ShowFrame);
const end = () => B.tag(B.T.End);

async function run(tags, opts = {}) {
  const swf = await SWFReader.load(B.swf({ version: opts.version || 6, frameCount: opts.frameCount || 1, tags }));
  const movie = new I.Movie(swf), reported = [];
  const env = I.createEnv(movie, (feature) => reported.push(feature));
  const root = new I.Clip(env, movie.root, 0, null);
  root.gotoFrame(1);
  I.runActionQueue(env);
  return { swf, movie, env, root, reported };
}

test('a button that contains itself (twice per level) is not instantiated recursively', async () => {
  const self = B.defineButton2(5, { records: [{ states: { up: true, hit: true }, character: 5, depth: 1 }] });
  const { root, reported } = await run([self, place(1, 5), show(), end()]);
  assert.ok(root.displayList.get(1).button, 'outer button created');
  assert.ok(reported.includes('render:recursiveCharacter'));
});

test('exponential nesting of distinct sprites is cut by the depth limit and the per-step instance budget', async () => {
  // Sprite 100+k places sprite 101+k twice: 2^25 instances if nothing stopped it.
  const sprites = [];
  for (let k = 24; k >= 0; k--) {
    const children = k === 24 ? [place(1, 1)] : [place(1, 101 + k), place(2, 101 + k)];
    sprites.push(B.tag(B.T.DefineSprite, Buffer.concat([B.body((w) => w.u16(100 + k).u16(1)), ...children, show(), end()])));
  }
  const started = Date.now();
  const { reported } = await run([square(1), ...sprites, place(1, 100), show(), end()]);
  assert.ok(reported.includes('render:instanceLimit'));
  assert.ok(Date.now() - started < 20000, 'bounded time');
});

test('press outside, then release over a button: the button gets its roll over', async () => {
  const button = B.defineButton2(9, {
    records: [{ states: { up: true }, character: 1, depth: 1 }, { states: { over: true }, character: 2, depth: 1 }, { states: { hit: true }, character: 1, depth: 1 }],
    actions: [{ conditions: 1, records: [B.A.gotoFrame(1)] }]
  });
  const { root, env } = await run([square(1), square(2), button, place(1, 9), B.doAction(B.A.stop()), show(), show(), end()], { frameCount: 2 });
  const input = new I.InputController(env, () => root), obj = root.displayList.get(1);
  input.move(5000, 5000);
  input.down();
  input.move(1000, 1000);
  assert.strictEqual(obj.button.state, 'up', 'no roll events while the mouse is held');
  assert.strictEqual(input.up(), true);
  I.runActionQueue(env);
  assert.strictEqual(obj.button.state, 'over');
  assert.strictEqual(root.frame, 2, 'roll-over action ran');
});

test('sprites in a hit area do not run frame scripts', async () => {
  const hitSprite = B.tag(B.T.DefineSprite, Buffer.concat([B.body((w) => w.u16(3).u16(1)), place(1, 1), B.doAction(B.A.setTarget('/'), B.A.stop()), show(), end()]));
  const button = B.defineButton2(4, { records: [{ states: { up: true }, character: 1, depth: 1 }, { states: { hit: true }, character: 3, depth: 1 }] });
  const { root } = await run([square(1), hitSprite, button, place(1, 4), show(), show(), end()], { frameCount: 2 });
  assert.strictEqual(root.playing, true, 'root not stopped by the hit-area sprite');
});

test('PlaceObject3 with an unreadable filter list keeps the placement (partial)', async () => {
  const po3 = B.tag(B.T.PlaceObject3, B.body((w) => w.u8(0x02).u8(0x01 | 0x02).u16(1).u16(1).raw([1, 9, 0, 0]).u8(3)));
  const { swf, root } = await run([square(1), po3, show(), end()], { version: 8 });
  const tag = swf.tags[1];
  assert.strictEqual(tag.status, 'partial');
  assert.deepStrictEqual(tag.unparsed, ['filterList']);
  assert.deepStrictEqual(tag.fields, { move: false, depth: 1, characterId: 1 });
  assert.ok(root.displayList.has(1), 'still placed');
});

test('DefineButton2 actions are found through ActionOffset even after a gap (reported)', async () => {
  const rec = new B.BitWriter();
  rec.u8(0x01).u16(1).u16(1);
  B.matrix(rec, {});
  B.cxform(rec, {}, true);
  rec.u8(0);
  const records = rec.bytes(), gap = [0xaa, 0xbb], action = [0x07, 0x00];
  const body = B.body((w) => w.u16(7).u8(0).u16(2 + records.length + gap.length).raw(records).raw(gap).u16(0).u16(8).raw(action));
  const { swf } = await run([square(1), B.tag(34, body), show(), end()]);
  const tag = swf.tags[1];
  assert.strictEqual(tag.status, 'decoded');
  assert.deepStrictEqual(tag.fields.actions.map((a) => [a.conditions, Array.from(swf.getTagData(tag).subarray(a.start, a.end))]), [[8, [0x07, 0x00]]]);
  assert.deepStrictEqual(swf.diagnostics.map((d) => d.code), ['BUTTON_ACTION_OFFSET_GAP']);
});

test('an undecodable definition still defines its id (reported as invalid, not missing)', async () => {
  const bad = B.tag(20, B.body((w) => w.u16(12).u8(9).u16(1).u16(1)));
  const { movie, reported } = await run([bad, place(1, 12), show(), end()]);
  assert.strictEqual(movie.characters[12].type, 'unsupported');
  assert.match(movie.characters[12].name, /invalid/);
  assert.ok(reported.includes('render:DefineBitsLossless (invalid)'));
  assert.ok(!reported.includes('render:missingCharacter'));
});

test('inflate: strict by default, truncate option keeps the first maxLength bytes', async () => {
  const data = new Uint8Array(zlib.deflateSync(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])));
  await rejectsWithCode(SWFReader.inflate(data, 4), 'INFLATE_TOO_LARGE');
  assert.deepStrictEqual(Array.from(await SWFReader.inflate(data, 4, { truncate: true })), [1, 2, 3, 4]);
  assert.deepStrictEqual(Array.from(await SWFReader.inflate(data, 20)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('DefineFunction/DefineFunction2: the body after the record is skipped and the next action runs', async () => {
  // SWF layout: the record's Length covers name, parameters and codeSize; the codeSize bytes of body follow it.
  const body = B.A.gotoFrame(2); // 5 bytes; would move the playhead if it ran
  const defineFunction = [0x9b, 6, 0, 0x66, 0, 0, 0, body.length, 0]; // "f", 0 params, codeSize
  const defineFunction2 = [0x8e, 9, 0, 0x66, 0, 0, 0, 0, 0, 0, body.length, 0]; // "f", 0 params, 0 registers, flags 0, codeSize
  for (const record of [defineFunction, defineFunction2]) {
    const { root, reported } = await run([B.doAction(record, body, B.A.stop()), show(), show(), show(), end()], { frameCount: 3 });
    assert.strictEqual(root.frame, 1, 'function body not run');
    assert.strictEqual(root.playing, false, 'stop() after the function ran');
    assert.ok(reported.some((f) => /^avm1:DefineFunction2?$/.test(f)));
  }
});

test('imageSize reads JPEG, PNG and GIF headers without decoding', () => {
  const jpeg = new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'assets', 'gradient-32.jpg')));
  assert.deepStrictEqual(I.imageSize(jpeg, 'jpeg'), { width: 32, height: 32 });
  assert.deepStrictEqual(I.imageSize(new Uint8Array(B.png(3, 2, new Uint8Array(24))), 'png'), { width: 3, height: 2 });
  assert.deepStrictEqual(I.imageSize(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 7, 0, 5, 0]), 'gif'), { width: 7, height: 5 });
  const sofFirst = [0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc2, 0, 11, 8, 0x13, 0x88, 0x27, 0x10, 1, 1, 0x11, 0];
  assert.deepStrictEqual(I.imageSize(Uint8Array.from(sofFirst), 'jpeg'), { width: 10000, height: 5000 }, 'progressive SOF2 after APP0');
  assert.strictEqual(I.imageSize(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1]), 'jpeg'), null, 'scan before frame header');
  assert.strictEqual(I.imageSize(Uint8Array.from([0xff, 0xd8, 0x12, 0x34]), 'jpeg'), null, 'not a marker');
  assert.strictEqual(I.imageSize(new Uint8Array(30), 'png'), null);
});

test('bitmap pixels are reserved from per-image and per-movie budgets', () => {
  const limits = { maxPixels: 100, remaining: 150 };
  assert.strictEqual(I.reservePixels(limits, 10, 10), 100);
  assert.throws(() => I.reservePixels(limits, 10, 6), (e) => e.code === 'BITMAP_BUDGET');
  assert.throws(() => I.reservePixels(limits, 11, 10), (e) => e.code === 'BITMAP_TOO_LARGE');
  assert.strictEqual(limits.remaining, 50, 'refused requests take nothing');
});

test('an oversized JPEG is refused from its header, before the browser decodes it', async () => {
  const sof = (w, h) => [0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 0xff, w >> 8, w & 0xff, 1, 1, 0x11, 0, 0xff, 0xd9];
  const { movie } = await run([B.defineBitsJPEG2(1, sof(30000, 30000)), B.defineBitsJPEG2(2, sof(10, 10)), B.defineBitsJPEG2(3, sof(10, 10)), show(), end()]);
  const failures = [];
  await movie.decodeBitmaps(4096 * 4096, 150, (feature, reason, source) => failures.push(source));
  // Node has no createImageBitmap: any bitmap that got past the checks fails there instead.
  assert.match(failures[0], /^1 .*30000×30000 exceeds options\.maxBitmapPixels/);
  assert.doesNotMatch(failures[1], /maxTotalBitmapPixels/, 'bitmap 2 fits the movie budget');
  assert.match(failures[2], /^3 .*maxTotalBitmapPixels/);
});

// Player on a stand-in canvas whose 2D context ignores every call.
function headlessPlayer() {
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => ({ addColorStop() {} })), set: (t, k, v) => { t[k] = v; return true; } });
  return new RetroFlash.Player({ canvas: { getContext: () => ctx, style: {}, width: 0, height: 0 }, input: false });
}
// Replaces SWFReader.load so each input can wait before parsing.
async function withDelayedReader(delays, fn) {
  const real = globalThis.SWFReader;
  globalThis.SWFReader = Object.assign({}, real, {
    load: (input, options) => new Promise((resolve) => setTimeout(resolve, delays.get(input) || 0)).then(() => real.load(input, options))
  });
  try { return await fn(); } finally { globalThis.SWFReader = real; }
}

test('overlapping loads: the latest call wins even when an older one finishes last', async () => {
  const older = B.swf({ version: 6, frameCount: 1, tags: [square(1), place(1, 1), show(), end()] });
  const newer = B.swf({ version: 6, frameCount: 2, tags: [show(), show(), end()] });
  const player = headlessPlayer(), loads = [];
  player.on('load', (info) => loads.push(info.frameCount));
  const [first, second] = await withDelayedReader(new Map([[older, 30]]), () => Promise.all([player.load(older), player.load(newer)]));
  assert.strictEqual(first, null, 'superseded load resolves to null');
  assert.strictEqual(second.frameCount, 2);
  assert.strictEqual(player.movie.swf.frameCount, 2, 'the older file did not replace the newer one');
  assert.deepStrictEqual(loads, [2]);
  assert.strictEqual(player.state, 'ready');
});

test('a load superseded while decoding bitmaps does not report into the newer movie', async () => {
  const bitmap = B.defineBitsLossless(1, 1, { format: 5, width: 1, height: 1, pixels: [[255, 0, 0]] });
  const older = B.swf({ version: 6, frameCount: 1, tags: [bitmap, show(), end()] });
  const newer = B.swf({ version: 6, frameCount: 1, tags: [show(), end()] });
  const player = headlessPlayer(), real = globalThis.SWFReader;
  let second = null;
  // The newer load starts while the older one inflates its bitmap; the older decode then fails (no canvas in Node).
  globalThis.SWFReader = Object.assign({}, real, {
    inflate: (...args) => { if (!second) second = player.load(newer); return real.inflate(...args); }
  });
  let first;
  try { first = await player.load(older); } finally { globalThis.SWFReader = real; }
  assert.strictEqual(first, null);
  assert.strictEqual((await second).frameCount, 1);
  assert.deepStrictEqual(player.getDiagnostics().unsupported.map((u) => u.feature), [], 'no render:bitmapDecodeFailed from the older file');
});

test('a load that fails after destroy() leaves the player destroyed', async () => {
  const player = headlessPlayer();
  const bad = Uint8Array.from([0x46, 0x57, 0x53, 6, 8, 0, 0, 0]);
  const pending = withDelayedReader(new Map([[bad, 10]]), () => player.load(bad));
  player.destroy();
  assert.strictEqual(await pending, null);
  assert.strictEqual(player.state, 'destroyed', 'not revived as error');
});
