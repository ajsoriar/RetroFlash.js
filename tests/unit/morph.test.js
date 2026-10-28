'use strict';
// Morph shapes: DefineMorphShape and DefineMorphShape2 bodies, the interpolated shape of each ratio (edges,
// styles, bounds, cache), and morph shapes on a timeline: ratios from PlaceObject2, geometry, hit testing,
// bounds and masks. Drawing itself is checked in a browser with demo/player.html and fws-morph.swf.
const fs = require('fs');
const path = require('path');
const { test, assert } = require('../support/harness');
const { SWFReader, RetroFlash } = require('../support/load-reader');
const { FIXTURE_DIR } = require('../fixtures/build-fixtures');
const { FRAMES, ratioAt } = require('../fixtures/morph');
const B = require('../support/swf-builder');

const I = RetroFlash.internals;
const fixture = () => SWFReader.load(new Uint8Array(fs.readFileSync(path.join(FIXTURE_DIR, 'valid/fws-morph.swf'))));
const show = () => B.tag(B.T.ShowFrame);
const end = () => B.tag(B.T.End);

// Absolute points visited by shape records: [[x, y, kind]], kind 'M' move, 'L' line, 'Q' curve (control first).
function points(records) {
  const out = [];
  let x = 0, y = 0;
  for (const r of records) {
    if (r.type === 'style') { if (r.moveTo) { x = r.moveTo.x; y = r.moveTo.y; out.push(['M', x, y]); } continue; }
    if (r.type === 'line') { x += r.dx; y += r.dy; out.push(['L', x, y]); continue; }
    out.push(['Q', x + r.cdx, y + r.cdy, x + r.cdx + r.adx, y + r.cdy + r.ady]);
    x += r.cdx + r.adx; y += r.cdy + r.ady;
  }
  return out;
}

async function setup(bytes) {
  const swf = bytes ? await SWFReader.load(bytes) : await fixture();
  const movie = new I.Movie(swf), reported = [];
  const env = I.createEnv(movie, (feature, reason, source) => reported.push([feature, source]));
  const root = new I.Clip(env, movie.root, 0, null);
  root.gotoFrame(1);
  return { swf, movie, env, root, reported, tick: () => root.tick() };
}

// ---- Reader -------------------------------------------------------------------------------------------------

test('reader: DefineMorphShape and DefineMorphShape2 give paired styles and both edge lists', async () => {
  const swf = await fixture();
  const [m1, m2] = swf.tags.filter((t) => t.code === 46 || t.code === 84);
  assert.deepStrictEqual([m1.status, m2.status, m1.name, m2.name], ['decoded', 'decoded', 'DefineMorphShape', 'DefineMorphShape2']);
  const a = m1.fields, b = m2.fields;
  assert.deepStrictEqual([a.characterId, a.morphVersion, a.startBounds.xMax, a.endBounds.xMax], [1, 1, 820, 880]);
  assert.deepStrictEqual(a.fillStyles, [{ start: { type: 'solid', color: { r: 230, g: 57, b: 70, a: 255 } }, end: { type: 'solid', color: { r: 37, g: 99, b: 235, a: 255 } } }]);
  assert.deepStrictEqual(a.lineStyles, [{ start: { width: 40, color: { r: 255, g: 255, b: 255, a: 255 } }, end: { width: 160, color: { r: 250, g: 204, b: 21, a: 255 } } }]);
  assert.deepStrictEqual(a.startRecords.map((r) => r.type), ['style', 'line', 'line', 'line', 'line']);
  assert.deepStrictEqual(a.endRecords.map((r) => r.type), ['style', 'curve', 'curve', 'curve', 'curve']);
  assert.deepStrictEqual(a.endRecords[0], { type: 'style', moveTo: { x: 0, y: -800 } }, 'end edges: moves only');
  assert.deepStrictEqual([b.morphVersion, b.startEdgeBounds.xMax, b.endEdgeBounds.yMax, b.usesScalingStrokes, b.usesNonScalingStrokes], [2, 630, 710, true, false]);
  const fill = b.fillStyles[0];
  assert.deepStrictEqual([fill.start.type, fill.end.type, fill.end.matrix.hasRotate], ['linear', 'linear', true]);
  assert.deepStrictEqual(fill.end.gradient.stops.map((s) => s.ratio), [0, 128]);
  assert.deepStrictEqual([b.lineStyles[0].start.width, b.lineStyles[0].end.width, b.lineStyles[0].start.startCap, b.lineStyles[0].end.join], [60, 20, 0, 0]);
  assert.deepStrictEqual(swf.diagnostics, []);
});

