'use strict';
// AVM1 game APIs: the mini game fixture (the acceptance test: a hero moved with the keys and a score), clip
// events (onClipEvent and AS2 handlers), Key and Mouse, timers, dragging, clips acting as buttons, attachMovie,
// createEmptyMovieClip, swapDepths, getBounds, hitTest, Color, Sound, Stage and DoInitAction. Movies are SWFs
// built in memory, driven tick by tick with an InputController, as the player does.
const fs = require('fs');
const path = require('path');
const { test, assert } = require('../support/harness');
const { SWFReader } = require('../support/load-reader');
const { FIXTURE_DIR } = require('../fixtures/build-fixtures');
const B = require('../support/swf-builder');
const { I, rec, str, push, assemble } = require('../support/avm1');

const GET = [0x1c], SET = [0x1d], POP = [0x17];
const u16 = (n) => [n & 0xff, n >> 8];
const show = () => B.tag(B.T.ShowFrame);
const end = () => B.tag(B.T.End);
const script = (...records) => B.doAction(records.flat(Infinity));
const set = (name, ...value) => [push(name), ...value, SET];
const method = (object, name, ...args) => [push(...args.slice().reverse(), args.length, object), GET, push(name), [0x52]];
const fn = (body) => { const code = assemble(body); return [...rec(0x9b, ...str(''), 0, 0, ...u16(code.length)), ...code]; };
const setMember = (object, name, ...value) => [push(object), GET, push(name), ...value, [0x4f]];
// SWF 6 clip event flags (UI32): the bit of each event, from the most significant bit of the first byte.
const EVENT = { keyUp: 0x80, keyDown: 0x40, mouseUp: 0x20, mouseDown: 0x10, mouseMove: 0x08, unload: 0x04, enterFrame: 0x02, load: 0x01,
  press: 0x400, release: 0x800, keyPress: 0x20000 };
const square = (id, half = 200) => B.defineShape(id, {
  version: 1, bounds: { xMin: -half, xMax: half, yMin: -half, yMax: half }, fills: [{ color: [255, 0, 0] }],
  records: [{ move: [-half, -half], fill1: 1 }, { to: [half, -half] }, { to: [half, half] }, { to: [-half, half] }, { to: [-half, -half] }]
});
const sprite = (id, ...inner) => B.tag(B.T.DefineSprite, Buffer.concat([B.body((w) => w.u16(id).u16(1)), ...inner, show(), end()]));
const placeShape = (depth, id) => B.tag(B.T.PlaceObject2, B.body((w) => { w.u8(0x02 | 0x04).u16(depth).u16(id); B.matrix(w, {}); }));
// PlaceObject2 with a name, a position (px) and clip actions [{ events: [names], keyCode, actions }].
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
      const key = a.events.includes('keyPress') ? [a.keyCode] : [];
      w.u32(flagsOf(a.events)).u32(code.length + key.length).raw([...key, ...code]);
    }
    w.u32(0);
  }));
}
const exportAssets = (...assets) => B.tag(56, B.body((w) => { w.u16(assets.length); assets.forEach(([id, name]) => w.u16(id).string(name)); }));
// Key.addListener(listener) or Mouse.addListener(listener), with the listener read from a variable.
const addListener = (object, listener) => [push(listener), GET, push(1, object), GET, push('addListener'), [0x52], POP];
const doInitAction = (spriteId, ...records) => B.tag(59, Uint8Array.from([...u16(spriteId), ...records.flat(Infinity), 0]));

async function load(bytes, version = 6) {
  const swf = await SWFReader.load(bytes);
  const m = new I.Movie(swf), reported = [];
  const env = I.createEnv(m, (feature) => reported.push(feature));
  const root = new I.Clip(env, m.root, 0, null);
  const input = new I.InputController(env, () => root);
  let now = 0;
  env.scripts.clock = () => now;
  root.gotoFrame(1);
  env.scripts.run();
  const update = (changed) => { if (changed) { env.scripts.beginUpdate(); env.scripts.run(); } return changed; };
  return {
    swf, root, env, input, reported, version,
    tick: (n = 1) => { for (let i = 0; i < n; i++) { env.scripts.beginUpdate(); root.tick(); env.scripts.run(); } },
    event: (changed) => update(changed),
    timers: (t) => { now = t; return update(env.scripts.runTimers()); },
    v: (name, clip = root) => clip.variables.get(version < 7 ? name.toLowerCase() : name),
    child: (name) => root.childByName(name)
  };
}
const movie = (tags, { version = 6, frameCount = 1 } = {}) => load(B.swf({ version, frameCount, tags: [...tags, end()] }), version);
const px = (clip) => [clip.displayObject().matrix[4] / 20, clip.displayObject().matrix[5] / 20];

