'use strict';
// Project-authored paint fixture (SWF 8, 480x320, 12 fps, 1 frame): the drawing details beyond plain fills.
//   bitmap 10: a 4x4 lossless image, red, green, blue and white quadrants
//   shape 1: a 2000x1200-twip rectangle with a clipped, unsmoothed fill of bitmap 10 (100 twips a pixel), so
//     the fill reaches past the bitmap and its edge pixels are extended
//   bitmap 10 placed directly at 5x, tinted (red kept, green removed, blue raised to the full)
//   shape 2: a linear gradient that repeats (spread 2) · shape 3: a radial gradient that reflects (spread 1)
//   shape 4 (DefineShape4): a focal gradient that repeats, outlined by a 200-twip line with a linear gradient fill
//   sprite 20: shape 5, two outlines (normal and NoHScale+NoVScale, 40 twips each), placed at 4x
//   sprite 21: shape 6, a frame with rounded corners, a DefineScalingGrid inside the corners, placed at 3x by 1.5x
//   DefineFont4 30 "RetroFlash Test" (no font file, unless `fontData` is given) used by text field 31
const B = require('../support/swf-builder');

const rect = (w, h, styles) => [Object.assign({ move: [0, 0] }, styles), { to: [w, 0] }, { to: [w, h] }, { to: [0, h] }, { to: [0, 0] }];
const place = (depth, id, m = {}, extra) => B.tag(B.T.PlaceObject2, B.body((w) => {
  w.u8(0x02 | 0x04 | (extra ? 0x08 : 0)).u16(depth).u16(id);
  B.matrix(w, m);
  if (extra) B.cxform(w, extra, true);
}));

function buildPaint({ fontData } = {}) {
  const quadrant = (x, y) => (x < 2 ? (y < 2 ? [255, 0, 0] : [0, 0, 255]) : (y < 2 ? [0, 255, 0] : [255, 255, 255]));
  const pixels = [];
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) pixels.push(quadrant(x, y));
  const stops = [[0, [250, 204, 21]], [255, [37, 99, 235]]];
  const tags = [
    B.tag(B.T.FileAttributes, B.body((w) => w.u32(0))),
    B.tag(B.T.SetBackgroundColor, B.body((w) => w.rgb({ r: 241, g: 245, b: 249 }))),
    B.defineBitsLossless(10, 1, { format: 5, width: 4, height: 4, pixels }),
    B.defineShape(1, { version: 3, bounds: { xMax: 2000, yMax: 1200 }, fills: [{ bitmap: { id: 10, smooth: false, matrix: { scaleX: 100, scaleY: 100, translateX: 800, translateY: 400 } } }], records: rect(2000, 1200, { fill1: 1 }) }),
    B.defineShape(2, { version: 3, bounds: { xMax: 2000, yMax: 1200 }, fills: [{ linear: { spread: 2, matrix: { scaleX: 0.0122, scaleY: 0.0122, translateX: 1000, translateY: 600 }, stops } }], records: rect(2000, 1200, { fill1: 1 }) }),
    B.defineShape(3, { version: 3, bounds: { xMax: 2000, yMax: 1200 }, fills: [{ radial: { spread: 1, matrix: { scaleX: 0.0183, scaleY: 0.0183, translateX: 1000, translateY: 600 }, stops } }], records: rect(2000, 1200, { fill1: 1 }) }),
    B.defineShape(4, {
      version: 4, bounds: { xMin: -100, xMax: 2100, yMin: -100, yMax: 1300 },
      fills: [{ focal: { spread: 2, focalPoint: 0.6, matrix: { scaleX: 0.0244, scaleY: 0.0244, translateX: 1000, translateY: 600 }, stops } }],
      lines: [{ width: 200, join: 1, fill: { linear: { matrix: { scaleX: 0.061, scaleY: 0.061, translateX: 1000, translateY: 600 }, stops: [[0, [220, 38, 38]], [255, [22, 163, 74]]] } } }],
      records: rect(2000, 1200, { fill1: 1, line: 1 })
    }),
    B.defineShape(5, {
      version: 4, bounds: { xMin: -20, xMax: 520, yMin: -20, yMax: 320 },
      lines: [{ width: 40, color: [15, 23, 42] }, { width: 40, color: [220, 38, 38], noHScale: true, noVScale: true }],
      records: [{ move: [0, 0], line: 1 }, { to: [200, 0] }, { to: [200, 300] }, { to: [0, 300] }, { to: [0, 0] },
        { move: [300, 0], line: 2 }, { to: [500, 0] }, { to: [500, 300] }, { to: [300, 300] }, { to: [300, 0] }]
    }),
    B.defineShape(6, {
      version: 3, bounds: { xMax: 1000, yMax: 600 }, fills: [{ color: [124, 58, 237] }],
      records: [{ move: [200, 0], fill1: 1 }, { to: [800, 0] }, { curve: [1000, 0, 1000, 200] }, { to: [1000, 400] }, { curve: [1000, 600, 800, 600] },
        { to: [200, 600] }, { curve: [0, 600, 0, 400] }, { to: [0, 200] }, { curve: [0, 0, 200, 0] }]
    }),
    B.tag(B.T.DefineSprite, Buffer.concat([B.body((w) => w.u16(20).u16(1)), place(1, 5), B.tag(B.T.ShowFrame), B.tag(B.T.End)])),
    B.tag(B.T.DefineSprite, Buffer.concat([B.body((w) => w.u16(21).u16(1)), place(1, 6), B.tag(B.T.ShowFrame), B.tag(B.T.End)])),
    B.defineScalingGrid(21, { xMin: 200, xMax: 800, yMin: 200, yMax: 400 }),
    B.defineFont4(30, { name: 'RetroFlash Test', bold: true, data: fontData }),
    B.defineEditText(31, { bounds: { xMax: 3000, yMax: 600 }, text: 'Font4', fontId: 30, height: 400, color: [15, 23, 42] }),
    place(1, 1, { translateX: 200, translateY: 200 }),
    place(2, 10, { scaleX: 5, scaleY: 5, translateX: 2600, translateY: 200 }, { mult: [256, 0, 256, 256], add: [0, 0, 255, 0] }),
    place(3, 2, { translateX: 200, translateY: 1800 }),
    place(4, 3, { translateX: 2600, translateY: 1800 }),
    place(5, 4, { translateX: 5200, translateY: 300 }),
    place(6, 20, { scaleX: 4, scaleY: 4, translateX: 5200, translateY: 2000 }),
    place(7, 21, { scaleX: 3, scaleY: 1.5, translateX: 200, translateY: 3400 }),
    place(8, 31, { translateX: 5200, translateY: 4600 }),
    B.tag(B.T.ShowFrame), B.tag(B.T.End)
  ];
  return B.swf({ version: 8, stage: { xMax: 9600, yMax: 6400 }, fps: 12, frameCount: 1, tags });
}

module.exports = { buildPaint };
