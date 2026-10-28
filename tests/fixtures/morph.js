'use strict';
// Project-authored morph shape fixture (SWF 8, 320x200, 12 fps, 11 root frames).
//   morph 1 (DefineMorphShape): a red square (four straight edges, ±800 twips) becomes a blue circle (four
//     curves through (0, -800), (800, 0), ...); its white 2 px outline becomes a yellow 8 px one
//   morph 2 (DefineMorphShape2): a wide rectangle with a green-to-white linear gradient becomes a tall one whose
//     gradient turns purple-to-orange, rotates a quarter turn and moves its second stop to the middle; its
//     round-capped outline goes from 3 px to 1 px
//   frame k (1-11) places both at ratio round((k - 1) * 65535 / 10): frame 1 shows the start shapes, frame 11
//   the end shapes
const B = require('../support/swf-builder');

const FRAMES = 11;
const ratioAt = (frame) => Math.round((frame - 1) * 65535 / (FRAMES - 1));

const square = [{ move: [-800, -800], fill1: 1, line: 1 }, { to: [800, -800] }, { to: [800, 800] }, { to: [-800, 800] }, { to: [-800, -800] }];
const circle = [{ move: [0, -800] }, { curve: [800, -800, 800, 0] }, { curve: [800, 800, 0, 800] }, { curve: [-800, 800, -800, 0] }, { curve: [-800, -800, 0, -800] }];
const box = (w, h, styles) => [Object.assign({ move: [-w, -h] }, styles), { to: [w, -h] }, { to: [w, h] }, { to: [-w, h] }, { to: [-w, -h] }];

function buildMorph() {
  const morph1 = B.defineMorphShape(1, {
    version: 1,
    startBounds: { xMin: -820, xMax: 820, yMin: -820, yMax: 820 }, endBounds: { xMin: -880, xMax: 880, yMin: -880, yMax: 880 },
    fills: [{ start: { color: [230, 57, 70] }, end: { color: [37, 99, 235] } }],
    lines: [{ start: { width: 40, color: [255, 255, 255] }, end: { width: 160, color: [250, 204, 21] } }],
    startRecords: square, endRecords: circle
  });
  const morph2 = B.defineMorphShape(2, {
    version: 2,
    startBounds: { xMin: -630, xMax: 630, yMin: -230, yMax: 230 }, endBounds: { xMin: -210, xMax: 210, yMin: -710, yMax: 710 },
    fills: [{
      start: { linear: { matrix: { scaleX: 0.0732, scaleY: 0.0732 }, stops: [[0, [34, 197, 94]], [255, [255, 255, 255]]] } },
      end: { linear: { matrix: { scaleX: 0, scaleY: 0, rotateSkew0: 0.0854, rotateSkew1: -0.0854 }, stops: [[0, [147, 51, 234]], [128, [249, 115, 22]]] } }
    }],
    lines: [{ start: { width: 60, color: [15, 23, 42], cap: 0 }, end: { width: 20, color: [15, 23, 42] } }],
    startRecords: box(600, 200, { fill1: 1, line: 1 }), endRecords: box(200, 700, {})
  });
  const place = (frame, depth, id, x) => B.tag(B.T.PlaceObject2, B.body((w) => {
    w.u8(frame === 1 ? 0x02 | 0x04 | 0x10 : 0x01 | 0x10).u16(depth);
    if (frame === 1) { w.u16(id); B.matrix(w, { translateX: x, translateY: 2000 }); }
    w.u16(ratioAt(frame));
  }));
  const tags = [
    B.tag(B.T.FileAttributes, B.body((w) => w.u32(0))),
    B.tag(B.T.SetBackgroundColor, B.body((w) => w.rgb({ r: 241, g: 245, b: 249 }))),
    morph1, morph2
  ];
  for (let frame = 1; frame <= FRAMES; frame++) tags.push(place(frame, 1, 1, 1800), place(frame, 2, 2, 4600), B.tag(B.T.ShowFrame));
  tags.push(B.tag(B.T.End));
  return B.swf({ version: 8, stage: { xMax: 6400, yMax: 4000 }, fps: 12, frameCount: FRAMES, tags });
}

module.exports = { buildMorph, FRAMES, ratioAt, square, circle };
