'use strict';
/* Version matrix: the same AVM1 bytecode, in a SWF of each version from 4 to 10, probes the behaviour that
   Flash Player changes with the SWF version. Each probe stores its result in a root variable; the table
   lists them by version. EXPECTED holds Flash Player's rules;
   tests/unit/corpus.test.js checks the player against it. */
const B = require('../support/swf-builder');
const { push } = require('../support/avm1-asm');

const VERSIONS = [4, 5, 6, 7, 8, 9, 10];
const GET = [0x1c], SET = [0x1d];
// name -> [description, records leaving the probe's value on the stack]
const PROBES = {
  undefinedPlusOne: ['undefined + 1 (Add)', [push(undefined, 1), [0x0a]]],
  trailingText: ['"12abc" * 1', [push('12abc', 1), [0x0c]]],
  hexString: ['"0x10" * 1', [push('0x10', 1), [0x0c]]],
  undefinedText: ['"x" add undefined (StringAdd)', [push('x', undefined), [0x21]]],
  stringTruth: ['!!"abc"', [push('abc'), [0x12], [0x12]]],
  trueText: ['"" add true (StringAdd)', [push('', true), [0x21]]],
  divideByZero: ['1 / 0', [push(1, 0), [0x0d]]],
  unsignedShift: ['-8 >>> 0', [push(-8, 0), [0x65]]],
  caseInsensitive: ['Score = 1; score', [push('Score', 1), SET, push('score'), GET]]
};
const EXPECTED = {
  undefinedPlusOne: { 4: 1, 5: 1, 6: 1, 7: NaN, 8: NaN, 9: NaN, 10: NaN },
  trailingText: { 4: 12, 5: NaN, 6: NaN, 7: NaN, 8: NaN, 9: NaN, 10: NaN },
  hexString: { 4: 0, 5: NaN, 6: 16, 7: 16, 8: 16, 9: 16, 10: 16 },
  undefinedText: { 4: 'x', 5: 'x', 6: 'x', 7: 'xundefined', 8: 'xundefined', 9: 'xundefined', 10: 'xundefined' },
  stringTruth: { 4: false, 5: false, 6: false, 7: true, 8: true, 9: true, 10: true },
  trueText: { 4: '1', 5: 'true', 6: 'true', 7: 'true', 8: 'true', 9: 'true', 10: 'true' },
  divideByZero: { 4: '#ERROR#', 5: Infinity, 6: Infinity, 7: Infinity, 8: Infinity, 9: Infinity, 10: Infinity },
  unsignedShift: { 4: 4294967288, 5: 4294967288, 6: 4294967288, 7: 4294967288, 8: -8, 9: -8, 10: 4294967288 },
  caseInsensitive: { 4: 1, 5: 1, 6: 1, 7: undefined, 8: undefined, 9: undefined, 10: undefined }
};

// A SWF of `version` whose frame script stores every probe in a root variable named after it.
function probeMovie(version) {
  const records = Object.keys(PROBES).map((name) => [push('probe_' + name), PROBES[name][1], SET]);
  return B.swf({ version, frameCount: 1, tags: [B.doAction(records.flat(Infinity)), B.tag(B.T.ShowFrame), B.tag(B.T.End)] });
}
const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));

// Runs every version: { rows: [{ version, results: { probe: value } }], markdown }.
async function versionMatrix() {
  const { SWFReader, RetroFlash } = require('../support/load-reader');
  const I = RetroFlash.internals, rows = [];
  for (const version of VERSIONS) {
    const swf = await SWFReader.load(probeMovie(version));
    const movie = new I.Movie(swf), env = I.createEnv(movie, () => {});
    const root = new I.Clip(env, movie.root, 0, null);
    root.gotoFrame(1);
    env.scripts.run();
    const results = {};
    Object.keys(PROBES).forEach((name) => { results[name] = root.variables.get(version < 7 ? 'probe_' + name.toLowerCase() : 'probe_' + name); });
    rows.push({ version, results });
  }
  const lines = ['| Probe | ' + VERSIONS.map((v) => 'SWF ' + v).join(' | ') + ' |', '|---|' + VERSIONS.map(() => '---').join('|') + '|'];
  Object.keys(PROBES).forEach((name) => lines.push('| `' + PROBES[name][0] + '` | ' + rows.map((r) => show(r.results[name])).join(' | ') + ' |'));
  return { rows, markdown: lines.join('\n') + '\n' };
}

module.exports = { VERSIONS, PROBES, EXPECTED, probeMovie, versionMatrix };
