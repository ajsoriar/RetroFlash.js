'use strict';
// Project-authored vector animation used by the player demo and the display-list tests.
// Stage 480x320 at 24 fps, 48 root frames. Characters:
//   1 DefineShape   square, solid fill + white outline            (depth 4: moves, rotates, fades)
//   2 DefineShape2  two-colour tile sharing one edge (fill0/fill1) (depth 3: removed at frame 40)
//   3 DefineShape3  circle of 8 curves, RGBA linear gradient + line
//   4 DefineShape3  star, radial gradient
//   5 DefineShape4  stroke-only zigzag (LINESTYLE2, round caps)    (depth 7)
//   6 DefineShape   circle used as a mask (clipDepth 2)            (depth 1)
//   7 DefineShape   striped square, masked by 6                    (depth 2: slides up and down)
//  10 DefineSprite  star spinning, 24 frames                       (depth 5)
//  11 DefineSprite  sprite 10 at half size + orbiting circle, 12 frames (depth 6)
const { body, tag, defineShape, matrix, cxform, T, swf } = require('../support/swf-builder');

const ROOT_FRAMES = 48;
const round = Math.round;

function transform(deg = 0, scale = 1, tx = 0, ty = 0) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a) * scale, s = Math.sin(a) * scale;
  return { scaleX: c, scaleY: c, rotateSkew0: s, rotateSkew1: -s, translateX: round(tx), translateY: round(ty) };
}

// Closed circle of 8 quadratic segments.
function circleRecords(r, styles) {
  const records = [{ move: [r, 0], ...styles }], k = r / Math.cos(Math.PI / 8);
  for (let i = 1; i <= 8; i++) {
    const mid = ((i - 0.5) * Math.PI) / 4, end = (i * Math.PI) / 4;
    records.push({ curve: [round(k * Math.cos(mid)), round(k * Math.sin(mid)), round(r * Math.cos(end)), round(r * Math.sin(end))] });
  }
  return records;
}

const box = (r) => ({ xMin: -r, xMax: r, yMin: -r, yMax: r });

function shapes() {
  const star = [];
  for (let i = 0; i < 10; i++) {
    const a = (i * Math.PI) / 5 - Math.PI / 2, r = i % 2 ? 300 : 700;
    star.push([round(r * Math.cos(a)), round(r * Math.sin(a))]);
  }
  const stripes = [];
  for (let i = 0; i < 8; i++) {
    const y0 = -1600 + i * 400, y1 = y0 + 400;
    stripes.push({ move: [-1600, y0], fill1: 1 + (i % 2) }, { to: [1600, y0] }, { to: [1600, y1] }, { to: [-1600, y1] }, { to: [-1600, y0] });
  }
  return [
    defineShape(1, {
      version: 1, bounds: box(830), fills: [{ color: [230, 57, 70] }], lines: [{ width: 60, color: [255, 255, 255] }],
      records: [{ move: [-800, -800], fill1: 1, line: 1 }, { to: [800, -800] }, { to: [800, 800] }, { to: [-800, 800] }, { to: [-800, -800] }]
    }),
    defineShape(2, {
      version: 2, bounds: { xMin: -1000, xMax: 1000, yMin: -600, yMax: 600 },
      fills: [{ color: [66, 135, 245] }, { color: [250, 204, 21] }],
      records: [
        // Shared middle edge: left half (fill 1) on its fill1 side, right half (fill 2) on its fill0 side.
        { move: [0, -600], fill0: 2, fill1: 1 }, { to: [0, 600] },
        { fill0: 0 }, { to: [-1000, 600] }, { to: [-1000, -600] }, { to: [0, -600] },
        { move: [0, -600], fill1: 2 }, { to: [1000, -600] }, { to: [1000, 600] }, { to: [0, 600] }
      ]
    }),
    defineShape(3, {
      version: 3, bounds: box(930),
      fills: [{ linear: { matrix: { scaleX: 1800 / 32768, scaleY: 1800 / 32768 }, stops: [[0, [34, 211, 238, 255]], [255, [217, 70, 239, 200]]] } }],
      lines: [{ width: 40, color: [255, 255, 255, 180] }],
      records: circleRecords(900, { fill1: 1, line: 1 })
    }),
    defineShape(4, {
      version: 3, bounds: box(700),
      fills: [{ radial: { matrix: { scaleX: 700 / 16384, scaleY: 700 / 16384 }, stops: [[0, [254, 240, 138, 255]], [255, [249, 115, 22, 255]]] } }],
      records: [{ move: star[0], fill1: 1 }, ...star.slice(1).map((p) => ({ to: p })), { to: star[0] }]
    }),
    defineShape(5, {
      version: 4, bounds: { xMin: -1560, xMax: 1560, yMin: -460, yMax: 460 },
      lines: [{ width: 120, color: [74, 222, 128, 255] }],
      records: [{ move: [-1500, 0], line: 1 }, { to: [-1000, -400] }, { to: [-500, 400] }, { to: [0, -400] }, { to: [500, 400] }, { to: [1000, -400] }, { to: [1500, 0] }]
    }),
    defineShape(6, { version: 1, bounds: box(1400), fills: [{ color: [255, 255, 255] }], records: circleRecords(1400, { fill1: 1 }) }),
    defineShape(7, { version: 1, bounds: box(1600), fills: [{ color: [244, 114, 182] }, { color: [56, 189, 248] }], records: stripes })
  ];
}

