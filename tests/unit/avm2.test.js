'use strict';
// ActionScript 3 (AVM2): ABC parsing and its checks, the document class and frame scripts, linked sprite classes,
// button MouseEvents, navigateToURL and ExternalInterface through a recording host, and bounded, reported failures.
// Every movie and ABC block is built here (tests/support/avm2-asm.js); no third-party SWF is used.
const { test, assert } = require('../support/harness');
const { SWFReader, RetroFlash } = require('../support/load-reader');
const B = require('../support/swf-builder');
const { AbcBuilder, timelineClass, NS, u30 } = require('../support/avm2-asm');

const I = RetroFlash.internals;
// Player on a stand-in canvas whose 2D context ignores every call; Node has no Path2D or DOMMatrix either.
if (!globalThis.Path2D) globalThis.Path2D = class { addPath() {} moveTo() {} lineTo() {} quadraticCurveTo() {} closePath() {} };
if (!globalThis.DOMMatrix) globalThis.DOMMatrix = class { constructor(m) { this.m = m; } };

// ---- Movie building blocks ----
const fileAttributes = () => B.tag(B.T.FileAttributes, B.body((w) => w.u32(0x08)));
const doABC = (bytes, { name = '', lazy = true } = {}) => B.tag(B.T.DoABC, B.body((w) => w.u32(lazy ? 1 : 0).string(name).raw(bytes)));
const symbolClass = (entries) => B.tag(76, B.body((w) => { w.u16(entries.length); entries.forEach(([id, n]) => w.u16(id).string(n)); }));
function sceneData(scenes, labels) {
  const out = [];
  u30(out, scenes.length);
  scenes.forEach(([offset, name]) => { u30(out, offset); out.push(...Buffer.from(name), 0); });
  u30(out, labels.length);
  labels.forEach(([frame, name]) => { u30(out, frame); out.push(...Buffer.from(name), 0); });
  return B.tag(86, Uint8Array.from(out));
}
const rectShape = (id, half) => B.defineShape(id, {
  version: 1, bounds: { xMin: -half, xMax: half, yMin: -half, yMax: half }, fills: [{ color: [40, 120, 220] }],
  records: [{ move: [-half, -half], fill1: 1 }, { to: [half, -half] }, { to: [half, half] }, { to: [-half, half] }, { to: [-half, -half] }]
});
const button = (id, shape) => B.defineButton2(id, { records: [{ states: { up: true, over: true, down: true }, character: shape, depth: 1 }, { states: { hit: true }, character: shape, depth: 1 }] });
function place(depth, character, x, y, name) {
  return B.tag(B.T.PlaceObject2, B.body((w) => {
    w.u8(0x02 | 0x04 | (name ? 0x20 : 0)).u16(depth).u16(character);
    B.matrix(w, { translateX: x, translateY: y });
    if (name) w.string(name);
  }));
}
const frameLabel = (name) => B.tag(B.T.FrameLabel, B.body((w) => w.string(name)));
const show = () => B.tag(B.T.ShowFrame);
const end = () => B.tag(B.T.End);
const sprite = (id, frames, ...tags) => B.tag(B.T.DefineSprite, Buffer.concat([B.body((w) => w.u16(id).u16(frames)), ...tags.map((t) => Buffer.from(t)), end()]));
const as3Movie = (abcBytes, tags, frameCount) => B.swf({ version: 9, frameCount, tags: [fileAttributes(), doABC(abcBytes), symbolClass([[0, 'demo.Main']]), ...tags, end()] });

const GO = [2000, 2000], EXT = [4000, 2000]; // stage twips of the two buttons of the menu movie

/* The menu movie: demo.Main (document class) with stage instances `go` and `ext` (SimpleButton). Frame 1 adds
   CLICK listeners (onGo: navigateToURL(new URLRequest("page.html"), "_self"); onExt:
   ExternalInterface.call("selectMenu", "mnu010")); frame 2 calls stop(). Three root frames. */
