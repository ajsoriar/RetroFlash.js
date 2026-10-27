'use strict';
// AVM1 decoder: record boundaries, operands, branch targets, versions and errors. The byte layouts are worked
// out by hand from the SWF 19 specification ("Actions"); nothing here executes an action, except the last
// tests, which check how the interpreter treats malformed records.
const { test, assert } = require('../support/harness');
const { SWFReader, RetroFlash } = require('../support/load-reader');
const B = require('../support/swf-builder');

const I = RetroFlash.internals;
const rec = (code, ...data) => [code, data.length & 0xff, data.length >> 8, ...data];
const str = (s) => [...Buffer.from(s, 'utf8'), 0];
const decode = (records, version = 6) => new I.ActionCode(Uint8Array.from(records.flat()), version);
const first = (records, version) => decode(records, version).at(0);

test('decoder: linear records end at ActionEndFlag; bytes after it are counted', () => {
  const code = decode([[0x07], rec(0x81, 5, 0), [0x00], [0xaa, 0xbb]]);
  const list = code.list();
  assert.deepStrictEqual(list.map((a) => [a.name, a.offset, a.end, a.since]), [['Stop', 0, 1, 3], ['GotoFrame', 1, 6, 3]]);
  assert.deepStrictEqual(list[1].args, { frame: 5 });
  assert.deepStrictEqual([list.endFound, list.endOffset, list.trailingBytes, list.truncated], [true, 6, 2, false]);
  const open = decode([[0x07]]).list();
  assert.deepStrictEqual([open.length, open.endFound, open.endOffset, open.trailingBytes], [1, false, 1, 0]);
});

test('decoder: operands of the SWF 3 and SWF 4 actions', () => {
  assert.deepStrictEqual(first([rec(0x83, ...str('http://a/'), ...str('_blank'))]).args, { url: 'http://a/', target: '_blank' });
  assert.deepStrictEqual(first([rec(0x8b, ...str('/a/b'))]).args, { path: '/a/b' });
  assert.deepStrictEqual(first([rec(0x8c, ...str('intro'))]).args, { label: 'intro' });
  assert.deepStrictEqual(first([rec(0x8a, 0x10, 0x01, 3)]).args, { frame: 0x110, skipCount: 3 });
  assert.deepStrictEqual(first([rec(0x8d, 7)]).args, { skipCount: 7 });
  // GetURL2: SendVarsMethod UB[2], Reserved UB[4], LoadTargetFlag UB[1], LoadVariablesFlag UB[1].
  assert.deepStrictEqual(first([rec(0x9a, 0b10000011)]).args, { sendVarsMethod: 2, loadTarget: true, loadVariables: true });
  assert.deepStrictEqual(first([rec(0x9a, 0b01000000)]).args, { sendVarsMethod: 1, loadTarget: false, loadVariables: false });
  // GotoFrame2: Reserved UB[6], SceneBiasFlag UB[1], PlayFlag UB[1], then SceneBias UI16 when the flag is set.
  assert.deepStrictEqual(first([rec(0x9f, 0b11, 2, 1)]).args, { play: true, sceneBias: 0x102 });
  assert.deepStrictEqual(first([rec(0x9f, 0)]).args, { play: false, sceneBias: 0 });
  const call = first([rec(0x9e)]);
  assert.deepStrictEqual([call.name, call.end, call.args, call.error], ['Call', 3, undefined, undefined]);
});

test('decoder: Push values of every type, including the word order of doubles', () => {
  const push = first([rec(0x96,
    0, ...str('hi'),
    1, 0x00, 0x00, 0x20, 0x40,                         // float 2.5
    2, 3,                                              // null, undefined
    4, 7,                                              // register 7
    5, 1,                                              // true
    6, 0xfb, 0x21, 0x09, 0x40, 0x18, 0x2d, 0x44, 0x54, // double pi: high word 0x400921FB first, then 0x54442D18
    7, 0xfe, 0xff, 0xff, 0xff,                         // integer -2
    8, 3,                                              // constant 3
    9, 0x34, 0x12                                      // constant 0x1234
  )]);
  assert.strictEqual(push.error, undefined);
  assert.deepStrictEqual(push.args.values, [
    { type: 'string', value: 'hi' }, { type: 'number', value: 2.5 }, { type: 'null', value: null },
    { type: 'undefined', value: undefined }, { type: 'register', value: 7 }, { type: 'boolean', value: true },
    { type: 'number', value: Math.PI }, { type: 'number', value: -2 }, { type: 'constant', value: 3 },
    { type: 'constant', value: 0x1234 }
  ]);
  assert.deepStrictEqual(first([rec(0x96)]).args.values, [], 'an empty Push');
});

