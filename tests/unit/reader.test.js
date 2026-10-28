'use strict';
const fs = require('fs');
const path = require('path');
const { test, assert, rejectsWithCode } = require('../support/harness');
const { SWFReader } = require('../support/load-reader');
const { body, tag, T, swf } = require('../support/swf-builder');
const { FIXTURE_DIR } = require('../fixtures/build-fixtures');

const fixture = (name) => new Uint8Array(fs.readFileSync(path.join(FIXTURE_DIR, name)));
const codes = (movie) => movie.diagnostics.map((d) => d.code).sort();

test('public API: frozen SWFReader with load, BitReader, version and tag names', () => {
  assert.ok(Object.isFrozen(SWFReader));
  assert.strictEqual(typeof SWFReader.load, 'function');
  assert.strictEqual(typeof SWFReader.BitReader, 'function');
  assert.strictEqual(SWFReader.version, '0.6.0');
  assert.strictEqual(SWFReader.tagNames[39], 'DefineSprite');
  assert.deepStrictEqual({ ...SWFReader.defaultOptions }, { maxFileBytes: 52428800, maxTags: 500000, maxSpriteDepth: 4, strict: false });
});

test('load() accepts Uint8Array, ArrayBuffer, Buffer/DataView and Blob', async () => {
  const bytes = fixture('valid/fws-minimal.swf');
  const inputs = [bytes, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), Buffer.from(bytes),
    new DataView(bytes.buffer, bytes.byteOffset, bytes.length)];
  if (typeof Blob === 'function') inputs.push(new Blob([bytes]));
  for (const input of inputs) assert.strictEqual((await SWFReader.load(input)).tags.length, 4);
  await rejectsWithCode(SWFReader.load('movie.swf'), 'INVALID_INPUT');
  await rejectsWithCode(SWFReader.load(null), 'INVALID_INPUT');
});

test('phase-1 compatible fields are preserved', async () => {
  const movie = await SWFReader.load(fixture('valid/fws-minimal.swf'));
  assert.strictEqual(movie.compression, 'none');
  assert.strictEqual(movie.declaredLength, movie.sourceLength);
  assert.deepStrictEqual(movie.background, { r: 0x33, g: 0x66, b: 0x99 });
  assert.deepStrictEqual(movie.bounds, { xminTwips: 0, xmaxTwips: 11000, yminTwips: 0, ymaxTwips: 8000, nBits: 15, width: 550, height: 400, nextOffset: 17 });
  assert.strictEqual(movie.fileAttributes.actionScript3, false);
  assert.strictEqual(movie.fileAttributes.useNetwork, false);
  assert.deepStrictEqual(movie.codeTags, { avm1: 0, avm2: 0, clipActions: 0, buttonActions: 0 });
  assert.deepStrictEqual(movie.warnings, []);
  assert.deepStrictEqual(movie.frames, [{ number: 1, endTagIndex: 2, labels: [] }]);
  const first = movie.tags[0];
  assert.deepStrictEqual({ ...first, fields: undefined }, {
    index: 0, path: '0', level: 0, code: 69, name: 'FileAttributes', offset: 21, dataOffset: 23, headerLength: 2,
    longHeader: false, length: 4, frame: 1, status: 'decoded', fields: undefined
  });
  assert.deepStrictEqual(Array.from(movie.getTagData(1)), [0x33, 0x66, 0x99]);
});

test('CWS decodes to exactly the same structure as the FWS original', async () => {
  const fws = await SWFReader.load(fixture('valid/fws-minimal.swf'));
  const cws = await SWFReader.load(fixture('valid/cws-minimal.swf'));
  assert.strictEqual(cws.compression, 'zlib');
  assert.strictEqual(cws.declaredLength, fws.declaredLength);
  assert.ok(cws.sourceLength !== fws.sourceLength);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(cws.tags)), JSON.parse(JSON.stringify(fws.tags)));
  assert.deepStrictEqual(Array.from(cws.getTagData(1)), [0x33, 0x66, 0x99]);
});

test('CWS without DecompressionStream is rejected explicitly; FWS still loads', async () => {
  const saved = globalThis.DecompressionStream;
  globalThis.DecompressionStream = undefined;
  try {
    await rejectsWithCode(SWFReader.load(fixture('valid/cws-minimal.swf')), 'CWS_UNSUPPORTED');
    assert.strictEqual((await SWFReader.load(fixture('valid/fws-minimal.swf'))).tags.length, 4);
  } finally {
    globalThis.DecompressionStream = saved;
  }
});

