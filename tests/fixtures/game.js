'use strict';
// Project-authored mini game (SWF 6, 400x200, 12 fps), the acceptance test of the AVM1 game APIs:
//   sprite 10 "hero": a 20 x 20 px blue square at (20, 100) px. Its onClipEvent(enterFrame) moves it 10 px
//     right or left while Key.RIGHT or Key.LEFT is down.
//   sprite 11 "coin": a 10 x 10 px yellow square at (100, 100) px. The root script gives it an onEnterFrame
//     method: when it touches the hero (hitTest), _root.score goes up by one and the coin jumps 60 px right.
//   text field 20, bound to the variable "score" (initial text "0"), at the top right.
//   root: one frame; its script sets score = 0 and the coin's onEnterFrame, then stops.
const B = require('../support/swf-builder');
const { rec, str, push, assemble } = require('../support/avm1-asm');

const GET = [0x1c], SET = [0x1d], NOT = [0x12];
const getMember = (name) => [push(name), [0x4e]];
const u16 = (n) => [n & 0xff, n >> 8];

function square(id, half, color) {
  return B.defineShape(id, {
    version: 1, bounds: { xMin: -half, xMax: half, yMin: -half, yMax: half }, fills: [{ color }],
    records: [{ move: [-half, -half], fill1: 1 }, { to: [half, -half] }, { to: [half, half] }, { to: [-half, half] }, { to: [-half, -half] }]
  });
}
const sprite = (id, shape) => B.tag(B.T.DefineSprite, Buffer.concat([
  B.body((w) => w.u16(id).u16(1)),
  B.tag(B.T.PlaceObject2, B.body((w) => { w.u8(0x02 | 0x04).u16(1).u16(shape); B.matrix(w, {}); })),
  B.tag(B.T.ShowFrame), B.tag(B.T.End)
]));
// if (Key.isDown(Key.<key>)) _x <op>= 10;
function moveOn(key, op) {
  const end = 'not' + key;
  return [
    push('Key'), GET, getMember(key), push(1, 'Key'), GET, push('isDown'), [0x52], NOT, { if: end },
    push('_x', '_x'), GET, push(10), [op], SET,
    { label: end }
  ];
}
// PlaceObject2 with a name and clip actions: one onClipEvent(enterFrame) record (SWF 6: UI32 event flags).
function placeWithEnterFrame(depth, id, name, x, y, actions) {
  const code = [...actions, 0x00];
  return B.tag(B.T.PlaceObject2, B.body((w) => {
    w.u8(0x02 | 0x04 | 0x20 | 0x80).u16(depth).u16(id);
    B.matrix(w, { translateX: x, translateY: y });
    w.string(name);
    w.u16(0).u32(0x02);              // Reserved, AllEventFlags (enterFrame)
    w.u32(0x02).u32(code.length);    // EventFlags (enterFrame), ActionRecordSize
    w.raw(code);
    w.u32(0);                        // ClipActionEndFlag
  }));
}
const place = (depth, id, name, x, y) => B.tag(B.T.PlaceObject2, B.body((w) => {
  w.u8(0x02 | 0x04 | (name ? 0x20 : 0)).u16(depth).u16(id);
  B.matrix(w, { translateX: x, translateY: y });
  if (name) w.string(name);
}));

function buildGame() {
  const heroActions = assemble([...moveOn('RIGHT', 0x47), ...moveOn('LEFT', 0x0b)]);
  // coin.onEnterFrame = function () { if (this.hitTest(_root.hero)) { _root.score++; this._x += 60; } }
  const onEnterFrame = assemble([
    push('_root'), GET, getMember('hero'), push(1, 'this'), GET, push('hitTest'), [0x52], NOT, { if: 'miss' },
    push('_root'), GET, push('score'), push('_root'), GET, getMember('score'), [0x50], [0x4f],
    push('this'), GET, push('_x'), push('this'), GET, getMember('_x'), push(60), [0x47], [0x4f],
    { label: 'miss' }
  ]);
  const literal = [...rec(0x9b, ...str(''), 0, 0, ...u16(onEnterFrame.length)), ...onEnterFrame];
  const rootScript = [
    push('score', 0), SET,
    push('coin'), GET, push('onEnterFrame'), literal, [0x4f],
    [0x07]
  ].flat(Infinity);
  const tags = [
    B.tag(B.T.SetBackgroundColor, B.body((w) => w.rgb({ r: 15, g: 23, b: 42 }))),
    square(1, 200, [56, 189, 248]), square(2, 100, [250, 204, 21]),
    sprite(10, 1), sprite(11, 2),
    B.defineEditText(20, {
      bounds: { xMin: 0, xMax: 1600, yMin: 0, yMax: 500 }, variable: 'score', text: '0', color: [255, 255, 255, 255]
    }),
    placeWithEnterFrame(1, 10, 'hero', 400, 2000, heroActions),
    place(2, 11, 'coin', 2000, 2000),
    place(3, 20, null, 6000, 200),
    B.doAction(rootScript),
    B.tag(B.T.ShowFrame),
    B.tag(B.T.End)
  ];
  return B.swf({ version: 6, stage: { xMax: 8000, yMax: 4000 }, fps: 12, frameCount: 1, tags });
}

module.exports = { buildGame };