// ---- The acceptance test ------------------------------------------------------------------------------------

test('mini game: the arrow keys move the hero, touching the coin raises the score, and the field shows it', async () => {
  async function play() {
    const g = await load(new Uint8Array(fs.readFileSync(path.join(FIXTURE_DIR, 'valid/fws-game.swf'))));
    const hero = g.child('hero'), coin = g.child('coin'), field = g.root.displayList.get(3), trail = [];
    g.tick(3);
    assert.deepStrictEqual(px(hero), [20, 100], 'no key, no move');
    g.event(g.input.keyDown(39, 0)); // Key.RIGHT
    for (let i = 0; i < 14; i++) { g.tick(); trail.push([px(hero)[0], g.v('score'), px(coin)[0]]); }
    g.event(g.input.keyUp(39));
    g.tick(2);
    const stopped = px(hero)[0];
    g.event(g.input.keyDown(37, 0)); // Key.LEFT
    g.tick(2);
    return { g, trail, stopped, back: px(hero)[0], text: I.textFieldText(field) };
  }
  const first = await play();
  assert.deepStrictEqual(first.trail.slice(0, 7).map((t) => t[1]), [0, 0, 0, 0, 0, 0, 1], 'the 7th step reaches the coin');
  assert.deepStrictEqual(first.trail[6], [90, 1, 160], 'the coin jumped 60 px');
  assert.deepStrictEqual(first.trail[13], [160, 2, 220], 'and was reached again');
  assert.strictEqual(first.stopped, 160, 'releasing the key stops the hero');
  assert.strictEqual(first.back, 140, 'Key.LEFT moves it back');
  assert.strictEqual(first.text, '2', 'the bound text field shows the score');
  assert.deepStrictEqual(first.g.reported, [], 'nothing unsupported');
  const second = await play();
  assert.deepStrictEqual(second.trail, first.trail, 'the same game every run');
});

// ---- Clip events ---------------------------------------------------------------------------------------------

test('clip events: onClipEvent(load/enterFrame/unload) and AS2 handlers, in Flash Player order', async () => {
  const log = (tag) => [push('_root.log', '_root.log'), GET, push(tag), [0x47], SET];
  const g = await movie([
    square(1), sprite(2, placeShape(1, 1), script(log('f'))),
    place(1, 2, 'a', 0, 0, [{ events: ['load'], actions: log('L') }, { events: ['enterFrame'], actions: log('E') }, { events: ['unload'], actions: log('U') }]),
    script(setMember('a', 'onEnterFrame', fn(log('M')))),
    show(), show(), B.tag(B.T.RemoveObject2, B.body((w) => w.u16(1))), show()
  ], { frameCount: 3 });
  g.root.loop = false;
  assert.strictEqual(g.v('log'), 'fL', 'the clip\'s own frame-1 script, then load, before the parent\'s frame script');
  g.tick();
  assert.strictEqual(g.v('log'), 'fLEM', 'enterFrame: clip actions, then the onEnterFrame method');
  g.tick();
  assert.strictEqual(g.v('log'), 'fLEMEMU', 'removed by the timeline: unload');
  g.tick();
  assert.strictEqual(g.v('log'), 'fLEMEMU', 'no more events');
});

test('mouse and key events reach every clip and the Mouse and Key listeners; keyPress matches its key', async () => {
  const count = (name) => [push(name, name), GET, [0x50], SET];
  const g = await movie([
    square(1), sprite(2, placeShape(1, 1)),
    place(1, 2, 'a', 50, 50, [
      { events: ['mouseDown'], actions: count('_root.downs') }, { events: ['keyDown'], actions: count('_root.keys') },
      { events: ['keyPress'], keyCode: 97, actions: count('_root.aPresses') }
    ]),
    script(
      set('downs', push(0)), set('keys', push(0)), set('apresses', push(0)), set('ups', push(0)), set('moves', push(0)), set('listened', push(0)),
      setMember('a', 'onMouseUp', fn(count('_root.ups'))),
      set('l', push(0), [0x43]), setMember('l', 'onMouseMove', fn(count('_root.moves'))), addListener('Mouse', 'l'),
      set('k', push(0), [0x43]), setMember('k', 'onKeyDown', fn([push('_root.listened'), push(0, 'Key'), GET, push('getCode'), [0x52], SET])),
      addListener('Key', 'k')
    ), show()
  ]);
  g.event(g.input.move(100, 100));
  g.event(g.input.down());
  g.event(g.input.up());
  g.event(g.input.keyDown(65, 97));
  g.event(g.input.key(97)); // SWF key code of "a" is its ASCII code
  g.event(g.input.key(66));
  assert.deepStrictEqual([g.v('downs'), g.v('ups'), g.v('keys'), g.v('apresses')], [1, 1, 1, 1], 'only the matching keyPress ran');
  assert.deepStrictEqual([g.v('moves'), g.v('listened')], [1, 65], 'the Mouse and Key listeners');
});