test('decoder: ConstantPool, StoreRegister, DefineFunction and DefineFunction2', () => {
  assert.deepStrictEqual(first([rec(0x88, 2, 0, ...str('a'), ...str('b'))]).args, { pool: ['a', 'b'] });
  assert.deepStrictEqual(first([rec(0x87, 3)]).args, { register: 3 });

  const fn = decode([rec(0x9b, ...str('f'), 2, 0, ...str('x'), ...str('y'), 2, 0), [0x07, 0x06], [0x00]]);
  const f = fn.at(0);
  assert.deepStrictEqual(f.args, { name: 'f', params: ['x', 'y'], bodyStart: f.end, bodyEnd: f.end + 2 });
  assert.deepStrictEqual(fn.list().map((a) => a.name), ['DefineFunction', 'Stop', 'Play'], 'the body records are listed too');

  // Flags: PreloadParent, PreloadRoot, SuppressSuper, PreloadSuper, SuppressArguments, PreloadArguments,
  // SuppressThis, PreloadThis (UB[1] each, from the most significant bit), Reserved UB[7], PreloadGlobal UB[1].
  const g = first([rec(0x8e, ...str('g'), 1, 0, 4, 0b10100001, 0b00000001, 1, ...str('p'), 0, 0)]);
  assert.deepStrictEqual(g.args, {
    name: 'g', registerCount: 4, params: [{ register: 1, name: 'p' }], bodyStart: g.end, bodyEnd: g.end,
    flags: {
      preloadParent: true, preloadRoot: false, suppressSuper: true, preloadSuper: false, suppressArguments: false,
      preloadArguments: false, suppressThis: false, preloadThis: true, preloadGlobal: true
    }
  });
});

test('decoder: With and Try bodies follow the record', () => {
  const w = first([rec(0x94, 1, 0), [0x07]]);
  assert.deepStrictEqual(w.args, { bodyStart: 5, bodyEnd: 6 });
  // Try: Reserved UB[5], CatchInRegisterFlag, FinallyBlockFlag, CatchBlockFlag; TrySize, CatchSize, FinallySize.
  const t = first([rec(0x8f, 0b011, 1, 0, 2, 0, 3, 0, ...str('e')), [0x07, 0x07, 0x07, 0x07, 0x07, 0x07]]);
  assert.deepStrictEqual(t.args, {
    catchInRegister: false, hasFinally: true, hasCatch: true, catchName: 'e',
    tryStart: t.end, tryEnd: t.end + 1, catchEnd: t.end + 3, finallyEnd: t.end + 6
  });
  const inRegister = first([rec(0x8f, 0b101, 0, 0, 0, 0, 0, 0, 2)]);
  assert.strictEqual(inRegister.args.catchRegister, 2);
  assert.strictEqual(inRegister.args.hasFinally, false);
});

test('decoder: branch targets are measured from the next record and must lie in the block', () => {
  const forward = decode([rec(0x99, 1, 0), [0x07], [0x06], [0x00]]);
  assert.deepStrictEqual(forward.at(0).args, { offset: 1, target: 6 });
  assert.strictEqual(forward.at(6).name, 'Play');
  assert.deepStrictEqual(decode([[0x07], rec(0x9d, 0xfa, 0xff)]).at(1).args, { offset: -6, target: 0 }, 'back to the start');
  assert.deepStrictEqual(first([rec(0x99, 0, 0)]).args, { offset: 0, target: 5 }, 'the end of the block is a valid target');
  assert.strictEqual(first([rec(0x9d, 0x10, 0)]).error.code, 'INVALID_BRANCH');
  assert.strictEqual(first([rec(0x99, 0xf0, 0xff)]).error.code, 'INVALID_BRANCH');
  // A target inside another record decodes from there: the string payload of this Push holds a Stop (0x07).
  const overlap = decode([rec(0x96, 0, 0x07, 0), rec(0x99, 0xf9, 0xff)]);
  assert.strictEqual(overlap.at(6).args.target, 4);
  assert.deepStrictEqual([overlap.at(4).name, overlap.at(4).end], ['Stop', 5]);
});

