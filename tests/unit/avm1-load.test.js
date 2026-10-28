'use strict';
// Loading into clips: GetURL2's flags in use, loadMovie of a SWF into a clip (its own dictionary and SWF
// version, the clip's position kept, unload and load events), images, unloadMovie, loadVariables, _level0,
// refusals and failures, superseded loads, the pending-load limit, and the Player's `loader` option. Every
// movie, image and host loader is built in memory; the player never fetches anything itself.
const { test, assert } = require('../support/harness');
const { SWFReader, RetroFlash } = require('../support/load-reader');
const B = require('../support/swf-builder');
const { I, rec, push } = require('../support/avm1');

const GET = [0x1c], SET = [0x1d];
const show = () => B.tag(B.T.ShowFrame);
const end = () => B.tag(B.T.End);
const script = (...records) => B.doAction(records.flat(Infinity));
// GetURL2 with its flags byte: 0x40 loads into a clip, 0x80 loads variables, the low bits are the method.
const getURL2 = (url, target, flags = 0x40) => [push(url, target), rec(0x9a, flags)];
const getURL = (url, target) => rec(0x83, ...Buffer.from(url + '\0' + target + '\0', 'latin1'));
const square = (id, half) => B.defineShape(id, {
  version: 1, bounds: { xMin: -half, xMax: half, yMin: -half, yMax: half }, fills: [{ color: [255, 0, 0] }],
  records: [{ move: [-half, -half], fill1: 1 }, { to: [half, -half] }, { to: [half, half] }, { to: [-half, half] }, { to: [-half, -half] }]
});
const sprite = (id, ...inner) => B.tag(B.T.DefineSprite, Buffer.concat([B.body((w) => w.u16(id).u16(1)), ...inner, show(), end()]));
// SWF 6 clip event flags (UI32): load, unload and data.
const EVENT = { unload: 0x04, load: 0x01, data: 0x100 };
// PlaceObject2 with a name, a position (px) and clip actions [{ events, actions }].
function place(depth, id, name, x = 0, y = 0, clipActions) {
  return B.tag(B.T.PlaceObject2, B.body((w) => {
    w.u8(0x02 | 0x04 | (name ? 0x20 : 0) | (clipActions ? 0x80 : 0)).u16(depth).u16(id);
    B.matrix(w, { translateX: x * 20, translateY: y * 20 });
    if (name) w.string(name);
    if (!clipActions) return;
    const flagsOf = (events) => events.reduce((f, e) => f | EVENT[e], 0);
    w.u16(0).u32(clipActions.reduce((f, a) => f | flagsOf(a.events), 0));
    for (const a of clipActions) {
      const code = [...a.actions.flat(Infinity), 0];
      w.u32(flagsOf(a.events)).u32(code.length).raw(code);
    }
    w.u32(0);
  }));
}
// _root.log += letter (a slash path, so it works from any timeline; undefined adds nothing before SWF 7).
const log = (letter) => [push('/:log', '/:log'), GET, push(letter), [0x21], SET];

// A container clip "box" at (100, 50) px holding a 20-twip square (shape 1), and a frame script.
const launcher = (records, { version = 7, clipActions } = {}) => B.swf({ version, frameCount: 1, tags: [
  square(1, 200), sprite(2, place(1, 1)), place(1, 2, 'box', 100, 50, clipActions), script(...records), show(), end()
] });
// The loaded movie: SWF 8, two frames, its own shape 1 and sprite 2 (the same ids as the launcher's).
const child = () => B.swf({ version: 8, frameCount: 2, tags: [
  square(1, 50), sprite(2, place(1, 1)), place(1, 2, 'inner'),
  script(push('u', -8, 0), [0x65], SET, push('url', '', 15), [0x22], SET), show(), show(), end()
] });

