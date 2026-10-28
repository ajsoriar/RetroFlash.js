'use strict';
// AVM1 timelines and movie clips: properties (GetProperty/SetProperty and through variables), movie clips as
// values, GotoFrame2, SetTarget2, TargetPath, duplicateMovieClip/removeMovieClip, instance names, and what the
// renderer and hit testing see. Blocks run in an Activation on the clips of a SWF built in memory.
const { test, assert } = require('../support/harness');
const { SWFReader } = require('../support/load-reader');
const B = require('../support/swf-builder');
const { I, rec, str, push, exec } = require('../support/avm1');

const show = () => B.tag(B.T.ShowFrame);
const end = () => B.tag(B.T.End);
const label = (name) => B.tag(B.T.FrameLabel, B.body((w) => w.string(name)));
// A 20 x 20 px square centred on its origin.
const square = B.defineShape(1, {
  version: 1, bounds: { xMin: -200, xMax: 200, yMin: -200, yMax: 200 }, fills: [{ color: [255, 0, 0] }],
  records: [{ move: [-200, -200], fill1: 1 }, { to: [200, -200] }, { to: [200, 200] }, { to: [-200, 200] }, { to: [-200, -200] }]
});
const place = (depth, id, { name, x = 0, y = 0, move = false } = {}) => B.tag(B.T.PlaceObject2, B.body((w) => {
  w.u8((move ? 0x01 : 0) | (id ? 0x02 : 0) | 0x04 | (name ? 0x20 : 0)).u16(depth);
  if (id) w.u16(id);
  B.matrix(w, { translateX: x, translateY: y });
  if (name) w.string(name);
}));
// Sprite 2: three frames holding the square; frame 1 sets born = 1 on its own timeline.
const kidSprite = B.tag(B.T.DefineSprite, Buffer.concat([
  B.body((w) => w.u16(2).u16(3)), place(1, 1), B.doAction(push('born', 1), [0x1d]), show(), show(), label('last'), show(), end()
]));

// Root: frame 1 places sprite 2 as "kid" at (50, 100) px and an unnamed copy; frame 2 moves kid; 4 frames, label "end" on 4.
async function movie({ version = 6, rootScripts = [] } = {}) {
  const tags = [square, kidSprite, place(1, 2, { name: 'kid', x: 1000, y: 2000 }), place(2, 2, { x: 4000 }), ...rootScripts, show(),
    place(1, 0, { move: true, x: 3000, y: 2000 }), show(), show(), label('end'), show(), end()];
  const swf = await SWFReader.load(B.swf({ version, frameCount: 4, tags }));
  const m = new I.Movie(swf), reported = [];
  const env = I.createEnv(m, (feature) => reported.push(feature));
  const root = new I.Clip(env, m.root, 0, null);
  root.gotoFrame(1);
  env.scripts.run();
  const run = (records) => {
    const out = exec(records, { version, clip: root });
    env.scripts.run(); // scripts queued by gotos and duplicates
    return out;
  };
  const tick = () => { env.scripts.beginUpdate(); root.tick(); env.scripts.run(); };
  return { root, env, run, tick, reported, kid: () => root.childByName('kid') };
}
const getProp = (target, index) => [push(target, index), [0x22]];
const setProp = (target, index, value) => [push(target, index, value), [0x23]];
const GET = [0x1c], SET = [0x1d];

test('properties: every GetProperty index on a sprite instance', async () => {
  const { run } = await movie();
  const values = run([...Array.from({ length: 22 }, (_, i) => getProp('kid', i)), getProp('kid', 22), getProp('kid', -1), getProp('missing', 0)]).stack;
  assert.deepStrictEqual(values, [
    50, 100, 100, 100, 1, 3, 100, true, 20, 20, 0, '/kid', 3, 'kid', '', '', 1, true, 5, 'HIGH', 0, 0, undefined, undefined, undefined
  ]);
  const swf5 = await movie({ version: 5 });
  assert.deepStrictEqual(swf5.run([getProp('kid', 14), getProp('kid', 17)]).stack, [undefined, 1], '_droptarget and _focusrect in SWF 5');
});

