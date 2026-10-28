'use strict';
// Browser interaction: getURL to windows, javascript: URLs read as page calls (never evaluated), FSCommand,
// GET and POST forms, ExternalInterface in both directions, FlashVars, the Player's cancelable events, and the
// browser host (RetroFlash.createBrowserHost) against a stand-in window: navigation, page calls, CORS and
// rewritten URLs. Nothing navigates or fetches for real.
const fs = require('fs');
const path = require('path');
const { test, assert } = require('../support/harness');
const { SWFReader, RetroFlash } = require('../support/load-reader');
const B = require('../support/swf-builder');
const { I, rec, str, push } = require('../support/avm1');
const { FIXTURE_DIR } = require('../fixtures/build-fixtures');
const { BUTTONS } = require('../fixtures/browser');

const GET = [0x1c], SET = [0x1d], MEMBER = [0x4e], CALL_METHOD = [0x52], RETURN = [0x3e];
const fixture = () => new Uint8Array(fs.readFileSync(path.join(FIXTURE_DIR, 'valid/fws-browser.swf')));
const plain = (request) => Object.assign({}, request);
const image = B.png(4, 2, new Uint8Array(32).fill(255));

// A test image decoder (Node has no createImageBitmap): the size comes from the image header.
async function decodeImage(bytes, limits) {
  const size = I.imageSize(bytes, I.imageFormat(bytes));
  const reserved = I.reservePixels(limits, size.width, size.height);
  return { source: { width: size.width, height: size.height, close() {} }, width: size.width, height: size.height, reserved };
}
// A loaded child movie: SWF 8, two frames.
const child = () => B.swf({ version: 8, frameCount: 2, tags: [B.tag(B.T.ShowFrame), B.tag(B.T.ShowFrame), B.tag(B.T.End)] });

/* Runs the fixture with a host that records what it is asked (`host: null` for none) and a loader that gives
   child.swf and an image for every .jpg. click(name) presses and releases a button of the fixture. */
async function start(host = {}, options = {}) {
  const movie = new I.Movie(await SWFReader.load(options.bytes || fixture()));
  const reported = [], asked = { navigate: [], call: [], fscommand: [] }, loads = [];
  const recorder = host && Object.assign({
    objectID: 'prue004',
    navigate: (r) => { asked.navigate.push(plain(r)); },
    call: (r) => { asked.call.push(plain(r)); },
    fscommand: (r) => { asked.fscommand.push(plain(r)); }
  }, host);
  const loader = (r) => { loads.push(r.url); return /\.jpg/.test(r.url) ? image : r.url === 'child.swf' ? child() : null; };
  const env = I.createEnv(movie, (feature) => reported.push(feature), { host: recorder, loader, dispatch: options.dispatch });
  env.loads.decodeImage = decodeImage;
  const root = new I.Clip(env, movie.root, 0, null);
  root.gotoFrame(1);
  env.scripts.run();
  const input = new I.InputController(env, () => root);
  const run = (changed) => { if (changed) { env.scripts.beginUpdate(); env.scripts.run(); } };
  return {
    env, root, reported, asked, loads,
    click: (name) => { run(input.move(BUTTONS[name][0], BUTTONS[name][1])); run(input.down()); run(input.up()); },
    settle: async () => { await env.loads.idle(); env.scripts.beginUpdate(); env.loads.apply(); env.scripts.run(); }
  };
}

test('getURL: a relative URL to the current window, _blank and a named window reach the host as written', async () => {
  const m = await start();
  m.click('self');
  m.click('blank');
  m.click('named');
  assert.deepStrictEqual(m.asked.navigate, [
    { url: 'visita002.html', target: '', method: null },
    { url: 'visita002.html', target: '_blank', method: null },
    { url: 'visita002.html', target: 'ventana', method: null }
  ]);
  assert.deepStrictEqual(m.reported, []);
});