test('reader: focal and bitmap morph fills, MORPHLINESTYLE2 with a miter join; a bad fill type invalidates the tag', async () => {
  const records = [{ move: [0, 0], fill1: 1 }, { to: [100, 0] }, { to: [0, 100] }, { to: [0, 0] }];
  const swf = await SWFReader.load(B.swf({ version: 8, tags: [
    B.tag(B.T.FileAttributes, B.body((w) => w.u32(0))),
    B.defineMorphShape(3, {
      version: 2, startBounds: { xMax: 100, yMax: 100 }, endBounds: { xMax: 100, yMax: 100 },
      fills: [
        { start: { focal: { matrix: {}, stops: [[0, [0, 0, 0]], [255, [255, 0, 0]]], focalPoint: 0.5 } }, end: { focal: { matrix: {}, stops: [[10, [0, 0, 255]], [200, [0, 255, 0]]], focalPoint: -0.25 } } },
        { start: { bitmap: { id: 9, matrix: { scaleX: 20, scaleY: 20 } } }, end: { bitmap: { id: 9, matrix: { scaleX: 40, scaleY: 40 } } } }
      ],
      lines: [{ start: { width: 20, color: [1, 2, 3], join: 2, miterLimit: 4 }, end: { width: 40, color: [4, 5, 6] } }],
      startRecords: records, endRecords: [{ move: [0, 0] }, { to: [50, 0] }, { to: [0, 50] }, { to: [0, 0] }]
    }),
    B.tag(46, Uint8Array.from([4, 0, 0, 0, 0, 0, 0, 0, 1, 0x07])), // fill style type 7
    show(), end()
  ] }));
  const [focal, bitmap] = swf.tags[1].fields.fillStyles;
  assert.deepStrictEqual([focal.start.type, focal.start.gradient.focalPoint, focal.end.gradient.focalPoint], ['focal', 0.5, -0.25]);
  assert.deepStrictEqual([bitmap.start.bitmapId, bitmap.start.matrix.scaleX, bitmap.end.matrix.scaleX, bitmap.start.repeat, bitmap.start.smooth], [9, 20, 40, false, true]);
  assert.deepStrictEqual([swf.tags[1].fields.lineStyles[0].start.join, swf.tags[1].fields.lineStyles[0].start.miterLimit], [2, 4]);
  assert.strictEqual(swf.tags[2].status, 'invalid');
  const movie = new I.Movie(swf);
  assert.deepStrictEqual([movie.characters[3].type, movie.characters[4].type], ['morphShape', 'unsupported']);
});

// ---- Interpolation ------------------------------------------------------------------------------------------

