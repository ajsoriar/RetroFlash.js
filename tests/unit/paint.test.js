'use strict';
// Drawing details: per-channel colour transforms on bitmaps, clipped bitmap fills extending their edges, gradient
// spread modes, gradient line fills, non-scaling strokes, 9-slice scaling (DefineScalingGrid) and DefineFont4.
// The renderer runs on stand-in canvases that record what they are asked to do; tests/fixtures/valid/fws-paint.swf
// is checked by eye (and by pixel) in a browser.
const fs = require('fs');
const path = require('path');
const { test, assert } = require('../support/harness');
const { SWFReader, RetroFlash } = require('../support/load-reader');
const { FIXTURE_DIR } = require('../fixtures/build-fixtures');
const B = require('../support/swf-builder');

const I = RetroFlash.internals;
const H = 16384;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
if (!globalThis.Path2D) globalThis.Path2D = class { addPath() {} moveTo() {} lineTo() {} quadraticCurveTo() {} closePath() {} };
if (!globalThis.DOMMatrix) globalThis.DOMMatrix = class { constructor(m) { this.m = m; } };

// A 2D context that records calls ([name, ...args]) and property writes (['set', name, value]).
function recordingContext(extra = {}) {
  const calls = [];
  const target = Object.assign({ calls }, extra);
  return new Proxy(target, {
    get: (t, k) => (k in t ? t[k] : (...args) => {
      calls.push([k, ...args]);
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return { kind: k, args, stops: [], addColorStop(at, color) { this.stops.push([at, color]); } };
      return {};
    }),
    set: (t, k, v) => { calls.push(['set', k, v]); t[k] = v; return true; }
  });
}
function renderer(canvas = { width: 480, height: 320 }) {
  const ctx = recordingContext(), reported = [];
  const r = new I.CanvasRenderer(Object.assign({ getContext: () => ctx }, canvas), (feature, reason, source) => reported.push([feature, source]));
  r.stageX = r.stageY = 1 / 20; // one pixel per 20 twips
  return { r, ctx, reported };
}
// A stand-in OffscreenCanvas whose context keeps real RGBA pixels: drawImage copies a source's `pixels`.
class StandInCanvas {
  constructor(width, height) { this.width = width; this.height = height; this.pixels = new Uint8ClampedArray(width * height * 4); this.log = []; }
  getContext() {
    const canvas = this;
    return recordingContext({
      drawImage(source, ...args) { canvas.log.push(['drawImage', source, ...args]); if (source.pixels && args.length === 2) canvas.pixels.set(source.pixels); },
      getImageData() { return { data: new Uint8ClampedArray(canvas.pixels) }; },
      putImageData(image) { canvas.pixels.set(image.data); },
      getTransform() { return 'world'; }
    });
  }
}
function withCanvas(fn) {
  const before = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = StandInCanvas;
  try { return fn(); } finally { if (before) globalThis.OffscreenCanvas = before; else delete globalThis.OffscreenCanvas; }
}
// A decoded MATRIX (every field, as the reader gives it).
const mat = (m = {}) => Object.assign({ hasScale: false, scaleX: 1, scaleY: 1, hasRotate: false, rotateSkew0: 0, rotateSkew1: 0, translateX: 0, translateY: 0 }, m);
const bitmap = () => ({ type: 'bitmap', id: 10, width: 2, height: 1, source: { pixels: Uint8ClampedArray.from([200, 100, 50, 255, 10, 20, 30, 128]) } });

// ---- Reader -------------------------------------------------------------------------------------------------

