'use strict';
// Project-authored bitmap fixture: every bitmap tag type drawn through bitmap fills (SWF 8, 480x320, 1 frame).
// assets/gradient-32.jpg is a 32x32 baseline JPEG rendered for this project (see assets/README.md).
//   row 1: 100 DefineBitsJPEG2 (JPEG) · 101 DefineBitsJPEG3 (JPEG + circular alpha) · 102 DefineBits + JPEGTables · 103 DefineBitsJPEG2 (PNG with alpha)
//   row 2: 104 Lossless fmt 3 (6x6, padded rows, not smoothed) · 105 Lossless fmt 4 (15-bit) · 106 Lossless fmt 5 · 107 Lossless2 fmt 5 (alpha ramp)
//   row 3: 108 Lossless2 fmt 3 (transparent palette entry) tiled with a repeating fill · 100 rotated at half alpha
const fs = require('fs');
const path = require('path');
const B = require('../support/swf-builder');

const JPEG = fs.readFileSync(path.join(__dirname, 'assets', 'gradient-32.jpg'));
const TILE = 1920; // 96 px

function pngWithAlpha() {
  const rgba = [];
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) rgba.push(239, 68, 68, Math.round((255 * (x + y)) / 30));
  return B.png(16, 16, rgba);
}

function bitmaps() {
  const { tables, image } = B.splitJpeg(JPEG);
  // Binary alpha (0 or 255) so the result does not depend on whether JPEG3 colours are premultiplied.
  const circle = [];
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) circle.push((x - 15.5) ** 2 + (y - 15.5) ** 2 <= 14 ** 2 ? 255 : 0);
  const ramp = (n, f) => Array.from({ length: n * n }, (_, i) => f(i % n, Math.floor(i / n)));
  return [
    B.defineBitsJPEG2(100, JPEG),
    B.defineBitsJPEG3(101, JPEG, circle),
    B.jpegTables(tables),
    B.defineBits(102, image),
    B.defineBitsJPEG2(103, pngWithAlpha()),
    B.defineBitsLossless(104, 1, {
      format: 3, width: 6, height: 6, palette: [[30, 41, 59], [56, 189, 248], [250, 204, 21], [244, 63, 94]],
      indices: ramp(6, (x, y) => (x + y) % 4)
    }),
    B.defineBitsLossless(105, 1, { format: 4, width: 8, height: 8, pixels: ramp(8, (x, y) => [x * 4, y * 4, 31 - x * 4]) }),
    B.defineBitsLossless(106, 1, { format: 5, width: 8, height: 8, pixels: ramp(8, (x, y) => [x * 32, 255 - y * 32, 128]) }),
    B.defineBitsLossless(107, 2, { format: 5, width: 8, height: 8, pixels: ramp(8, (x) => [34, 197, 94, Math.round((255 * x) / 7)]) }),
    B.defineBitsLossless(108, 2, { format: 3, width: 4, height: 4, palette: [[255, 255, 255, 255], [0, 0, 0, 0]], indices: ramp(4, (x, y) => (x + y) % 2) })
  ];
}

// Square shape filled with bitmap `id` scaled to TILE twips (width x height twips for repeating fills).
function tileShape(shapeId, bitmapId, pixels, opts = {}) {
  const w = opts.width || TILE, h = TILE, scale = opts.scale || TILE / pixels;
  return B.defineShape(shapeId, {
    version: 3, bounds: { xMin: 0, xMax: w, yMin: 0, yMax: h },
    fills: [{ bitmap: { id: bitmapId, repeat: !!opts.repeat, smooth: opts.smooth !== false, matrix: { scaleX: scale, scaleY: scale } } }],
    records: [{ move: [0, 0], fill1: 1 }, { to: [w, 0] }, { to: [w, h] }, { to: [0, h] }, { to: [0, 0] }]
  });
}

function place(depth, character, x, y, extra = {}) {
  return B.tag(B.T.PlaceObject2, B.body((w) => {
    w.u8(0x02 | 0x04 | (extra.cx ? 0x08 : 0)).u16(depth).u16(character);
    B.matrix(w, extra.matrix || { translateX: x, translateY: y });
    if (extra.cx) B.cxform(w, extra.cx, true);
  }));
}

function buildBitmaps() {
  const col = (i) => (24 + i * 112) * 20, row = (i) => (8 + i * 104) * 20;
  const band = B.defineShape(1, {
    version: 1, bounds: { xMin: 0, xMax: 9600, yMin: 0, yMax: 6400 }, fills: [{ color: [250, 204, 21] }],
    records: [{ move: [0, 5200], fill1: 1 }, { to: [8400, 0] }, { to: [9600, 0] }, { to: [9600, 1200] }, { to: [1200, 6400] }, { to: [0, 6400] }, { to: [0, 5200] }]
  });
  const a = Math.PI / 6, s = 0.7;
  const tags = [
    B.tag(B.T.FileAttributes, B.body((w) => w.u32(0))),
    B.tag(B.T.SetBackgroundColor, B.body((w) => w.rgb({ r: 60, g: 64, b: 80 }))),
    ...bitmaps(), band,
    tileShape(200, 100, 32), tileShape(201, 101, 32), tileShape(202, 102, 32), tileShape(203, 103, 16),
    tileShape(204, 104, 6, { smooth: false }), tileShape(205, 105, 8), tileShape(206, 106, 8), tileShape(207, 107, 8),
    tileShape(208, 108, 4, { repeat: true, width: TILE * 2 + 320, scale: 80 }),
    place(1, 1, 0, 0),
    place(2, 200, col(0), row(0)), place(3, 201, col(1), row(0)), place(4, 202, col(2), row(0)), place(5, 203, col(3), row(0)),
    place(6, 204, col(0), row(1)), place(7, 205, col(1), row(1)), place(8, 206, col(2), row(1)), place(9, 207, col(3), row(1)),
    place(10, 208, col(0), row(2)),
    place(11, 200, 0, 0, {
      matrix: { scaleX: s * Math.cos(a), scaleY: s * Math.cos(a), rotateSkew0: s * Math.sin(a), rotateSkew1: -s * Math.sin(a), translateX: col(3) + 400, translateY: row(2) },
      cx: { mult: [256, 256, 256, 128] }
    }),
    B.tag(B.T.ShowFrame), B.tag(B.T.End)
  ];
  return B.swf({ version: 8, stage: { xMax: 9600, yMax: 6400 }, fps: 12, frameCount: 1, tags });
}

module.exports = { buildBitmaps, JPEG };