test('edges: ratio 0 is the start shape, 65535 the end shape; straight edges paired with curves become curves', async () => {
  const { movie } = await setup();
  const m = movie.characters[1].morph;
  const at = (t) => points(I.morphRecords(m.startRecords, m.endRecords, t).records);
  assert.deepStrictEqual(at(0), [['M', -800, -800], ['Q', 0, -800, 800, -800], ['Q', 800, 0, 800, 800], ['Q', 0, 800, -800, 800], ['Q', -800, 0, -800, -800]],
    'the square, its control points at the middle of each side');
  assert.deepStrictEqual(at(1), [['M', 0, -800], ['Q', 800, -800, 800, 0], ['Q', 800, 800, 0, 800], ['Q', -800, 800, -800, 0], ['Q', -800, -800, 0, -800]]);
  assert.deepStrictEqual(at(0.5), [['M', -400, -800], ['Q', 400, -800, 800, -400], ['Q', 800, 400, 400, 800], ['Q', -400, 800, -800, 400], ['Q', -800, -400, -400, -800]]);
  assert.deepStrictEqual(at(1 / 3).slice(0, 2), [['M', -533, -800], ['Q', 267, -800, 800, -533]], 'whole twips');
  const lines = I.morphRecords([{ type: 'style', moveTo: { x: 0, y: 0 } }, { type: 'line', dx: 100, dy: 0 }], [{ type: 'line', dx: 0, dy: 100 }], 0.5);
  assert.deepStrictEqual(points(lines.records), [['M', 0, 0], ['L', 50, 50]], 'a move on one side keeps the other pen');
  const extra = I.morphRecords([{ type: 'line', dx: 1, dy: 0 }, { type: 'line', dx: 1, dy: 0 }], [{ type: 'line', dx: 2, dy: 0 }], 0);
  assert.deepStrictEqual([extra.records.length, extra.unpaired], [1, 1]);
});

test('styles and bounds: colours, widths, gradient matrix and stops interpolated; the end of a closed contour meets its start', async () => {
  const { movie } = await setup();
  const half = I.morphFrame(movie.characters[1], 32768).shape;
  assert.deepStrictEqual(half.fillStyles[0].color, { r: 133, g: 78, b: 153, a: 255 });
  assert.deepStrictEqual([half.lineStyles[0].width, half.lineStyles[0].color], [100, { r: 252, g: 229, b: 138, a: 255 }]);
  assert.deepStrictEqual([half.shapeVersion, half.bounds], [3, { xMin: -850, xMax: 850, yMin: -850, yMax: 850 }]);
  const gradient = I.morphFrame(movie.characters[2], 65535).shape;
  assert.strictEqual(gradient.shapeVersion, 4);
  assert.deepStrictEqual(gradient.fillStyles[0].gradient.stops.map((s) => [s.ratio, s.color.r]), [[0, 147], [128, 249]]);
  const mid = I.morphFrame(movie.characters[2], 32768).shape.fillStyles[0];
  assert.ok(Math.abs(mid.matrix.scaleX - 0.0366) < 0.001 && Math.abs(mid.matrix.rotateSkew0 - 0.0427) < 0.001 && mid.matrix.hasRotate);
  assert.strictEqual(mid.gradient.stops[1].ratio, 191); // 32768 / 65535 is just above one half
  assert.strictEqual(I.morphFrame(movie.characters[2], 32768).shape.lineStyles[0].startCap, 0);
  for (const ratio of [0, 12345, 32768, 65535]) {
    const geometry = I.geometryOf(I.morphFrame(movie.characters[1], ratio), () => {});
    const commands = geometry.groups[0].fills[0].commands;
    let moves = 0;
    for (let i = 0; i < commands.length; i += commands[i] === 2 ? 5 : 3) if (commands[i] === 0) moves++;
    assert.strictEqual(moves, 1);
    assert.deepStrictEqual(commands.slice(1, 3), commands.slice(-2), 'one closed contour at ratio ' + ratio);
  }
});

test('cache: one shape per ratio, at most 32 kept; a missing ratio is 0 and ratios above 65535 are the end', async () => {
  const { movie } = await setup();
  const c = movie.characters[1];
  assert.strictEqual(I.morphFrame(c, 100), I.morphFrame(c, 100));
  assert.strictEqual(I.morphFrame(c, undefined), I.morphFrame(c, 0));
  assert.deepStrictEqual(I.morphFrame(c, 70000).shape.records, I.morphFrame(c, 65535).shape.records);
  for (let r = 1000; r < 1040; r++) I.morphFrame(c, r);
  assert.strictEqual(c.frames.size, 32);
  assert.ok(!c.frames.has(100) && c.frames.has(1039), 'the oldest ratios go first');
  assert.deepStrictEqual(I.morphBounds(c, 65535), { xMin: -880, xMax: 880, yMin: -880, yMax: 880 });
});