function menuAbc(extra = {}) {
  const abc = new AbcBuilder(), s = (t) => abc.string(t);
  const nav = abc.qname('flash.net', 'navigateToURL'), req = abc.qname('flash.net', 'URLRequest');
  const mouseEvent = abc.qname('flash.events', 'MouseEvent'), external = abc.qname('flash.external', 'ExternalInterface');
  const handler = (n) => abc.qname('demo', n, NS.PACKAGE_INTERNAL);
  const listen = (target, fn) => [['getlex', abc.name(target, 'demo')], ['getlex', mouseEvent], ['getproperty', abc.name('CLICK')],
    ['getlex', handler(fn)], ['callpropvoid', abc.name('addEventListener'), 2]];
  timelineClass(abc, {
    pkg: 'demo', name: 'Main', slots: [['go', 'flash.display', 'SimpleButton'], ['ext', 'flash.display', 'SimpleButton']],
    methods: Object.assign({
      onGo: [['findpropstrict', nav], ['findpropstrict', req], ['pushstring', s('page.html')], ['constructprop', req, 1],
        ['pushstring', s('_self')], ['callpropvoid', nav, 2], ['returnvoid']],
      onExt: [['getlex', external], ['pushstring', s('selectMenu')], ['pushstring', s('mnu010')], ['callpropvoid', abc.name('call'), 2], ['returnvoid']],
      frame1: [...listen('go', 'onGo'), ...listen('ext', 'onExt'), ['returnvoid']],
      frame2: [['findpropstrict', abc.name('stop', 'demo')], ['callpropvoid', abc.name('stop', 'demo'), 0], ['returnvoid']]
    }, extra.methods || {}),
    frames: extra.frames || { 0: 'frame1', 1: 'frame2' }
  });
  return abc.bytes();
}
const menuMovie = (abcBytes = menuAbc()) => as3Movie(abcBytes, [
  rectShape(1, 400), button(10, 1), place(1, 10, GO[0], GO[1], 'go'), place(2, 10, EXT[0], EXT[1], 'ext'), show(), show(), show()
], 3);

function headlessPlayer(options) {
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => ({ addColorStop() {} })), set: (t, k, v) => { t[k] = v; return true; } });
  return new RetroFlash.Player(Object.assign({ canvas: { getContext: () => ctx, style: {}, width: 0, height: 0 }, input: false, audio: false }, options));
}
// A host that records what the movie asks of the page, without a browser.
function recordingHost() {
  const log = [];
  return {
    log,
    navigate: (r) => { log.push(['navigate', r.url, r.target]); },
    call: (r) => { log.push(['call', r.kind, r.name, r.args]); return 'from page'; }
  };
}
async function start(bytes, options = {}) {
  const host = options.host === undefined ? recordingHost() : options.host, reported = [];
  const player = headlessPlayer(Object.assign({ host }, options.player));
  player.on('warning', (w) => reported.push(w));
  await player.load(bytes, { url: 'http://example.test/movie/test.swf' });
  const sources = (feature) => (player.unsupportedByFeature[feature] || { sources: [] }).sources;
  return { player, host, reported, sources, rootObject: () => player.root.object.as3 };
}
function click(player, [x, y]) {
  player.input.move(x, y); player.afterInput();
  player.input.down(); player.afterInput();
  player.input.up(); player.afterInput();
}
const slotValue = (obj, name) => obj.slots[obj.klass.traits.get('::' + name).index];

// ---- Reader and ABC parser ----