test('decoder: strings follow the SWF version (Latin-1 before SWF 6, UTF-8 from SWF 6)', () => {
  assert.strictEqual(first([rec(0x8c, 0xc3, 0xa9, 0)], 5).args.label, 'Ã©');
  assert.strictEqual(first([rec(0x8c, 0xc3, 0xa9, 0)], 6).args.label, 'é');
});

test('decoder: errors are explicit and never skip to arbitrary bytes', () => {
  const cutHeader = decode([[0x07, 0x81, 2]]);
  assert.deepStrictEqual(cutHeader.list().map((a) => a.name), ['Stop']);
  assert.strictEqual(cutHeader.list().truncated, true);
  assert.deepStrictEqual([cutHeader.at(1).error.code, cutHeader.at(1).end], ['TRUNCATED_RECORD', 3]);
  assert.strictEqual(first([[0x96, 9, 0, 0]]).error.code, 'TRUNCATED_RECORD', 'declared length past the block');

  const short = decode([rec(0x81, 5), [0x07]]);
  assert.deepStrictEqual([short.at(0).error.code, short.at(0).end], ['INVALID_OPERANDS', 4], 'the record boundary is still known');
  assert.deepStrictEqual(short.list().map((a) => a.name), ['GotoFrame', 'Stop']);
  assert.strictEqual(first([rec(0x8c, 0x41)]).error.code, 'INVALID_OPERANDS', 'string without a terminator');
  assert.match(first([rec(0x96, 10)]).error.message, /Push value type 10/);
  assert.strictEqual(first([rec(0x96, 6, 1, 2, 3)]).error.code, 'INVALID_OPERANDS', 'truncated double');
  assert.strictEqual(first([rec(0x9b, ...str(''), 0, 0, 10, 0)]).error.code, 'INVALID_RANGE', 'function body past the block');
  assert.strictEqual(first([rec(0x8f, 0b010, 0, 0, 0, 0, 4, 0, 0)]).error.code, 'INVALID_RANGE', 'finally block past the block');
  assert.throws(() => decode([[0x07]]).at(1), (err) => err.code === 'INVALID_OFFSET');

  const extra = first([rec(0x81, 5, 0, 0xff)]);
  assert.deepStrictEqual([extra.args, extra.error, extra.end], [{ frame: 5 }, undefined, 6], 'extra payload bytes are ignored');
});

test('decoder: names, versions and unknown codes', () => {
  const since = (code) => first([code >= 0x80 ? rec(code) : [code]]).since;
  assert.deepStrictEqual([since(0x07), since(0x96), since(0x3d), since(0x54), since(0x8e)], [3, 4, 5, 6, 7]);
  const low = first([[0x70]]);
  assert.deepStrictEqual([low.name, low.since, low.end, low.error], ['Unknown_0x70', null, 1, undefined]);
  const high = first([rec(0xa0, 1, 2)]);
  assert.deepStrictEqual([high.name, high.end, high.data.length, high.args, high.error], ['Unknown_0xa0', 5, 2, undefined, undefined]);
  for (const code of Object.keys(I.ACTIONS)) assert.strictEqual(I.ACTION_NAMES[code], I.ACTIONS[code][0]);
});

test('decoder: each offset is decoded once; decoding leaves the bytes untouched', () => {
  const bytes = Uint8Array.from([0x07, ...rec(0x96, 0, ...str('x')), 0x00]);
  const copy = bytes.slice(), code = new I.ActionCode(bytes, 6);
  assert.strictEqual(code.at(0), code.at(0));
  assert.strictEqual(code.list()[1], code.at(1));
  assert.strictEqual(code.list(), code.list());
  assert.deepStrictEqual(bytes, copy);
});