test('javascript:panorama(2) and (3) call the page function by name with a number; nothing is evaluated', async () => {
  const m = await start();
  m.click('panorama2');
  m.click('panorama3');
  assert.deepStrictEqual(m.asked.call, [
    { kind: 'javascript', name: 'panorama', args: [2], source: 'javascript:panorama(2)' },
    { kind: 'javascript', name: 'panorama', args: [3], source: 'javascript:panorama(3)' }
  ]);
  assert.strictEqual(typeof m.asked.call[0].args[0], 'number');
  assert.deepStrictEqual(m.asked.navigate, [], 'a javascript: URL is not a page to open');
});

test('FSCommand: the command and its arguments go to the host', async () => {
  const m = await start();
  m.click('fscommand');
  assert.deepStrictEqual(m.asked.fscommand, [{ command: 'mensaje', args: 'hola' }]);
});

test('GetURL2 with GET and POST sends the variables of the timeline the button is on', async () => {
  const m = await start();
  m.click('get');
  m.click('post');
  const variables = [['edad', '30'], ['nombre', 'Ana Ñ']];
  assert.deepStrictEqual(m.asked.navigate, [
    { url: 'buscar.php?q=1&edad=30&nombre=Ana+%C3%91', target: '_blank', method: 'GET', variables },
    { url: 'enviar.php', target: 'resultado', method: 'POST', variables, body: 'edad=30&nombre=Ana+%C3%91' }
  ]);
});

test('gallery: loadMovie into "contenedor", and the image URL built from num_img into "square" as buttons change it', async () => {
  const m = await start();
  assert.deepStrictEqual(m.loads, ['child.swf', 'vv/imagenes/img1.jpg']);
  await m.settle();
  const square = m.root.childByName('square'), contenedor = m.root.childByName('contenedor');
  assert.strictEqual(contenedor.frameCount(), 2, 'child.swf plays in contenedor');
  assert.strictEqual(square.displayList.get(1).character.type, 'bitmap');
  assert.strictEqual(I.getProperty(square, 15, 7), 'vv/imagenes/img1.jpg', '_url of the loaded image');
  m.click('next');
  m.click('next');
  m.click('prev');
  m.click('prev');
  m.click('prev');
  await m.env.loads.idle();
  assert.deepStrictEqual(m.loads.slice(2), ['vv/imagenes/img2.jpg', 'vv/imagenes/img3.jpg', 'vv/imagenes/img2.jpg', 'vv/imagenes/img1.jpg', 'vv/imagenes/img1.jpg']);
  assert.strictEqual(m.root.variables.get('num_img'), 1, 'never below 1');
  await m.settle();
  assert.strictEqual(square.displayList.get(1).character.name, 'vv/imagenes/img1.jpg');
  assert.deepStrictEqual(m.reported, []);
});

test('without a host, navigation, page calls and FSCommands are reported and never done', async () => {
  const m = await start(null);
  m.click('self');
  m.click('panorama2');
  m.click('fscommand');
  assert.deepStrictEqual(m.reported, ['browser:noHost', 'browser:noHost', 'browser:noHost']);
});

test('host errors are reported by kind; the movie goes on', async () => {
  const fail = (code) => () => { const e = new Error(code); e.code = code; throw e; };
  const m = await start({ navigate: fail('BLOCKED'), call: fail('FUNCTION_MISSING'), fscommand: () => { throw new Error('boom'); } });
  m.click('self');
  m.click('panorama2');
  m.click('fscommand');
  const unsupported = await start({ call: fail('UNSUPPORTED'), navigate: fail('INVALID_URL') });
  unsupported.click('panorama2');
  unsupported.click('blank');
  assert.deepStrictEqual(m.reported.concat(unsupported.reported),
    ['browser:blocked', 'browser:functionMissing', 'browser:callFailed', 'browser:javascriptUnsupported', 'browser:invalidURL']);
  m.click('next');
  assert.strictEqual(m.root.variables.get('num_img'), 2, 'scripts still run');
});