test('reader: DoABC header, SymbolClass and DefineSceneAndFrameLabelData are decoded; the AS3 flag is kept', async () => {
  const bytes = B.swf({ version: 9, frameCount: 1, tags: [
    fileAttributes(), doABC(Uint8Array.from([16, 0, 46, 0]), { name: 'frame1', lazy: true }),
    symbolClass([[0, 'demo.Main'], [7, 'demo.Spin']]), sceneData([[0, 'Scene 1'], [2, 'Scene 2']], [[0, 'intro'], [3, 'menu']]), show(), end()
  ] });
  const swf = await SWFReader.load(bytes);
  const tag = (code) => swf.tags.find((t) => t.code === code);
  assert.deepStrictEqual(tag(82).fields, { flags: 1, lazyInitialize: true, name: 'frame1', abcStart: 11 });
  assert.strictEqual(tag(82).status, 'not-executed');
  assert.deepStrictEqual(Array.from(swf.getTagData(tag(82)).subarray(11)), [16, 0, 46, 0]);
  assert.deepStrictEqual(tag(76).fields.symbols, [{ characterId: 0, name: 'demo.Main' }, { characterId: 7, name: 'demo.Spin' }]);
  assert.deepStrictEqual(tag(86).fields, { scenes: [{ offset: 0, name: 'Scene 1' }, { offset: 2, name: 'Scene 2' }], labels: [{ frame: 0, name: 'intro' }, { frame: 3, name: 'menu' }] });
  const movie = new I.Movie(swf);
  assert.strictEqual(movie.actionScript3, true);
  assert.deepStrictEqual(Object.assign({}, movie.symbolClasses), { 0: 'demo.Main', 7: 'demo.Spin' });
  assert.deepStrictEqual(movie.scenes.map((s) => s.name), ['Scene 1', 'Scene 2']);
  assert.strictEqual(movie.root.labels.intro, 1, 'scene frame labels join the root labels (1-based)');
  assert.strictEqual(movie.abcBlocks.length, 1);
});

test('ABC parser: names, classes, traits and decoded instructions of a hand-built block', () => {
  const abc = I.parseAbc(menuAbc());
  assert.strictEqual(abc.major, 46);
  assert.strictEqual(abc.instances.length, 1);
  const main = abc.instances[0];
  assert.strictEqual(I.abcMultinameText(main.name), 'demo::Main');
  assert.strictEqual(I.abcMultinameText(main.superName), 'flash.display::MovieClip');
  assert.deepStrictEqual(main.traits.map((t) => t.name.name), ['go', 'ext', 'onGo', 'onExt', 'frame1', 'frame2']);
  assert.deepStrictEqual(main.init.body.instructions.map((i) => i.name),
    ['getlocal_0', 'pushscope', 'getlocal_0', 'constructsuper', 'findpropstrict', 'pushbyte', 'getlex', 'pushbyte', 'getlex', 'callpropvoid', 'returnvoid']);
  const nav = main.traits[2].method.body.instructions[2];
  assert.strictEqual(nav.name, 'findpropstrict');
  assert.strictEqual(I.abcMultinameText(nav.args[0]), 'flash.net::navigateToURL');
  assert.strictEqual(abc.scripts.length, 1);
});

test('ABC parser: malformed blocks are refused before anything runs', () => {
  const rejects = (bytes, pattern, options) => assert.throws(() => I.parseAbc(bytes, options), (err) => err.code === 'AVM2_ABC_INVALID' && pattern.test(err.message), String(pattern));
  const good = menuAbc();
  rejects(good.subarray(0, good.length - 3), /truncated|after the last/);
  const badVersion = Uint8Array.from(good); badVersion[2] = 47;
  rejects(badVersion, /version 47/);
  rejects(Uint8Array.from([16, 0, 46, 0, 0xff, 0xff, 0xff, 0xff, 0x03]), /exceeds the bytes left/, undefined);
  rejects(good, /limit/, { maxAbcBytes: 16 });
  // One method whose body is `code` (raw bytes), with one local.
  const withCode = (code) => { const abc = new AbcBuilder(); abc.script(abc.method(code, { localCount: 1 }), []); return abc.bytes(); };
  rejects(withCode([0x60, 0xf4, 0x03, 0x47]), /outside its pool/);           // getlex multiname 500
  rejects(withCode([0x10, 0x01, 0x00, 0x00, 0x2c, 0x00, 0x47]), /jumps to 5/); // jump into an operand
  rejects(withCode([0x62, 0x05, 0x47]), /register 5/);                       // getlocal 5 of 1
  rejects(withCode([0xff]), /unknown opcode 0xff/);
  rejects(withCode([0x10, 0xff, 0xff]), /truncated/);
  assert.ok(I.parseAbc(withCode([0xd0, 0x30, 0x47])), 'a well-formed body parses');
});

// ---- Running movies ----