test('reader: DefineScalingGrid and DefineFont4 (with and without a font file)', async () => {
  const swf = await SWFReader.load(new Uint8Array(fs.readFileSync(path.join(FIXTURE_DIR, 'valid/fws-paint.swf'))));
  const grid = swf.tags.find((t) => t.code === 78), font = swf.tags.find((t) => t.code === 91);
  assert.deepStrictEqual([grid.status, grid.fields.characterId, grid.fields.splitter.xMin, grid.fields.splitter.yMax], ['decoded', 21, 200, 400]);
  assert.deepStrictEqual(font.fields, { fontId: 30, hasFontData: false, italic: false, bold: true, name: 'RetroFlash Test', dataStart: 19 });
  const withData = await SWFReader.load(B.swf({ version: 9, tags: [B.tag(B.T.FileAttributes, B.body((w) => w.u32(0))), B.defineFont4(2, { name: 'F', italic: true, data: [1, 2, 3] }), B.tag(1), B.tag(0)] }));
  const f = withData.tags[1].fields;
  assert.deepStrictEqual([f.hasFontData, f.italic, f.bold, Array.from(withData.getTagData(withData.tags[1]).subarray(f.dataStart))], [true, true, false, [1, 2, 3]]);
  const movie = new I.Movie(swf);
  assert.deepStrictEqual(movie.characters[21].scalingGrid, grid.fields.splitter);
  assert.deepStrictEqual([movie.characters[30].type, movie.characters[30].fontName, movie.characters[30].data], ['font4', 'RetroFlash Test', null]);
  assert.deepStrictEqual(Array.from(new I.Movie(withData).characters[2].data), [1, 2, 3]);
});

// ---- Bitmaps ------------------------------------------------------------------------------------------------

test('bitmaps: per-channel colour transforms tint a copy (cached); alpha alone does not; no canvas falls back', () => {
  const { r, reported } = renderer();
  const b = bitmap();
  assert.deepStrictEqual(r.bitmapImage(b, [1, 1, 1, 0.5, 0, 0, 0, 0], 10), { source: b.source, alpha: 0.5 });
  const fallback = r.bitmapImage(b, [0, 1, 1, 1, 0, 0, 255, 0], 10);
  assert.deepStrictEqual([fallback.source, reported], [b.source, [['render:bitmapColorTransform', 10]]], 'Node has no canvas');
  withCanvas(() => {
    const tinted = r.bitmapImage(b, [0.5, 0, 1, 0.25, 10, 0, 255, 0], 10);
    assert.deepStrictEqual(Array.from(tinted.source.pixels), [110, 0, 255, 255, 15, 0, 255, 128], 'alpha untouched without an alpha offset');
    assert.strictEqual(tinted.alpha, 0.25, 'the alpha multiplier stays a global alpha');
    assert.strictEqual(r.bitmapImage(b, [0.5, 0, 1, 0.9, 10, 0, 255, 0], 10).source, tinted.source, 'same tint, other alpha: cached copy');
    const withAlpha = r.bitmapImage(b, [1, 1, 1, 0.5, 0, 0, 0, 64], 10);
    assert.deepStrictEqual([Array.from(withAlpha.source.pixels.slice(3, 8)), withAlpha.alpha], [[192, 10, 20, 30, 128], 1]);
    for (let i = 0; i < 5; i++) r.bitmapImage(b, [1, 1, 1, 1, i + 1, 0, 0, 0], 10);
    assert.strictEqual(b.tints.size, 4, 'at most four tinted copies per bitmap');
  });
  I.releaseSource(b);
  assert.strictEqual(b.tints, null, 'released with the bitmap');
});

test('bitmaps: a clipped fill extends the edge rows, columns and corners over the shape; a repeating fill tiles', () => {
  const { r } = renderer();
  r.characters = { 10: { type: 'bitmap', id: 10, width: 4, height: 4, source: { name: 'img' } } };
  const ctx = recordingContext();
  const shape = { id: 1 };
  r.paintBitmap(ctx, shape, { type: 'bitmap', bitmapId: 10, matrix: mat({ scaleX: 100, scaleY: 100, translateX: 800, translateY: 400 }), repeat: false, smooth: false }, I.CX_IDENTITY, { xMin: 0, yMin: 0, xMax: 2000, yMax: 1200 });
  const draws = ctx.calls.filter((c) => c[0] === 'drawImage').map((c) => c.slice(2).map((v) => Math.round(v * 100) / 100));
  // The shape spans bitmap pixels -8 to 12 by -4 to 8 (plus a margin of one).
  assert.deepStrictEqual(draws, [
    [0, 0],
    [0, 0, 1, 4, -9, 0, 9, 4], [3, 0, 1, 4, 4, 0, 9, 4], [0, 0, 4, 1, 0, -5, 4, 5], [0, 3, 4, 1, 0, 4, 4, 5],
    [0, 0, 1, 1, -9, -5, 9, 5], [3, 0, 1, 1, 4, -5, 9, 5], [0, 3, 1, 1, -9, 4, 9, 5], [3, 3, 1, 1, 4, 4, 9, 5]
  ]);
  assert.ok(ctx.calls.some((c) => c[0] === 'set' && c[1] === 'imageSmoothingEnabled' && c[2] === false));
  const tiled = recordingContext();
  r.paintBitmap(tiled, shape, { type: 'bitmap', bitmapId: 10, matrix: mat({ scaleX: 100, scaleY: 100 }), repeat: true, smooth: true }, I.CX_IDENTITY, { xMin: 0, yMin: 0, xMax: 2000, yMax: 1200 });
  assert.deepStrictEqual(tiled.calls.filter((c) => ['createPattern', 'fillRect', 'drawImage'].includes(c[0])).map((c) => c[0]), ['createPattern', 'fillRect']);
});

