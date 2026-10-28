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
  const env = I.createEnv(movie, (feature) => reported.push(feature), { limits: I.resolveLimits(opts.limits) });
  const root = new I.Clip(env, movie.root, 0, null);
  root.gotoFrame(1);
  env.scripts.run();
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
  env.scripts.run();
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
    assert.ok(!reported.some((f) => /^avm1:DefineFunction2?$/.test(f)), 'function definitions are interpreted');
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
function headlessPlayer(options) {
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => ({ addColorStop() {} })), set: (t, k, v) => { t[k] = v; return true; } });
  return new RetroFlash.Player(Object.assign({ canvas: { getContext: () => ctx, style: {}, width: 0, height: 0 }, input: false }, options));
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

// ---- Limits ---------------------------------------------------------------------------------------------------

const sprite = (id, ...tags) => B.tag(B.T.DefineSprite, Buffer.concat([B.body((w) => w.u16(id).u16(1)), ...tags, show(), end()]));

test('limits: defaults, overrides, and invalid values', () => {
  const D = RetroFlash.defaultLimits;
  assert.deepStrictEqual(Object.keys(D), ['maxNesting', 'maxInstances', 'maxBitmapPixels', 'maxTotalBitmapPixels', 'maxActionBlocks', 'maxActionSteps', 'maxActionStack', 'maxCallDepth']);
  assert.ok(Object.isFrozen(D));
  assert.deepStrictEqual(headlessPlayer().limits, D);
  const custom = headlessPlayer({ maxNesting: 4, maxActionSteps: 50, maxBitmapPixels: null });
  assert.strictEqual(custom.limits.maxNesting, 4);
  assert.strictEqual(custom.limits.maxActionSteps, 50);
  assert.strictEqual(custom.limits.maxBitmapPixels, D.maxBitmapPixels, 'null takes the default');
  for (const bad of [0, -1, 1.5, '10', NaN, Infinity]) {
    assert.throws(() => headlessPlayer({ maxInstances: bad }), (err) => err.code === 'INVALID_OPTION' && /maxInstances/.test(err.message), String(bad));
  }
});

test('limits: maxNesting and maxInstances bound sprite instances', async () => {
  const nested = [square(1), sprite(3, place(1, 1)), sprite(2, place(1, 3)), place(1, 2), show(), end()];
  const deep = await run(nested, { limits: { maxNesting: 1 } });
  assert.ok(deep.reported.includes('render:nestingLimit'));
  assert.ok(deep.root.displayList.get(1).clip, 'level 1 is created');
  assert.strictEqual(deep.root.displayList.get(1).clip.displayList.get(1).clip, null, 'level 2 is not');
  assert.ok(!(await run(nested)).reported.includes('render:nestingLimit'), 'the default allows it');

  const many = await run([square(1), sprite(2, place(1, 1)), place(1, 2), place(2, 2), show(), end()], { limits: { maxInstances: 1 } });
  assert.ok(many.reported.includes('render:instanceLimit'));
  assert.ok(many.root.displayList.get(1).clip && !many.root.displayList.get(2).clip);
});

test('limits: maxActionBlocks counts every DoAction; maxActionSteps counts actions', async () => {
  const twoScripts = [B.doAction(), B.doAction(B.A.stop()), show(), show(), end()];
  const blocks = await run(twoScripts, { frameCount: 2, limits: { maxActionBlocks: 1 } });
  assert.ok(blocks.reported.includes('avm1:budget'));
  assert.strictEqual(blocks.root.playing, true, 'the second DoAction of the frame did not run');
  assert.strictEqual((await run(twoScripts, { frameCount: 2 })).root.playing, false, 'by default it runs');

  const steps = await run([B.doAction(B.A.play(), B.A.play(), B.A.stop()), show(), show(), end()], { frameCount: 2, limits: { maxActionSteps: 2 } });
  assert.ok(steps.reported.includes('avm1:budget'));
  assert.strictEqual(steps.root.playing, true, 'the third action did not run');
});

