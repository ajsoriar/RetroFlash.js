'use strict';
// AVM1 functions and objects: DefineFunction/DefineFunction2, calls, `this`, closures, recursion limits,
// objects, arrays, prototypes and classes, with, try/catch/finally/throw, for..in, the built-in classes, the
// MovieClip methods, Call, and the global registers. Blocks run in an Activation on the clips of SWFs built in
// memory; the byte layouts follow SWF 19.
const { test, assert } = require('../support/harness');
const { SWFReader } = require('../support/load-reader');
const B = require('../support/swf-builder');
const { I, rec, str, push, assemble, exec } = require('../support/avm1');

const U = I.UNKNOWN_VALUE;
const GET = [0x1c], SET = [0x1d], RETURN = [0x3e], POP = [0x17];
const u16 = (n) => [n & 0xff, n >> 8];
// function name(params) { body }: DefineFunction, its body assembled on its own (labels are local to it).
function fn1(name, params, body) {
  const code = assemble(body);
  return [...rec(0x9b, ...str(name), ...u16(params.length), ...params.flatMap(str), ...u16(code.length)), ...code];
}
// DefineFunction2: params [{ register, name }], flags [first byte, second byte].
function fn2(name, params, registerCount, flags, body) {
  const code = assemble(body);
  return [...rec(0x8e, ...str(name), ...u16(params.length), registerCount, flags[0], flags[1],
    ...params.flatMap((p) => [p.register, ...str(p.name)]), ...u16(code.length)), ...code];
}
// f(args): arguments are pushed last first, then their count, then the name.
const call = (name, ...args) => [push(...args.slice().reverse(), args.length, name), [0x3d]];
// object.method(args), with the object read from a variable.
const method = (object, name, ...args) => [push(...args.slice().reverse(), args.length, object), GET, push(name), [0x52]];
const set = (name, ...valueRecords) => [push(name), ...valueRecords, SET];
const get = (name) => [push(name), GET];
const member = (name) => [push(name), [0x4e]];
const reg = (r) => rec(0x96, 4, r);

const show = () => B.tag(B.T.ShowFrame);
// A DoAction tag from records, nested lists included.
const script = (...records) => B.doAction(records.flat(Infinity));
const end = () => B.tag(B.T.End);
async function movie(tags = [], { version = 6, frameCount = 1 } = {}) {
  const swf = await SWFReader.load(B.swf({ version, frameCount, tags: [...tags, end()] }));
  const m = new I.Movie(swf), reported = [];
  const env = I.createEnv(m, (feature) => reported.push(feature), { limits: I.resolveLimits({ maxCallDepth: 32 }) });
  const root = new I.Clip(env, m.root, 0, null);
  root.gotoFrame(1);
  env.scripts.run();
  const run = (records) => {
    const scheduler = Object.assign(env.scripts, {});
    const act = new I.Activation(scheduler, root, new I.ActionCode(Uint8Array.from(records.flat(Infinity)), version), 'test');
    let error = null;
    try { act.run(); } catch (err) { error = err; }
    env.scripts.run();
    return { act, stack: Array.from(act.stack), error };
  };
  const v = (name) => root.variables.get(version < 7 ? name.toLowerCase() : name);
  const tick = () => { env.scripts.beginUpdate(); root.tick(); env.scripts.run(); };
  return { root, env, run, v, reported, tick };
}

test('functions: parameters, return values, arguments, locals that do not leak, and recursion', async () => {
  const { run, v, root } = await movie();
  run([
    fn1('add', ['a', 'b'], [get('a'), get('b'), [0x47], RETURN]),
    fn1('count', [], [get('arguments'), member('length'), RETURN]),
    fn1('second', ['a', 'b'], [get('b'), RETURN]),
    fn1('scoped', [], [push('local', 1), [0x3c], set('global', push(2)), RETURN]),
    // fact(n): n > 1 ? n * fact(n - 1) : 1
    fn1('fact', ['n'], [get('n'), push(1), [0x67], { if: 'rec' }, push(1), RETURN,
      { label: 'rec' }, get('n'), get('n'), push(1), [0x0b], push(1, 'fact'), [0x3d], [0x0c], RETURN]),
    set('sum', call('add', 2, 3)), set('n', call('count', 1, 2, 3)), set('missing', call('second', 1)),
    call('scoped'), POP, set('f', call('fact', 5)), set('none', call('nothing', 1))
  ]);
  assert.deepStrictEqual([v('sum'), v('n'), v('missing'), v('global'), v('f'), v('none')], [5, 3, undefined, 2, 120, undefined]);
  assert.ok(!root.variables.has('local'), 'a local stays in the function');
  assert.strictEqual(I.typeOf(v('add')), 'function', 'a named function is a variable of the timeline');
});

test('recursion stops at maxCallDepth; the whole block ends and is reported', async () => {
  const { root, reported } = await movie([
    script(fn1('down', [], [call('down'), RETURN]), call('down'), POP, set('after', push(1))), show()
  ]);
  assert.ok(reported.includes('avm1:budget'));
  assert.ok(!root.variables.has('after'), 'the block stopped');
});