test('document class: built on the root, stage instances in its slots, frame scripts at their frames, stop()', async () => {
  const { player, rootObject, reported } = await start(menuMovie());
  const main = rootObject();
  assert.strictEqual(main.klass.name, 'demo::Main');
  assert.strictEqual(main.constructed, true);
  assert.deepStrictEqual(Object.keys(main.frameScripts), ['0', '1']);
  const go = [...player.root.displayList.values()].find((o) => o.name === 'go');
  assert.strictEqual(slotValue(main, 'go'), go.as3, 'the named button is in the declared slot');
  assert.strictEqual(go.as3.klass.name, 'flash.display::SimpleButton');
  assert.ok(go.as3.listeners.get('click').length, 'frame 1 registered its listener');
  assert.strictEqual(player.root.frame, 1);
  player.step();
  assert.strictEqual(player.root.frame, 2);
  assert.strictEqual(player.root.playing, false, 'frame 2 ran stop()');
  player.step();
  assert.strictEqual(player.root.frame, 2);
  assert.deepStrictEqual(reported.filter((w) => /^avm2:/.test(w.feature)), []);
  assert.ok(!player.getDiagnostics().unsupported.some((u) => /^avm2:/.test(u.feature)));
});

test('button clicks: CLICK listeners navigate and call the page through the host; listeners can cancel', async () => {
  const { player, host } = await start(menuMovie());
  click(player, GO);
  assert.deepStrictEqual(host.log, [['navigate', 'page.html', '_self']]);
  click(player, EXT);
  assert.deepStrictEqual(host.log[1], ['call', 'external', 'selectMenu', ['mnu010']]);
  assert.ok(player.getInteractionLog().some((e) => e.channel === 'navigate' && e.url === 'page.html' && e.status === 'accepted'));
  player.on('navigate', (request) => request.preventDefault());
  click(player, GO);
  assert.strictEqual(host.log.length, 2, 'a prevented navigation never reaches the host');
  click(player, [9000, 7000]);
  assert.strictEqual(host.log.length, 2, 'a click outside every button sends nothing');
});