test('javascript: URLs: calls with literal arguments are read; anything else is never run', () => {
  const read = I.parseScriptURL;
  assert.deepStrictEqual(read('javascript:panorama(2)'), [{ name: 'panorama', args: [2] }]);
  assert.deepStrictEqual(read(' JavaScript: window.open("a.html", \'_blank\');'), [{ name: 'window.open', args: ['a.html', '_blank'] }]);
  assert.deepStrictEqual(read('javascript:a(-0x10, 1.5e2, -.5, true, false, null, undefined, "x\\"y\\u00f1", \'\')'),
    [{ name: 'a', args: [-16, 150, -0.5, true, false, null, undefined, 'x"yñ', ''] }]);
  assert.deepStrictEqual(read('javascript:a(1); b . c ("2");;'), [{ name: 'a', args: [1] }, { name: 'b.c', args: ['2'] }]);
  assert.deepStrictEqual(read('javascript:void(0)'), []);
  assert.deepStrictEqual(read('javascript:void 0'), []);
  assert.deepStrictEqual(read('javascript:void(abrir(%27a%20b%27))'), [{ name: 'abrir', args: ['a b'] }]);
  assert.deepStrictEqual(read('javascript:panorama%282%29'), [{ name: 'panorama', args: [2] }]);
  ['javascript:alert(document.cookie)', 'javascript:x=1', 'javascript:f(1)+g(2)', 'javascript:new Foo()', 'javascript:"text"',
    'javascript:f(1', 'javascript:f(g(1))', 'javascript:f(1) g(2)', 'javascript:f("a\nb")', 'http://example.com/', 'javascript:' + 'f(1);'.repeat(1000)]
    .forEach((url) => assert.strictEqual(read(url), null, url));
});

test('javascript: text that is not calls reaches the host with no name, for it to refuse', async () => {
  const swf = B.swf({ version: 7, tags: [B.doAction([rec(0x83, ...Buffer.from('javascript:alert(document.cookie)\0\0'))].flat()), B.tag(B.T.ShowFrame), B.tag(B.T.End)] });
  const m = await start({}, { bytes: swf });
  assert.deepStrictEqual(m.asked.call, [{ kind: 'javascript', name: null, args: [], source: 'javascript:alert(document.cookie)' }]);
});

test('values to and from the page: arrays, objects, clips, functions and cycles', async () => {
  const m = await start();
  const rt = I.runtimeOf(m.env.scripts);
  const obj = I.fromHostValue(rt, { a: [1, 'x', { b: true }], f() {}, n: null, big: 2n });
  const back = I.toHostValue(rt, obj);
  assert.deepStrictEqual(back, { a: [1, 'x', { b: true }], f: undefined, n: null, big: 2 });
  const cycle = {};
  cycle.self = cycle;
  assert.deepStrictEqual(I.toHostValue(rt, I.fromHostValue(rt, cycle)), { self: null });
  const form = m.root.childByName('form');
  assert.deepStrictEqual(I.toHostValue(rt, form), { edad: 30, nombre: 'Ana Ñ' }, 'a clip gives its variables');
  const named = new I.AvmObject(rt.protos.Object);
  I.setOwn(named, '__proto__', I.fromHostValue(rt, { x: 1 }), 7);
  const out = I.toHostValue(rt, named);
  assert.strictEqual(Object.getPrototypeOf(out), Object.prototype, 'a member named __proto__ stays a plain property');
  assert.deepStrictEqual(Object.keys(out), ['__proto__']);
});

// ---- ExternalInterface and the Player ----

if (!globalThis.Path2D) globalThis.Path2D = class { addPath() {} moveTo() {} lineTo() {} quadraticCurveTo() {} closePath() {} };
if (!globalThis.DOMMatrix) globalThis.DOMMatrix = class { constructor(m) { this.m = m; } };
function headlessPlayer(options) {
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => ({ addColorStop() {} })), set: (t, k, v) => { t[k] = v; return true; } });
  return new RetroFlash.Player(Object.assign({ canvas: { getContext: () => ctx, style: {}, width: 0, height: 0 }, input: false }, options));
}
const EI = [push('flash'), GET, push('external'), MEMBER, push('ExternalInterface'), MEMBER];
const u16 = (n) => [n & 0xff, n >> 8];
// function (params) { body } pushed on the stack (DefineFunction without a name).
function fn(params, body) {
  const code = body.flat(Infinity);
  return [...rec(0x9b, ...str(''), ...u16(params.length), ...params.flatMap(str), ...u16(code.length)), ...code];
}
/* r = ExternalInterface.call("sumar", 2, 3); avail = .available; id = .objectID;
   obj = ExternalInterface.call("eco", { a: [1, "x"] }); t = obj.a[1];
   ok = ExternalInterface.addCallback("saludar", null, function (n) { count++; return "hola " + n; });
   nested = ExternalInterface.call("reentrar") */
