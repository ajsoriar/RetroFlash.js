'use strict';
// AVM1 stack core: Push, Pop, PushDuplicate, StackSwap, StoreRegister and ConstantPool, the stack effect of
// skipped actions, underflow, malformed records and the stack limit. Each test runs one action block in an
// Activation and checks its stack and registers. The byte layouts follow the SWF 19 specification ("Actions").
const { test, assert } = require('../support/harness');
const { RetroFlash } = require('../support/load-reader');

const I = RetroFlash.internals;
const U = I.UNKNOWN_VALUE;
const rec = (code, ...data) => [code, data.length & 0xff, data.length >> 8, ...data];
const str = (s) => [...Buffer.from(s, 'utf8'), 0];
// Push operands: [type, ...value].
const S = (s) => [0, ...str(s)];
const N = (n) => [7, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const R = (r) => [4, r];
const C = (i) => [8, i];
const push = (...operands) => rec(0x96, ...operands.flat());
const POP = [0x17], DUP = [0x4c], SWAP = [0x4d];
const store = (r) => rec(0x87, r);
const pool = (...strings) => rec(0x88, strings.length & 0xff, strings.length >> 8, ...strings.flatMap(str));

// prepare(act) runs before the block, to instrument the activation.
function exec(records, limits, prepare) {
  const reported = [];
  const scheduler = { limits: I.resolveLimits(limits), steps: 0, report: (feature) => reported.push(feature) };
  const act = new I.Activation(scheduler, null, new I.ActionCode(Uint8Array.from(records.flat()), 6), 'test');
  if (prepare) prepare(act);
  act.run();
  return { act, reported, stack: Array.from(act.stack), registers: Array.from(act.registers) };
}

test('stack: Push puts values of every type on the stack, in order', () => {
  const { stack, reported } = exec([push(
    S('a'), N(-2),
    [1, 0x00, 0x00, 0x20, 0x40],                         // float 2.5
    [2], [3], [5, 1], [5, 0],                            // null, undefined, true, false
    [6, 0xfb, 0x21, 0x09, 0x40, 0x18, 0x2d, 0x44, 0x54]  // double pi, high word first
  ), push(S('b'))]);
  assert.deepStrictEqual(stack, ['a', -2, 2.5, null, undefined, true, false, Math.PI, 'b']);
  assert.deepStrictEqual(reported, [], 'the stack core is interpreted, not reported');
});

test('stack: Pop, PushDuplicate and StackSwap', () => {
  assert.deepStrictEqual(exec([push(N(1), N(2), N(3)), SWAP]).stack, [1, 3, 2]);
  assert.deepStrictEqual(exec([push(N(1), N(2)), DUP]).stack, [1, 2, 2]);
  assert.deepStrictEqual(exec([push(N(1), N(2)), POP]).stack, [1]);
  assert.deepStrictEqual(exec([push(N(1), N(2), N(3)), SWAP, DUP, POP, POP]).stack, [1, 3]);
});

test('stack: underflow gives undefined, as in Flash Player', () => {
  const { stack, reported } = exec([POP, POP, DUP]);
  assert.deepStrictEqual(stack, [undefined, undefined]);
  assert.deepStrictEqual(exec([push(S('x')), SWAP]).stack, ['x', undefined], 'the missing value comes up on top');
  assert.deepStrictEqual(reported, []);
});

test('registers: StoreRegister copies the top without popping it; Push reads registers 0-3', () => {
  const { stack, registers } = exec([push(N(5)), store(0), push(S('t')), store(3), POP, POP, push(R(0), R(3), R(1))]);
  assert.deepStrictEqual(stack, [5, 't', undefined]);
  assert.deepStrictEqual(registers, [5, undefined, undefined, 't']);
  const empty = exec([store(2)]);
  assert.deepStrictEqual([empty.stack, empty.registers[2]], [[], undefined], 'an empty stack stores undefined');
  const outside = exec([push(N(9)), store(4), push(R(4), R(255))]);
  assert.deepStrictEqual(outside.stack, [9, undefined, undefined], 'registers past 3 do not exist outside DefineFunction2');
  assert.strictEqual(outside.registers.length, 4);
});

test('constant pool: Push reads it by index; a later pool replaces it; missing entries give undefined', () => {
  const { stack, act } = exec([
    push(C(0)),
    pool('a', 'b'), push(C(1), [9, 0, 0], C(2)),  // constant8 1, constant16 0, constant8 2
    pool('c'), push(C(0), C(1))
  ]);
  assert.deepStrictEqual(stack, [undefined, 'b', 'a', undefined, 'c', undefined]);
  assert.deepStrictEqual(Array.from(act.constants), ['c']);
});

test('skipped actions keep the stack in step: what they push is unknown', () => {
  const add = exec([push(N(1), N(2)), [0x0a], push(S('v')), [0x1c]]); // Add, GetVariable
  assert.deepStrictEqual(add.stack, [U, U]);
  assert.ok(add.reported.includes('avm1:Add') && add.reported.includes('avm1:GetVariable'));
  assert.deepStrictEqual(exec([push(S('x'), N(1), S('keep'), S('v'), N(2)), [0x1d]]).stack, ['x', 1, 'keep'], 'SetVariable pops two');
  assert.deepStrictEqual(exec([push(N(1), N(2), N(3)), [0x23]]).stack, [], 'SetProperty pops three');
  assert.deepStrictEqual(exec([push(N(1)), [0x70]]).stack, [1], 'an unknown action code has no effect');

  // InitArray pops a count that depends on the values: everything below is unknown afterwards.
  const array = exec([push(N(7), N(1), N(1)), [0x42], push(S('top')), POP, POP, DUP]);
  assert.strictEqual(array.act.stackUnknown, true);
  assert.deepStrictEqual(array.stack, [U, U], 'popping past the known values gives unknown values, not undefined');
  assert.strictEqual(exec([push(N(1)), [0x42], store(1)]).registers[1], U);
});

test('function definitions: a function literal leaves an unknown value; a named function does not', () => {
  const literal = exec([rec(0x9b, ...str(''), 0, 0, 1, 0), [0x07], push(N(1))]);
  assert.deepStrictEqual(literal.stack, [U, 1], 'the body (Stop) is skipped');
  assert.deepStrictEqual(exec([rec(0x9b, ...str('f'), 0, 0, 0, 0)]).stack, []);
  assert.deepStrictEqual(exec([rec(0x8e, ...str(''), 0, 0, 0, 0, 0, 0, 0)]).stack, [U], 'DefineFunction2 too');
});

test('stack core: malformed Push, StoreRegister and ConstantPool end the script', () => {
  for (const bad of [rec(0x96, 10), rec(0x96, 6, 1, 2), rec(0x87), rec(0x88, 2, 0, ...str('a'))]) {
    const { stack, reported } = exec([push(N(1)), bad, push(N(2))]);
    assert.deepStrictEqual(stack, [1], 'nothing after the malformed record ran');
    assert.ok(reported.includes('avm1:malformedAction'));
  }
});

// Records the largest stack the activation ever held.
const trackDepth = (seen) => (act) => {
  act.stack.push = function (...values) { Array.prototype.push.apply(this, values); seen.max = Math.max(seen.max, this.length); return this.length; };
};

test('limits: maxActionStack bounds the values on the stack of one block, even inside one Push', () => {
  const seen = { max: 0 };
  const over = exec([push(N(1), N(2), N(3), N(4), N(5)), push(S('after'))], { maxActionStack: 2 }, trackDepth(seen));
  assert.ok(over.reported.includes('avm1:budget'));
  assert.strictEqual(seen.max, 2, 'the Push stops at the limit');
  assert.deepStrictEqual(over.stack, [], 'the stack is released and the script ends');
  const fits = exec([push(N(1), N(2), N(3)), POP, push(S('after'))], { maxActionStack: 3 });
  assert.deepStrictEqual([fits.stack, fits.reported], [[1, 2, 'after'], []]);
  // Every way of growing the stack respects the limit: PushDuplicate, StackSwap on an empty stack, the results of
  // skipped actions, and function literals.
  const literal = rec(0x9b, ...str(''), 0, 0, 0, 0);
  for (const grow of [[push(N(1)), DUP], [SWAP], [[0x34], [0x34]], [literal, literal]]) {
    const depth = { max: 0 }, full = exec(grow, { maxActionStack: 1 }, trackDepth(depth));
    assert.ok(full.reported.includes('avm1:budget'));
    assert.strictEqual(depth.max, 1);
  }
});

test('limits: a block is decoded only as far as it runs', () => {
  const plays = Array(5000).fill([0x06]);
  const { act, reported } = exec(plays, { maxActionSteps: 10 });
  assert.ok(reported.includes('avm1:budget'));
  assert.ok(act.code.records.size <= 10, act.code.records.size + ' records decoded');
  assert.strictEqual(act.code.linear, null, 'the block is never listed');
});

test('a record that runs past the block is reported when it is reached', () => {
  const cut = [0x96, 9, 0, 0];
  assert.ok(exec([push(N(1)), cut]).reported.includes('avm1:malformedAction'));
  const stopped = exec([push(N(1)), rec(0x9e), cut]); // Call ends the script first
  assert.deepStrictEqual(stopped.reported, ['avm1:Call']);
});

test('stack effects: the table lists only skipped actions', () => {
  const handled = [0x04, 0x05, 0x06, 0x07, 0x17, 0x4c, 0x4d, 0x81, 0x83, 0x87, 0x88, 0x8a, 0x8b, 0x8c, 0x8e, 0x96, 0x9b];
  const endScript = [0x20, 0x2a, 0x3d, 0x3e, 0x52, 0x8d, 0x8f, 0x94, 0x99, 0x9d, 0x9e, 0x9f];
  for (const code of Object.keys(I.STACK_EFFECTS).map(Number)) {
    assert.ok(I.ACTIONS[code], '0x' + code.toString(16) + ' is an action');
    assert.ok(!handled.includes(code) && !endScript.includes(code), '0x' + code.toString(16) + ' is skipped');
  }
});