test('closures, this, and the timeline a function was defined on', async () => {
  const { run, v, root } = await movie();
  run([
    // makeCounter() { var c = 0; return function () { c++; return c; }; }
    fn1('makeCounter', [], [push('c', 0), [0x3c], fn1('', [], [push('c'), get('c'), [0x50], SET, get('c'), RETURN]), RETURN]),
    set('k', call('makeCounter')), call('k'), POP, set('twice', call('k')),
    // obj = { v: 7, read: function () { return this.v; } }
    push('obj', 'v', 7, 'read'), fn1('', [], [get('this'), member('v'), RETURN]), push(2), [0x43], SET,
    set('fromMethod', method('obj', 'read')),
    fn1('whoami', [], [get('this'), RETURN]), set('me', call('whoami'))
  ]);
  assert.strictEqual(v('twice'), 2, 'the inner function kept its own c');
  assert.ok(!root.variables.has('c'));
  assert.strictEqual(v('frommethod'), 7, 'this is the object of a method call');
  assert.strictEqual(v('me'), root, 'a timeline function called by name runs with the timeline as this');
});

test('objects and arrays: literals, members, delete, for..in order, typeof, conversions', async () => {
  const { run, v } = await movie();
  run([
    set('a', push(3, 2, 1, 3), [0x42]),                   // [1, 2, 3]
    set('len', get('a'), member('length')),
    method('a', 'push', 4), POP,
    set('joined', method('a', 'join', '-')),
    set('text', get('a'), [0x4b]),                        // String(a)
    set('o', push('x', 1, 'y', 2, 2), [0x43]),            // { x: 1, y: 2 }
    set('deleted', get('o'), push('x'), [0x3a]), set('again', get('o'), push('x'), [0x3a]),
    get('o'), push('z', 3), [0x4f],                       // o.z = 3
    set('keys', get('o'), [0x55], push(3), [0x42], method('', 'join'), POP),
    set('kinds', get('o'), [0x44], get('a'), [0x44], [0x47]),
    set('plain', get('o'), [0x4b])
  ]);
  assert.deepStrictEqual([v('len'), v('joined'), v('text'), v('deleted'), v('again')], [3, '1-2-3-4', '1,2,3,4', true, false]);
  assert.deepStrictEqual(v('keys').items, ['z', 'y', undefined], 'for..in lists the last added first, then the undefined end marker');
  assert.deepStrictEqual([v('kinds'), v('plain')], ['objectobject', '[object Object]']);
});

test('built-ins: String, Array, Math, Number, global functions, and valueOf/toString in conversions', async () => {
  const { run, v } = await movie();
  run([
    set('s', push('Hello')),
    set('up', method('s', 'toUpperCase')), set('part', method('s', 'substr', 1, 3)), set('at', method('s', 'charCodeAt', 1)),
    set('parts', method('s', 'split', 'l')), set('pieces', get('parts'), member('length')),
    set('chars', push(105, 72, 2, 'String'), GET, push('fromCharCode'), [0x52]),
    set('big', method('Math', 'max', 1, 5, 3)), set('floor', method('Math', 'floor', 2.7)),
    set('int', call('parseInt', '0x1F')), set('flt', call('parseFloat', '3.5kg')), set('nan', call('isNaN', 'abc')),
    set('list', push(10, 9, 1, 3), [0x42]), method('list', 'sort', 16), POP, set('numeric', method('list', 'join', ',')),
    set('list2', push(10, 9, 1, 3), [0x42]), method('list2', 'sort'), POP, set('lexical', method('list2', 'join', ',')),
    // an object whose valueOf gives 40: o + 2 is 42
    set('o', push(0), [0x43]), get('o'), push('valueOf'), fn1('', [], [push(40), RETURN]), [0x4f],
    set('sum', get('o'), push(2), [0x47]),
    set('n', push(255)), set('hex', method('n', 'toString', 16))
  ]);
  assert.deepStrictEqual([v('up'), v('part'), v('at'), v('pieces'), v('chars')], ['HELLO', 'ell', 101, 3, 'Hi']);
  assert.deepStrictEqual([v('big'), v('floor'), v('int'), v('flt'), v('nan')], [5, 2, 31, 3.5, true]);
  assert.deepStrictEqual([v('numeric'), v('lexical'), v('sum'), v('hex')], ['1,9,10', '1,10,9', 42, 'ff']);
});