test('ExternalInterface without a host: an uncaught Error #2067, reported; actions: false runs no ActionScript 3', async () => {
  const bare = await start(menuMovie(), { host: null });
  click(bare.player, EXT);
  assert.match(bare.sources('avm2:uncaughtError')[0], /^test\.swf: demo::Main\/onExt at offset \d+: Error: Error #2067/);
  click(bare.player, GO);
  assert.ok(bare.sources('browser:noHost').length, 'navigation without a host is reported by the bridge');
  const off = await start(menuMovie(), { player: { actions: false } });
  assert.strictEqual(off.player.env.avm2, null);
  off.player.step();
  assert.strictEqual(off.player.root.frame, 2);
  off.player.step();
  assert.strictEqual(off.player.root.frame, 3, 'no frame script stopped the timeline');
  click(off.player, GO);
  assert.deepStrictEqual(off.host.log, []);
});

test('linked sprite class: its constructor adds a frame script that loops with gotoAndPlay(label)', async () => {
  const abc = new AbcBuilder();
  timelineClass(abc, { pkg: 'demo', name: 'Main', slots: [['spin', 'flash.display', 'MovieClip']] });
  timelineClass(abc, {
    pkg: 'demo', name: 'Spin', frames: { 2: 'frame3' },
    methods: { frame3: [['findpropstrict', abc.name('gotoAndPlay')], ['pushstring', abc.string('again')], ['callpropvoid', abc.name('gotoAndPlay'), 1], ['returnvoid']] }
  });
  const bytes = B.swf({ version: 9, frameCount: 1, tags: [
    fileAttributes(), doABC(abc.bytes()), symbolClass([[0, 'demo.Main'], [30, 'demo.Spin']]), rectShape(1, 200),
    sprite(30, 3, place(1, 1, 0, 0), frameLabel('again'), show(), show(), show()),
    place(1, 30, 1000, 1000, 'spin'), show(), end()
  ] });
  const { player, rootObject, reported } = await start(bytes);
  const spin = player.root.displayList.get(1);
  assert.strictEqual(spin.as3.klass.name, 'demo::Spin');
  assert.strictEqual(spin.as3.constructed, true);
  assert.strictEqual(slotValue(rootObject(), 'spin'), spin.as3);
  const frames = [];
  for (let i = 0; i < 5; i++) { player.step(); frames.push(spin.clip.frame); }
  assert.deepStrictEqual(frames, [2, 1, 2, 1, 2], 'frame 3 jumps back to "again" (frame 1) before it is drawn');
  assert.deepStrictEqual(reported.filter((w) => /^avm2:/.test(w.feature)), []);
});

test('failures are reported with the method and offset; the movie keeps playing', async () => {
  const unsupported = await start(menuMovie(menuAbc({ methods: { frame1: [['newarray', 0], ['pop'], ['returnvoid']] } })));
  assert.deepStrictEqual(unsupported.sources('avm2:unsupportedOpcode'), ['test.swf: demo::Main/frame1 at offset 2: Instruction newarray (0x56)']);
  unsupported.player.step();
  assert.strictEqual(unsupported.player.root.playing, false, 'frame 2 ran after frame 1 failed');
  const thrown = await start(menuMovie((() => {
    const abc = new AbcBuilder();
    timelineClass(abc, { pkg: 'demo', name: 'Main', frames: { 0: 'frame1' }, methods: { frame1: [['getlex', abc.name('noSuchThing')], ['returnvoid']] } });
    return abc.bytes();
  })()));
  assert.match(thrown.sources('avm2:uncaughtError')[0], /demo::Main\/frame1 at offset 2: ReferenceError: Error #1065: Variable noSuchThing is not defined/);
  thrown.player.step();
  assert.strictEqual(thrown.player.root.frame, 2, 'the timeline goes on');
  const malformed = await start(menuMovie(Uint8Array.from([16, 0, 46, 0, 5])));
  assert.match(malformed.sources('avm2:invalidAbc')[0], /^test\.swf: DoABC 1: ABC: int count \(5\) exceeds the bytes left/);
  assert.strictEqual(malformed.rootObject().klass.name, 'flash.display::MovieClip', 'the root is a plain MovieClip');
  assert.ok(malformed.sources('avm2:missingClass').includes('demo.Main'));
  malformed.player.step();
  assert.strictEqual(malformed.player.root.frame, 2);
});

test('budget: an endless frame script is stopped by maxActionSteps; the next frame gets a new budget', async () => {
  const abc = new AbcBuilder();
  timelineClass(abc, { pkg: 'demo', name: 'Main', frames: { 0: 'frame1', 1: 'frame2' }, methods: {
    frame1: [{ label: 'top' }, ['jump', 'top']],
    frame2: [['findpropstrict', abc.name('stop')], ['callpropvoid', abc.name('stop'), 0], ['returnvoid']]
  } });
  const { player, sources } = await start(menuMovie(abc.bytes()), { player: { maxActionSteps: 1000 } });
  assert.match(player.unsupportedByFeature['avm2:budget'].reason, /More than 1000 actions/);
  assert.match(sources('avm2:budget')[0], /demo::Main\/frame1 at offset \d+/);
  player.step();
  assert.strictEqual(player.root.frame, 2);
  assert.strictEqual(player.root.playing, false, 'frame 2 still ran');
});

test('recursion is bounded by maxCallDepth', async () => {
  const abc = new AbcBuilder(), self = abc.qname('demo', 'again', NS.PACKAGE_INTERNAL);
  timelineClass(abc, { pkg: 'demo', name: 'Main', frames: { 0: 'frame1' }, methods: {
    frame1: [['findpropstrict', self], ['callpropvoid', self, 0], ['returnvoid']],
    again: [['findpropstrict', self], ['callpropvoid', self, 0], ['returnvoid']]
  } });
  const { player, sources } = await start(menuMovie(abc.bytes()), { player: { maxCallDepth: 20 } });
  assert.strictEqual(player.unsupportedByFeature['avm2:budget'].reason, 'More than 20 nested ActionScript 3 calls.');
  assert.match(sources('avm2:budget')[0], /^test\.swf: demo::Main\/again at offset 4$/);
  player.step();
  assert.strictEqual(player.root.frame, 2);
});