test('properties: SetProperty on position, scale, rotation, alpha, visibility, size and name', async () => {
  const { run, kid } = await movie();
  const obj = () => kid().displayObject();
  run([setProp('kid', 0, 10.06), setProp('kid', 1, -2.5)]);
  assert.deepStrictEqual([obj().matrix[4], obj().matrix[5]], [201, -50], 'pixels to twips truncate toward zero');
  assert.deepStrictEqual(run([getProp('kid', 0)]).stack, [10.05]);
  run([setProp('kid', 2, 50)]);
  assert.deepStrictEqual(run([getProp('kid', 2), getProp('kid', 8), getProp('kid', 9)]).stack, [50, 10, 20]);
  run([setProp('kid', 10, 90)]);
  assert.deepStrictEqual(run([getProp('kid', 2), getProp('kid', 10), getProp('kid', 8), getProp('kid', 9)]).stack.map((v) => Math.round(v * 1e6) / 1e6),
    [50, 90, 20, 10], 'rotating keeps the scale; the bounds turn');
  run([setProp('kid', 10, 270)]);
  assert.strictEqual(Math.round(run([getProp('kid', 10)]).stack[0]), -90, 'rotation is normalized to ±180');
  run([setProp('kid', 10, 0), setProp('kid', 8, 40), setProp('kid', 9, 5)]);
  assert.deepStrictEqual(run([getProp('kid', 2), getProp('kid', 3)]).stack.map(Math.round), [200, 25], '_width and _height scale the clip');
  run([setProp('kid', 6, 50), setProp('kid', 7, 0)]);
  assert.deepStrictEqual([obj().cx[3], obj().visible], [0.5, false]);
  run([setProp('kid', 7, 'abc'), setProp('kid', 0, undefined), setProp('kid', 6, Infinity)]);
  assert.deepStrictEqual([obj().visible, obj().matrix[4], obj().cx[3]], [false, 201, 0], 'NaN and undefined set nothing; Infinity alpha is 0');
  run([setProp('kid', 4, 3), setProp('kid', 13, 'renamed')]);
  assert.strictEqual(kid(), null, '_name renames the instance');
  const out = run([getProp('renamed', 4), getProp('renamed', 13), getProp('renamed', 11)]);
  assert.deepStrictEqual(out.stack, [1, 'renamed', '/renamed'], '_currentframe is read-only');
});

test('properties through variables; a transformed clip is no longer moved by the timeline', async () => {
  const { run, kid, root, tick } = await movie();
  run([push('kid._x', 30), SET, push('kid:_ALPHA', 25), SET, push('w', 'kid._width'), GET, SET, push('f', '_currentframe'), GET, SET]);
  assert.deepStrictEqual([kid().displayObject().matrix[4], kid().displayObject().cx[3]], [600, 0.25]);
  assert.deepStrictEqual([root.variables.get('w'), root.variables.get('f')], [20, 1]);
  const unnamed = root.displayList.get(2).clip;
  tick(); // frame 2 moves depth 1 to x = 150 px
  assert.strictEqual(kid().displayObject().matrix[4], 600, 'kid keeps the script position');
  assert.strictEqual(unnamed.displayObject().matrix[4], 4000);
});

test('movie clips as values: paths, TargetPath, conversions, comparisons, and paths through variables', async () => {
  const { run, kid, root } = await movie();
  const out = run([
    push('kid'), GET, [0x45],                  // TargetPath(kid)
    push('kid'), GET, [0x44],                  // typeof kid
    push('kid'), GET, [0x4b],                  // String(kid)
    push('kid'), GET, push('!'), [0x47],       // kid + "!"
    push('kid'), GET, push('_root.kid'), GET, [0x49], // kid == _root.kid
    push('kid'), GET, push('/'), GET, [0x66],  // kid === _root
    push('x'), [0x45],                         // TargetPath of a string
    push('ref', 'kid'), GET, SET, push('ref.v', 7), SET, push('ref:_name'), GET
  ]);
  assert.deepStrictEqual(out.stack, ['_level0.kid', 'movieclip', '_level0.kid', '_level0.kid!', true, false, undefined, 'kid']);
  assert.strictEqual(kid().variables.get('v'), 7, 'a path step can be a variable holding a clip');
  assert.strictEqual(root.variables.get('ref'), kid());
  assert.deepStrictEqual(run([push('instance1'), GET, [0x45], getProp('/instance1', 11)]).stack, ['_level0.instance1', '/instance1'], 'unnamed instances are named instanceN');
});

