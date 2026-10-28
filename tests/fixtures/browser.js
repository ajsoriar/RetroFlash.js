'use strict';
// Project-authored browser-interaction fixture (SWF 7, 400x200, 12 fps): what a movie asks of the page.
//   root f1: num_img = 1; loadMovie("child.swf", "contenedor"); gotoAndStop(2)
//        f2: loadMovie("vv/imagenes/img" + num_img + ".jpg", "square"); stop()
//        f3: gotoAndStop(2)
//   buttons on the root (release): 20 prev (num_img - 1, not below 1; gotoAndStop(3)), 21 next (num_img + 1;
//   gotoAndStop(3)), 22 getURL("visita002.html"), 23 getURL("visita002.html", "_blank"), 24 getURL("visita002.html",
//   "ventana"), 25 getURL("javascript:panorama(2)"), 26 getURL("javascript:panorama(3)"), 27 fscommand("mensaje", "hola")
//   sprite 40 "form": f1 nombre = "Ana Ñ"; edad = 30; stop(); its buttons 28 getURL("buscar.php?q=1", "_blank", "GET")
//   and 29 getURL("enviar.php", "resultado", "POST") send its variables.
//   Empty sprites "contenedor" (41) and "square" (42) receive the loads.
const B = require('../support/swf-builder');
const { rec, push, assemble } = require('../support/avm1-asm');

const GET = [0x1c], SET = [0x1d], STOP = [0x07];
const gotoAndStop = (frame) => [0x81, 2, 0, (frame - 1) & 0xff, (frame - 1) >> 8];
const getURL = (url, target) => rec(0x83, ...Buffer.from(url + '\0' + target + '\0', 'utf8'));
// GetURL2 with its flags byte: 0x40 loads into a clip, the low two bits are the method (1 GET, 2 POST).
const getURL2 = (url, target, flags) => [push(url, target), rec(0x9a, flags)];
const script = (...records) => B.doAction(records.flat(Infinity));
const show = () => B.tag(B.T.ShowFrame);
const end = () => B.tag(B.T.End);
const sprite = (id, frames, children) => B.tag(B.T.DefineSprite, Buffer.concat([B.body((w) => w.u16(id).u16(frames)), ...children, end()]));
function place(depth, id, x, y, name) {
  return B.tag(B.T.PlaceObject2, B.body((w) => {
    w.u8(0x02 | 0x04 | (name ? 0x20 : 0)).u16(depth).u16(id);
    B.matrix(w, { translateX: x, translateY: y });
    if (name) w.string(name);
  }));
}
// A push button: shape 1 in every state, its actions on release (OverDownToOverUp).
const button = (id, records) => B.defineButton2(id, {
  records: [{ states: { up: true, over: true, down: true, hit: true }, character: 1, depth: 1 }],
  actions: [{ conditions: 8, records: [records.flat(Infinity)] }]
});

// The buttons' positions (twips), for tests that click them.
const BUTTONS = {
  prev: [500, 1000], next: [1300, 1000], self: [2100, 1000], blank: [2900, 1000], named: [3700, 1000],
  panorama2: [4500, 1000], panorama3: [5300, 1000], fscommand: [6100, 1000], get: [500, 3000], post: [1300, 3000]
};

function buildBrowser() {
  const face = B.defineShape(1, {
    version: 1, bounds: { xMin: -300, xMax: 300, yMin: -300, yMax: 300 }, fills: [{ color: [56, 189, 248] }],
    records: [{ move: [-300, -300], fill1: 1 }, { to: [300, -300] }, { to: [300, 300] }, { to: [-300, 300] }, { to: [-300, -300] }]
  });
  const prev = assemble([
    push('num_img'), GET, push(1), [0x67], [0x12], { if: 'go' },  // if (num_img > 1)
    push('num_img', 'num_img'), GET, [0x51], SET,                 //   num_img--
    { label: 'go' }, gotoAndStop(3)
  ]);
  const next = [push('num_img', 'num_img'), GET, [0x50], SET, gotoAndStop(3)];
  const form = sprite(40, 1, [
    place(1, 28, 0, 0), place(2, 29, 800, 0),
    script(push('nombre', 'Ana Ñ'), SET, push('edad', 30), SET, STOP),
    show()
  ]);
  const tags = [
    B.tag(B.T.SetBackgroundColor, B.body((w) => w.rgb({ r: 255, g: 255, b: 255 }))),
    face,
    button(20, prev), button(21, next),
    button(22, getURL('visita002.html', '')), button(23, getURL('visita002.html', '_blank')),
    button(24, getURL('visita002.html', 'ventana')),
    button(25, getURL('javascript:panorama(2)', '')), button(26, getURL('javascript:panorama(3)', '')),
    button(27, getURL('FSCommand:mensaje', 'hola')),
    button(28, getURL2('buscar.php?q=1', '_blank', 0x01)), button(29, getURL2('enviar.php', 'resultado', 0x02)),
    sprite(41, 1, [show()]), sprite(42, 1, [show()]), form,
    place(1, 41, 0, 2000, 'contenedor'), place(2, 42, 4000, 2000, 'square'),
    ...['prev', 'next', 'self', 'blank', 'named', 'panorama2', 'panorama3', 'fscommand'].map((k, i) => place(10 + i, 20 + i, BUTTONS[k][0], BUTTONS[k][1])),
    place(30, 40, BUTTONS.get[0], BUTTONS.get[1], 'form'),
    script(push('num_img', 1), SET, getURL2('child.swf', 'contenedor', 0x40), gotoAndStop(2)),
    show(),
    script(push('vv/imagenes/img', 'num_img'), GET, [0x47], push('.jpg'), [0x47], push('square'), rec(0x9a, 0x40), STOP),
    show(),
    script(gotoAndStop(2)),
    show(),
    end()
  ];
  return B.swf({ version: 7, stage: { xMax: 8000, yMax: 4000 }, fps: 12, frameCount: 3, tags });
}

module.exports = { buildBrowser, BUTTONS };
