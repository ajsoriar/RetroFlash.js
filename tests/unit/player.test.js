'use strict';
// Player building blocks that run without a canvas: shape decoding, shape geometry, dictionary and timelines.
// Drawing itself is checked in a browser with demo/player.html.
const fs = require('fs');
const path = require('path');
const { test, assert } = require('../support/harness');
const { SWFReader, RetroFlash } = require('../support/load-reader');
const { FIXTURE_DIR } = require('../fixtures/build-fixtures');

const { buildShapeGeometry, Movie, Clip } = RetroFlash.internals;
const loadAnimation = () => SWFReader.load(new Uint8Array(fs.readFileSync(path.join(FIXTURE_DIR, 'valid/fws-animation.swf'))));

async function setup() {
  const movie = new Movie(await loadAnimation());
  const reported = [];
  const root = new Clip({ characters: movie.characters, report: (feature, reason, source) => reported.push([feature, source]) }, movie.root, 0);
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
  assert.strictEqual(RetroFlash.version, '0.1.0');
});