const externalMovie = () => B.swf({ version: 8, tags: [B.tag(B.T.FileAttributes, B.body((w) => w.u32(0))), B.doAction([
  push('count', 0), SET,
  push('r', 3, 2, 'sumar', 3), EI, push('call'), CALL_METHOD, SET,
  push('avail'), EI, push('available'), MEMBER, SET,
  push('id'), EI, push('objectID'), MEMBER, SET,
  push('obj', 'a', 'x', 1, 2), [0x42], push(1), [0x43], push('eco', 2), EI, push('call'), CALL_METHOD, SET,
  push('t', 'obj'), GET, push('a'), MEMBER, push(1), MEMBER, SET,
  push('ok'), fn(['n'], [push('count', 'count'), GET, [0x50], SET, push('hola ', 'n'), GET, [0x47], RETURN]), push(null, 'saludar', 3), EI,
  push('addCallback'), CALL_METHOD, SET,
  push('nested', 'reentrar', 1), EI, push('call'), CALL_METHOD, SET
].flat(Infinity)), B.tag(B.T.ShowFrame), B.tag(B.T.End)] });

test('ExternalInterface: call returns the page result, values convert both ways, and the page calls back', async () => {
  const calls = [];
  let player;
  const host = {
    objectID: 'prue004',
    call: (r) => {
      calls.push(plain(r));
      if (r.name === 'sumar') return r.args[0] + r.args[1];
      if (r.name === 'eco') return r.args[0];
      if (r.name === 'reentrar') return player.callback('saludar', ['dentro']);
      return undefined;
    }
  };
  player = headlessPlayer({ host });
  const announced = [];
  const liveInteractions = [];
  player.on('interaction', (entry) => liveInteractions.push(entry));
  player.on('callbacks', (names) => announced.push(names));
  await player.load(externalMovie());
  const v = (name) => player.root.variables.get(name);
  assert.deepStrictEqual([v('r'), v('avail'), v('id'), v('t'), v('ok')], [5, true, 'prue004', 'x', true]);
  assert.deepStrictEqual(calls.slice(0, 2), [
    { kind: 'external', name: 'sumar', args: [2, 3], source: 'sumar' },
    { kind: 'external', name: 'eco', args: [{ a: [1, 'x'] }], source: 'eco' }
  ]);
  assert.strictEqual(v('nested'), 'hola dentro', 'the page called back while the movie was calling it');
  assert.deepStrictEqual(announced, [['saludar']]);
  assert.deepStrictEqual(player.getCallbacks(), ['saludar']);
  let frames = 0;
  player.on('frame', () => frames++);
  assert.strictEqual(player.callback('saludar', ['Ana']), 'hola Ana');
  assert.strictEqual(v('count'), 2);
  assert.strictEqual(frames, 1, 'redrawn after a call from the page');
  assert.strictEqual(player.callback('nada'), undefined);
  assert.ok(player.getDiagnostics().unsupported.some((u) => u.feature === 'browser:callbackMissing'));
  const log = player.getInteractionLog();
  assert.ok(log.some((e) => e.direction === 'outgoing' && e.channel === 'call' && e.name === 'sumar' && e.argumentCount === 2));
  assert.ok(log.some((e) => e.direction === 'outgoing' && e.channel === 'ExternalInterface.addCallback' && e.status === 'registered' && e.name === 'saludar'));
  assert.ok(log.some((e) => e.direction === 'incoming' && e.channel === 'ExternalInterface.callback' && e.status === 'called' && e.name === 'saludar'));
  assert.ok(log.some((e) => e.direction === 'incoming' && e.status === 'missing' && e.name === 'nada'));
  assert.ok(log.every(Object.isFrozen), 'log entries cannot be changed by consumers');
  assert.strictEqual(liveInteractions.length, log.length, 'interaction events and the retained history agree');
  const retained = log.length;
  log.pop();
  assert.strictEqual(player.getInteractionLog().length, retained, 'callers receive a copy of the log array');
  assert.strictEqual(player.clearInteractionLog(), player);
  assert.deepStrictEqual(player.getInteractionLog(), []);
  player.stop();
  assert.deepStrictEqual(announced[announced.length - 1], ['saludar'], 'a restart registers them again');
  player.destroy();
});