// ---- Gradients ----------------------------------------------------------------------------------------------

const stops = [{ ratio: 0, color: { r: 255, g: 0, b: 0, a: 255 } }, { ratio: 255, color: { r: 0, g: 0, b: 255, a: 255 } }];
const RED = 'rgba(255,0,0,1)', BLUE = 'rgba(0,0,255,1)';
const gradientOf = (r, type, spreadMode, area, focalPoint) =>
  r.gradient(recordingContext(), { type, gradient: { spreadMode, interpolationMode: 0, stops, focalPoint } }, I.CX_IDENTITY, area, 7);

test('gradients: pad is one period; repeat and reflect cover every period the fill reaches', () => {
  const { r, reported } = renderer();
  const pad = gradientOf(r, 'linear', 0, [-50000, 0, 100000, 10]);
  assert.deepStrictEqual(pad.args, [-H, 0, H, 0]);
  assert.deepStrictEqual(pad.stops.map((s) => s[0]), [0, 0, 1, 1]);
  // From x = -40000 to 40000: periods -1 to 1 (each 32768 wide, period 0 from -16384).
  const round = (g) => g.stops.map((s) => [Math.round(s[0] * 1000) / 1000, s[1]]);
  const repeat = gradientOf(r, 'linear', 2, [-40000, 0, 80000, 10]);
  assert.deepStrictEqual(repeat.args, [-H - 2 * H, 0, -H + 2 * 2 * H, 0]);
  assert.deepStrictEqual(round(repeat), [
    [0, RED], [0, RED], [0.333, BLUE], [0.333, BLUE], [0.333, RED], [0.333, RED], [0.667, BLUE], [0.667, BLUE],
    [0.667, RED], [0.667, RED], [1, BLUE], [1, BLUE]
  ]);
  const reflect = gradientOf(r, 'linear', 1, [-H, 0, 2 * 2 * H, 10]);
  assert.deepStrictEqual(reflect.stops.map((s) => [s[0], s[1]]), [[0, RED], [0, RED], [0.5, BLUE], [0.5, BLUE], [0.5, BLUE], [0.5, BLUE], [1, RED], [1, RED]], 'period 1 runs backwards');
  const radial = gradientOf(r, 'radial', 1, [-40000, -30000, 80000, 60000]);
  assert.deepStrictEqual(radial.args.map((v) => v + 0), [0, 0, 0, 0, 0, 4 * H], 'radius 50000: four periods');
  const focal = gradientOf(r, 'focal', 2, [-H, -H, 2 * H, 2 * H], 0.5);
  assert.deepStrictEqual(focal.args, [H / 2, 0, 0, H / 2 * (1 - 4), 0, 4 * H], 'the cone continues past the end circle');
  const tooMany = gradientOf(r, 'linear', 2, [0, 0, 600 * 2 * H, 10]);
  assert.deepStrictEqual([tooMany.args, reported], [[-H, 0, H, 0], [['render:gradientSpread', 7]]]);
});

// ---- Strokes ------------------------------------------------------------------------------------------------

