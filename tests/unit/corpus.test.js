'use strict';
// Compatibility corpus (tools/corpus.js): the layer of each diagnostic, the version matrix against Flash
// Player's rules, the fixture matrix against its committed snapshot, and how failures are classified.
const fs = require('fs');
const path = require('path');
const { test, assert } = require('../support/harness');
const { FIXTURE_DIR } = require('../fixtures/build-fixtures');
const B = require('../support/swf-builder');
const corpus = require('../../tools/corpus');
const { VERSIONS, PROBES, EXPECTED, versionMatrix } = require('../corpus/versions');

const SNAPSHOT = path.join(__dirname, '..', 'corpus', 'fixtures-matrix.json');
const FOLDERS = ['valid', 'warn', 'bad'].map((f) => path.join(FIXTURE_DIR, f));
// The decompressor's wording differs between Node versions, so errors are compared by layer only.
const comparable = (rows) => rows.map((r) => Object.assign({}, r, { error: r.error && r.error.split(':')[0] }));

test('layerOf: each diagnostic belongs to one layer', () => {
  const cases = {
    'tag:Unknown_1000': 'parser', 'actionscript:DoABC': 'parser', 'PlaceObject2.clipActions': 'parser',
    TRUNCATED_DATA: 'parser', MISSING_END: 'parser',
    'avm1:Unknown_0x99': 'vm', 'avm1:maxActionSteps': 'vm', 'avm1:uncaughtThrow': 'vm',
    'avm1:GetURL': 'api', 'avm1:objectValue': 'api', 'sound:DefineSound': 'api', 'load:noLoader': 'api', 'load:failed': 'api',
    'render:blendMode': 'render', 'render:missingCharacter': 'render', 'text:input': 'render',
    'input:keyPress': 'input', 'actionscript:DoAction': null, 'actionscript:DoInitAction': null
  };
  Object.keys(cases).forEach((feature) => assert.strictEqual(corpus.layerOf(feature), cases[feature], feature));
});

test('Version matrix: every probe follows Flash Player\'s rule for SWF 4 to 10', async () => {
  const { rows } = await versionMatrix();
  assert.deepStrictEqual(rows.map((r) => r.version), VERSIONS);
  for (const row of rows) {
    for (const name of Object.keys(PROBES)) {
      const got = row.results[name], want = EXPECTED[name][row.version];
      assert.ok(Object.is(got, want), `${name} in SWF ${row.version}: got ${String(got)}, expected ${String(want)}`);
    }
  }
});

test('Fixture matrix: the same on every run and equal to tests/corpus/fixtures-matrix.json', async () => {
  const files = corpus.collect(FOLDERS);
  const first = await corpus.matrix(files), second = await corpus.matrix(files);
  assert.deepStrictEqual(first, second);
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  assert.deepStrictEqual(comparable(first), comparable(snapshot), 'run `npm run corpus:fixtures` and review the diff');
  const game = first.find((r) => r.name === 'fws-game.swf');
  assert.strictEqual(game.status, 'ok');
  assert.ok(game.actions.steps > 0);
  const md = corpus.toMarkdown(first);
  assert.strictEqual(md.split('\n').filter(Boolean).length, files.length + 2);
});

test('Classification: a file the reader rejects fails in the parser layer', async () => {
  const r = await corpus.analyze(new Uint8Array([0x46, 0x57, 0x53, 10, 8, 0, 0, 0]), 'short.swf');
  assert.strictEqual(r.status, 'failed');
  assert.strictEqual(r.layers.parser.status, 'failed');
  assert.ok(/^parser: /.test(r.error));
  ['vm', 'api', 'render', 'input'].forEach((l) => assert.strictEqual(r.layers[l].status, 'ok'));
});

test('Classification: an ActionScript 3 movie fails in the vm layer', async () => {
  const bytes = B.swf({ version: 10, frameCount: 1, tags: [
    B.tag(B.T.FileAttributes, B.body((w) => w.u32(0x08))), B.tag(B.T.ShowFrame), B.tag(B.T.End)
  ] });
  const r = await corpus.analyze(bytes, 'as3.swf');
  assert.strictEqual(r.avm, 2);
  assert.strictEqual(r.status, 'failed');
  assert.strictEqual(r.layers.vm.status, 'failed');
  assert.deepStrictEqual(r.layers.parser.features, { AVM2_DECLARED: 1 });
});

test('Classification: unknown actions are vm diagnostics, URLs are api diagnostics', async () => {
  const bytes = B.swf({ version: 6, frameCount: 1, tags: [
    // An action code no Flash Player version defines (0x01), then GetURL "a" "" (0x83).
    B.doAction([0x01, 0x83, 0x03, 0x00, 0x61, 0x00, 0x00, 0x00]), B.tag(B.T.ShowFrame), B.tag(B.T.End)
  ] });
  const r = await corpus.analyze(bytes, 'mixed.swf', { frames: 2 });
  assert.strictEqual(r.status, 'degraded');
  assert.strictEqual(r.layers.parser.status, 'ok');
  assert.strictEqual(r.layers.vm.status, 'degraded', JSON.stringify(r.layers.vm));
  assert.deepStrictEqual(Object.keys(r.layers.api.features), ['avm1:GetURL']);
});
