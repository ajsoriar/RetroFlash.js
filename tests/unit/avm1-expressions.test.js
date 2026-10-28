'use strict';
// AVM1 expressions and variables: the operators on primitive values, GetVariable/SetVariable/DefineLocal on
// timelines (paths, case, SetTarget scope) and text fields bound to a variable. Operator tests run one action
// block in an Activation; variable tests run frame scripts of SWFs built in memory.
const { test, assert } = require('../support/harness');
const { SWFReader } = require('../support/load-reader');
const B = require('../support/swf-builder');
const { I, rec, str, push, exec } = require('../support/avm1');

const U = I.UNKNOWN_VALUE;
const GET = [0x1c], SET = [0x1d];
const set = (name, v) => [push(name, v), SET];
const copy = (to, from) => [push(to, from), GET, SET]; // to = from

// Runs `code` (operator action codes or records) on `operands` and returns the single result.
function result(operands, code, version) {
  const out = exec([push(...operands), typeof code === 'number' ? [code] : code], { version });
  assert.strictEqual(out.stack.length, 1, 'one result');
  return out.stack[0];
}
const same = (a, b) => (a !== a && b !== b) || a === b;
function check(cases, version) {
  for (const [operands, code, expected] of cases) {
    const actual = result(operands, code, version);
    assert.ok(same(actual, expected), `0x${code.toString(16)} ${JSON.stringify(operands)} in SWF ${version}: ${String(actual)}, expected ${String(expected)}`);
  }
}

test('operators: SWF 4 arithmetic, comparisons, logic and strings', () => {
  check([
    [['3', '4'], 0x0a, 7], [['a', 1], 0x0a, 1], [[10, 4], 0x0b, 6], [[3, 4], 0x0c, 12], [[7, 2], 0x0d, 3.5],
    [[1, 0], 0x0d, '#ERROR#'], [['5', 5], 0x0e, true], [['a', 'b'], 0x0e, true], [[1, 2], 0x0f, true],
    [[1, 0], 0x10, false], [[1, 'x'], 0x11, true], [[0], 0x12, true],
    [['ab', 'ab'], 0x13, true], [['hello'], 0x14, 5], [['hello', 2, 3], 0x15, 'ell'], [['hello', 0, -1], 0x15, 'hello'],
    [['hello', 4, 10], 0x15, 'lo'], [['hello', 9, 2], 0x15, ''], [['ab', 'cd'], 0x21, 'abcd'], [[true, 'x'], 0x21, '1x'],
    [['a', 'b'], 0x29, true], [[-3.7], 0x18, -3], [['4294967297'], 0x18, 1], [['A'], 0x32, 65], [[''], 0x32, 0],
    [[66], 0x33, 'B'], [[0], 0x33, ''], [['xyz', 2, 1], 0x35, 'y'], [['A'], 0x36, 65], [[0x263a], 0x37, '☺']
  ], 4);
  // SWF 5: division by zero gives Infinity; Equals compares numbers, so two strings that are not numbers differ.
  check([[[1, 0], 0x0d, Infinity], [[-1, 0], 0x0d, -Infinity], [['a', 'b'], 0x0e, false]], 5);
});

test('operators: SWF 5 and later', () => {
  check([
    [['1', 2], 0x47, '12'], [[1, 2], 0x47, 3], [[true, 1], 0x47, 2], [[undefined, 'x'], 0x47, 'x'],
    [[1, NaN], 0x48, undefined], [['a', 'b'], 0x48, true], [[2, 1], 0x67, true], [['b', 'a'], 0x68, true],
    [['1', 1], 0x49, true], [[null, undefined], 0x49, true], [['1', 1], 0x66, false], [[NaN, NaN], 0x66, true],
    [[-7, 3], 0x3f, -1], [[1.5], 0x50, 2.5], [['3'], 0x51, 2], [[null], 0x44, 'null'], [['5'], 0x44, 'string'],
    [['0x10'], 0x4a, 16], [[0.1], 0x4b, '0.1'], [[true], 0x4b, 'true'],
    [[5, 3], 0x60, 1], [[5, 3], 0x61, 7], [[5, 3], 0x62, 6], [[1, 33], 0x63, 2], [[-8, 1], 0x64, -4],
    [[-1, 28], 0x65, 15], [[-8, 0], 0x65, 4294967288], [['3.9'], 0x18, 3]
  ], 6);
  check([[[undefined, 'x'], 0x47, 'undefinedx'], [[undefined, 1], 0x47, NaN]], 7);
  check([[[-8, 0], 0x65, -8]], 8); // unsigned shift results are signed in SWF 8 and 9
  check([[[-8, 0], 0x65, 4294967288]], 10);
});