test('limits: the action budget covers a whole tick, and each input event gets a new one', async () => {
  // Frame 2 places a button under the still pointer: the tick runs the frame script (play), then the roll-over
  // (stop) in a second run. Pressing runs the press action (stop) in a new update.
  const button = B.defineButton2(9, {
    records: [{ states: { up: true, hit: true }, character: 1, depth: 1 }],
    actions: [{ conditions: 1, records: [B.A.stop()] }, { conditions: 4, records: [B.A.stop()] }]
  });
  const tags = [square(1), button, show(), place(1, 9), B.doAction(B.A.play()), show(), show(), end()];
  async function stepOverButton(maxActionSteps) {
    const player = headlessPlayer({ maxActionSteps });
    await player.load(B.swf({ version: 6, frameCount: 3, tags }));
    Object.assign(player.input, { inside: true, x: 1000, y: 1000 });
    player.step();
    return player;
  }
  const roomy = await stepOverButton(2);
  assert.strictEqual(roomy.getInfo().rootPlaying, false, 'with two steps, the roll-over runs');
  const tight = await stepOverButton(1);
  assert.strictEqual(tight.input.hovered.button.state, 'over');
  assert.strictEqual(tight.getInfo().rootPlaying, true, 'the roll-over shares the budget the frame script used');
  assert.ok(tight.getDiagnostics().unsupported.some((u) => u.feature === 'avm1:budget'));
  assert.strictEqual(tight.input.down(), true);
  tight.afterInput();
  assert.strictEqual(tight.getInfo().rootPlaying, false, 'the press starts with a fresh budget');
});

test('limits: decoded actions are budgeted per movie across blocks; cached blocks keep running', async () => {
  const FRAMES = 30, tags = [];
  for (let i = 0; i < FRAMES; i++) tags.push(B.doAction(B.A.pushString('a'), [0x17]), show()); // Push (6 bytes), Pop (1)
  tags.push(B.doAction(), show()); // frame 31: an empty block
  const { env, root, reported } = await run([...tags, end()], { frameCount: FRAMES + 1 });
  const scripts = env.scripts, PER_BLOCK = I.ACTION_BLOCK_COST + 7, FIT = 10;
  const tick = () => { scripts.beginUpdate(); root.tick(); scripts.run(); };
  const stops = () => reported.filter((f) => f === 'avm1:budget').length;
  const cachedCost = () => [...scripts.cache.values()]
    .reduce((sum, code) => sum + I.ACTION_BLOCK_COST + [...code.records.values()].reduce((s, a) => s + a.end - a.offset, 0), 0);
  assert.strictEqual(scripts.decoded.used, PER_BLOCK, 'frame 1');
  assert.ok(scripts.decoded.max >= 1024 * 1024, 'the default allows megabytes of bytecode');

  // FIT blocks fit; the next one decodes its Push past the threshold, then stops at its Pop.
  scripts.decoded.max = FIT * PER_BLOCK + 1;
  const crossed = FIT * PER_BLOCK + I.ACTION_BLOCK_COST + 6;
  for (let i = 1; i <= FRAMES; i++) tick();
  assert.strictEqual(root.frame, FRAMES + 1);
  assert.strictEqual(scripts.decoded.used, crossed);
  assert.strictEqual(cachedCost(), crossed, 'the budget counts exactly what the cache holds');
  assert.strictEqual(scripts.cache.size, FIT + 1, 'blocks that decoded nothing, and the empty block, are not kept');
  assert.strictEqual(stops(), FRAMES - FIT, 'the block that crossed the threshold and every later one stopped');

  // Second loop: the cached blocks run again; the others stop again; nothing new is decoded or kept.
  for (let frame = 1; frame <= FRAMES; frame++) {
    const before = stops();
    tick();
    assert.strictEqual(root.frame, frame);
    assert.strictEqual(stops() - before, frame <= FIT ? 0 : 1, 'frame ' + frame);
  }
  assert.strictEqual(scripts.decoded.used, crossed);
  assert.strictEqual(scripts.cache.size, FIT + 1);
});

test('limits: the player passes its limits to the movie', async () => {
  const player = headlessPlayer({ maxActionSteps: 1 });
  await player.load(B.swf({ version: 6, frameCount: 2, tags: [B.doAction(B.A.play(), B.A.stop()), show(), show(), end()] }));
  assert.strictEqual(player.getInfo().rootPlaying, true, 'stop() was over budget');
  assert.ok(player.getDiagnostics().unsupported.some((u) => u.feature === 'avm1:budget'));
});