test('timeline fixture: frames, labels, long header and every decoded placement', async () => {
  const movie = await SWFReader.load(fixture('valid/fws-timeline.swf'));
  const t = movie.tags;
  assert.deepStrictEqual(movie.frames, [
    { number: 1, endTagIndex: 8, labels: ['intro'] },
    { number: 2, endTagIndex: 14, labels: ['outro'] }
  ]);
  assert.deepStrictEqual(t.map((x) => x.frame), [1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 3], 'End reports the frame after the last ShowFrame (as in v0.1)');
  assert.deepStrictEqual(t.map((x) => x.status), ['decoded', 'decoded', 'decoded', 'decoded', 'decoded', 'decoded', 'decoded',
    'not-executed', 'decoded', 'decoded', 'decoded', 'decoded', 'decoded', 'decoded', 'decoded', 'decoded']);

  assert.deepStrictEqual(t[5].fields, {
    characterId: 2, depth: 1,
    matrix: { hasScale: true, scaleX: 2, scaleY: 2, hasRotate: false, rotateSkew0: 0, rotateSkew1: 0, translateX: 400, translateY: 800 },
    colorTransform: { hasAddTerms: true, hasMultTerms: true, redMult: 128, redAdd: 10, greenMult: 256, greenAdd: -10, blueMult: 256, blueAdd: 0 }
  });
  assert.deepStrictEqual(t[6].fields, {
    move: false, depth: 2, characterId: 1,
    matrix: { hasScale: true, scaleX: 1.5, scaleY: -0.5, hasRotate: false, rotateSkew0: 0, rotateSkew1: 0, translateX: -20, translateY: 31 },
    colorTransform: { hasAddTerms: true, hasMultTerms: true, redMult: 256, redAdd: -255, greenMult: 128, greenAdd: 0, blueMult: 0, blueAdd: 255, alphaMult: -256, alphaAdd: 1 },
    name: 'clip_ñ'
  });
  assert.deepStrictEqual(t[9].fields, { move: true, depth: 2, ratio: 300 });
  assert.deepStrictEqual(t[10].fields, { characterId: 2, depth: 1 });
  assert.strictEqual(t[11].longHeader, true);
  assert.strictEqual(t[11].headerLength, 6);
  assert.strictEqual(t[11].label, 'outro');
  assert.deepStrictEqual(t[12].fields, {
    move: false, depth: 3, characterId: 2,
    matrix: { hasScale: false, scaleX: 1, scaleY: 1, hasRotate: false, rotateSkew0: 0, rotateSkew1: 0, translateX: 0, translateY: 0 },
    blendMode: 3, bitmapCache: 1
  });
  assert.deepStrictEqual(t[13].fields, { depth: 2 });
  assert.deepStrictEqual(movie.codeTags, { avm1: 1, avm2: 0, clipActions: 0, buttonActions: 0 });
  assert.deepStrictEqual(Array.from(movie.getTagData(7)), [0x07, 0x00], 'DoAction bytes are available, never executed');
});

test('DefineSprite contents are indexed recursively with sprite-local frames', async () => {
  const movie = await SWFReader.load(fixture('valid/fws-timeline.swf'));
  const sprite = movie.tags[3];
  assert.strictEqual(sprite.spriteId, 1);
  assert.strictEqual(sprite.spriteFrames, 2);
  assert.strictEqual(sprite.actualFrameCount, 2);
  assert.strictEqual(sprite.endFound, true);
  assert.deepStrictEqual(sprite.children.map((c) => [c.path, c.level, c.name, c.frame]), [
    ['3/0', 1, 'PlaceObject2', 1], ['3/1', 1, 'ShowFrame', 1], ['3/2', 1, 'FrameLabel', 2],
    ['3/3', 1, 'PlaceObject2', 2], ['3/4', 1, 'ShowFrame', 2], ['3/5', 1, 'End', 3]
  ]);
  assert.deepStrictEqual(sprite.frames, [{ number: 1, endTagIndex: 1, labels: [] }, { number: 2, endTagIndex: 4, labels: ['spin'] }]);
  assert.deepStrictEqual(sprite.children[3].fields.matrix, {
    hasScale: false, scaleX: 1, scaleY: 1, hasRotate: true, rotateSkew0: 0.5, rotateSkew1: -0.5, translateX: 100, translateY: 200
  });
  assert.deepStrictEqual(Array.from(movie.getTagData(sprite.children[2])), [0x73, 0x70, 0x69, 0x6e, 0x00]);
  const seen = [];
  movie.walkTags((t, parent) => seen.push(t.path + (parent ? '<' + parent.path : '')));
  assert.strictEqual(seen.length, movie.totalTagCount);
  assert.strictEqual(movie.totalTagCount, 22);
  assert.strictEqual(movie.spriteCount, 1);
  assert.ok(seen.includes('3/5<3'));
});