test('operators: RandomNumber, unknown operands, and Trace', () => {
  assert.deepStrictEqual(exec([push(10), [0x30], push(0), [0x30], push(-5), [0x30]], { random: () => 0.75 }).stack, [7, 0, 0]);
  // Date is not implemented yet, so it reads as an unknown value: what is computed from it is unknown too.
  const unknown = exec([push('Date'), GET, push(1), [0x0a], [0x12], push('x'), [0x47]]);
  assert.deepStrictEqual(unknown.stack, [U]);
  assert.deepStrictEqual(exec([push('hidden'), [0x26], push(1)]).stack, [1], 'Trace pops its value and prints nothing');
});

// ---- Variables on timelines -----------------------------------------------------------------------------

const show = () => B.tag(B.T.ShowFrame);
const end = () => B.tag(B.T.End);
const placeNamed = (depth, id, name) => B.tag(B.T.PlaceObject2, B.body((w) => {
  w.u8(0x02 | 0x04 | (name ? 0x20 : 0)).u16(depth).u16(id);
  B.matrix(w, {});
  if (name) w.string(name);
}));
const sprite = (id, ...tags) => B.tag(B.T.DefineSprite, Buffer.concat([B.body((w) => w.u16(id).u16(1)), ...tags, show(), end()]));
const script = (...records) => B.doAction(...records.flat(1));
const setTarget = (path) => rec(0x8b, ...str(path));

async function movie(tags, { version = 6, frameCount = 1 } = {}) {
  const swf = await SWFReader.load(B.swf({ version, frameCount, tags: [...tags, end()] }));
  const m = new I.Movie(swf), reported = [];
  const env = I.createEnv(m, (feature, reason, source) => reported.push([feature, source]));
  const root = new I.Clip(env, m.root, 0, null);
  root.gotoFrame(1);
  env.scripts.run();
  const tick = () => { env.scripts.beginUpdate(); root.tick(); env.scripts.run(); };
  const vars = (clip) => Object.fromEntries(clip.variables);
  return { root, env, reported, tick, vars, kid: () => root.displayList.get(1).clip, features: () => reported.map((r) => r[0]) };
}

test('variables: plain names, slash, dot and colon paths, from the root and from a child', async () => {
  const kidScript = script(set('../:fromKid', 'k'), set('own', 1), set('_parent.viaParent', 2), set('/:viaSlash', 3));
  const { root, kid, vars, features } = await movie([
    sprite(2, kidScript), placeNamed(1, 2, 'kid'),
    script(
      set('a', 5), set('/:b', 'x'), set('kid:c', 1), set('kid.d', 2), set('_root.kid.e', 3), set('/kid:f', 4),
      copy('copyA', 'A'), copy('copyC', 'kid.c'), copy('copyF', '/kid:f'), copy('fromKidCopy', 'fromkid'),
      set('missing:z', 1), set('_x', 9), copy('ref', 'kid'), copy('nothing', 'neverSet'), copy('pathRef', '/kid'),
      copy('date', 'Date'), set('_root', 1)
    ), show()
  ]);
  assert.deepStrictEqual(vars(kid()), { own: 1, c: 1, d: 2, e: 3, f: 4 });
  const r = vars(root);
  assert.deepStrictEqual([r.fromkid, r.viaparent, r.viaslash], ['k', 2, 3], 'the child script ran first and reached the root three ways');
  assert.deepStrictEqual([r.a, r.b, r.copya, r.copyc, r.copyf, r.fromkidcopy], [5, 'x', 5, 1, 4, 'k']);
  assert.strictEqual(r.ref, kid(), 'a movie clip is a value');
  assert.strictEqual(r.pathref, kid(), 'so is a slash path to one');
  assert.ok('nothing' in r && r.nothing === undefined, 'an unknown name reads as undefined');
  assert.ok(!('z' in r) && !('_x' in r) && !('_root' in r));
  assert.strictEqual(root.displayObject().matrix[4], 180, '_x = 9 moved the root');
  assert.strictEqual(r.date, U, 'global objects that are not implemented read as unknown values');
  assert.ok(features().includes('avm1:objectValue'));
  assert.ok(features().includes('avm1:variableNotSet'), '_root cannot be set');
  assert.ok(!features().some((f) => f === 'avm1:GetVariable' || f === 'avm1:SetVariable'));
});

test('variables: names are case-insensitive before SWF 7; SWF 4 paths use only ":" and "/"', async () => {
  const swf6 = await movie([script(set('Score', 1), copy('copy', 'SCORE')), show()]);
  assert.deepStrictEqual(swf6.vars(swf6.root), { score: 1, copy: 1 });
  const swf7 = await movie([script(set('Score', 1), copy('copy', 'score')), show()], { version: 7 });
  assert.deepStrictEqual(swf7.vars(swf7.root), { Score: 1, copy: undefined });

  const swf4 = await movie([
    sprite(2), placeNamed(1, 2, 'kid'),
    script(set('kid:a', 1), set('kid.b', 2), copy('viaColon', 'kid:a'), copy('viaDot', 'kid.b'), copy('ref', 'kid')), show()
  ], { version: 4 });
  assert.deepStrictEqual(swf4.vars(swf4.kid()), { a: 1, b: 2 }, 'SetVariable splits at "." even in SWF 4');
  const r = swf4.vars(swf4.root);
  assert.deepStrictEqual([r.viacolon, r.viadot, r.ref], [1, undefined, undefined], 'GetVariable does not; a clip reads as undefined');
});