// A test image decoder (Node has no createImageBitmap): the size comes from the image header.
async function decodeImage(bytes, limits) {
  const size = I.imageSize(bytes, I.imageFormat(bytes));
  const reserved = I.reservePixels(limits, size.width, size.height);
  return { source: { width: size.width, height: size.height, close() { this.closed = true; } }, width: size.width, height: size.height, reserved };
}
// Runs `bytes` with a host loader. settle() waits for the host, then shows what arrived, as the player does
// between frames.
async function start(bytes, loader) {
  const swf = await SWFReader.load(bytes);
  const movie = new I.Movie(swf), reported = [], requests = [];
  const host = loader && ((request) => { requests.push(request); return loader(request); });
  const env = I.createEnv(movie, (feature) => reported.push(feature), { loader: host });
  env.loads.decodeImage = decodeImage;
  const root = new I.Clip(env, movie.root, 0, null);
  root.gotoFrame(1);
  env.scripts.run();
  const run = () => { env.scripts.beginUpdate(); env.scripts.run(); };
  return {
    env, root, reported, requests,
    box: () => root.childByName('box'),
    settle: async () => { await env.loads.idle(); env.scripts.beginUpdate(); const changed = env.loads.apply(); env.scripts.run(); return changed; },
    tick: () => { env.scripts.beginUpdate(); root.tick(); env.scripts.run(); },
    run
  };
}
const bytesOf = (files) => (request) => files[request.url] || null;

test('loadMovie: a SWF replaces the content of the target clip, which keeps its place', async () => {
  const m = await start(launcher([getURL2('child.swf', 'box'), push('u', -8, 0), [0x65], SET]), bytesOf({ 'child.swf': child() }));
  const box = m.box();
  assert.deepStrictEqual(m.requests, [{ url: 'child.swf', type: 'movie', method: null }]);
  assert.strictEqual(box.displayList.size, 0, 'emptied as soon as the load starts');
  assert.strictEqual(box.frameCount(), 1);
  assert.strictEqual(await m.settle(), true);
  assert.strictEqual(m.box(), box, 'the same clip');
  assert.deepStrictEqual([box.displayObject().matrix[4], box.displayObject().matrix[5], box.displayObject().name], [2000, 1000, 'box']);
  assert.strictEqual(box.frameCount(), 2);
  assert.strictEqual(box.frame, 1);
  // The loaded movie has its own dictionary: its shape 1 and its sprite 2 (not refused as recursive).
  const inner = box.childByName('inner');
  assert.ok(inner, 'sprite 2 of the loaded movie inside sprite 2 of the launcher');
  assert.strictEqual(inner.displayList.get(1).character.shape.bounds.xMax, 50);
  assert.strictEqual(m.root.displayList.get(1).characterId, 2, 'placed as sprite 2 of the launcher');
  assert.strictEqual(m.env.characters[1].shape.bounds.xMax, 200, 'the launcher keeps its own shape 1');
  // Its scripts follow its own version: -8 >>> 0 is -8 in SWF 8, 4294967288 in the SWF 7 launcher.
  assert.strictEqual(box.env.version, 8);
  assert.strictEqual(box.variables.get('u'), -8);
  assert.strictEqual(m.root.variables.get('u'), 4294967288);
  assert.strictEqual(box.variables.get('url'), 'child.swf', '_url');
  assert.strictEqual(I.getProperty(m.root, 15, 7), '');
  m.tick();
  assert.strictEqual(box.frame, 2, 'it plays on');
  assert.deepStrictEqual(m.reported, []);
});

test('loadMovie: the target gets unload when emptied and load when the movie arrives', async () => {
  const clipActions = [{ events: ['load'], actions: log('L') }, { events: ['unload'], actions: log('U') }];
  const m = await start(launcher([getURL2('child.swf', 'box')], { version: 6, clipActions }), bytesOf({ 'child.swf': child() }));
  assert.strictEqual(m.root.variables.get('log'), 'LU');
  await m.settle();
  assert.strictEqual(m.root.variables.get('log'), 'LUL');
  assert.strictEqual(m.box().object.clipActions.length, 2, 'the clip events stay with the clip');
});

test('loadMovie: an image is shown at the clip origin; unloadMovie empties the clip and frees it', async () => {
  const image = B.png(4, 2, new Uint8Array(4 * 2 * 4).fill(255));
  const m = await start(launcher([getURL2('photo.png', 'box')]), bytesOf({ 'photo.png': image }));
  await m.settle();
  const box = m.box(), obj = box.displayList.get(1);
  assert.deepStrictEqual([obj.character.type, obj.character.width, obj.character.height], ['bitmap', 4, 2]);
  assert.strictEqual(I.getProperty(box, 8, 7), 4, '_width');
  assert.strictEqual(I.getProperty(box, 9, 7), 2, '_height');
  assert.strictEqual(m.env.loads.pixels.remaining, RetroFlash.defaultLimits.maxTotalBitmapPixels - 8);
  const source = obj.character.source;
  I.loadInto(box, '', 'movie', 0, () => {});
  assert.strictEqual(box.displayList.size, 0);
  assert.strictEqual(source.closed, true);
  assert.strictEqual(m.env.loads.pixels.remaining, RetroFlash.defaultLimits.maxTotalBitmapPixels);
  assert.strictEqual(m.env.loads.contents.size, 0);
});

