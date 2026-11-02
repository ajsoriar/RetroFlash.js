'use strict';
// Player building blocks that run without a canvas: shape decoding, shape geometry, dictionary and timelines.
// Drawing itself is checked in a browser with demo/player.html.
const fs = require('fs');
const path = require('path');
const { test, assert } = require('../support/harness');
const { SWFReader, RetroFlash } = require('../support/load-reader');
const { FIXTURE_DIR } = require('../fixtures/build-fixtures');

const { buildShapeGeometry, Movie, Clip, createEnv } = RetroFlash.internals;
const loadAnimation = () => SWFReader.load(new Uint8Array(fs.readFileSync(path.join(FIXTURE_DIR, 'valid/fws-animation.swf'))));

async function setup() {
  const movie = new Movie(await loadAnimation());
  const reported = [];
  const root = new Clip(createEnv(movie, (feature, reason, source) => reported.push([feature, source])), movie.root, 0);
  root.gotoFrame(1);
  return { movie, root, reported };
}

// Splits flat commands into contours: [[x0, y0, ...ops]]
function contours(cmds) {
  const out = [];
  for (let i = 0; i < cmds.length;) {
    const n = cmds[i] === 2 ? 5 : 3;
    if (cmds[i] === 0) out.push({ start: [cmds[i + 1], cmds[i + 2]], ops: [] });
    else out[out.length - 1].ops.push(cmds.slice(i, i + n));
    i += n;
  }
  return out;
}
const endOf = (op) => op.slice(-2);

test('DefineShape 1-4 bodies are decoded: styles, gradients, LINESTYLE2 and records', async () => {
  const swf = await loadAnimation();
  const shapes = swf.tags.filter((t) => [2, 22, 32, 83].includes(t.code));
  assert.deepStrictEqual(shapes.map((t) => [t.fields.shapeId, t.fields.shapeVersion, t.status]),
    [[1, 1, 'decoded'], [2, 2, 'decoded'], [3, 3, 'decoded'], [4, 3, 'decoded'], [5, 4, 'decoded'], [6, 1, 'decoded'], [7, 1, 'decoded']]);
  const [square, tile, circle, star, zigzag] = shapes.map((t) => t.fields);
  assert.deepStrictEqual(square.fillStyles, [{ type: 'solid', color: { r: 230, g: 57, b: 70, a: 255 } }]);
  assert.deepStrictEqual(square.lineStyles, [{ width: 60, color: { r: 255, g: 255, b: 255, a: 255 } }]);
  assert.deepStrictEqual(square.records[0], { type: 'style', moveTo: { x: -800, y: -800 }, fill1: 1, line: 1 });
  assert.deepStrictEqual(square.records.slice(1).map((r) => [r.type, r.dx, r.dy]), [['line', 1600, 0], ['line', 0, 1600], ['line', -1600, 0], ['line', 0, -1600]]);
  assert.strictEqual(tile.fillStyles.length, 2);
  assert.strictEqual(circle.fillStyles[0].type, 'linear');
  assert.deepStrictEqual(circle.fillStyles[0].gradient.stops[1], { ratio: 255, color: { r: 217, g: 70, b: 239, a: 200 } });
  assert.strictEqual(circle.records.filter((r) => r.type === 'curve').length, 8);
  assert.strictEqual(star.fillStyles[0].type, 'radial');
  assert.deepStrictEqual(zigzag.lineStyles[0], {
    width: 120, startCap: 0, join: 0, noHScale: false, noVScale: false, pixelHinting: false, noClose: false, endCap: 0,
    color: { r: 74, g: 222, b: 128, a: 255 }
  });
  assert.strictEqual(zigzag.fillStyles.length, 0);
});

test('geometry: fill0/fill1 edges become one closed contour per fill (shared edge used by both)', async () => {
  const { movie } = await setup();
  const g = buildShapeGeometry(movie.characters[2].shape);
  assert.deepStrictEqual(g.problems, []);
  assert.strictEqual(g.fillRule, 'evenodd');
  const [left, right] = g.groups[0].fills;
  for (const fill of [left, right]) {
    const [c, ...extra] = contours(fill.commands);
    assert.deepStrictEqual(extra, [], 'single contour');
    assert.strictEqual(c.ops.length, 4);
    assert.deepStrictEqual(endOf(c.ops[3]), c.start, 'contour closes on its start point');
  }
  const xs = (fill) => contours(fill.commands)[0].ops.map((op) => op[1]);
  assert.ok(xs(left).every((x) => x <= 0) && xs(right).every((x) => x >= 0), 'left fill stays left of the shared edge, right fill right');
  assert.ok(xs(left).includes(0) && xs(right).includes(0), 'both fills use the shared edge');
});