test('nested sprites recurse; maxSpriteDepth stops indexing with a diagnostic', async () => {
  const bytes = fixture('valid/fws-nested-sprite.swf');
  const full = await SWFReader.load(bytes);
  const inner = full.tags[1].children[0];
  assert.strictEqual(inner.path, '1/0');
  assert.deepStrictEqual(inner.children.map((c) => c.path + ':' + c.name), ['1/0/0:ShowFrame', '1/0/1:End']);
  assert.strictEqual(full.spriteCount, 3);

  const shallow = await SWFReader.load(bytes, { maxSpriteDepth: 1 });
  assert.ok(codes(shallow).includes('SPRITE_DEPTH_EXCEEDED'));
  const cut = shallow.tags[1].children[0];
  assert.strictEqual(cut.status, 'partial');
  assert.deepStrictEqual(cut.children, []);
  assert.ok(shallow.unsupported.some((u) => u.feature === 'DefineSprite.controlTags'));

  const none = await SWFReader.load(bytes, { maxSpriteDepth: 0 });
  assert.strictEqual(none.tags[1].status, 'partial');
  assert.strictEqual(none.totalTagCount, 5);
});

test('unsupported content is listed with counts, reasons and first location', async () => {
  const movie = await SWFReader.load(fixture('valid/fws-unsupported.swf'));
  const byFeature = Object.fromEntries(movie.unsupported.map((u) => [u.feature, u]));
  assert.strictEqual(movie.tags[1].status, 'unknown');
  assert.strictEqual(byFeature['tag:Unknown_1000'].count, 1);
  assert.strictEqual(byFeature['tag:Unknown_1000'].firstPath, '1');
  assert.match(byFeature['actionscript:DoABC'].reason, /never executed/);
  assert.strictEqual(movie.tags[3].status, 'decoded', 'clip actions are read (here, none)');
  assert.deepStrictEqual(movie.tags[3].fields, { move: false, depth: 1, characterId: 2, hasClipActions: true, clipActions: [] });
  assert.strictEqual(movie.tags[4].status, 'decoded');
  assert.deepStrictEqual(movie.tags[4].fields, { move: false, depth: 2, characterId: 2, filters: ['blur'], blendMode: 3 });
  assert.deepStrictEqual(movie.codeTags, { avm1: 0, avm2: 1, clipActions: 1, buttonActions: 0 });
});

test('invalid tag bodies become diagnostics; strict mode rejects them', async () => {
  const bytes = fixture('warn/fws-invalid-bodies.swf');
  const movie = await SWFReader.load(bytes);
  assert.deepStrictEqual(movie.tags.map((t) => t.status), ['decoded', 'invalid', 'invalid', 'invalid', 'decoded', 'decoded']);
  const placement = movie.diagnostics.find((d) => d.path === '1');
  assert.strictEqual(placement.level, 'error');
  assert.match(placement.message, /PlaceObject2 at offset \d+: MATRIX\.ScaleY needs 2 bit/);
  assert.strictEqual(movie.warnings.length, 4);
  assert.strictEqual(movie.background, null);
  await rejectsWithCode(SWFReader.load(bytes, { strict: true }), 'TRUNCATED_DATA');
  await rejectsWithCode(SWFReader.load(fixture('warn/fws-sprite-overflow.swf'), { strict: true }), 'TAG_OUT_OF_BOUNDS');
});

test('a malformed sprite keeps the children read before the error', async () => {
  const movie = await SWFReader.load(fixture('warn/fws-sprite-overflow.swf'));
  const sprite = movie.tags[1];
  assert.strictEqual(sprite.status, 'invalid');
  assert.deepStrictEqual(sprite.children.map((c) => c.name), ['ShowFrame']);
  assert.strictEqual(sprite.actualFrameCount, 1);
  assert.deepStrictEqual(movie.tags.slice(2).map((t) => t.name), ['ShowFrame', 'End']);
});

test('limits: maxFileBytes, maxTags and option validation', async () => {
  const bytes = fixture('valid/fws-timeline.swf');
  await rejectsWithCode(SWFReader.load(bytes, { maxFileBytes: 100 }), 'FILE_TOO_LARGE');
  await rejectsWithCode(SWFReader.load(bytes, { maxTags: 10 }), 'TOO_MANY_TAGS');
  await rejectsWithCode(SWFReader.load(bytes, { maxTags: 21 }), 'TOO_MANY_TAGS'); // 22 with sprite children
  assert.strictEqual((await SWFReader.load(bytes, { maxTags: 22 })).totalTagCount, 22);
  if (typeof Blob === 'function') await rejectsWithCode(SWFReader.load(new Blob([bytes]), { maxFileBytes: 10 }), 'FILE_TOO_LARGE');
  await rejectsWithCode(SWFReader.load(bytes, { maxTags: -1 }), 'INVALID_OPTION');
  await rejectsWithCode(SWFReader.load(bytes, { maxSpriteDepth: 1.5 }), 'INVALID_OPTION');
  await rejectsWithCode(SWFReader.load(bytes, 'strict'), 'INVALID_OPTION');
});