test('strokes: NoHScale/NoVScale keep the width the stroke has on the stage; hairlines stay one device pixel', () => {
  const { r } = renderer();
  const world = [0.2, 0, 0, 0.1, 0, 0]; // 4x by 2x at one pixel per 20 twips
  const scale = Math.sqrt(0.02);
  assert.ok(near(r.strokeWidth({ width: 40 }, 4, scale, world), 40));
  assert.ok(near(r.strokeWidth({ width: 40, noHScale: true, noVScale: true }, 4, scale, world) * scale, 2), '40 twips = 2 device pixels');
  assert.ok(near(r.strokeWidth({ width: 40, noHScale: true }, 4, scale, world) * scale, 4), 'scaled by the vertical scale only');
  assert.ok(near(r.strokeWidth({ width: 40, noVScale: true }, 4, scale, world) * scale, 8));
  assert.ok(near(r.strokeWidth({ width: 40, noHScale: true, noVScale: true }, 3, scale, world), 40), 'LINESTYLE (before DefineShape4) has no such flags');
  assert.ok(near(r.strokeWidth({ width: 1 }, 3, scale, world) * scale, 1));
});

test('strokes: a gradient line fill is painted over the stroke on a layer, then drawn; without a canvas it takes its first colour', () => {
  const fill = { type: 'linear', matrix: mat({ scaleX: 0.01, scaleY: 0.01 }), gradient: { spreadMode: 0, interpolationMode: 0, stops } };
  const character = { id: 4, shape: { shapeVersion: 4, bounds: { xMin: 0, yMin: 0, xMax: 100, yMax: 100 } } };
  const line = { style: { width: 40, fill }, commands: [0, 0, 0, 1, 100, 0] };
  const plain = renderer();
  plain.r.stroke(character, line, I.CX_IDENTITY, 1, [1, 0, 0, 1, 0, 0]);
  assert.deepStrictEqual(plain.reported, [['render:lineFill', 4]]);
  assert.ok(plain.ctx.calls.some((c) => c[0] === 'set' && c[1] === 'strokeStyle' && c[2] === RED));
  withCanvas(() => {
    const { r, ctx, reported } = renderer();
    r.stroke(character, line, I.CX_IDENTITY, 1, [1, 0, 0, 1, 0, 0]);
    assert.deepStrictEqual(reported, []);
    const layer = r.layerCanvas;
    assert.deepStrictEqual([layer.width, layer.height], [480, 320], 'a layer the size of the canvas');
    const drawn = ctx.calls.find((c) => c[0] === 'drawImage');
    assert.strictEqual(drawn[1], layer);
    assert.strictEqual(r.layer(), layer, 'kept while the canvas keeps its size');
  });
});

// ---- 9-slice --------------------------------------------------------------------------------------------------

test('9-slice: corners keep their size, edges stretch one way, the centre takes the rest; rotated clips scale normally', async () => {
  const frame = B.defineShape(1, { version: 1, bounds: { xMax: 1000, yMax: 600 }, fills: [{ color: [0, 0, 0] }],
    records: [{ move: [0, 0], fill1: 1 }, { to: [1000, 0] }, { to: [1000, 600] }, { to: [0, 600] }, { to: [0, 0] }] });
  const sprite = B.tag(B.T.DefineSprite, Buffer.concat([B.body((w) => w.u16(2).u16(1)),
    B.tag(B.T.PlaceObject2, B.body((w) => { w.u8(0x02 | 0x04).u16(1).u16(1); B.matrix(w, { translateX: 0 }); })), B.tag(1), B.tag(0)]));
  const swf = await SWFReader.load(B.swf({ version: 8, tags: [B.tag(B.T.FileAttributes, B.body((w) => w.u32(0))), frame, sprite,
    B.defineScalingGrid(2, { xMin: 200, xMax: 800, yMin: 100, yMax: 500 }),
    B.tag(B.T.PlaceObject2, B.body((w) => { w.u8(0x02 | 0x04).u16(1).u16(2); B.matrix(w, { scaleX: 4, scaleY: 0.5 }); })), B.tag(1), B.tag(0)] }));
  const movie = new I.Movie(swf), env = I.createEnv(movie, () => {}), root = new I.Clip(env, movie.root, 0, null);
  root.gotoFrame(1);
  const { r } = renderer();
  const obj = root.displayList.get(1), world = [0.2, 0, 0, 0.025, 0, 0]; // 4x by 0.5x on a 20-twip pixel
  const nine = r.nineSlice(movie.characters[2], obj, world);
  // Horizontally (4x): the 200-twip sides become 50 twips of the sprite's space, so 200 twips once scaled.
  assert.deepStrictEqual([0, 200, 500, 800, 1000].map((x) => nine.x(x)), [0, 50, 500, 950, 1000]);
  // Vertically (0.5x): the 100-twip corners keep their size, 200 twips of the sprite's space.
  assert.deepStrictEqual([0, 100, 300, 500, 600].map((y) => nine.y(y)), [0, 200, 300, 400, 600]);
  // At 0.25x the clip is 150 twips tall, less than its 200 twips of corners: they shrink evenly to 75 each.
  const small = r.nineSlice(movie.characters[2], obj, [0.2, 0, 0, 0.0125, 0, 0]);
  assert.deepStrictEqual([0, 100, 300, 500, 600].map((y) => small.y(y)), [0, 300, 300, 300, 600]);
  const child = obj.clip.displayList.get(1);
  const moved = r.nineGeometry(child, child.character, nine).groups[0].fills[0].commands;
  assert.deepStrictEqual(moved, [0, 0, 0, 1, 1000, 0, 1, 1000, 600, 1, 0, 600, 1, 0, 0], 'the outline keeps its outer corners');
  assert.strictEqual(r.nineSlice(movie.characters[2], obj, [0.2, 0.01, 0, 0.025, 0, 0]), null, 'rotated or skewed');
  assert.strictEqual(r.nineSlice(movie.characters[2], obj, [0.05, 0, 0, 0.05, 0, 0]), null, 'not scaled');
  assert.strictEqual(r.nineSlice(movie.characters[1], obj, world), null, 'no grid');
  // Drawn through drawObject: the child shape gets the moved geometry.
  const drawn = [];
  r.drawShape = (shape, w, cx, geometry) => drawn.push(geometry && geometry.groups[0].fills[0].commands);
  r.drawObject(obj, world, I.CX_IDENTITY);
  assert.deepStrictEqual(drawn, [moved]);
});

