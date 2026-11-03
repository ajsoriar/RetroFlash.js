'use strict';
// Project-authored JavaScript <-> ActionScript 2 fixture (SWF 8, 550x400, 24 fps), used by tests/unit/interop.test.js
// and played by demo/interop/index.html. `node tests/fixtures/interop.js` (re)writes demo/interop/interop.swf.
//   root f1: sum = ExternalInterface.call("test.add", 2, 3); uni = call("echo", "ñ€😀"); viaReturn = call("viaReturn");
//            missing = call("nope"); holder = { prefix: "SWF:" };
//            ok = addCallback("setMessage", holder, function (m) { return this.prefix + m; });
//            ok2 = addCallback("rawArgs", null, function (a) { return a; });
//            ok3 = addCallback("nest", null, function (n) { return ExternalInterface.call("deeper", n); });
//            avail / oid / marshal = ExternalInterface.available / objectID / marshallExceptions;
//            fscommand("ready", "yes"); getURL("fscommand:viaurl", "args"); getURL("javascript:onReady(42)");
//            getURL("javascript:alert(document.cookie)") (never run: not a plain call); stop()
//        f2: frame2 = "ran"; an orange bar appears
//        f3: labelled "end"
//   sprite 5 "menu" (at 10, 5 px): f1 stop(), a blue square; f2 "open": _root.menuCalled = "yes", a green square on
//   top; f3 the blue square only.
const fs = require('fs');
const path = require('path');
const B = require('../support/swf-builder');
const { rec, str, push } = require('../support/avm1-asm');

const GET = [0x1c], SET = [0x1d], MEMBER = [0x4e], CALL_METHOD = [0x52], RETURN = [0x3e], ADD2 = [0x47], STOP = [0x07];
const INIT_OBJECT = [0x43];
const EI = [push('flash'), GET, push('external'), MEMBER, push('ExternalInterface'), MEMBER];
const u16 = (n) => [n & 0xff, n >> 8];
// function (params) { body } pushed on the stack (DefineFunction without a name).
function fn(params, body) {
  const code = body.flat(Infinity);
  return [...rec(0x9b, ...str(''), ...u16(params.length), ...params.flatMap(str), ...u16(code.length)), ...code];
}
// ExternalInterface.method(arg, ...): each argument is code that pushes one value.
const ei = (method, ...args) => [...args.slice().reverse(), push(args.length), EI, push(method), CALL_METHOD];
const getURL = (url, target = '') => rec(0x83, ...str(url), ...str(target));
const set = (name, ...code) => [push(name), ...code, SET];
const frameLabel = (name) => B.tag(B.T.FrameLabel, B.body((w) => w.string(name)));
const show = () => B.tag(B.T.ShowFrame);
const end = () => B.tag(B.T.End);
const action = (...code) => B.doAction(code.flat(Infinity));
const sprite = (id, frames, ...tags) => B.tag(B.T.DefineSprite, Buffer.concat([B.body((w) => w.u16(id).u16(frames)), ...tags.map((t) => Buffer.from(t)), end()]));
function place(depth, character, x, y, name) {
  return B.tag(B.T.PlaceObject2, B.body((w) => {
    w.u8(0x02 | 0x04 | (name ? 0x20 : 0)).u16(depth).u16(character);
    B.matrix(w, { translateX: x, translateY: y });
    if (name) w.string(name);
  }));
}
const removeObject = (depth) => B.tag(B.T.RemoveObject2, B.body((w) => w.u16(depth)));
const rectangle = (id, width, height, color) => B.defineShape(id, {
  version: 1, bounds: { xMin: 0, xMax: width, yMin: 0, yMax: height }, fills: [{ color }],
  records: [{ move: [0, 0], fill1: 1 }, { to: [width, 0] }, { to: [width, height] }, { to: [0, height] }, { to: [0, 0] }]
});

function buildInterop() {
  return B.swf({ version: 8, frameCount: 3, tags: [
    B.tag(B.T.FileAttributes, B.body((w) => w.u32(0))),
    B.tag(B.T.SetBackgroundColor, B.body((w) => w.rgb({ r: 0xf4, g: 0xf1, b: 0xea }))),
    rectangle(10, 1600, 1600, [40, 110, 200]),
    rectangle(11, 1200, 1200, [30, 160, 90]),
    rectangle(12, 6000, 600, [230, 130, 40]),
    sprite(5, 3,
      place(1, 10, 0, 0), action(STOP), show(),
      frameLabel('open'), place(2, 11, 200, 200), action(push('/:menuCalled', 'yes'), SET), show(),
      removeObject(2), show()),
    place(1, 5, 200, 100, 'menu'),
    action(
      set('sum', ei('call', push('test.add'), push(2), push(3))),
      set('uni', ei('call', push('echo'), push('ñ€😀'))),
      set('viaReturn', ei('call', push('viaReturn'))),
      set('missing', ei('call', push('nope'))),
      set('holder', push('prefix', 'SWF:', 1), INIT_OBJECT),
      set('ok', ei('addCallback', push('setMessage'), [push('holder'), GET],
        fn(['m'], [push('this'), GET, push('prefix'), MEMBER, push('m'), GET, ADD2, RETURN]))),
      set('ok2', ei('addCallback', push('rawArgs'), push(null), fn(['a'], [push('a'), GET, RETURN]))),
      set('ok3', ei('addCallback', push('nest'), push(null), fn(['n'], [ei('call', push('deeper'), [push('n'), GET]), RETURN]))),
      set('avail', EI, push('available'), MEMBER),
      set('oid', EI, push('objectID'), MEMBER),
      set('marshal', EI, push('marshallExceptions'), MEMBER),
      getURL('FSCommand:ready', 'yes'),
      getURL('fscommand:viaurl', 'args'),
      getURL('javascript:onReady(42)'),
      getURL('javascript:alert(document.cookie)'),
      STOP
    ), show(),
    place(2, 12, 2000, 6000), action(set('frame2', push('ran'))), show(),
    frameLabel('end'), show(),
    end()
  ] });
}

const DEMO_FILE = path.join(__dirname, '..', '..', 'demo', 'interop', 'interop.swf');

if (require.main === module) {
  fs.writeFileSync(DEMO_FILE, buildInterop());
  console.log('wrote ' + path.relative(process.cwd(), DEMO_FILE));
}

module.exports = { buildInterop, DEMO_FILE };
