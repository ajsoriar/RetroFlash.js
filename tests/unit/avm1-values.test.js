'use strict';
// AVM1 values: conversions and comparisons, as a matrix of values by SWF version.
const { test, assert } = require('../support/harness');
const { RetroFlash } = require('../support/load-reader');

const I = RetroFlash.internals;
const VERSIONS = [4, 5, 6, 7];
const same = (a, b) => (a !== a && b !== b) || a === b;
const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));

// rows: [input, result in SWF 4, 5, 6, 7]
function matrix(fn, rows) {
  for (const [input, ...expected] of rows) {
    VERSIONS.forEach((version, i) => {
      const actual = fn(input, version);
      assert.ok(same(actual, expected[i]), `${fn.name}(${show(input)}) in SWF ${version}: ${show(actual)}, expected ${show(expected[i])}`);
    });
  }
}

test('toNumber: undefined and null, booleans, and strings by SWF version', () => {
  matrix(I.toNumber, [
    [undefined, 0, 0, 0, NaN],
    [null, 0, 0, 0, NaN],
    [true, 1, 1, 1, 1],
    [false, 0, 0, 0, 0],
    [2.5, 2.5, 2.5, 2.5, 2.5],
    ['12', 12, 12, 12, 12],
    ['  12', 12, 12, 12, 12],
    ['-3.5', -3.5, -3.5, -3.5, -3.5],
    ['+7', 7, 7, 7, 7],
    ['.5', 0.5, 0.5, 0.5, 0.5],
    ['.', 0, 0, 0, 0],
    ['1.5e3', 1500, 1500, 1500, 1500],
    ['2e', 2, 2, 2, 2],
    ['', 0, NaN, NaN, NaN],
    ['abc', 0, NaN, NaN, NaN],
    ['12abc', 12, NaN, NaN, NaN],
    ['12 ', 12, NaN, NaN, NaN],
    ['Infinity', 0, NaN, NaN, NaN],
    ['0x1F', 0, NaN, 31, 31],
    ['0XfF', 0, NaN, 255, 255],
    ['0xFFFFFFFF', 0, NaN, -1, -1],
    ['0x', 0, NaN, NaN, NaN],
    ['0x1G', 0, NaN, NaN, NaN],
    ['-0x1F', -0, NaN, NaN, NaN],
    [' 0x10', 0, NaN, NaN, NaN],
    ['010', 10, 10, 8, 8],
    ['-010', -10, -10, -8, -8],
    ['08', 8, 8, 8, 8],
    ['0', 0, 0, 0, 0]
  ]);
});

test('toAvmString: undefined, booleans and numbers', () => {
  matrix(I.toAvmString, [
    [undefined, '', '', '', 'undefined'],
    [null, 'null', 'null', 'null', 'null'],
    [true, '1', 'true', 'true', 'true'],
    [false, '0', 'false', 'false', 'false'],
    ['x', 'x', 'x', 'x', 'x']
  ]);
  const cases = [
    [0, '0'], [-0, '0'], [7, '7'], [-42, '-42'], [2147483647, '2147483647'], [2147483648, '2147483648'],
    [0.1 + 0.2, '0.3'], [1 / 3, '0.333333333333333'], [-990.123, '-990.123'], [100000.12345678912, '100000.123456789'],
    [9.999999999999999, '10'], [999990000000000, '999990000000000'], [1e15, '1e+15'], [1.5e20, '1.5e+20'],
    [-1e15, '-1e+15'], [0.00001, '0.00001'], [-0.00001, '-0.00001'], [0.999e-5, '9.99e-6'], [-2.5e-7, '-2.5e-7'],
    [0.19999999999999996, '0.2'], [NaN, 'NaN'], [Infinity, 'Infinity'], [-Infinity, '-Infinity'],
    [Number.MAX_VALUE, '1.79769313486232e+308']
  ];
  for (const [n, s] of cases) assert.strictEqual(I.numberToString(n), s, String(n));
});

test('toBoolean: strings convert through numbers before SWF 7', () => {
  matrix(I.toBoolean, [
    [undefined, false, false, false, false],
    [null, false, false, false, false],
    [0, false, false, false, false],
    [NaN, false, false, false, false],
    [-1, true, true, true, true],
    ['', false, false, false, false],
    ['0', false, false, false, true],
    ['2', true, true, true, true],
    ['abc', false, false, false, true],
    ['0x10', false, false, true, true]
  ]);
});

test('comparisons: Equals2, StrictEquals and Less2 on primitives', () => {
  const eq = (a, b, v = 6) => I.looseEquals(a, b, v);
  assert.strictEqual(eq(undefined, null), true);
  assert.strictEqual(eq(null, 0), false);
  assert.strictEqual(eq(undefined, ''), false);
  assert.strictEqual(eq('1', 1), true);
  assert.strictEqual(eq(true, '1'), true);
  assert.strictEqual(eq(true, 2), false);
  assert.strictEqual(eq(NaN, NaN), true, 'NaN equals NaN');
  assert.strictEqual(eq('NaN', NaN), false);
  assert.strictEqual(eq('', 0), false, 'an empty string is NaN from SWF 5');
  assert.strictEqual(eq('0x10', 16, 6), true);
  assert.strictEqual(eq('0x10', 16, 5), false);
  assert.strictEqual(eq('a', 'a'), true);

  assert.strictEqual(I.strictEquals(1, '1'), false);
  assert.strictEqual(I.strictEquals(NaN, NaN), true);
  assert.strictEqual(I.strictEquals(null, undefined), false);
  assert.strictEqual(I.strictEquals('a', 'a'), true);

  const lt = (a, b, v = 6) => I.lessThan(a, b, v);
  assert.strictEqual(lt('a', 'b'), true);
  assert.strictEqual(lt('10', '9'), true, 'two strings compare as strings');
  assert.strictEqual(lt(10, '9'), false, 'a number and a string compare as numbers');
  assert.strictEqual(lt(1, NaN), undefined);
  assert.strictEqual(lt(undefined, 1, 6), true, 'undefined is 0 before SWF 7');
  assert.strictEqual(lt(undefined, 1, 7), undefined, 'and NaN from SWF 7');
  assert.deepStrictEqual([I.typeOf(null), I.typeOf(undefined), I.typeOf(1), I.typeOf('s'), I.typeOf(false)],
    ['null', 'undefined', 'number', 'string', 'boolean']);
});
