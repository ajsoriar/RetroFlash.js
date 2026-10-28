'use strict';
// AVM1 control flow: Jump, If, Return, WaitForFrame and WaitForFrame2. Blocks are assembled with labels and run
// in an Activation (the executed offsets are traced); the last test drives a timeline from a frame script.
const { test, assert } = require('../support/harness');
const { SWFReader } = require('../support/load-reader');
const B = require('../support/swf-builder');
const { I, rec, push, assemble, exec } = require('../support/avm1');

const U = I.UNKNOWN_VALUE;
const POP = [0x17], DUP = [0x4c];
const pushRegister = (r) => rec(0x96, 4, r);
const store = (r) => rec(0x87, r);
const target = { root() { return this; } }; // a timeline for WaitForFrame, which counts frames as loaded without one

test('Jump: forward, to the end of the block, and into the middle of a record', () => {
  assert.deepStrictEqual(exec([assemble([push(1), { jump: 'skip' }, push(2), { label: 'skip' }, push(3)])]).stack, [1, 3]);
  assert.deepStrictEqual(exec([assemble([push(1), { jump: 'end' }, push(2), { label: 'end' }])]).stack, [1], 'the end of the block ends the script');
  // Offsets: Push 1 at 0 (8 bytes); at 8 a Push of the string "\x4c" (6 bytes), whose byte 12 is PushDuplicate and
  // byte 13 the string's terminator (ActionEndFlag); at 14 a Jump back to 12 (14 + 5 - 7).
  const inside = exec([push(1), rec(0x96, 0, 0x4c, 0), rec(0x99, (-7) & 0xff, 0xff)], { trace: true });
  assert.deepStrictEqual(inside.trace, [0, 8, 14, 12]);
  assert.deepStrictEqual(inside.stack, [1, 'L', 'L']);
});

test('If: branches by the boolean conversion of each SWF version', () => {
  const branch = (v, version) => exec([assemble([
    push(v), { if: 'yes' }, push('no'), { jump: 'end' }, { label: 'yes' }, push('yes'), { label: 'end' }
  ])], { version }).stack[0];
  const cases = [
    [true, 6, 'yes'], [false, 6, 'no'], [0, 6, 'no'], [-1, 6, 'yes'], [NaN, 6, 'no'], [undefined, 6, 'no'], [null, 7, 'no'],
    ['2', 5, 'yes'], ['abc', 6, 'no'], ['abc', 7, 'yes'], ['0', 6, 'no'], ['0', 7, 'yes'], ['', 7, 'no']
  ];
  for (const [v, version, expected] of cases) assert.strictEqual(branch(v, version), expected, `If(${JSON.stringify(v)}) in SWF ${version}`);
});

test('loops: a counter loop follows the same path every run; endless loops stop at the limits', () => {
  // r0 = 0; while (r0 < 3) { push r0; r0++; }
  const loop = assemble([
    push(0), store(0), POP,
    { label: 'loop' }, pushRegister(0), push(3), [0x48], [0x12], { if: 'end' },
    pushRegister(0),
    pushRegister(0), [0x50], store(0), POP,
    { jump: 'loop' },
    { label: 'end' }
  ]);
  const first = exec([loop], { trace: true }), second = exec([loop], { trace: true });
  assert.deepStrictEqual(first.stack, [0, 1, 2]);
  assert.strictEqual(first.registers[0], 3);
  assert.deepStrictEqual(second.trace, first.trace, 'the same records, in the same order');
  assert.strictEqual(first.trace.length, 3 + 3 * 11 + 5, 'set-up, three rounds of test, body and jump, and the last test');

  const endless = exec([assemble([{ label: 'l' }, { jump: 'l' }])], { limits: { maxActionSteps: 50 }, trace: true });
  assert.ok(endless.reported.includes('avm1:budget'));
  assert.strictEqual(endless.trace.length, 50, 'exactly maxActionSteps actions ran');
  const growing = exec([assemble([{ label: 'l' }, push(1), { jump: 'l' }])], { limits: { maxActionStack: 10 } });
  assert.ok(growing.reported.includes('avm1:budget'));
  assert.deepStrictEqual(growing.stack, [], 'the stack limit stops a loop that pushes');
});