test('GotoFrame and GotoLabel stop; GotoFrame2 takes numbers, labels and paths, adds the scene bias, and plays or stops', async () => {
  const { run, root, kid, reported } = await movie();
  const goto2 = (play, bias = 0) => bias ? rec(0x9f, (play ? 1 : 0) | 2, bias & 0xff, bias >> 8) : rec(0x9f, play ? 1 : 0);
  run([rec(0x81, 2, 0)]);
  assert.deepStrictEqual([root.frame, root.playing], [3, false], 'GotoFrame is gotoAndStop');
  root.playing = true;
  run([rec(0x8c, ...str('end'))]);
  assert.deepStrictEqual([root.frame, root.playing], [4, false], 'so is GotoLabel');
  run([push(2), goto2(true)]);
  assert.deepStrictEqual([root.frame, root.playing], [2, true]);
  run([push('end'), goto2(false)]);
  assert.deepStrictEqual([root.frame, root.playing], [4, false]);
  run([push('kid:last'), goto2(false), push('kid.2'), goto2(true)]);
  assert.deepStrictEqual([kid().frame, kid().playing, root.frame], [2, true, 4], 'a path sends another timeline');
  run([push('1.9'), goto2(false)]);
  assert.strictEqual(root.frame, 4, 'a dot in a string separates a path (no clip "1" here) from the frame');
  run([push('2'), goto2(false)]);
  assert.strictEqual(root.frame, 2, 'a numeric string');
  run([push(1), goto2(false, 2)]);
  assert.strictEqual(root.frame, 3, 'scene bias');
  run([push(0), goto2(true), push(-3), goto2(true), push('nolabel'), goto2(true), push(99), goto2(false)]);
  assert.deepStrictEqual([root.frame, root.playing], [4, false], 'frames below 1 and missing labels do nothing; past the end is the last frame');
  const unknown = run([push('Date'), GET, goto2(true), push('after')]);
  assert.deepStrictEqual(unknown.stack, []);
  assert.ok(reported.length === 0 && unknown.reported.includes('avm1:unknownValue'));
});

test('SetTarget2: a path, a clip value, and undefined by SWF version', async () => {
  const { run, kid, root } = await movie();
  run([push('kid'), [0x20], [0x07], push('t', 1), SET]);
  assert.deepStrictEqual([kid().playing, kid().variables.get('t')], [false, 1]);
  kid().playing = true;
  run([push('kid'), GET, [0x20], [0x07]]);
  assert.strictEqual(kid().playing, false, 'a clip value');
  run([push('kid'), [0x20], push(undefined), [0x20], [0x07]]);
  assert.strictEqual(root.playing, false, 'undefined returns to the base clip up to SWF 6');
  const swf7 = await movie({ version: 7 });
  const out = swf7.run([push(undefined), [0x20], [0x07], push('n', 1), SET]);
  assert.strictEqual(swf7.root.playing, true, 'from SWF 7 there is no target: Stop does nothing');
  assert.strictEqual(swf7.root.variables.get('n'), 1, 'and variables go to the root');
  assert.deepStrictEqual(out.reported, []);
});

test('duplicateMovieClip and removeMovieClip: script depths, frame-1 scripts, rewinds, and what cannot be removed', async () => {
  const { run, kid, root } = await movie();
  run([setProp('kid', 0, 70), push('kid', 'copy', 5), [0x24]]);
  const copy = root.childByName('copy'), copyObj = copy.displayObject();
  assert.strictEqual(root.displayList.get(5 + I.SCRIPT_DEPTH), copyObj, 'depth + 16384');
  assert.deepStrictEqual([copyObj.matrix[4], copy.frame, copy.variables.get('born')], [1400, 1, 1], 'matrix copied; its frame-1 script ran');
  run([push('kid', 'other', -1), [0x24], push('/', 'rootCopy', 1), [0x24]]);
  assert.strictEqual(root.childByName('other'), null, 'negative depths are refused');
  assert.strictEqual(root.childByName('rootCopy'), null, 'the root cannot be duplicated');
  root.gotoFrame(3);
  root.gotoFrame(1);
  assert.strictEqual(root.childByName('copy'), copy, 'a timeline rewind keeps clips made by scripts');
  run([push('copy'), [0x20], push('/copy'), [0x25], [0x07], push('kid'), [0x25]]); // paths start at the target
  assert.strictEqual(root.childByName('copy'), null, 'removed');
  assert.strictEqual(copy.removed, true);
  assert.strictEqual(root.playing, false, 'removing the current target returns to the base clip');
  assert.ok(kid(), 'timeline instances cannot be removed');
});

test('what scripts change is drawn and hit-tested: _visible, and the root transform', async () => {
  const { run, root, env } = await movie();
  const rootObj = { character: { type: 'sprite' }, clip: root };
  assert.strictEqual(I.hitTestObject(rootObj, I.IDENTITY, 1000, 2000), true, 'kid is under (50, 100) px');
  run([setProp('kid', 7, 0)]);
  assert.strictEqual(I.hitTestObject(rootObj, I.IDENTITY, 1000, 2000), false, 'an invisible clip is not hit');
  run([setProp('/', 0, 10)]);
  assert.strictEqual(root.displayObject().matrix[4], 200, '_root._x moves the whole movie');
  env.input = { x: 2000, y: 0 };
  assert.deepStrictEqual(run([getProp('instance1', 20), getProp('/', 20), getProp('/', 21)]).stack, [-110, 90, 0], '_xmouse/_ymouse in each clip\'s space (the root moved 10 px)');
});