test('geometry: curves, strokes and closed outlines', async () => {
  const { movie } = await setup();
  const circle = buildShapeGeometry(movie.characters[3].shape).groups[0];
  const [c] = contours(circle.fills[0].commands);
  assert.strictEqual(c.ops.filter((op) => op[0] === 2).length, 8);
  assert.deepStrictEqual(endOf(c.ops[7]), c.start);
  assert.strictEqual(contours(circle.lines[0].commands).length, 1, 'outline is one continuous stroke');
  const zigzag = buildShapeGeometry(movie.characters[5].shape).groups[0];
  assert.strictEqual(zigzag.fills.length, 0);
  assert.strictEqual(contours(zigzag.lines[0].commands)[0].ops.length, 6);
  const stripes = buildShapeGeometry(movie.characters[7].shape).groups[0];
  assert.deepStrictEqual(stripes.fills.map((f) => contours(f.commands).length), [4, 4], 'four bars per colour');
});

test('geometry: references to missing styles are reported, not drawn', () => {
  const g = buildShapeGeometry({
    fillStyles: [], lineStyles: [],
    records: [{ type: 'style', moveTo: { x: 0, y: 0 }, fill1: 3 }, { type: 'line', dx: 10, dy: 0 }]
  });
  assert.deepStrictEqual(g.groups, []);
  assert.strictEqual(g.problems.length, 1);
});

test('dictionary: shapes and sprites by character id, root and sprite frame lists', async () => {
  const { movie } = await setup();
  assert.deepStrictEqual(Object.keys(movie.characters).map(Number).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 10, 11]);
  assert.strictEqual(movie.characters[10].type, 'sprite');
  assert.strictEqual(movie.characters[10].frames.length, 24);
  assert.strictEqual(movie.characters[11].frames.length, 12);
  assert.strictEqual(movie.root.frames.length, 48);
  assert.deepStrictEqual({ ...movie.root.labels }, { start: 1, middle: 24 });
});

test('display list: frame 1 placements, mask, nested sprite instances', async () => {
  const { root, reported } = await setup();
  assert.deepStrictEqual(root.depths(), [1, 2, 3, 4, 5, 6, 7]);
  const list = root.displayList;
  assert.strictEqual(list.get(1).clipDepth, 2);
  assert.deepStrictEqual(list.get(3).matrix, [1, 0, 0, 1, 2000, 1400]);
  assert.strictEqual(list.get(4).cx[3], 1, 'square starts fully opaque');
  assert.strictEqual(list.get(5).clip.frame, 1);
  const orbit = list.get(6).clip;
  assert.deepStrictEqual(orbit.depths(), [1, 2]);
  assert.strictEqual(orbit.displayList.get(1).clip.def.id, 10, 'sprite 11 holds an instance of sprite 10');
  assert.deepStrictEqual(reported, []);
});

test('timelines: each tick advances children and the root; sprites loop on their own length', async () => {
  const { root } = await setup();
  const star = root.displayList.get(5).clip, orbit = root.displayList.get(6).clip, inner = orbit.displayList.get(1).clip;
  const square = root.displayList.get(4);
  const x0 = square.matrix[4];
  for (let i = 0; i < 12; i++) root.tick();
  assert.strictEqual(root.frame, 13);
  assert.strictEqual(star.frame, 13);
  assert.strictEqual(orbit.frame, 1, '12-frame sprite looped back to 1');
  assert.strictEqual(inner.frame, 13, 'nested sprite advances with its parent');
  assert.strictEqual(root.displayList.get(4), square, 'moved object keeps its identity');
  assert.ok(square.matrix[4] > x0, 'square moved right');
  assert.ok(square.cx[3] < 1, 'square is fading');
});

test('timelines: removal, rewind keeps matching instances, root loop reports the end', async () => {
  const { root } = await setup();
  const star = root.displayList.get(5);
  root.gotoFrame(40);
  assert.ok(!root.displayList.has(3), 'tile removed at frame 40');
  star.clip.gotoFrame(7);
  root.gotoFrame(1);
  assert.ok(root.displayList.has(3), 'tile back after rewinding');
  assert.strictEqual(root.displayList.get(5), star, 'sprite instance survives the rewind');
  assert.strictEqual(star.clip.frame, 7, 'and keeps its own playhead');
  assert.strictEqual(root.displayList.get(4).matrix[4], 1000, 'square reset to its frame-1 position');
  root.gotoFrame(48);
  assert.strictEqual(root.tick(), true, 'passing the last frame is reported');
  assert.strictEqual(root.frame, 1, 'and loops to frame 1');
  root.loop = false;
  root.gotoFrame(48);
  assert.strictEqual(root.tick(), true);
  assert.strictEqual(root.frame, 48, 'without loop the playhead stays on the last frame');
});