test('If on an unknown value ends the script; malformed branches end it too', () => {
  const unknown = exec([assemble([push(1), push('Date'), [0x1c], { if: 'x' }, push('after'), { label: 'x' }])]);
  assert.deepStrictEqual(unknown.stack, [1], 'neither branch ran');
  assert.ok(unknown.reported.includes('avm1:unknownCondition'));
  for (const bad of [rec(0x9d, 0x10, 0), rec(0x99, 0xf0, 0xff), rec(0x99, 1)]) {
    const out = exec([push(true), bad, push('after')]);
    assert.ok(out.reported.includes('avm1:malformedAction'), JSON.stringify(bad));
    assert.ok(!out.stack.includes('after'));
  }
});

test('Return ends the block outside functions; nothing after it runs', () => {
  const out = exec([push(1), push('result'), [0x3e], push(2)]);
  assert.deepStrictEqual([out.stack, out.reported], [[1], []]);
});

test('WaitForFrame and WaitForFrame2: every frame up to 16000 is loaded; others skip N records', () => {
  const abc = [push('a'), push('b'), push('c')];
  const wait = (frame, skip) => rec(0x8a, frame & 0xff, frame >> 8, skip);
  assert.deepStrictEqual(exec([wait(16000, 2), ...abc], { clip: target }).stack, ['a', 'b', 'c']);
  assert.deepStrictEqual(exec([wait(16001, 2), ...abc], { clip: target }).stack, ['c'], 'two records skipped, whatever their size');
  assert.deepStrictEqual(exec([wait(16001, 2), ...abc]).stack, ['a', 'b', 'c'], 'without a target the frame counts as loaded');
  assert.deepStrictEqual(exec([wait(16001, 5), push('a'), [0x00], push('z')], { clip: target }).stack, [], 'skipping stops at ActionEndFlag');

  const wait2 = (v) => exec([push(v), rec(0x8d, 1), push('a'), push('b')], { clip: target }).stack;
  assert.deepStrictEqual(wait2(16001), ['a', 'b']);
  assert.deepStrictEqual(wait2(16002), ['b']);
  assert.deepStrictEqual(wait2('16002'), ['b'], 'a string holding an integer');
  assert.deepStrictEqual(wait2('label'), ['a', 'b'], 'any other value is frame 0');
  assert.deepStrictEqual(wait2(16002.5), ['a', 'b']);
  assert.deepStrictEqual(wait2(-2147483648), ['b'], 'Flash Player arithmetic saturates');
  const unknown = exec([push('Date'), [0x1c], rec(0x8d, 1), push('a')], { clip: target });
  assert.deepStrictEqual(unknown.stack, []);
  assert.ok(unknown.reported.includes('avm1:unknownCondition'));
  assert.ok(exec([rec(0x8a, 1)], { clip: target }).reported.includes('avm1:malformedAction'));
});

test('control flow in a frame script: a counter replays a frame twice, then stops, the same way every run', async () => {
  // Frame 2: count = count + 1; if (!(count < 3)) stop(); else { gotoAndPlay(1); }
  const frame2 = assemble([
    push('count', 'count'), [0x1c], push(1), [0x47], [0x1d],
    push('count'), [0x1c], push(3), [0x48], [0x12], { if: 'stop' },
    rec(0x81, 0, 0), [0x06], { jump: 'end' },
    { label: 'stop' }, [0x07],
    { label: 'end' }
  ]);
  const show = () => B.tag(B.T.ShowFrame);
  async function play() {
    const swf = await SWFReader.load(B.swf({ version: 6, frameCount: 3, tags: [show(), B.doAction(frame2), show(), show(), B.tag(B.T.End)] }));
    const movie = new I.Movie(swf), reported = [];
    const env = I.createEnv(movie, (feature) => reported.push(feature));
    const root = new I.Clip(env, movie.root, 0, null);
    root.gotoFrame(1);
    env.scripts.run();
    const frames = [];
    for (let i = 0; i < 5; i++) { env.scripts.beginUpdate(); root.tick(); env.scripts.run(); frames.push(root.frame); }
    return { frames, root, reported };
  }
  const first = await play(), second = await play();
  assert.deepStrictEqual(first.frames, [1, 1, 2, 2, 2]);
  assert.strictEqual(first.root.variables.get('count'), 3);
  assert.strictEqual(first.root.playing, false);
  assert.deepStrictEqual(first.reported, []);
  assert.deepStrictEqual(second.frames, first.frames, 'reproducible');
});