test('constructors and classes: new, prototype methods, Extends, super, instanceof, CastOp', async () => {
  const { run, v } = await movie();
  run([
    // function Point(x) { this.x = x; }  Point.prototype.getX = function () { return this.x; };
    fn1('Point', ['x'], [get('this'), push('x'), get('x'), [0x4f]]),
    get('Point'), push('prototype'), [0x4e], push('getX'), fn1('', [], [get('this'), member('x'), RETURN]), [0x4f],
    set('p', push(4, 1, 'Point'), [0x40]),
    set('px', method('p', 'getX')),
    set('isPoint', get('p'), get('Point'), [0x54]),
    // function Sub() { super(9); }  Sub extends Point
    fn1('Sub', [], [push(9, 1, 'super'), GET, push(undefined), [0x52], POP]),
    get('Sub'), get('Point'), [0x69],
    set('s', push(0, 'Sub'), [0x40]),
    set('sx', method('s', 'getX')),
    set('subIsPoint', get('s'), get('Point'), [0x54]),
    set('cast', get('Point'), get('s'), [0x2b]), set('badCast', get('Sub'), get('p'), [0x2b]),
    set('arr', push(0, 'Array'), [0x40]), method('arr', 'push', 'x'), POP, set('arrLen', get('arr'), member('length'))
  ]);
  assert.deepStrictEqual([v('px'), v('ispoint'), v('sx'), v('subispoint')], [4, true, 9, true]);
  assert.strictEqual(v('cast'), v('s'));
  assert.strictEqual(v('badcast'), null);
  assert.strictEqual(v('arrlen'), 1);
});

test('with, try/catch/finally and throw, also across function calls', async () => {
  const { run, v } = await movie();
  const withBody = assemble([set('w', push(9)), set('outside', push(1))]);
  // try { throw "boom"; } catch (e) { caught = e; } finally { fin = 1; }  (flags: catch 1, finally 2)
  const tryBody = assemble([push('boom'), [0x2a]]), catchBody = assemble([set('caught', get('e'))]), finallyBody = assemble([set('fin', push(1))]);
  const tryRecord = rec(0x8f, 0b011, ...u16(tryBody.length), ...u16(catchBody.length), ...u16(finallyBody.length), ...str('e'));
  const thrower = fn1('thrower', [], [push('deep'), [0x2a]]);
  const callerTry = assemble([call('thrower'), POP]), callerCatch = assemble([set('fromFunction', get('e'))]);
  run([
    set('o', push('w', 1, 1), [0x43]),
    get('o'), rec(0x94, ...u16(withBody.length)), withBody,
    tryRecord, tryBody, catchBody, finallyBody,
    thrower, rec(0x8f, 0b001, ...u16(callerTry.length), ...u16(callerCatch.length), 0, 0, ...str('e')), callerTry, callerCatch,
    get('undefinedThing'), rec(0x94, ...u16(withBody.length)), withBody, set('afterWith', push(1))
  ]);
  const o = v('o');
  assert.strictEqual(o.props.get('w').value, 9, 'with set the member of its object');
  assert.deepStrictEqual([v('outside'), v('caught'), v('fin'), v('fromfunction'), v('afterwith')], [1, 'boom', 1, 'deep', 1]);
  const uncaught = await movie([script(push('x'), [0x2a], set('after', push(1))), show()]);
  assert.ok(uncaught.reported.includes('avm1:uncaughtThrow'));
  assert.ok(!uncaught.root.variables.has('after'));
});

test('DefineFunction2 registers and preloading; the global registers are shared by every block', async () => {
  // function f(p in r4) with 5 registers, preloading this (r1), arguments (r2) and _root (r3): returns [r1, r2.length, r3, r4]
  const flags = [0x40 | 0x04 | 0x01, 0];
  const { run, v, root, tick } = await movie([
    script(push(5), rec(0x87, 0), POP), show(),
    script(set('fromFrame1', reg(0))), show()
  ], { frameCount: 2 });
  run([
    fn2('f', [{ register: 4, name: 'p' }], 5, flags, [reg(4), reg(3), reg(2), member('length'), reg(1), push(4), [0x42], RETURN]),
    set('r', call('f', 'P', 'extra')), set('pInLocals', push('p'), GET)
  ]);
  assert.deepStrictEqual(v('r').items, [root, 2, root, 'P'], 'this, arguments.length, _root and the parameter');
  tick();
  assert.strictEqual(v('fromframe1'), 5, 'register 0 kept its value from frame 1');
});

test('MovieClip methods, _root.gotoAndPlay, and Call', async () => {
  const label = (name) => B.tag(B.T.FrameLabel, B.body((w) => w.string(name)));
  const { run, root, v } = await movie([
    show(), label('two'), show(), script(set('called', push(3))), show()
  ], { frameCount: 3 });
  run([method('_root', 'gotoAndStop', 'two')]);
  assert.deepStrictEqual([root.frame, root.playing], [2, false]);
  run([method('_root', 'gotoAndPlay', 1), set('depth', method('_root', 'getDepth'))]);
  assert.deepStrictEqual([root.frame, root.playing, v('depth')], [1, true, -16384]);
  run([push(3), rec(0x9e)]);
  assert.deepStrictEqual([v('called'), root.frame], [3, 1], 'Call ran the script of frame 3 without going there');
});