test('unloadMovie (GetURL2 with an empty URL) needs no loader', async () => {
  const m = await start(launcher([getURL2('', 'box')]));
  assert.strictEqual(m.box().displayList.size, 0);
  assert.deepStrictEqual(m.reported, []);
});

test('loadVariables: name=value pairs set variables of the target, then its data event', async () => {
  const clipActions = [{ events: ['data'], actions: log('D') }];
  const m = await start(launcher([getURL2('vars.txt', 'box', 0xc0)], { version: 6, clipActions }), () => 'a=1&b=hello+world%21&c&=x&d=%E9');
  const box = m.box();
  assert.strictEqual(box.displayList.size, 1, 'variables do not empty the clip');
  assert.strictEqual(m.requests[0].type, 'variables');
  await m.settle();
  assert.deepStrictEqual(['a', 'b', 'c', 'd'].map((k) => box.variables.get(k)), ['1', 'hello world!', '', 'é']);
  assert.strictEqual(m.root.variables.get('log'), 'D');
  // Bytes are text: UTF-8 from SWF 6.
  const utf8 = await start(launcher([getURL2('vars.txt', 'box', 0xc0)]), () => new TextEncoder().encode('name=Jos%C3%A9&t=ñ'));
  await utf8.settle();
  assert.deepStrictEqual([utf8.box().variables.get('name'), utf8.box().variables.get('t')], ['José', 'ñ']);
});

test('GetURL with _level0 loads into the root; other levels and window targets are reported', async () => {
  const m = await start(launcher([getURL('child.swf', '_level0')]), bytesOf({ 'child.swf': child() }));
  await m.settle();
  assert.strictEqual(m.root.frameCount(), 2);
  assert.strictEqual(m.root.env.version, 8);
  const other = await start(launcher([getURL('child.swf', '_level1'), getURL2('page.html', '_blank', 0), getURL('page.html', '_self')]), bytesOf({}));
  assert.deepStrictEqual(other.reported, ['load:level', 'avm1:GetURL2', 'avm1:GetURL']);
  assert.deepStrictEqual(other.requests, []);
  assert.strictEqual(other.box().displayList.size, 1);
});

test('loads that cannot be shown are reported; without a loader nothing changes', async () => {
  const none = await start(launcher([getURL2('child.swf', 'box')]));
  assert.deepStrictEqual(none.reported, ['load:noLoader']);
  assert.strictEqual(none.box().displayList.size, 1, 'the clip keeps its content');
  const refused = await start(launcher([getURL2('child.swf', 'box', 0x41)]), () => null);
  assert.strictEqual(refused.requests[0].method, 'GET');
  await refused.settle();
  assert.deepStrictEqual(refused.reported, ['load:sendVariables', 'load:refused']);
  assert.strictEqual(refused.box().displayList.size, 0, 'a failed load leaves the clip empty');
  const broken = await start(launcher([getURL2('a.swf', 'box'), getURL2('b.bin', 'box'), getURL2('c.swf', 'box')]), (r) => {
    if (r.url === 'a.swf') throw new Error('host error');
    return r.url === 'b.bin' ? new Uint8Array([1, 2, 3]) : child();
  });
  await broken.settle();
  assert.deepStrictEqual(broken.reported, [], 'only the latest load into a clip counts');
  const failed = await start(launcher([getURL2('b.bin', 'box')]), () => new Uint8Array([1, 2, 3]));
  await failed.settle();
  assert.deepStrictEqual(failed.reported, ['load:failed']);
  const missing = await start(launcher([getURL2('child.swf', 'nothere')]), bytesOf({ 'child.swf': child() }));
  assert.deepStrictEqual(missing.reported, ['avm1:targetNotFound']);
});