// PlaceObject2. opts: { character, matrix, cx (CXFORMWITHALPHA {mult, add}), clipDepth, move }
function place(depth, opts) {
  return tag(T.PlaceObject2, body((w) => {
    let flags = 0;
    if (opts.move) flags |= 0x01;
    if (opts.character !== undefined) flags |= 0x02;
    if (opts.matrix) flags |= 0x04;
    if (opts.cx) flags |= 0x08;
    if (opts.clipDepth !== undefined) flags |= 0x40;
    w.u8(flags).u16(depth);
    if (opts.character !== undefined) w.u16(opts.character);
    if (opts.matrix) matrix(w, opts.matrix);
    if (opts.cx) cxform(w, opts.cx, true);
    if (opts.clipDepth !== undefined) w.u16(opts.clipDepth);
  }));
}

const showFrame = () => tag(T.ShowFrame);
const end = () => tag(T.End);
const label = (name) => tag(T.FrameLabel, body((w) => w.string(name)));
const sprite = (id, frames, children) => tag(T.DefineSprite, Buffer.concat([body((w) => w.u16(id).u16(frames)), ...children]));

function spinningStar() {
  const tags = [];
  for (let k = 0; k < 24; k++) tags.push(place(1, k ? { move: true, matrix: transform(k * 15) } : { character: 4, matrix: transform(0) }), showFrame());
  return sprite(10, 24, [...tags, end()]);
}

function orbit() {
  const tags = [place(1, { character: 10, matrix: transform(0, 0.5) })];
  for (let k = 0; k < 12; k++) {
    const a = (k * Math.PI) / 6, m = transform(0, 0.4, 1500 * Math.cos(a), 900 * Math.sin(a));
    tags.push(place(2, k ? { move: true, matrix: m } : { character: 3, matrix: m }), showFrame());
  }
  return sprite(11, 12, [...tags, end()]);
}

const stripesAt = (k) => transform(0, 1, 7600, 2200 + 800 * Math.sin((2 * Math.PI * k) / ROOT_FRAMES));
const squareAt = (k) => transform(k * 7.5, 0.8, 1000 + k * 160, 5500);
const fadeAt = (k) => ({ mult: [256, 256, 256, round(256 - (176 * k) / (ROOT_FRAMES - 1))] });

function rootTags() {
  const tags = [
    tag(T.FileAttributes, body((w) => w.u32(0))),
    tag(T.SetBackgroundColor, body((w) => w.rgb({ r: 20, g: 24, b: 38 }))),
    ...shapes(), spinningStar(), orbit(),
    label('start'),
    place(1, { character: 6, matrix: transform(0, 1, 7600, 2200), clipDepth: 2 }),
    place(2, { character: 7, matrix: stripesAt(0) }),
    place(3, { character: 2, matrix: transform(0, 1, 2000, 1400) }),
    place(4, { character: 1, matrix: squareAt(0), cx: fadeAt(0) }),
    place(5, { character: 10, matrix: transform(0, 1, 2000, 3900) }),
    place(6, { character: 11, matrix: transform(0, 1, 4800, 1700) }),
    place(7, { character: 5, matrix: transform(0, 1, 5200, 3900) }),
    showFrame()
  ];
  for (let k = 1; k < ROOT_FRAMES; k++) {
    if (k === 23) tags.push(label('middle'));
    tags.push(place(2, { move: true, matrix: stripesAt(k) }), place(4, { move: true, matrix: squareAt(k), cx: fadeAt(k) }));
    if (k === 39) tags.push(tag(T.RemoveObject2, body((w) => w.u16(3))));
    tags.push(showFrame());
  }
  tags.push(end());
  return tags;
}

const buildAnimation = () => swf({ version: 8, stage: { xMax: 9600, yMax: 6400 }, fps: 24, frameCount: ROOT_FRAMES, tags: rootTags() });

module.exports = { buildAnimation, ROOT_FRAMES };