// ---- Key, Mouse, timers, Stage, Color, Sound ------------------------------------------------------------------

test('Key state, Mouse.hide, getTimer, setInterval, setTimeout and clearInterval', async () => {
  const g = await movie([script(
    set('ticks', push(0)), set('once', push(0)),
    set('id', push(100), fn([push('_root.ticks', '_root.ticks'), GET, [0x50], SET]), push(2, 'setInterval'), [0x3d]),
    push(50), fn([push('_root.once', 1), SET]), push(2, 'setTimeout'), [0x3d], POP
  ), show()]);
  g.event(g.input.keyDown(37, 0));
  const check = (records) => { const a = new I.Activation(g.env.scripts, g.root, new I.ActionCode(Uint8Array.from(records.flat(Infinity)), 6), 't'); a.run(); return Array.from(a.stack); };
  assert.deepStrictEqual(check([push(37, 1, 'Key'), GET, push('isDown'), [0x52], push(0, 'Key'), GET, push('getCode'), [0x52]]), [true, 37]);
  g.event(g.input.keyUp(37));
  assert.deepStrictEqual(check([push(37, 1, 'Key'), GET, push('isDown'), [0x52]]), [false]);
  check([push(0, 'Mouse'), GET, push('hide'), [0x52]]);
  assert.strictEqual(g.input.cursor(), 'none');
  g.timers(40);
  assert.deepStrictEqual([g.v('ticks'), g.v('once')], [0, 0]);
  g.timers(60);
  assert.deepStrictEqual([g.v('ticks'), g.v('once')], [0, 1]);
  g.timers(100); g.timers(150); g.timers(200);
  assert.strictEqual(g.v('ticks'), 2, 'every 100 ms');
  assert.deepStrictEqual(check([push(0, 'getTimer'), [0x3d], [0x34]]), [200, 200]);
  check([push(g.v('id'), 1, 'clearInterval'), [0x3d]]);
  g.timers(400);
  assert.strictEqual(g.v('ticks'), 2, 'cleared');
});

test('Stage, Color.setRGB/getRGB/setTransform, and Sound (silent, reported)', async () => {
  const g = await movie([square(1), sprite(2, placeShape(1, 1)), place(1, 2, 'a'), script(
    set('w', push('Stage'), GET, push('width'), [0x4e]),
    set('c', push('a'), GET, push(1, 'Color'), [0x40]), method('c', 'setRGB', 0x336699), POP, set('rgb', method('c', 'getRGB')),
    set('s', push(0, 'Sound'), [0x40]), method('s', 'start'), POP, set('vol', method('s', 'getVolume'))
  ), show()]);
  assert.deepStrictEqual([g.v('w'), g.v('rgb'), g.v('vol')], [550, 0x336699, 100]);
  assert.deepStrictEqual(g.child('a').displayObject().cx, [0, 0, 0, 1, 0x33, 0x66, 0x99, 0]);
  assert.ok(g.reported.includes('sound:Sound'));
});

// ---- Dragging, buttons made of clips, MovieClip methods --------------------------------------------------------

test('startDrag/stopDrag: lock centre, offset, constraint rectangle, and _droptarget', async () => {
  const g = await movie([square(1), sprite(2, placeShape(1, 1)), place(1, 2, 'a', 100, 100), place(2, 2, 'b', 300, 100), show()]);
  const run = (records) => new I.Activation(g.env.scripts, g.root, new I.ActionCode(Uint8Array.from(records.flat(Infinity)), 6), 't').run();
  g.input.move(110 * 20, 120 * 20);
  run([method('a', 'startDrag', false)]);
  g.event(g.input.move(150 * 20, 150 * 20));
  assert.deepStrictEqual(px(g.child('a')), [140, 130], 'keeps its offset from the pointer');
  run([method('a', 'stopDrag')]);
  g.event(g.input.move(200 * 20, 200 * 20));
  assert.deepStrictEqual(px(g.child('a')), [140, 130], 'stopped');
  // StartDrag action: lock centre, constrained to x 0..200, y 0..50.
  run([push(0, 0, 200, 50, 1, 1, 'a'), [0x27]]);
  g.event(g.input.move(300 * 20, 100 * 20));
  assert.deepStrictEqual(px(g.child('a')), [200, 50]);
  run([[0x28]]);
  g.input.move(300 * 20, 100 * 20);
  run([push(true, 1, 'a'), GET, push('startDrag'), [0x52]]);
  g.event(g.input.move(300 * 20, 100 * 20));
  run([[0x28]]);
  const target = new I.Activation(g.env.scripts, g.root, new I.ActionCode(Uint8Array.from([push('a', 14), [0x22]].flat(Infinity)), 6), 't');
  target.run();
  assert.deepStrictEqual(Array.from(target.stack), ['/b'], 'dropped over b');
});