test('ExternalInterface without a host: not available, call gives null, addCallback false', async () => {
  const player = headlessPlayer({});
  await player.load(externalMovie());
  const v = (name) => player.root.variables.get(name);
  assert.deepStrictEqual([v('r'), v('avail'), v('id'), v('ok'), v('nested')], [null, false, null, false, null]);
  assert.deepStrictEqual(player.getCallbacks(), []);
  player.destroy();
});

test('Player events: a listener that prevents the default handles the request, and may answer a call', async () => {
  const asked = [];
  const host = { call: (r) => { asked.push(r.name); return 1; }, navigate: (r) => asked.push(r.url) };
  const player = headlessPlayer({ host });
  const seen = [];
  player.on('call', (r) => { if (r.name === 'sumar') { r.preventDefault(); r.result = 42; seen.push(r.args); } });
  player.on('navigate', (r) => seen.push(r.url));
  await player.load(externalMovie());
  assert.strictEqual(player.root.variables.get('r'), 42);
  assert.deepStrictEqual(seen, [[2, 3]]);
  assert.deepStrictEqual(asked, ['eco', 'reentrar'], 'the host is asked only for the others');
  assert.ok(player.getInteractionLog().some((e) => e.channel === 'call' && e.name === 'sumar' && e.status === 'handled'));
  player.destroy();
});

test('interaction log: a clip load records URL, type, method and result without variables', async () => {
  const player = headlessPlayer({ loader: (request) => request.url === 'child.swf' ? child() : image });
  await player.load(fixture());
  while (player.env.loads.pending) await player.env.loads.idle();
  const log = player.getInteractionLog().filter((e) => e.channel === 'load');
  assert.ok(log.some((e) => e.status === 'requested' && e.url === 'child.swf' && e.resourceType === 'movie'));
  assert.ok(log.some((e) => e.status === 'received' && e.url === 'child.swf' && e.method === 'GET'));
  assert.ok(log.every((e) => !('variables' in e) && !('body' in e)), 'request contents are not retained');
  player.destroy();
});

test('Player.load options: FlashVars set on the root before frame 1, and the movie URL as _url', async () => {
  const swf = B.swf({ version: 7, tags: [B.doAction([push('seen', 'nombre'), GET, SET, push('url', '', 15), [0x22], SET].flat(Infinity)), B.tag(B.T.ShowFrame), B.tag(B.T.End)] });
  const player = headlessPlayer({});
  await player.load(swf, { url: 'https://site.test/example_1.swf', variables: '?nombre=Ana+%C3%91&n=2' });
  const v = (name) => player.root.variables.get(name);
  assert.deepStrictEqual([v('seen'), v('n'), v('url')], ['Ana Ñ', '2', 'https://site.test/example_1.swf']);
  await player.load(swf, { variables: { nombre: 7 } });
  assert.deepStrictEqual([v('seen'), v('url')], ['7', '']);
  await assert.rejects(player.load(swf, { variables: 5 }), (e) => e.code === 'INVALID_OPTION');
  assert.throws(() => headlessPlayer({ host: 'page' }), (e) => e.code === 'INVALID_OPTION');
  player.destroy();
});

test('MovieClip.getURL opens a page with the clip variables; loads with a method send them', async () => {
  const call = (name, ...args) => [push(...args.slice().reverse(), args.length, '_root'), GET, push(name), CALL_METHOD, [0x17]];
  const swf = B.swf({ version: 7, tags: [B.doAction([
    push('a', 'b c'), SET,
    call('getURL', 'p.html', '_top', 'post'), call('getURL', 'q.html'), call('loadVariables', 'v.php', 'GET')
  ].flat(Infinity)), B.tag(B.T.ShowFrame), B.tag(B.T.End)] });
  const m = await start({}, { bytes: swf });
  assert.deepStrictEqual(m.asked.navigate, [
    { url: 'p.html', target: '_top', method: 'POST', variables: [['a', 'b c']], body: 'a=b+c' },
    { url: 'q.html', target: '', method: null }
  ]);
  assert.deepStrictEqual(m.loads, ['v.php?a=b+c']);
});