test('Player requires a canvas', () => {
  assert.throws(() => new RetroFlash.Player({}), (err) => err.name === 'RetroFlashError' && err.code === 'INVALID_OPTION');
  assert.strictEqual(RetroFlash.version, '1.1.0');
});

// ---- Layout: scale modes and alignment; the players of the page ----

const B = require('../support/swf-builder');
if (!globalThis.Path2D) globalThis.Path2D = class { addPath() {} moveTo() {} lineTo() {} quadraticCurveTo() {} closePath() {} };
const stage1080 = () => B.swf({ stage: { xMax: 1920 * 20, yMax: 1080 * 20 }, tags: [B.tag(B.T.ShowFrame), B.tag(B.T.End)] });
// A player whose canvas the page lays out at `box` CSS pixels.
function laidOutPlayer(box, options) {
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => ({ addColorStop() {} })), set: (t, k, v) => { t[k] = v; return true; } });
  const canvas = { id: 'stage', getContext: () => ctx, style: {}, width: 300, height: 150, getBoundingClientRect: () => ({ left: 0, top: 0, width: box.width, height: box.height }) };
  return new RetroFlash.Player(Object.assign({ canvas, input: false, audio: false, pixelRatio: 1 }, options));
}
const rounded = (p) => p && { x: Math.round(p.x * 1000) / 1000 + 0, y: Math.round(p.y * 1000) / 1000 + 0 };
async function layoutIn(box, options) {
  const player = laidOutPlayer(box, options);
  await player.load(stage1080());
  const layout = player.getLayout();
  player.destroy();
  return [rounded(layout.scale), rounded(layout.offset), layout.buffer.width, layout.buffer.height];
}

test('layout: without a scale mode the canvas takes the size of the stage', async () => {
  const player = laidOutPlayer({ width: 1280, height: 720 });
  await player.load(stage1080());
  const { canvas } = player, layout = player.getLayout();
  assert.deepStrictEqual([canvas.width, canvas.height, canvas.style.width, canvas.style.height], [1920, 1080, '1920px', 'auto']);
  assert.deepStrictEqual([layout.scaleMode, layout.align, layout.stage, layout.display], [null, '', { width: 1920, height: 1080 }, { width: 1920, height: 1080 }]);
  assert.deepStrictEqual([rounded(layout.scale), rounded(layout.offset)], [{ x: 1, y: 1 }, { x: 0, y: 0 }]);
  player.destroy();
});

test('layout: scale modes and alignment fit a 1920x1080 stage into the canvas the page sizes', async () => {
  assert.deepStrictEqual(await layoutIn({ width: 1280, height: 720 }, { scaleMode: 'showAll' }), [{ x: 0.667, y: 0.667 }, { x: 0, y: 0 }, 1280, 720]);
  assert.deepStrictEqual(await layoutIn({ width: 1280, height: 720 }, { scaleMode: 'showAll', pixelRatio: 2 }), [{ x: 0.667, y: 0.667 }, { x: 0, y: 0 }, 2560, 1440], 'canvas pixels follow pixelRatio');
  const box = { width: 1024, height: 768 };
  assert.deepStrictEqual(await layoutIn(box, { scaleMode: 'SHOWALL' }), [{ x: 0.533, y: 0.533 }, { x: 0, y: 96 }, 1024, 768], 'letterboxed, centred');
  assert.deepStrictEqual(await layoutIn(box, { scaleMode: 'showAll', align: 't' }), [{ x: 0.533, y: 0.533 }, { x: 0, y: 0 }, 1024, 768]);
  assert.deepStrictEqual(await layoutIn(box, { scaleMode: 'showAll', align: 'B' }), [{ x: 0.533, y: 0.533 }, { x: 0, y: 192 }, 1024, 768]);
  assert.deepStrictEqual(await layoutIn(box, { scaleMode: 'noBorder' }), [{ x: 0.711, y: 0.711 }, { x: -170.667, y: 0 }, 1024, 768], 'cropped');
  assert.deepStrictEqual(await layoutIn(box, { scaleMode: 'exactFit' }), [{ x: 0.533, y: 0.711 }, { x: 0, y: 0 }, 1024, 768], 'stretched');
  assert.deepStrictEqual(await layoutIn(box, { scaleMode: 'noScale' }), [{ x: 1, y: 1 }, { x: -448, y: -156 }, 1024, 768]);
  assert.deepStrictEqual(await layoutIn(box, { scaleMode: 'noScale', align: 'TL' }), [{ x: 1, y: 1 }, { x: 0, y: 0 }, 1024, 768]);
});