test('clips with onPress/onRelease act as buttons: picked under the pointer, hand cursor, events', async () => {
  const count = (name) => [push(name, name), GET, [0x50], SET];
  const g = await movie([
    square(1), sprite(2, placeShape(1, 1)), place(1, 2, 'btn', 100, 100),
    script(set('presses', push(0)), set('releases', push(0)), setMember('btn', 'onPress', fn(count('_root.presses'))),
      setMember('btn', 'onRelease', fn(count('_root.releases')))), show()
  ]);
  g.event(g.input.move(100 * 20, 100 * 20));
  assert.strictEqual(g.input.hovered && g.input.hovered.clip, g.child('btn'));
  assert.strictEqual(g.input.cursor(), 'pointer');
  g.event(g.input.down());
  g.event(g.input.up());
  g.event(g.input.move(10, 10));
  assert.deepStrictEqual([g.v('presses'), g.v('releases'), g.input.hovered], [1, 1, null]);
});

test('attachMovie, createEmptyMovieClip, swapDepths, getNextHighestDepth, getInstanceAtDepth, getBounds, hitTest, localToGlobal', async () => {
  const g = await movie([
    square(1), sprite(2, placeShape(1, 1)), exportAssets([2, 'Ball']), place(1, 2, 'a', 100, 100),
    script(push('init', 'v', 5, 1), [0x43], SET), show()
  ]);
  const run = (records) => {
    const a = new I.Activation(g.env.scripts, g.root, new I.ActionCode(Uint8Array.from(records.flat(Infinity)), 6), 't');
    a.run();
    g.env.scripts.run();
    return Array.from(a.stack);
  };
  run([push('init'), GET, push(3, 'ball1', 'ball', 4, '_root'), GET, push('attachMovie'), [0x52], POP]);
  const ball = g.child('ball1');
  assert.ok(ball, 'attached by its linkage name');
  assert.strictEqual(g.v('v', ball), 5, 'the init object\'s properties were copied');
  assert.strictEqual(g.root.displayList.get(3 + I.SCRIPT_DEPTH).clip, ball);
  run([method('_root', 'createEmptyMovieClip', 'holder', 7), POP]);
  assert.ok(g.child('holder'));
  assert.deepStrictEqual(run([method('_root', 'getNextHighestDepth'), method('_root', 'getInstanceAtDepth', 7), [0x45]]), [8, '_level0.holder']);
  run([method('ball1', 'swapDepths', 7)]);
  assert.deepStrictEqual([ball.displayObject().depth, g.child('holder').displayObject().depth], [7 + I.SCRIPT_DEPTH, 3 + I.SCRIPT_DEPTH]);
  const bounds = run([method('a', 'getBounds', '_root'), push('xMin'), [0x4e], method('a', 'getBounds'), push('xMax'), [0x4e]]);
  assert.deepStrictEqual(bounds, [90, 10]);
  assert.deepStrictEqual(run([method('a', 'hitTest', 100, 100, true), method('a', 'hitTest', 120, 100, false), method('a', 'hitTest', '_root.ball1')]),
    [true, false, false], 'a point on its shape, a point outside its bounds, a clip far away');
  run([push('ball1._x', 105), SET, push('ball1._y', 95), SET]);
  assert.deepStrictEqual(run([method('a', 'hitTest', '_root.ball1')]), [true], 'overlapping bounds');
  // p = { x: 5, y: 0 }; a.localToGlobal(p): (100, 100) + (5, 0)
  assert.deepStrictEqual(run([push('p', 'x', 5, 'y', 0, 2), [0x43], SET, push('p'), GET, push(1, 'a'), GET, push('localToGlobal'), [0x52], POP,
    push('p'), GET, push('x'), [0x4e]]), [105]);
  run([method('ball1', 'removeMovieClip')]);
  assert.strictEqual(g.child('ball1'), null);
});

test('DoInitAction runs once, before the frame scripts, on the root timeline', async () => {
  const g = await movie([
    square(1), sprite(2, placeShape(1, 1)),
    doInitAction(2, push('order', 'init'), SET),
    script(push('order', 'order'), GET, push('+frame'), [0x47], SET),
    show(), show()
  ], { frameCount: 2 });
  assert.strictEqual(g.v('order'), 'init+frame');
  g.tick();
  g.root.gotoFrame(1);
  g.env.scripts.run();
  assert.strictEqual(g.v('order'), 'init+frame+frame', 'the init actions did not run again');
});