// ---- The browser host against a stand-in window ----

function standInWindow({ fetch, images = false } = {}) {
  const log = [];
  const body = { appendChild(n) { n.parentNode = body; }, removeChild(n) { n.parentNode = null; } };
  const document = {
    baseURI: 'https://site.test/visita/example_1.html', body, documentElement: body,
    createElement: (tag) => ({ tag, style: {}, children: [], appendChild(c) { this.children.push(c); }, submit() { log.push(['submit', this]); } })
  };
  class StandInImage {
    set src(href) { this.href = href; setTimeout(() => { if (images) { this.naturalWidth = 4; this.naturalHeight = 2; this.onload(); } else this.onerror(); }, 0); }
  }
  const win = {
    document, Image: StandInImage, fetch: fetch || (() => Promise.reject(new TypeError('Failed to fetch'))),
    location: { origin: 'https://site.test', href: document.baseURI, assign: (url) => log.push(['assign', url]) },
    open: (url, target) => { log.push(['open', url, target]); return {}; },
    eval: () => 'evaluated', Function: function () {}, setTimeout: () => 0, setInterval: () => 0,
    panorama(n) { log.push(['panorama', n, this === win]); return n * 10; },
    visita: { abrir(a, b) { log.push(['abrir', a, b, this === win.visita]); } },
    prue004_DoFSCommand: (command, args) => log.push(['fscommand', command, args]),
    falla: () => { throw new Error('mal'); }
  };
  return { win, log };
}
const response = (bytes, status = 200) => ({ ok: status < 300, status, headers: { get: () => null }, arrayBuffer: async () => Uint8Array.from(bytes).buffer });
const codeOf = (fn) => { try { fn(); } catch (err) { return err.code; } return null; };

test('browser host: navigation resolves against the page and opens windows; POST submits a form', () => {
  const { win, log } = standInWindow();
  const host = RetroFlash.createBrowserHost({ window: win, objectID: 'prue004' });
  host.navigate({ url: 'visita002.html', target: '', method: null });
  host.navigate({ url: '../otra.html', target: '_blank', method: null });
  host.navigate({ url: 'visita002.html', target: 'ventana', method: 'GET' });
  host.navigate({ url: 'enviar.php', target: 'resultado', method: 'POST', variables: [['a', 'b c']], body: 'a=b+c' });
  assert.deepStrictEqual(log.slice(0, 3), [
    ['assign', 'https://site.test/visita/visita002.html'],
    ['open', 'https://site.test/otra.html', '_blank'],
    ['open', 'https://site.test/visita/visita002.html', 'ventana']
  ]);
  const form = log[3][1];
  assert.deepStrictEqual([form.method, form.action, form.target, form.parentNode], ['POST', 'https://site.test/visita/enviar.php', 'resultado', null]);
  assert.deepStrictEqual(form.children.map((c) => [c.type, c.name, c.value]), [['hidden', 'a', 'b c']]);
  const based = RetroFlash.createBrowserHost({ window: win, base: 'https://cdn.test/swf/' });
  based.navigate({ url: 'x.html', target: '_blank' });
  assert.deepStrictEqual(log[4], ['open', 'https://cdn.test/swf/x.html', '_blank'], 'the base parameter');
  assert.strictEqual(codeOf(() => host.navigate({ url: 'http://[bad', target: '' })), 'INVALID_URL');
});

