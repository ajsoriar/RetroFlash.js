'use strict';
// Project-authored text fixture (SWF 10, 400x300, 12 fps, 1 frame). Fonts are drawn here, not taken from a font file.
//   font 1 "RetroSans" (DefineFont2, layout): glyphs H, I, O (a ring with a hole) and space, on a 1024 EM square
//   font 2 "RetroSans3" (DefineFont3, layout): glyph I on the 20480 EM square
//   font 3 "_sans" (DefineFont2 without glyphs: device font)
//   font 4 "Verdana" bold (DefineFont2 without glyphs, without CodeTableOffset)
//   text 10 (DefineText): "HI O" red, then "OH" blue one line lower (font and height carried over)
//   text 11 (DefineText2): "III" in translucent green with font 2
//   field 20: device font, centered, single line
//   field 21: embedded font 1 (UseOutlines), word wrap in a narrow box
//   field 22: HTML: right-aligned paragraph with <font color size> and <b>, centered paragraph with <u>, &amp; and <i>, an <li>
//   field 23: border and AutoSize (grows to fit its text)
//   field 24: input field bound to the variable "secret", password, border
const B = require('../support/swf-builder');

const box = (x0, y0, x1, y1) => [{ move: [x0, y0], fill1: 1 }, { to: [x1, y0] }, { to: [x1, y1] }, { to: [x0, y1] }, { to: [x0, y0] }];
const H = [
  { move: [100, -700], fill1: 1 }, { to: [220, -700] }, { to: [220, -420] }, { to: [480, -420] }, { to: [480, -700] }, { to: [600, -700] },
  { to: [600, 0] }, { to: [480, 0] }, { to: [480, -300] }, { to: [220, -300] }, { to: [220, 0] }, { to: [100, 0] }, { to: [100, -700] }
];
const O = [...box(100, -700, 600, 0), { move: [250, -550] }, { to: [450, -550] }, { to: [450, -150] }, { to: [250, -150] }, { to: [250, -550] }];
const glyphBounds = (xMax) => ({ xMin: 100, xMax, yMin: -700, yMax: 0 });

function place(depth, character, x, y) {
  return B.tag(B.T.PlaceObject2, B.body((w) => { w.u8(0x02 | 0x04).u16(depth).u16(character); B.matrix(w, { translateX: x, translateY: y }); }));
}

function buildText() {
  const tags = [
    B.tag(B.T.FileAttributes, B.body((w) => w.u32(0))),
    B.tag(B.T.SetBackgroundColor, B.body((w) => w.rgb({ r: 248, g: 250, b: 252 }))),
    B.defineFont2(1, {
      name: 'RetroSans', layout: { ascent: 800, descent: 224, leading: 0 }, nameNul: true,
      glyphs: [
        { code: 72, records: H, advance: 700, bounds: glyphBounds(600) },
        { code: 73, records: box(100, -700, 300, 0), advance: 400, bounds: glyphBounds(300) },
        { code: 79, records: O, advance: 700, bounds: glyphBounds(600) },
        { code: 32, records: [], advance: 300 }
      ],
      kerning: [[72, 73, -20]]
    }),
    B.defineFont2(2, {
      name: 'RetroSans3', layout: { ascent: 16000, descent: 4480, leading: 0 },
      glyphs: [{ code: 73, records: box(2000, -14000, 6000, 0), advance: 8000 }]
    }, 3),
    B.defineFont2(3, { name: '_sans', glyphs: [] }),
    B.defineFont2(4, { name: 'Verdana', bold: true, glyphs: [], noCodeTableOffset: true }),
    B.defineText(10, {
      bounds: { xMin: 0, xMax: 830, yMin: -280, yMax: 500 },
      records: [
        { fontId: 1, height: 400, color: [220, 38, 38], x: 0, y: 0, glyphs: [[0, 273], [1, 156], [3, 117], [2, 273]] },
        { color: [37, 99, 235], x: 0, y: 500, glyphs: [[2, 273], [0, 273]] }
      ]
    }),
    B.defineText(11, {
      version: 2, bounds: { xMin: 0, xMax: 470, yMin: -280, yMax: 0 },
      records: [{ fontId: 2, height: 400, color: [22, 163, 74, 128], x: 0, y: 0, glyphs: [[0, 156], [0, 156], [0, 156]] }]
    }),
    B.defineEditText(20, {
      bounds: { xMin: -40, xMax: 3960, yMin: -40, yMax: 460 }, fontId: 3, height: 300, color: [15, 23, 42],
      align: 2, leading: 40, noSelect: true, text: 'Device text, centered'
    }),
    B.defineEditText(21, {
      bounds: { xMin: -40, xMax: 1640, yMin: -40, yMax: 1800 }, fontId: 1, height: 400, color: [22, 101, 52],
      leading: 40, wordWrap: true, multiline: true, useOutlines: true, text: 'HI HO OH IH OHIO'
    }),
    B.defineEditText(22, {
      bounds: { xMin: -40, xMax: 7600, yMin: -40, yMax: 1400 }, fontId: 3, height: 280, color: [0, 0, 0],
      wordWrap: true, multiline: true, html: true,
      text: '<p align="right"><font color="#0000FF" size="18">Blue</font> and <b>bold</b></p>' +
        '<p align="center"><u>Second</u> &amp; <i>last</i></p><li>Item</li>'
    }),
    B.defineEditText(23, {
      bounds: { xMin: -40, xMax: 400, yMin: -40, yMax: 300 }, fontId: 3, height: 240, color: [30, 41, 59],
      border: true, autoSize: true, text: 'Auto-sized box'
    }),
    B.defineEditText(24, {
      bounds: { xMin: -40, xMax: 2000, yMin: -40, yMax: 400 }, fontId: 4, height: 240, color: [30, 41, 59],
      border: true, readOnly: false, password: true, variable: 'secret', text: 'hidden'
    }),
    place(1, 10, 400, 1000),
    place(2, 11, 2400, 1000),
    place(3, 21, 4400, 400),
    place(4, 20, 200, 1700),
    place(5, 22, 200, 2400),
    place(6, 23, 200, 4400),
    place(7, 24, 4400, 4400),
    B.tag(B.T.ShowFrame),
    B.tag(B.T.End)
  ];
  return B.swf({ version: 10, stage: { xMax: 8000, yMax: 6000 }, fps: 12, frameCount: 1, tags });
}

module.exports = { buildText };