test('getTagData rejects tags that are missing or outside the file', async () => {
  const movie = await SWFReader.load(fixture('valid/fws-minimal.swf'));
  for (const bad of [4, -1, 1.5, null, {}, { dataOffset: 0, length: 9999 }]) {
    assert.throws(() => movie.getTagData(bad), (err) => err.code === 'INVALID_TAG');
  }
});

test('versioned strings and FrameLabel named anchors', async () => {
  const label = (version, data) => SWFReader.load(swf({ version, tags: [tag(T.FrameLabel, Uint8Array.from(data)), tag(T.ShowFrame), tag(T.End)] }));
  assert.strictEqual((await label(5, [0xe9, 0x00])).tags[0].label, 'é', 'SWF 5: Latin-1');
  assert.strictEqual((await label(6, [0xc3, 0xa9, 0x00])).tags[0].label, 'é', 'SWF 6: UTF-8');
  const anchored = await label(6, [0x61, 0x00, 0x01]);
  assert.strictEqual(anchored.tags[0].fields.namedAnchor, true);
  const old = await label(5, [0x61, 0x00, 0x01]);
  assert.deepStrictEqual(codes(old), ['TAG_EXTRA_BYTES'], 'SWF 5 has no named-anchor flag');
});

test('header diagnostics: FileAttributes rules, AVM2 flag, CWS version, stage RECT', async () => {
  const end = [tag(T.ShowFrame), tag(T.End)];
  const attrs = (raw) => tag(T.FileAttributes, body((w) => w.u32(raw)));
  assert.deepStrictEqual(codes(await SWFReader.load(swf({ version: 8, tags: end }))), ['FILE_ATTRIBUTES_MISSING']);
  assert.deepStrictEqual(codes(await SWFReader.load(swf({ version: 6, tags: end }))), []);
  assert.deepStrictEqual(codes(await SWFReader.load(swf({ version: 9, tags: [tag(T.SetBackgroundColor, Uint8Array.from([0, 0, 0])), attrs(0), ...end] }))),
    ['FILE_ATTRIBUTES_NOT_FIRST']);
  const as3 = await SWFReader.load(swf({ version: 9, tags: [attrs(0x08 | 0x01), ...end] }));
  assert.deepStrictEqual(codes(as3), ['AVM2_DECLARED']);
  assert.strictEqual(as3.fileAttributes.actionScript3, true);
  assert.strictEqual(as3.fileAttributes.useNetwork, true);
  assert.deepStrictEqual(codes(await SWFReader.load(swf({ signature: 'CWS', version: 5, tags: end }))), ['CWS_OLD_VERSION']);
  const flipped = await SWFReader.load(swf({ version: 6, stage: { xMin: 100, xMax: -100, yMin: 0, yMax: 20 }, tags: end }));
  assert.deepStrictEqual(codes(flipped), ['INVALID_STAGE_RECT']);
  assert.strictEqual(flipped.width, -10);
});

test('controlled fuzz: byte mutations and truncations only ever produce SWFReaderError', async () => {
  const original = fixture('valid/fws-timeline.swf');
  let loaded = 0, rejected = 0;
  const attempt = async (bytes) => {
    try { await SWFReader.load(bytes); loaded++; } catch (err) {
      assert.strictEqual(err.name, 'SWFReaderError', 'unexpected ' + (err && err.stack));
      assert.ok(typeof err.code === 'string');
      rejected++;
    }
  };
  for (let i = 0; i < original.length; i++) {
    for (const value of [0x00, 0xff, original[i] ^ 0x01, original[i] ^ 0x80, 0x3f]) {
      const mutated = original.slice();
      mutated[i] = value;
      await attempt(mutated);
    }
  }
  for (let length = 0; length < original.length; length++) {
    const cut = original.slice(0, length);
    if (length >= 8) { cut[4] = length & 0xff; cut[5] = length >>> 8; cut[6] = 0; cut[7] = 0; }
    await attempt(cut);
  }
  assert.ok(loaded > 0 && rejected > 0, `loaded ${loaded}, rejected ${rejected}`);
});