test('browser host: allowScriptAccess and allowNetworking', () => {
  const { win, log } = standInWindow();
  const noScript = RetroFlash.createBrowserHost({ window: win, objectID: 'prue004', allowScriptAccess: false });
  assert.strictEqual(codeOf(() => noScript.navigate({ url: 'a.html', target: '_self' })), 'BLOCKED');
  assert.strictEqual(codeOf(() => noScript.navigate({ url: 'a.html', target: '' })), 'BLOCKED');
  noScript.navigate({ url: 'a.html', target: '_blank' });
  assert.strictEqual(codeOf(() => noScript.call({ name: 'panorama', args: [2] })), 'BLOCKED');
  assert.strictEqual(codeOf(() => noScript.fscommand({ command: 'x', args: '' })), 'BLOCKED');
  const internal = RetroFlash.createBrowserHost({ window: win, allowNetworking: 'internal' });
  assert.strictEqual(codeOf(() => internal.navigate({ url: 'a.html', target: '_blank' })), 'BLOCKED');
  assert.strictEqual(codeOf(() => internal.call({ name: 'panorama', args: [2] })), 'BLOCKED');
  assert.deepStrictEqual(log, [['open', 'https://site.test/visita/a.html', '_blank']]);
});

test('browser host: page functions are called by name; code-running functions and arguments never are', () => {
  const { win, log } = standInWindow();
  const host = RetroFlash.createBrowserHost({ window: win, objectID: 'prue004' });
  assert.strictEqual(host.call({ kind: 'javascript', name: 'panorama', args: [2] }), 20);
  host.call({ kind: 'external', name: 'visita.abrir', args: ['a', 1] });
  host.fscommand({ command: 'mensaje', args: 'hola' });
  assert.deepStrictEqual(log, [['panorama', 2, true], ['abrir', 'a', 1, true], ['fscommand', 'mensaje', 'hola']]);
  assert.strictEqual(codeOf(() => host.call({ name: 'nada', args: [] })), 'FUNCTION_MISSING');
  assert.strictEqual(codeOf(() => host.call({ name: 'visita.nada.mas', args: [] })), 'FUNCTION_MISSING');
  assert.strictEqual(codeOf(() => host.call({ name: 'falla', args: [] })), 'CALL_FAILED');
  assert.strictEqual(codeOf(() => host.call({ name: null, args: [], source: 'javascript:x=1' })), 'UNSUPPORTED');
  ['eval', 'Function', 'panorama.constructor', 'visita.__proto__.x'].forEach((name) => {
    assert.strictEqual(codeOf(() => host.call({ name, args: ['1'] })), 'BLOCKED', name);
  });
  assert.strictEqual(codeOf(() => host.call({ name: 'setTimeout', args: ['alert(1)', 0] })), 'BLOCKED');
  assert.strictEqual(codeOf(() => host.call({ name: 'panorama', args: ['javascript:alert(1)'] })), 'BLOCKED');
  assert.strictEqual(codeOf(() => RetroFlash.createBrowserHost({ window: win }).fscommand({ command: 'x', args: '' })), 'FUNCTION_MISSING');
});

test('browser host: loads use fetch with CORS; a refused cross-origin read is a recoverable load:cors', async () => {
  const fetched = [];
  const fetch = async (url, init) => {
    fetched.push([url, init.method, init.mode, init.body]);
    if (url.startsWith('https://cors.test/')) return response([1, 2, 3]);
    if (url.startsWith('https://site.test/')) return /missing/.test(url) ? response([], 404) : response([4, 5]);
    throw new TypeError('Failed to fetch');
  };
  const { win } = standInWindow({ fetch });
  const host = RetroFlash.createBrowserHost({ window: win });
  assert.deepStrictEqual([...new Uint8Array(await host.load({ url: 'visor.swf', type: 'movie', method: null }))], [4, 5]);
  assert.deepStrictEqual([...new Uint8Array(await host.load({ url: 'https://cors.test/img1.jpg', type: 'movie', method: null }))], [1, 2, 3], 'a CORS response is read');
  await host.load({ url: 'datos.php', type: 'variables', method: 'POST', body: 'a=1' });
  const loadCode = (request, h = host) => h.load(request).then(() => null, (e) => e.code);
  assert.strictEqual(await loadCode({ url: 'missing.swf', type: 'movie' }), 'LOAD_HTTP');
  assert.strictEqual(await loadCode({ url: 'http://www.infodesa.es/visita/vv/imagenes/img1.jpg', type: 'movie' }), 'LOAD_CORS');
  assert.strictEqual(await loadCode({ url: 'http://www.infodesa.es/vars.txt', type: 'variables' }), 'LOAD_CORS');
  assert.strictEqual(await loadCode({ url: 'x.swf', type: 'movie' }, RetroFlash.createBrowserHost({ window: win, allowNetworking: 'none' })), 'LOAD_BLOCKED');
  assert.deepStrictEqual(fetched[2], ['https://site.test/visita/datos.php', 'POST', 'cors', 'a=1']);
  // The browser may still show a cross-origin image the page cannot read.
  const shown = standInWindow({ fetch, images: true });
  const element = await RetroFlash.createBrowserHost({ window: shown.win }).load({ url: 'http://www.infodesa.es/img2.jpg', type: 'movie' });
  assert.deepStrictEqual([element.href, element.naturalWidth], ['http://www.infodesa.es/img2.jpg', 4]);
});