// ---- DefineFont4 ----------------------------------------------------------------------------------------------

test('DefineFont4: loaded with FontFace under a family of its own, used by text fields that name it, removed on release', async () => {
  const swf = await SWFReader.load(B.swf({ version: 9, tags: [B.tag(B.T.FileAttributes, B.body((w) => w.u32(0))),
    B.defineFont4(30, { name: 'Caslon', bold: true, data: [0, 1, 0, 0] }),
    B.defineEditText(31, { bounds: { xMax: 2000, yMax: 400 }, text: 'Hi', fontId: 30, height: 240 }),
    B.defineText(32, { bounds: { xMax: 100, yMax: 100 }, records: [{ fontId: 30, height: 200, glyphs: [[0, 100]] }] }),
    B.tag(1), B.tag(0)] }));
  const reported = [], report = (feature, reason, source) => reported.push([feature, source]);
  const movie = new I.Movie(swf);
  await movie.loadFonts(report);
  assert.deepStrictEqual(reported, [['text:font4', '30']], 'Node has no FontFace');
  reported.length = 0;
  const added = [], deleted = [];
  globalThis.FontFace = class { constructor(family, data, desc) { this.family = family; this.data = data; this.desc = desc; } load() { return Promise.resolve(this); } };
  globalThis.document = { fonts: { add: (f) => added.push(f), delete: (f) => deleted.push(f) } };
  try {
    await movie.loadFonts(report);
    const font = movie.characters[30];
    assert.ok(/^RetroFlash Font4 \d+$/.test(font.family) && added[0] === font.face);
    assert.deepStrictEqual([Array.from(font.face.data), font.face.desc], [[0, 1, 0, 0], { weight: 'bold', style: 'normal' }]);
    const measure = { width: (css, s) => s.length * 10, metrics: () => ({ ascent: 10, descent: 2 }) };
    const layout = I.layoutEditText(movie.characters[31], movie.characters, measure, report);
    assert.strictEqual(layout.lines[0].runs[0].face.css, 'bold 12px "' + font.family + '", "Caslon", sans-serif');
    I.staticTextGlyphs(movie.characters[32], movie.characters, report);
    assert.deepStrictEqual(reported, [['render:font4Text', '32 → 30']]);
    movie.release();
    assert.deepStrictEqual([deleted, font.family], [[added[0]], null]);
  } finally {
    delete globalThis.FontFace;
    delete globalThis.document;
  }
});