test('a newer load into a clip wins, even when the older one finishes last', async () => {
  const waits = {};
  const later = (bytes) => new Promise((resolve) => { waits.older = () => resolve(bytes); });
  const m = await start(launcher([getURL2('old.swf', 'box'), getURL2('new.swf', 'box')]), (r) => (r.url === 'old.swf' ? later(launcher([])) : child()));
  await new Promise((resolve) => setTimeout(resolve, 0));
  m.env.scripts.beginUpdate();
  m.env.loads.apply();
  m.env.scripts.run();
  assert.strictEqual(m.box().frameCount(), 2, 'new.swf');
  waits.older();
  await m.settle();
  assert.strictEqual(m.box().frameCount(), 2, 'old.swf is dropped');
  assert.ok(m.box().childByName('inner'));
});

test('at most 8 loads wait for the host at once; the rest are reported', async () => {
  const records = [];
  for (let i = 0; i < 9; i++) records.push(getURL2('v' + i, 'box', 0xc0));
  const m = await start(launcher(records), () => new Promise(() => {}));
  assert.strictEqual(m.requests.length, 8);
  assert.deepStrictEqual(m.reported, ['load:limit']);
  m.env.loads.close();
});

test('MovieClip.loadMovie, unloadMovie and loadVariables', async () => {
  const call = (name, ...args) => [push(...args.slice().reverse(), args.length, 'box'), GET, push(name), [0x52], [0x17]];
  const m = await start(launcher([call('loadVariables', 'vars.txt', 'POST')]), (r) => (r.type === 'variables' ? 'k=v' : child()));
  await m.settle();
  assert.strictEqual(m.box().variables.get('k'), 'v');
  assert.deepStrictEqual(m.requests[0], { url: 'vars.txt', type: 'variables', method: 'POST' });
  const n = await start(launcher([call('loadMovie', 'child.swf')]), bytesOf({ 'child.swf': child() }));
  await n.settle();
  assert.strictEqual(n.box().frameCount(), 2);
  const u = await start(launcher([call('unloadMovie')]));
  assert.strictEqual(u.box().displayList.size, 0);
});

// Player on a stand-in canvas whose 2D context ignores every call; Node has no Path2D or DOMMatrix either.
if (!globalThis.Path2D) globalThis.Path2D = class { addPath() {} moveTo() {} lineTo() {} quadraticCurveTo() {} closePath() {} };
if (!globalThis.DOMMatrix) globalThis.DOMMatrix = class { constructor(m) { this.m = m; } };
function headlessPlayer(options) {
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => ({ addColorStop() {} })), set: (t, k, v) => { t[k] = v; return true; } });
  return new RetroFlash.Player(Object.assign({ canvas: { getContext: () => ctx, style: {}, width: 0, height: 0 }, input: false }, options));
}

test('Player: the loader option, loads shown while paused or at the next frame, and freed on restart', async () => {
  assert.throws(() => headlessPlayer({ loader: 'files/' }), (e) => e.code === 'INVALID_OPTION');
  const image = B.png(4, 2, new Uint8Array(32).fill(255));
  const files = { 'child.swf': child(), 'photo.png': image };
  const player = headlessPlayer({ loader: (r) => files[r.url] || null });
  let frames = 0;
  player.on('frame', () => frames++);
  await player.load(launcher([getURL2('child.swf', 'box')]));
  await player.env.loads.idle();
  const box = player.root.childByName('box');
  assert.strictEqual(box.frameCount(), 2, 'shown at once while not playing');
  assert.strictEqual(frames, 1);
  player.step();
  assert.strictEqual(box.frame, 2);
  // While playing, a load is shown by the next frame.
  player.env.loads.decodeImage = decodeImage;
  I.loadInto(box, 'photo.png', 'movie', 0, () => {});
  player.state = 'playing';
  await player.env.loads.idle();
  assert.strictEqual(box.displayList.size, 0, 'not yet');
  player.advance();
  assert.strictEqual(box.displayList.get(1).character.type, 'bitmap');
  player.state = 'paused';
  const source = box.displayList.get(1).character.source;
  player.stop();
  assert.strictEqual(source.closed, true, 'restart frees loaded content');
  player.destroy();
  assert.strictEqual(player.state, 'destroyed');
});