test('variables: SetTarget scopes them; an invalid target scopes them to the root; DefineLocal and DefineLocal2', async () => {
  const { root, kid, vars } = await movie([
    sprite(2), placeNamed(1, 2, 'kid'),
    script(
      setTarget('kid'), set('inKid', 1), copy('readInKid', 'inKid'), setTarget(''), set('inRoot', 2),
      setTarget('nowhere'), set('fallback', 3), setTarget(''),
      push('local', 4), [0x3c], push('local2'), [0x41], push('local'), [0x41], push('kid:deep'), [0x41]
    ), show()
  ]);
  assert.deepStrictEqual(vars(kid()), { inkid: 1, readinkid: 1, deep: undefined });
  const r = vars(root);
  assert.deepStrictEqual([r.inroot, r.fallback, r.local, r.local2], [2, 3, 4, undefined]);
  assert.ok('local2' in r, 'DefineLocal2 creates the variable');
});

test('variables: values are kept between frames, and unknown names change nothing', async () => {
  const { root, tick, vars, features } = await movie([
    script(set('n', 1)), show(),
    script(push('n', 'n'), GET, [0x50], SET, push('Date'), GET, push(5), SET), show() // n = n + 1; Date = 5
  ], { frameCount: 2 });
  tick();
  assert.deepStrictEqual(vars(root), { n: 2 });
  assert.ok(features().includes('avm1:unknownName'));
});

// ---- Text fields bound to variables ---------------------------------------------------------------------

const field = (id, variable, opts = {}) => B.defineEditText(id, { bounds: { xMin: 0, xMax: 4000, yMin: 0, yMax: 600 }, variable, ...opts });
const measure = { width: (css, s) => s.length * 10, metrics: () => ({ ascent: 10, descent: 2 }) };
const lineTexts = (layout) => layout.lines.map((l) => l.runs.map((r) => r.text).join(''));

test('bound text fields: initial text sets the variable; a later SetVariable changes what the field shows', async () => {
  const { root, tick, vars, env } = await movie([
    field(5, 'score', { text: '0' }), placeNamed(2, 5), show(),
    script(set('score', 42)), show(),
    script(set('score', 1.5), copy('copy', 'score')), show()
  ], { frameCount: 3 });
  const obj = root.displayList.get(2);
  assert.strictEqual(vars(root).score, '0', 'the field initialized its variable');
  assert.strictEqual(I.textFieldText(obj), '0');
  tick();
  assert.strictEqual(I.textFieldText(obj), '42', 'a number shows as text');
  assert.strictEqual(vars(root).score, 42, 'the variable keeps its number');

  const renderer = { characters: env.characters, measure, report: () => {} };
  const first = I.CanvasRenderer.prototype.editTextLayout.call(renderer, obj.character, obj);
  assert.deepStrictEqual(lineTexts(first), ['42']);
  assert.strictEqual(I.CanvasRenderer.prototype.editTextLayout.call(renderer, obj.character, obj), first, 'laid out again only when the text changes');
  tick();
  const second = I.CanvasRenderer.prototype.editTextLayout.call(renderer, obj.character, obj);
  assert.deepStrictEqual(lineTexts(second), ['1.5']);
  assert.strictEqual(vars(root).copy, 1.5);
});

test('bound text fields: an existing variable wins; paths, HTML, and unknown values', async () => {
  const { root, kid, vars, tick } = await movie([
    sprite(2), placeNamed(1, 2, 'kid'),
    script(set('greeting', 'from script'), set('kid:label', 'kid text')), show(),
    field(5, 'greeting', { text: 'initial' }), placeNamed(2, 5),
    field(6, 'kid.label', { text: 'ignored' }), placeNamed(3, 6),
    field(7, 'empty'), placeNamed(4, 7),
    field(8, 'html', { html: true, text: '<b>bold</b>' }), placeNamed(5, 8),
    script(set('html', '<p>new <i>html</i></p>')), show(),
    script(push('greeting', 'Date'), GET, SET), show() // greeting = an unknown value
  ], { frameCount: 3 });
  tick();
  const text = (depth) => I.textFieldText(root.displayList.get(depth));
  assert.deepStrictEqual([text(2), text(3), text(4)], ['from script', 'kid text', '']);
  assert.deepStrictEqual([vars(root).greeting, vars(kid()).label], ['from script', 'kid text'], 'existing variables are not overwritten');
  assert.ok(!('empty' in vars(root)), 'empty initial text does not create the variable');
  assert.strictEqual(text(5), '<p>new <i>html</i></p>', 'an HTML field shows the value as HTML');
  tick();
  assert.strictEqual(vars(root).greeting, U);
  assert.strictEqual(text(2), 'from script', 'an unknown value keeps the last text');
});