test('browser host: rewriteUrl serves remote resources from local copies', async () => {
  const fetched = [];
  const { win } = standInWindow({ fetch: async (url) => { fetched.push(url); return response([9]); } });
  const host = RetroFlash.createBrowserHost({
    window: win, rewriteUrl: (url) => url.replace('http://www.infodesa.es/visita/', '')
  });
  await host.load({ url: 'http://www.infodesa.es/visita/vv/imagenes/img2.jpg', type: 'movie' });
  await host.load({ url: 'visor.swf', type: 'movie' });
  assert.deepStrictEqual(fetched, ['https://site.test/visita/vv/imagenes/img2.jpg', 'https://site.test/visita/visor.swf']);
});

test('loads: host errors are reported by kind, the clip is left empty, and a decoded image is shown', async () => {
  const fail = (code) => { const e = new Error(code + ' detail'); e.code = code; return Promise.reject(e); };
  const codes = ['LOAD_CORS', 'LOAD_HTTP', 'LOAD_NETWORK', 'LOAD_BLOCKED', 'INVALID_URL'];
  for (const code of codes) {
    const movie = new I.Movie(await SWFReader.load(fixture()));
    const reported = [];
    const env = I.createEnv(movie, (feature) => reported.push(feature), { loader: (r) => (r.url === 'child.swf' ? child() : fail(code)) });
    const root = new I.Clip(env, movie.root, 0, null);
    root.gotoFrame(1);
    env.scripts.run();
    await env.loads.idle();
    env.loads.apply();
    assert.deepStrictEqual(reported, [{ LOAD_CORS: 'load:cors', LOAD_HTTP: 'load:http', LOAD_NETWORK: 'load:network', LOAD_BLOCKED: 'load:blocked', INVALID_URL: 'load:invalidURL' }[code]]);
    assert.strictEqual(root.childByName('square').displayList.size, 0);
    assert.strictEqual(root.childByName('contenedor').frameCount(), 2, 'other loads are not affected');
  }
  const element = { naturalWidth: 4, naturalHeight: 2, width: 4, height: 2 };
  const movie = new I.Movie(await SWFReader.load(fixture()));
  const env = I.createEnv(movie, () => {}, { loader: (r) => (r.url === 'child.swf' ? child() : element) });
  const root = new I.Clip(env, movie.root, 0, null);
  root.gotoFrame(1);
  env.scripts.run();
  await env.loads.idle();
  env.loads.apply();
  const shown = root.childByName('square').displayList.get(1).character;
  assert.deepStrictEqual([shown.type, shown.source, shown.width, shown.height], ['bitmap', element, 4, 2]);
  assert.strictEqual(env.loads.pixels.remaining, RetroFlash.defaultLimits.maxTotalBitmapPixels - 8);
});

test('diagnostics: the reader says it never runs ActionScript; the player does not log DoAction as unsupported', async () => {
  const swf = await SWFReader.load(fixture());
  const entry = swf.unsupported.find((u) => u.feature === 'actionscript:DoAction');
  assert.match(entry.reason, /reader only indexes it and never runs it/);
  assert.match(entry.reason, /RetroFlash\.Player runs it/);
  const warned = [], original = console.warn;
  console.warn = (...args) => warned.push(args.join(' '));
  try {
    const player = headlessPlayer({ host: {} });
    await player.load(fixture());
    player.destroy();
  } finally {
    console.warn = original;
  }
  assert.ok(!warned.some((w) => /actionscript:DoAction/.test(w)), warned.join('\n'));
});
