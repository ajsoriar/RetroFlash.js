'use strict';
// Project-authored AVM1 timeline-control fixture (SWF 6, 200x200, 12 fps).
//   sprite 10 "spinner": 10 frames, a square rotating; frame 5 runs stop()
//   sprite 11: 2 frames; frame 1 runs play(), a Jump with offset 0 (to the next record), then stop()
//   root: f1 places both sprites · f3 label "three": gotoLabel("five"), play() · f4 stop() (skipped over)
//         f5 label "five": setTarget("spinner"), gotoFrame(7), setTarget(""), x = "1" (a root variable),
//            getURL (ignored, never navigates), stop() · f6 stop()
const B = require('../support/swf-builder');
const { A } = B;

function rotation(deg, tx = 0, ty = 0) {
  const r = (deg * Math.PI) / 180;
  return { scaleX: Math.cos(r), scaleY: Math.cos(r), rotateSkew0: Math.sin(r), rotateSkew1: -Math.sin(r), translateX: tx, translateY: ty };
}

function place(depth, opts) {
  return B.tag(B.T.PlaceObject2, B.body((w) => {
    w.u8((opts.move ? 0x01 : 0) | (opts.character !== undefined ? 0x02 : 0) | 0x04 | (opts.name ? 0x20 : 0)).u16(depth);
    if (opts.character !== undefined) w.u16(opts.character);
    B.matrix(w, opts.matrix);
    if (opts.name) w.string(opts.name);
  }));
}
const label = (name) => B.tag(B.T.FrameLabel, B.body((w) => w.string(name)));
const show = () => B.tag(B.T.ShowFrame);
const sprite = (id, frames, children) => B.tag(B.T.DefineSprite, Buffer.concat([B.body((w) => w.u16(id).u16(frames)), ...children, B.tag(B.T.End)]));

function buildActions() {
  const square = B.defineShape(1, {
    version: 1, bounds: { xMin: -600, xMax: 600, yMin: -600, yMax: 600 }, fills: [{ color: [56, 189, 248] }],
    records: [{ move: [-600, -600], fill1: 1 }, { to: [600, -600] }, { to: [600, 600] }, { to: [-600, 600] }, { to: [-600, -600] }]
  });
  const spinner = [];
  for (let k = 0; k < 10; k++) {
    spinner.push(place(1, k ? { move: true, matrix: rotation(k * 36) } : { character: 1, matrix: rotation(0) }));
    if (k === 4) spinner.push(B.doAction(A.stop()));
    spinner.push(show());
  }
  const tags = [
    B.tag(B.T.SetBackgroundColor, B.body((w) => w.rgb({ r: 15, g: 23, b: 42 }))),
    square,
    sprite(10, 10, spinner),
    sprite(11, 2, [place(1, { character: 1, matrix: { scaleX: 0.3, scaleY: 0.3 } }), B.doAction(A.play(), A.jump(0), A.stop()), show(), show()]),
    place(1, { character: 10, matrix: { translateX: 1000, translateY: 1000 }, name: 'spinner' }),
    place(2, { character: 11, matrix: { translateX: 3000, translateY: 3000 } }),
    show(),
    show(),
    label('three'), B.doAction(A.gotoLabel('five'), A.play()), show(),
    B.doAction(A.stop()), show(),
    label('five'),
    B.doAction(A.setTarget('spinner'), A.gotoFrame(6), A.setTarget(''), A.pushString('x'), A.pushString('1'), A.setVariable(),
      A.getURL('http://example.com/', '_blank'), A.stop()),
    show(),
    B.doAction(A.stop()), show(),
    B.tag(B.T.End)
  ];
  return B.swf({ version: 6, stage: { xMax: 4000, yMax: 4000 }, fps: 12, frameCount: 6, tags });
}

module.exports = { buildActions };