test('layout: with a scale mode the canvas keeps a CSS size: the width/height options, its inline style, or the stage', async () => {
  const sized = laidOutPlayer({ width: 1280, height: 720 }, { scaleMode: 'showAll', width: '100%', height: 720 });
  await sized.load(stage1080());
  assert.deepStrictEqual([sized.canvas.style.width, sized.canvas.style.height, sized.getLayout().width], ['100%', '720px', '100%']);
  sized.setSize('50vw', null);
  assert.deepStrictEqual([sized.canvas.style.width, sized.canvas.style.height], ['50vw', '720px']);
  sized.destroy();
  const inline = laidOutPlayer({ width: 640, height: 360 }, { scaleMode: 'showAll' });
  inline.canvas.style.width = '640px';
  inline.canvas.style.height = '360px';
  await inline.load(stage1080());
  assert.deepStrictEqual([inline.canvas.style.width, inline.canvas.style.height, inline.canvas.width], ['640px', '360px', 640]);
  inline.setScaleMode(null);
  assert.deepStrictEqual([inline.canvas.style.width, inline.canvas.width, inline.getLayout().scaleMode], ['1920px', 1920, null], 'back to the stage size');
  inline.setScaleMode('exactFit', 'BR');
  assert.deepStrictEqual([inline.getLayout().scaleMode, inline.getLayout().align], ['exactFit', 'BR']);
  assert.throws(() => inline.setScaleMode('zoom'), (e) => e.code === 'INVALID_OPTION');
  inline.destroy();
  for (const bad of [{ scaleMode: 'fit' }, { align: 'C' }, { width: -1 }, { height: 'a;b' }]) {
    assert.throws(() => laidOutPlayer({ width: 1, height: 1 }, bad), (e) => e.code === 'INVALID_OPTION', JSON.stringify(bad));
  }
});

test('RetroFlash.getInstances lists the players of the page until they are destroyed; getInstance finds one', async () => {
  const before = RetroFlash.getInstances().length;
  const player = laidOutPlayer({ width: 960, height: 540 }, { scaleMode: 'showAll', host: { objectID: 'movie1' } });
  await player.load(stage1080(), { url: 'file:///apps/app/test2.swf' });
  const listed = RetroFlash.getInstances();
  assert.strictEqual(listed.length, before + 1);
  const item = listed[listed.length - 1];
  assert.deepStrictEqual(
    [item.id, item.elementId, item.objectID, item.url, item.state, item.width, item.height, item.frameCount, item.volume, item.unsupported],
    [player.id, 'stage', 'movie1', 'file:///apps/app/test2.swf', 'ready', 1920, 1080, 1, 1, 0]);
  assert.deepStrictEqual([item.player, item.canvas, item.layout.scaleMode, item.layout.scale.x], [player, player.canvas, 'showAll', 0.5]);
  for (const key of [player.id, 'stage', 'movie1', player.canvas]) assert.strictEqual(RetroFlash.getInstance(key), player, String(key));
  assert.strictEqual(RetroFlash.getInstance('nothing'), null);
  player.destroy();
  assert.strictEqual(RetroFlash.getInstances().length, before);
  assert.strictEqual(RetroFlash.getInstance(player.id), null);
});

test('RetroFlash.getEnvironment describes what the page runs on', () => {
  const env = RetroFlash.getEnvironment();
  assert.strictEqual(env.version, RetroFlash.version);
  assert.strictEqual(typeof env.devicePixelRatio, 'number');
  assert.strictEqual(env.instances, RetroFlash.getInstances().length);
  assert.deepStrictEqual(Object.keys(env.features), ['fetch', 'XMLHttpRequest', 'PointerEvent', 'WebAudio', 'DecompressionStream', 'createImageBitmap', 'DOMMatrix', 'Path2DAddPath']);
  assert.ok(Object.values(env.features).every((v) => typeof v === 'boolean'));
});

test('layout: the pointer is read through the stage\'s place in the canvas, letterbox included', async () => {
  const handlers = {};
  const player = laidOutPlayer({ width: 1024, height: 768 }, { scaleMode: 'showAll', input: true, pixelRatio: 2 });
  Object.assign(player.canvas, { addEventListener: (type, fn) => { handlers[type] = fn; }, removeEventListener() {} });
  player.attachInput();
  await player.load(stage1080());
  handlers.pointermove({ clientX: 512, clientY: 96 + 288 });
  assert.deepStrictEqual([Math.round(player.input.x), Math.round(player.input.y)], [19200, 10800], 'the centre of the canvas is the centre of the stage');
  handlers.pointermove({ clientX: 0, clientY: 50 });
  assert.deepStrictEqual([Math.round(player.input.x), Math.round(player.input.y)], [0, -1725], 'the band above the stage is outside it');
  player.destroy();
});