// ---- On a timeline ------------------------------------------------------------------------------------------

test('timeline: PlaceObject2 ratios select the shape; hit testing, bounds and masks follow it; nothing is reported', async () => {
  const g = await setup();
  const obj = g.root.displayList.get(1), world = obj.matrix;
  assert.strictEqual(obj.character.type, 'morphShape');
  const corner = [1800 + 750, 2000 - 750]; // inside the square, outside the circle
  assert.deepStrictEqual([obj.ratio, I.hitTestObject(obj, world, corner[0], corner[1], () => {})], [0, true]);
  const seen = [];
  for (let frame = 2; frame <= FRAMES; frame++) { g.tick(); seen.push(obj.ratio); }
  assert.deepStrictEqual(seen, Array.from({ length: FRAMES - 1 }, (_, i) => ratioAt(i + 2)));
  assert.strictEqual(I.hitTestObject(obj, world, corner[0], corner[1], () => {}), false, 'the circle does not reach the corner');
  assert.strictEqual(I.hitTestObject(obj, world, 1800, 2000 - 790, () => {}), true);
  assert.deepStrictEqual(I.contentBounds(obj), { xMin: -880, xMax: 880, yMin: -880, yMax: 880 });
  // Drawn and used as a mask through the renderer, on a context that records what it is asked to do.
  const calls = [];
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...a) => { calls.push(k); return { addColorStop() {} }; }), set: (t, k, v) => { t[k] = v; return true; } });
  if (!globalThis.Path2D) globalThis.Path2D = class { addPath() {} moveTo() {} lineTo() {} quadraticCurveTo() {} closePath() {} };
  if (!globalThis.DOMMatrix) globalThis.DOMMatrix = class { constructor(m) { this.m = m; } };
  const renderer = new I.CanvasRenderer({ getContext: () => ctx, width: 320, height: 200 }, (f) => g.reported.push([f]));
  const stage = { background: null, xMin: 0, yMin: 0, characters: g.movie.characters, widthTwips: 6400, heightTwips: 4000 };
  renderer.render(stage, g.root);
  assert.ok(calls.filter((k) => k === 'fill').length >= 1 && calls.filter((k) => k === 'stroke').length === 2, 'both morphs filled and stroked');
  obj.clipDepth = 2;
  calls.length = 0;
  renderer.render(stage, g.root);
  assert.ok(calls.includes('clip'), 'a morph shape masks');
  assert.deepStrictEqual(g.reported, []);
});

test('a morph shape whose edges do not pair up is drawn as far as they do, and reported once', async () => {
  const morph = B.defineMorphShape(1, {
    startBounds: { xMax: 100, yMax: 100 }, endBounds: { xMax: 100, yMax: 100 },
    fills: [{ start: { color: [0, 0, 0] }, end: { color: [9, 9, 9] } }], lines: [],
    startRecords: [{ move: [0, 0], fill1: 1 }, { to: [100, 0] }, { to: [0, 100] }, { to: [0, 0] }],
    endRecords: [{ move: [0, 0] }, { to: [100, 0] }]
  });
  const place = B.tag(B.T.PlaceObject2, B.body((w) => { w.u8(0x02 | 0x10).u16(1).u16(1).u16(30000); }));
  const g = await setup(B.swf({ version: 6, tags: [morph, place, show(), end()] }));
  const obj = g.root.displayList.get(1);
  I.morphFrame(obj.character, 1, g.env.report);
  I.morphFrame(obj.character, 2, g.env.report);
  assert.deepStrictEqual(g.reported, [['render:morphEdges', '1: 2 edge(s)']]);
  assert.strictEqual(I.morphFrame(obj.character, 1).shape.records.filter((r) => r.type !== 'style').length, 1);
});
