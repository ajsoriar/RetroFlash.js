'use strict';
// Project-authored button fixture (SWF 6, 320x200, 12 fps, 2 root frames).
//   sprite 30 "lamp": frame 1 dark circle, frame 2 lit circle; both frames run stop()
//   button 20 (DefineButton2): up/over/down rectangles in three blues; a larger, invisible hit rectangle.
//     roll over -> setTarget("lamp") gotoFrame(2) · roll out -> lamp gotoFrame(1)
//     release (or the Enter key) -> gotoLabel("done")
//   button 21 (DefineButton v1, tinted by DefineButtonCxform): release -> gotoFrame(1)
//   root: frame 1 stop(); frame 2 "done" shows a green bar and runs stop()
const B = require('../support/swf-builder');
const { A } = B;

const rectShape = (id, w, h, color) => B.defineShape(id, {
  version: 1, bounds: { xMin: -w, xMax: w, yMin: -h, yMax: h }, fills: [{ color }],
  records: [{ move: [-w, -h], fill1: 1 }, { to: [w, -h] }, { to: [w, h] }, { to: [-w, h] }, { to: [-w, -h] }]
});
function circleShape(id, r, color) {
  const k = r / Math.cos(Math.PI / 8), records = [{ move: [r, 0], fill1: 1 }];
  for (let i = 1; i <= 8; i++) {
    const mid = ((i - 0.5) * Math.PI) / 4, end = (i * Math.PI) / 4;
    records.push({ curve: [Math.round(k * Math.cos(mid)), Math.round(k * Math.sin(mid)), Math.round(r * Math.cos(end)), Math.round(r * Math.sin(end))] });
  }
  return B.defineShape(id, { version: 1, bounds: { xMin: -r, xMax: r, yMin: -r, yMax: r }, fills: [{ color }], records });
}
function place(depth, character, x, y, name) {
  return B.tag(B.T.PlaceObject2, B.body((w) => {
    w.u8(0x02 | 0x04 | (name ? 0x20 : 0)).u16(depth).u16(character);
    B.matrix(w, { translateX: x, translateY: y });
    if (name) w.string(name);
  }));
}
const show = () => B.tag(B.T.ShowFrame);

const BUTTON_RELEASE = 1 << 3, ROLL_OVER = 1 << 0, ROLL_OUT = 1 << 1, KEY_ENTER = 13;

function buildButtons() {
  const lamp = B.tag(B.T.DefineSprite, Buffer.concat([
    B.body((w) => w.u16(30).u16(2)),
    place(1, 5, 0, 0), B.doAction(A.stop()), show(),
    B.tag(B.T.PlaceObject2, B.body((w) => { w.u8(0x01 | 0x02).u16(1).u16(6); })), B.doAction(A.stop()), show(),
    B.tag(B.T.End)
  ]));
  const lampFrame = (index0) => [A.setTarget('lamp'), A.gotoFrame(index0), A.setTarget('')];
  const tags = [
    B.tag(B.T.SetBackgroundColor, B.body((w) => w.rgb({ r: 15, g: 23, b: 42 }))),
    rectShape(1, 1200, 400, [59, 130, 246]), rectShape(2, 1200, 400, [147, 197, 253]), rectShape(3, 1200, 400, [30, 64, 175]),
    rectShape(4, 1300, 500, [255, 0, 255]), circleShape(5, 500, [71, 85, 105]), circleShape(6, 500, [250, 204, 21]),
    rectShape(7, 1200, 150, [34, 197, 94]), rectShape(8, 400, 400, [200, 200, 200]),
    lamp,
    B.defineButton2(20, {
      records: [
        { states: { up: true }, character: 1, depth: 1 },
        { states: { over: true }, character: 2, depth: 1 },
        { states: { down: true }, character: 3, depth: 1 },
        { states: { hit: true }, character: 4, depth: 1 }
      ],
      actions: [
        { conditions: ROLL_OVER, records: lampFrame(1) },
        { conditions: ROLL_OUT, records: lampFrame(0) },
        { conditions: BUTTON_RELEASE, key: KEY_ENTER, records: [A.gotoLabel('done')] }
      ]
    }),
    B.defineButton(21, [{ states: { up: true, over: true, down: true, hit: true }, character: 8, depth: 1 }], [A.gotoFrame(0)]),
    B.defineButtonCxform(21, [{ mult: [256, 128, 128], add: [0, 0, 0] }]),
    place(1, 30, 1600, 2000, 'lamp'),
    place(2, 20, 3800, 2000),
    place(3, 21, 5600, 3400),
    B.doAction(A.stop()),
    show(),
    B.tag(B.T.FrameLabel, B.body((w) => w.string('done'))),
    place(4, 7, 3800, 3400),
    B.doAction(A.stop()),
    show(),
    B.tag(B.T.End)
  ];
  return B.swf({ version: 6, stage: { xMax: 6400, yMax: 4000 }, fps: 12, frameCount: 2, tags });
}

module.exports = { buildButtons };