test('decoder: a shared budget counts the bytes of each record decoded once, across blocks', () => {
  const BLOCK = I.ACTION_BLOCK_COST, budget = { used: 0, max: 2 * BLOCK + 12 };
  const a = new I.ActionCode(Uint8Array.from([0x07, ...rec(0x81, 1, 0), 0x06]), 6, budget);
  const b = new I.ActionCode(Uint8Array.from([...rec(0x96, 0, ...str('x')), 0x07]), 6, budget);
  a.at(0); a.at(1); a.at(1);
  assert.strictEqual(budget.used, BLOCK + 6, 'the block, Stop (1) and GotoFrame (5); a cached record is free');
  b.at(0);
  assert.strictEqual(budget.used, 2 * BLOCK + 12, 'another block and its Push (6)');
  assert.throws(() => a.at(6), (err) => err.code === 'DECODE_BUDGET', 'the budget is spent');
  assert.strictEqual(a.at(1).name, 'GotoFrame', 'decoded records stay available');
  assert.strictEqual(budget.used, 2 * BLOCK + 12);
  assert.strictEqual(new I.ActionCode(Uint8Array.from([0x07]), 6).budget, null, 'no budget by default');
});

test('decoder: a record that crosses the budget is kept; records with errors cost at most their header', () => {
  const crossing = { used: 0, max: I.ACTION_BLOCK_COST + 2 }; // room for the block and the Stop, not the Push
  const code = new I.ActionCode(Uint8Array.from([0x07, ...rec(0x96, 0, ...str('long string')), 0x07]), 6, crossing);
  code.at(0); code.at(1);
  assert.strictEqual(crossing.used, I.ACTION_BLOCK_COST + 1 + 16, 'the Push crossed the threshold by its length');
  assert.throws(() => code.at(17), (err) => err.code === 'DECODE_BUDGET');

  const budget = { used: 0, max: 1e6 };
  const cut = new I.ActionCode(Uint8Array.from([0x96, 0xff, 0xff, ...Array(5000).fill(2)]), 6, budget); // declares 65535 bytes
  assert.strictEqual(cut.at(0).error.code, 'TRUNCATED_RECORD');
  assert.strictEqual(budget.used, I.ACTION_BLOCK_COST + 3, 'not the 5003 bytes up to the end of the block');
  const bad = new I.ActionCode(Uint8Array.from(rec(0x96, 10, ...Array(1000).fill(0))), 6, budget);
  assert.strictEqual(bad.at(0).error.code, 'INVALID_OPERANDS');
  assert.strictEqual(budget.used, 2 * (I.ACTION_BLOCK_COST + 3));
  const header = new I.ActionCode(Uint8Array.from([0x96, 1]), 6, budget);
  assert.strictEqual(header.at(0).error.code, 'TRUNCATED_RECORD');
  assert.strictEqual(budget.used, 3 * I.ACTION_BLOCK_COST + 8, 'a cut header costs its 2 bytes');
});

// ---- Interpreter on malformed records --------------------------------------------------------------------------

async function runActions(...records) {
  const swf = await SWFReader.load(B.swf({ version: 6, frameCount: 2, tags: [B.doAction(...records), B.tag(B.T.ShowFrame), B.tag(B.T.ShowFrame), B.tag(B.T.End)] }));
  const movie = new I.Movie(swf), reported = [];
  const env = I.createEnv(movie, (feature) => reported.push(feature));
  const root = new I.Clip(env, movie.root, 0, null);
  root.gotoFrame(1);
  env.scripts.run();
  return { root, reported };
}

test('AVM1: an executed action with malformed operands ends the script', async () => {
  const short = await runActions(rec(0x81, 1), B.A.stop());
  assert.ok(short.reported.includes('avm1:malformedAction'));
  assert.strictEqual(short.root.playing, true, 'the Stop after it did not run');
  const body = await runActions(rec(0x9b, ...str('f'), 0, 0, 50, 0), B.A.stop());
  assert.ok(body.reported.includes('avm1:malformedAction'), 'a function body past the block');
  assert.strictEqual(body.root.playing, true);
});

test('AVM1: a malformed action outside the subset is reported and skipped, as before', async () => {
  const { root, reported } = await runActions(rec(0x9a), B.A.stop()); // GetURL2 without its flags
  assert.ok(reported.includes('avm1:GetURL2'));
  assert.ok(!reported.includes('avm1:malformedAction'));
  assert.strictEqual(root.playing, false);
});
