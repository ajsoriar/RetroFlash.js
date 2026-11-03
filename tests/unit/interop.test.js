'use strict';
// JavaScript <-> ActionScript interoperability, end to end with movies built here (ActionScript 2 bytecode and an
// ActionScript 3 ABC block): ExternalInterface both ways (receivers, values, errors, marshallExceptions, nesting),
// FSCommand (Player handlers and `<id>_DoFSCommand`), getURL("fscommand:"/"javascript:") and its modes, the
// legacy plugin methods on the page element (SetVariable, GotoFrame, T*, CallFunction, SetReturnValue, Zoom),
// FlashVars for ActionScript 2 and 3, trust, isolation and disposal, and the <object>/<embed> bootstrap against a
// minimal stand-in DOM. Nothing is evaluated: the tests also run with eval and Function turned off.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test, assert } = require('../support/harness');
const { RetroFlash } = require('../support/load-reader');
const B = require('../support/swf-builder');
const { AbcBuilder, timelineClass, NS } = require('../support/avm2-asm');
const { buildInterop, DEMO_FILE } = require('../fixtures/interop');

const I = RetroFlash.internals;
if (!globalThis.Path2D) globalThis.Path2D = class { addPath() {} moveTo() {} lineTo() {} quadraticCurveTo() {} closePath() {} };
if (!globalThis.DOMMatrix) globalThis.DOMMatrix = class { constructor(m) { this.m = m; } };

const show = () => B.tag(B.T.ShowFrame);
const end = () => B.tag(B.T.End);
// The ActionScript 2 movie of tests/fixtures/interop.js (what it does is listed there).
const as2Movie = buildInterop;

function headlessCanvas() {
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => ({ addColorStop() {} })), set: (t, k, v) => { t[k] = v; return true; } });
  return { getContext: () => ctx, style: {}, width: 0, height: 0 };
}
function headlessPlayer(options) {
  return new RetroFlash.Player(Object.assign({ canvas: headlessCanvas(), input: false, audio: false }, options));
}

/* A page: window functions the movies call (a log of what they got), and a browser host on it. */
function page(hostOptions = {}) {
  const log = [];
  const win = {
    location: { origin: 'https://site.test', href: 'https://site.test/page.html', assign: (url) => log.push(['assign', url]) },
    document: { baseURI: 'https://site.test/page.html' },
    open: (url, target) => { log.push(['open', url, target]); return {}; },
    test: { add(a, b) { log.push(['add', a, b, this === win.test]); return a + b; } },
    echo: (v) => v,
    onReady(n) { log.push(['onReady', n, typeof n]); },
    alert(text) { log.push(['alert', text]); },
    legacyMovie_DoFSCommand(command, args) { log.push(['DoFSCommand', command, args]); },
    viaReturn() { log.push(['viaReturn']); return 1; },
    deeper: null,
    eval() { throw new Error('eval must never be used'); },
    Function() { throw new Error('Function must never be used'); }
  };
  const host = RetroFlash.createBrowserHost(Object.assign({ window: win, objectID: 'legacyMovie' }, hostOptions));
  return { win, host, log };
}
/* The AS2 movie in a player on a stand-in element (the page's <object>), with the plugin interface attached
   before the movie loads, as the bootstrap does. */
async function as2(hostOptions, playerOptions = {}, loadOptions = {}) {
  const p = page(hostOptions);
  const element = { id: 'legacyMovie', title: 'kept' };
  const player = headlessPlayer(Object.assign({ host: p.host }, playerOptions));
  RetroFlash.attachLegacyInterface(element, player);
  p.win.viaReturn = () => { p.log.push(['viaReturn']); element.SetReturnValue('<number>99</number>'); return 1; };
  await player.load(as2Movie(), loadOptions);
  const v = (name) => player.root.variables.get(name);
  const reported = () => player.getDiagnostics().unsupported.map((u) => u.feature);
  return Object.assign(p, { element, player, v, reported });
}
// Runs `fn` with eval and Function made unusable, as under a Content Security Policy without 'unsafe-eval'.
// An async fn keeps them off until it settles (the tests run one at a time).
async function withoutEval(fn) {
  const saved = { eval: globalThis.eval, Function: globalThis.Function };
  globalThis.eval = () => { throw new EvalError('eval is blocked'); };
  globalThis.Function = function () { throw new EvalError('Function is blocked'); };
  try { return await fn(); } finally { globalThis.eval = saved.eval; globalThis.Function = saved.Function; }
}

// ---- ExternalInterface, ActionScript 2 ----

test('AS2 ExternalInterface.call: test.add(2, 3) is 5 in the same call, with test as `this`; Unicode round trips', async () => {
  const m = await as2();
  assert.strictEqual(m.v('sum'), 5);
  assert.deepStrictEqual(m.log[0], ['add', 2, 3, true], 'dotted name keeps its receiver');
  assert.strictEqual(m.v('uni'), 'ñ€😀');
  assert.strictEqual(m.v('missing'), null, 'a missing page function gives null');
  assert.ok(m.reported().includes('browser:functionMissing'));
  m.player.destroy();
});

test('AS2 ExternalInterface API: available, call and addCallback only (objectID and marshallExceptions are AS3)', async () => {
  const m = await as2();
  assert.deepStrictEqual([m.v('avail'), m.v('oid'), m.v('marshal'), m.v('ok'), m.v('ok2')], [true, undefined, undefined, true, true]);
  const bare = headlessPlayer({});
  await bare.load(as2Movie());
  assert.deepStrictEqual([bare.root.variables.get('avail'), bare.root.variables.get('ok'), bare.root.variables.get('sum')], [false, false, null]);
  bare.destroy();
  m.player.destroy();
});

test('AS2 addCallback: the page element method returns the AS function result at once, with `instance` as this', async () => {
  const m = await as2();
  const result = m.element.setMessage('Hello');
  assert.strictEqual(result, 'SWF:Hello');
  assert.ok(!(result instanceof Promise));
  assert.strictEqual(m.player.callback('setMessage', ['x']), 'SWF:x');
  assert.deepStrictEqual(m.player.getCallbacks(), ['setMessage', 'rawArgs', 'nest']);
  m.player.destroy();
});

test('values: primitives, NaN and Infinity, arrays (sparse), objects, Unicode, Date; cycles and getters are safe', async () => {
  const m = await as2();
  const value = { s: 'ñ€😀', n: -1.5, nan: NaN, inf: -Infinity, t: true, f: false, z: null, u: undefined, list: [1, 'x', [2, { deep: true }]] };
  assert.deepStrictEqual(m.element.rawArgs(value), value);
  assert.deepStrictEqual(m.element.rawArgs([1, , 3]), [1, undefined, 3]); // eslint-disable-line no-sparse-arrays
  assert.deepStrictEqual(m.element.rawArgs([]), []);
  assert.deepStrictEqual(m.element.rawArgs({}), {});
  assert.strictEqual(m.element.rawArgs(''), '');
  const cycle = { name: 'c' };
  cycle.self = cycle;
  assert.deepStrictEqual(m.element.rawArgs(cycle), { name: 'c', self: null });
  let reads = 0;
  const withGetter = { plain: 1, get secret() { reads++; return 'leak'; } };
  assert.deepStrictEqual(m.element.rawArgs(withGetter), { plain: 1, secret: null });
  assert.strictEqual(reads, 0, 'a getter of a page object is never called');
  assert.strictEqual(m.element.rawArgs(new Date(86400000)), 86400000, 'AVM1 has no Date: its time in ms');
  assert.strictEqual(m.element.rawArgs(() => 1), undefined);
  class Point { constructor() { this.x = 1; } get len() { reads++; return 0; } }
  assert.deepStrictEqual(m.element.rawArgs(new Point()), { x: 1 });
  assert.strictEqual(reads, 0);
  let deep = {};
  const top = deep;
  for (let i = 0; i < 100; i++) deep = deep.next = {};
  assert.doesNotThrow(() => m.element.rawArgs(top), 'deep values are cut, not a stack overflow');
  m.player.destroy();
});

test('nested calls page -> movie -> page keep their order; past maxBridgeDepth they fail predictably', async () => {
  const m = await as2(undefined, { maxBridgeDepth: 6 });
  const order = [];
  m.win.deeper = (n) => { order.push(n); return n < 2 ? m.element.nest(n + 1) : 'bottom ' + n; };
  assert.strictEqual(m.element.nest(0), 'bottom 2');
  assert.deepStrictEqual(order, [0, 1, 2]);
  order.length = 0;
  m.win.deeper = (n) => { order.push(n); return m.element.nest(n + 1); };
  assert.strictEqual(m.element.nest(0), null, 'the refused call gives null at the top, the movie is unharmed');
  assert.deepStrictEqual(order, [0, 1, 2], 'three page<->movie round trips fit in depth 6');
  assert.ok(m.player.getDiagnostics().unsupported.some((u) => u.feature === 'browser:callFailed' && /CALL_DEPTH|nested calls/.test(u.reason + u.sources.join())));
  assert.strictEqual(m.player.env.host.depth, 0, 'the depth is back to zero');
  assert.strictEqual(m.element.setMessage('again'), 'SWF:again');
  m.player.destroy();
});

test('SetReturnValue during a movie call gives that call its result; outside a call it is reported, not faked', async () => {
  const m = await as2();
  assert.strictEqual(m.v('viaReturn'), 99, 'the value given to SetReturnValue wins over the function result');
  m.element.SetReturnValue('<string>late</string>');
  assert.ok(m.reported().includes('plugin:returnValueUnused'));
  m.player.destroy();
});

// ---- FSCommand and getURL ----

test('fscommand("ready", "yes") reaches Player handlers first, then <id>_DoFSCommand; "fscommand:" URLs too', async () => {
  const p = page(), seen = [];
  const player = headlessPlayer({ host: p.host, onFSCommand: (c, a) => { seen.push(['option', c, a]); } });
  const off = player.addFSCommandHandler((c, a, who) => { seen.push(['handler', c, a, who === player]); p.log.push(['handler-mark']); });
  await player.load(as2Movie());
  assert.deepStrictEqual(seen, [['option', 'ready', 'yes'], ['handler', 'ready', 'yes', true], ['option', 'viaurl', 'args'], ['handler', 'viaurl', 'args', true]]);
  const fs = p.log.filter((e) => e[0] === 'DoFSCommand' || e[0] === 'handler-mark');
  assert.deepStrictEqual(fs, [['handler-mark'], ['DoFSCommand', 'ready', 'yes'], ['handler-mark'], ['DoFSCommand', 'viaurl', 'args']]);
  assert.ok(!p.log.some((e) => e[0] === 'assign' || e[0] === 'open'), 'an fscommand: URL is not navigation');
  off();
  const handled = headlessPlayer({ host: p.host });
  handled.addFSCommandHandler(() => true);
  p.log.length = 0;
  await handled.load(as2Movie());
  assert.ok(!p.log.some((e) => e[0] === 'DoFSCommand'), 'a handler that returns true handles the command');
  player.destroy();
  handled.destroy();
});

test('fscommand: the VBScript-era <id>_FSCommand name; exec is reported and never run; projector commands are opt-in', async () => {
  const p = page();
  delete p.win.legacyMovie_DoFSCommand;
  p.win.legacyMovie_FSCommand = (c, a) => p.log.push(['FSCommand', c, a]);
  p.host.fscommand({ command: 'ready', args: 'yes' });
  assert.deepStrictEqual(p.log, [['FSCommand', 'ready', 'yes']]);
  const reported = [];
  const bridge = new I.HostBridge(p.host, (f) => reported.push(f));
  bridge.fscommand('EXEC', 'format c:');
  assert.deepStrictEqual(reported, ['browser:fscommandExec']);
  const player = headlessPlayer({ projectorCommands: true, scaleMode: 'showAll' });
  await player.load(as2Movie());
  player.projectorCommand('allowscale', 'false');
  assert.strictEqual(player.getLayout().scaleMode, 'noScale');
  player.projectorCommand('allowscale', 'true');
  assert.strictEqual(player.getLayout().scaleMode, 'showAll');
  player.destroy();
});

test('javascript: URLs: a known call runs with literal arguments and no eval; other code is refused unless trusted-eval', async () => {
  const plain = await withoutEval(() => as2());
  assert.deepStrictEqual(plain.log.filter((e) => e[0] === 'onReady' || e[0] === 'alert'), [['onReady', 42, 'number']]);
  assert.ok(plain.reported().includes('browser:javascriptUnsupported'), 'alert(document.cookie) was refused');
  plain.player.destroy();

  const ran = [];
  const trusted = await as2({ scriptUrls: 'trusted-eval', executeScript: (source) => { ran.push(source); return 'done'; } });
  assert.deepStrictEqual(ran, ['javascript:alert(document.cookie)'], 'only the URL that is not plain calls, through the integrator\'s executor');
  trusted.player.destroy();

  const off = await as2({ scriptUrls: 'off' });
  assert.ok(!off.log.some((e) => e[0] === 'onReady'), 'scriptUrls "off" refuses even plain calls');
  assert.ok(off.reported().includes('browser:blocked'));
  off.player.destroy();

  const p = page();
  assert.throws(() => RetroFlash.createBrowserHost({ window: p.win, scriptUrls: 'trusted-eval' }), (e) => e.code === 'INVALID_OPTION');
  assert.throws(() => RetroFlash.createBrowserHost({ window: p.win, scriptUrls: 'trusted-eval', executeScript() {}, trust: 'untrusted' }), (e) => e.code === 'INVALID_OPTION');
  assert.throws(() => RetroFlash.createBrowserHost({ window: p.win, scriptUrls: 'eval' }), (e) => e.code === 'INVALID_OPTION');
});

test('trust: an untrusted movie calls only allowed functions, sends no FSCommand and cannot replace the page', async () => {
  const m = await as2({ trust: 'untrusted' });
  assert.deepStrictEqual([m.v('sum'), m.v('uni')], [null, null]);
  assert.ok(!m.log.some((e) => ['add', 'onReady', 'DoFSCommand'].includes(e[0])), m.log.join('|'));
  assert.ok(m.reported().includes('browser:blocked'));
  assert.strictEqual(m.element.setMessage('in'), 'SWF:in', 'the page may still call the movie');
  m.player.destroy();
  const allowed = await as2({ trust: 'untrusted', allowedFunctions: ['test.add', 'onReady'], allowFSCommand: true });
  assert.deepStrictEqual([allowed.v('sum'), allowed.v('uni')], [5, null]);
  assert.ok(allowed.log.some((e) => e[0] === 'onReady') && allowed.log.some((e) => e[0] === 'DoFSCommand'));
  const p = page({ trust: 'untrusted' });
  assert.throws(() => p.host.navigate({ url: 'x.html', target: '_self' }), (e) => e.code === 'BLOCKED');
  p.host.navigate({ url: 'x.html', target: '_blank' });
  assert.deepStrictEqual(p.log, [['open', 'https://site.test/x.html', '_blank']]);
  allowed.player.destroy();
});

// ---- Legacy plugin methods ----

test('SetVariable and GetVariable use the movie\'s AVM1 variables (dot and slash paths); $version is emulated', async () => {
  const m = await as2();
  m.element.SetVariable('_root.counter', '7');
  assert.strictEqual(m.element.GetVariable('_root.counter'), '7');
  assert.strictEqual(m.v('counter'), '7', 'stored in the root timeline');
  m.element.SetVariable('/:other', 12);
  assert.strictEqual(m.v('other'), '12', 'values are set as strings');
  assert.strictEqual(m.element.GetVariable('/:other'), '12');
  assert.strictEqual(m.element.GetVariable('sum'), '5');
  assert.strictEqual(m.element.GetVariable('menu'), '_level0.menu', 'a clip reads as its path');
  m.element.SetVariable('/menu:inner', 'x');
  assert.strictEqual(m.element.GetVariable('/menu:inner'), 'x');
  assert.strictEqual(m.element.GetVariable('nothing'), null);
  assert.strictEqual(m.element.GetVariable('$version'), 'WIN 10,3,183,90');
  assert.strictEqual(m.element.FlashVersion(), 10 * 65536 + 3);
  m.player.destroy();
});

test('GotoFrame, CurrentFrame and the main timeline: zero-based frames, real timeline state and frame scripts', async () => {
  const m = await as2();
  const e = m.element;
  assert.deepStrictEqual([e.CurrentFrame(), e.TotalFrames(), e.PercentLoaded(), e.FrameLoaded(2), e.FrameLoaded(3), e.IsPlaying()], [0, 3, 100, true, false, false]);
  e.GotoFrame(1);
  assert.strictEqual(m.player.root.frame, 2, 'GotoFrame(1) is the second frame');
  assert.strictEqual(m.v('frame2'), 'ran', 'its frame script ran');
  assert.strictEqual(m.player.root.playing, false);
  e.Forward();
  assert.strictEqual(e.CurrentFrame(), 2);
  e.Back();
  assert.strictEqual(e.CurrentFrame(), 1);
  e.Rewind();
  assert.strictEqual(e.CurrentFrame(), 0);
  let rafs = 0;
  globalThis.requestAnimationFrame = () => ++rafs;
  globalThis.cancelAnimationFrame = () => {};
  try {
    e.Play();
    assert.strictEqual(e.IsPlaying(), true);
    assert.strictEqual(m.player.state, 'playing');
    e.StopPlay();
    assert.strictEqual(e.IsPlaying(), false);
    assert.strictEqual(m.player.root.playing, false);
  } finally {
    m.player.pause();
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  }
  e.GotoFrame('x');
  assert.ok(m.reported().includes('plugin:frameNotFound'));
  m.player.destroy();
});

test('T* methods: target timelines by path, zero-based frames, labels, frame scripts and property indexes', async () => {
  const m = await as2();
  const e = m.element, menu = m.player.root.childByName('menu');
  assert.deepStrictEqual([e.TCurrentFrame('/menu'), e.TCurrentLabel('/menu')], [0, '']);
  e.TGotoLabel('/menu', 'open');
  assert.deepStrictEqual([menu.frame, e.TCurrentFrame('_level0.menu'), e.TCurrentLabel('/menu'), m.v('menuCalled')], [2, 1, 'open', 'yes']);
  e.SetVariable('/:menuCalled', 'no');
  e.TGotoFrame('/menu', 2);
  assert.strictEqual(menu.frame, 3);
  e.TCallFrame('/menu', 1);
  assert.deepStrictEqual([m.v('menuCalled'), menu.frame], ['yes', 3], 'TCallFrame runs the scripts without going there');
  e.SetVariable('/:menuCalled', 'no');
  e.TCallLabel('/menu', 'open');
  assert.strictEqual(m.v('menuCalled'), 'yes');
  e.TPlay('/menu');
  assert.strictEqual(menu.playing, true);
  e.TStopPlay('/menu');
  assert.strictEqual(menu.playing, false);
  // Property indexes: 0 _x, 1 _y, 2 _xscale, 5 _totalframes, 6 _alpha, 7 _visible, 11 _target, 13 _name.
  assert.deepStrictEqual([e.TGetProperty('/menu', 0), e.TGetProperty('/menu', 11), e.TGetProperty('/menu', 13), e.TGetProperty('/menu', 5)],
    ['10', '/menu', 'menu', '3']);
  e.TSetProperty('/menu', 0, '25');
  e.TSetPropertyNum('/menu', 6, 50);
  e.TSetPropertyNum('/menu', 2, 200);
  assert.deepStrictEqual([e.TGetPropertyAsNumber('/menu', 0), e.TGetPropertyNum('/menu', 6), e.TGetPropertyAsNumber('/menu', 2)], [25, 50, 200]);
  assert.strictEqual(e.TGetProperty('/', 13), '', 'the root has no name');
  assert.strictEqual(e.TGetProperty('/menu', 99), null);
  assert.strictEqual(e.TCurrentFrame('/nowhere'), -1);
  const reported = m.reported();
  assert.ok(reported.includes('plugin:propertyIndex') && reported.includes('plugin:targetNotFound'));
  m.player.destroy();
});

test('Zoom, SetZoomRect and Pan change the part of the stage shown, in twips', async () => {
  const m = await as2(undefined, { scaleMode: 'showAll' });
  const e = m.element;
  assert.strictEqual(m.player.getViewRect(), null);
  e.Pan(10, 10, 0);
  assert.strictEqual(m.player.getViewRect(), null, 'Pan does nothing when not zoomed in');
  e.Zoom(50);
  assert.deepStrictEqual(m.player.getViewRect(), { x: 2750, y: 2000, width: 5500, height: 4000 });
  e.Pan(10, 0, 1);
  assert.deepStrictEqual(m.player.getViewRect(), { x: 3300, y: 2000, width: 5500, height: 4000 });
  e.Pan(-1000, 0, 1);
  assert.strictEqual(m.player.getViewRect().x, 0, 'Pan stops at the stage edge');
  e.Zoom(0);
  assert.strictEqual(m.player.getViewRect(), null);
  e.SetZoomRect(0, 0, 2200, 1600);
  assert.deepStrictEqual(m.player.getViewRect(), { x: 0, y: 0, width: 2200, height: 1600 });
  const layout = m.player.getLayout();
  assert.strictEqual(layout.scale.x, 5, 'a fifth of the stage fills the canvas');
  e.SetZoomRect(10, 10, 5, 5);
  assert.ok(m.reported().includes('plugin:zoomRect'));
  m.player.destroy();
});

test('LoadMovie: level 0 goes to the host loader; other levels are reported, not faked', async () => {
  const requested = [];
  const m = await as2(undefined, { loader: (r) => { requested.push(r.url); return null; } });
  m.element.LoadMovie(0, 'other.swf');
  m.element.LoadMovie(1, 'level1.swf');
  await m.player.env.loads.idle();
  assert.deepStrictEqual(requested, ['other.swf']);
  assert.ok(m.reported().includes('load:level'));
  m.player.destroy();
});

// ---- CallFunction and the XML protocol ----

test('CallFunction: an <invoke> calls the AS callback and answers in XML at once (or as a JavaScript literal)', async () => {
  const m = await as2();
  const xml = '<invoke name="setMessage" returntype="xml"><arguments><string>Hello &amp; ñ</string></arguments></invoke>';
  assert.strictEqual(await withoutEval(() => m.element.CallFunction(xml)), '<string>SWF:Hello &amp; ñ</string>');
  assert.strictEqual(m.element.CallFunction('<invoke name="setMessage" returntype="javascript"><arguments><string>x</string></arguments></invoke>'), '"SWF:x"');
  const nested = '<invoke name="rawArgs" returntype="xml"><arguments><object><property id="a"><array><property id="0"><number>1</number></property>' +
    '<property id="1"><true/></property><property id="2"><null/></property></array></property><property id="n"><number>NaN</number></property></object></arguments></invoke>';
  assert.deepStrictEqual(RetroFlash.flashXML.fromXML(m.element.CallFunction(nested)), { a: [1, true, null], n: NaN });
  assert.strictEqual(m.element.CallFunction('<invoke name="nothing"><arguments/></invoke>'), '<undefined/>');
  assert.throws(() => m.element.CallFunction('<invoke name="setMessage"><arguments><string>x</arguments></invoke>'), (e) => e.code === 'INVALID_XML');
  m.player.destroy();
});

test('flash XML: values both ways, entities, CDATA, limits; malformed or hostile XML is refused, nothing evaluated', () => {
  const X = RetroFlash.flashXML;
  const value = { s: '<a & "b">\'', n: 1.5, inf: -Infinity, list: [1, , 'x'], d: new Date(5), u: undefined, z: null }; // eslint-disable-line no-sparse-arrays
  const xml = X.toXML(value);
  assert.ok(xml.indexOf('<a &') < 0 && xml.indexOf('&lt;a &amp; &quot;b&quot;&gt;&apos;') > 0, 'text is escaped');
  const back = X.fromXML(xml);
  assert.deepStrictEqual(Object.assign({}, back, { d: back.d.getTime() }), Object.assign({}, value, { d: 5, list: [1, undefined, 'x'] }));
  assert.strictEqual(X.fromXML('<string><![CDATA[<raw>]]> &#241;&#x1F600;</string>'), '<raw> ñ😀');
  assert.deepStrictEqual(X.parseInvoke('<?xml version="1.0"?><!-- c --><invoke name="f"><arguments><number> 2 </number><false/></arguments></invoke>'),
    { name: 'f', returnType: 'xml', args: [2, false] });
  assert.strictEqual(X.invoke('f', ['a', 1]), '<invoke name="f" returntype="xml"><arguments><string>a</string><number>1</number></arguments></invoke>');
  const proto = X.fromXML('<object><property id="__proto__"><string>x</string></property></object>');
  assert.strictEqual(Object.getPrototypeOf(proto), Object.prototype);
  assert.deepStrictEqual(Object.keys(proto), ['__proto__'], 'a property named __proto__ stays data');
  assert.strictEqual(X.toJSLiteral([1, 'a ', NaN, new Date(3), { k: null }]), '[1,"a\\u2028",NaN,new Date(3),({"k":null})]');
  const cycle = [];
  cycle.push(cycle);
  assert.strictEqual(X.toXML(cycle), '<array><property id="0"><null/></property></array>');
  ['<string>a</strin>', '<string>a', '<number>x</number>', '<string a=1>x</string>', '<string>&bogus;</string>', '<script>x</script>',
    '<string>a</string><string>b</string>', '<array><property id="-1"><null/></property></array>', '<true>x</true>',
    '<!DOCTYPE x [<!ENTITY a "b">]><string>&a;</string>', '<' + 'a>'.repeat(70) + '</a>'.repeat(70), 'x'.repeat(1024 * 1024 + 1)]
    .forEach((bad) => assert.throws(() => X.fromXML(bad), (e) => e.code === 'INVALID_XML', bad.slice(0, 40)));
  assert.throws(() => X.parseInvoke('<invoke><arguments/></invoke>'), (e) => e.code === 'INVALID_XML');
  assert.throws(() => X.parseInvoke('<invoke name="f" returntype="vbscript"/>'), (e) => e.code === 'INVALID_XML');
});

// ---- FlashVars ----

test('FlashVars reach the AS2 root as strings: decoding, empty values, repeated names, objects and pairs', async () => {
  const m = await as2(undefined, {}, { variables: 'level=3&name=Guest+%C3%91&empty=&flag&level=4&=skipped' });
  assert.deepStrictEqual([m.v('level'), m.v('name'), m.v('empty'), m.v('flag')], ['4', 'Guest Ñ', '', '']);
  await m.player.load(as2Movie(), { variables: [['a', 1], ['b', 'x']] });
  assert.deepStrictEqual([m.v('a'), m.v('b')], ['1', 'x']);
  await assert.rejects(m.player.load(as2Movie(), { variables: 'x='.repeat(600000) }), (e) => e.code === 'INVALID_OPTION');
  m.player.destroy();
});

// ---- Isolation and disposal ----

test('two players with the same callback name stay apart; dispose and destroy remove what was added', async () => {
  const a = await as2(), b = await as2();
  a.player.env.host.callbacks.get('setMessage').thisValue = I.fromHostValue(I.runtimeOf(a.player.env.scripts), { prefix: 'A:' });
  assert.deepStrictEqual([a.element.setMessage('1'), b.element.setMessage('1')], ['A:1', 'SWF:1']);
  assert.notStrictEqual(a.element.setMessage, b.element.setMessage);
  const own = { id: 'x', SetVariable: 'page value', setMessage: 'mine' };
  const handle = RetroFlash.attachLegacyInterface(own, b.player);
  assert.strictEqual(typeof own.SetVariable, 'function');
  assert.strictEqual(own.setMessage, 'mine', 'a callback never covers a property the element already has');
  assert.ok(b.reported().includes('browser:callbackName'));
  handle.dispose();
  assert.deepStrictEqual(own, { id: 'x', SetVariable: 'page value', setMessage: 'mine' }, 'the element is given back as it was');
  a.player.destroy();
  assert.ok(!('setMessage' in a.element) && !('SetVariable' in a.element) && !('retroflashInterface' in a.element), 'destroy removes the methods');
  assert.deepStrictEqual(a.element, { id: 'legacyMovie', title: 'kept' });
  assert.strictEqual(b.element.setMessage('2'), 'SWF:2');
  assert.throws(() => a.player.callback('setMessage', ['late']), (e) => e.code === 'DESTROYED');
  b.player.destroy();
});

test('callbacks registered later appear on the element; a reload keeps them registered by the new movie only', async () => {
  const m = await as2();
  const element = {};
  RetroFlash.attachLegacyInterface(element, m.player, { methods: false });
  assert.strictEqual(typeof element.setMessage, 'function');
  assert.strictEqual(element.SetVariable, undefined, 'methods: false installs callbacks only');
  const plain = B.swf({ version: 8, tags: [B.tag(B.T.FileAttributes, B.body((w) => w.u32(0))), show(), end()] });
  await m.player.load(plain);
  assert.strictEqual(element.setMessage, undefined, 'a new movie without the callback removes it');
  assert.strictEqual(m.element.setMessage, undefined);
  m.player.destroy();
});

// ---- ActionScript 3 ----

/* demo.Main: frame 1 calls Security.allowDomain("*"), reads ExternalInterface (sum = call("test.add", 2, 3), available, objectID,
   marshallExceptions, missing = call("nope"), level = loaderInfo.parameters.level), registers setMessage,
   echo, broken (throws), callBroken (calls a page function that throws) and marshal(flag), and sends
   fscommand("ready", "yes"). */
function as3Abc() {
  const abc = new AbcBuilder(), s = (t) => abc.string(t);
  const EIQ = abc.qname('flash.external', 'ExternalInterface'), fsq = abc.qname('flash.system', 'fscommand');
  const security = abc.qname('flash.system', 'Security');
  const handler = (n) => abc.qname('demo', n, NS.PACKAGE_INTERNAL);
  const setDyn = (name, code) => [['getlocal0'], ...code, ['setproperty', abc.name(name)]];
  const callback = (name, method) => [['getlex', EIQ], ['pushstring', s(name)], ['getlex', handler(method)], ['callpropvoid', abc.name('addCallback'), 2]];
  timelineClass(abc, {
    pkg: 'demo', name: 'Main',
    methods: {
      onMessage: [['pushstring', s('SWF:')], ['getlocal1'], ['add'], ['returnvalue']],
      onEcho: [['getlocal1'], ['returnvalue']],
      onBroken: [['getlocal0'], ['callpropvoid', abc.name('noSuchMethod'), 0], ['returnvoid']],
      onCallBroken: [['getlex', EIQ], ['pushstring', s('broken')], ['callproperty', abc.name('call'), 1], ['returnvalue']],
      onMarshal: [['getlex', EIQ], ['getlocal1'], ['setproperty', abc.name('marshallExceptions')], ['returnvoid']],
      frame1: [
        ['getlex', security], ['pushstring', s('*')], ['callpropvoid', abc.name('allowDomain'), 1],
        ...setDyn('sum', [['getlex', EIQ], ['pushstring', s('test.add')], ['pushbyte', 2], ['pushbyte', 3], ['callproperty', abc.name('call'), 3]]),
        ...setDyn('avail', [['getlex', EIQ], ['getproperty', abc.name('available')]]),
        ...setDyn('oid', [['getlex', EIQ], ['getproperty', abc.name('objectID')]]),
        ...setDyn('marshal', [['getlex', EIQ], ['getproperty', abc.name('marshallExceptions')]]),
        ...setDyn('missing', [['getlex', EIQ], ['pushstring', s('nope')], ['callproperty', abc.name('call'), 1]]),
        ...setDyn('level', [['getlocal0'], ['getproperty', abc.name('loaderInfo')], ['getproperty', abc.name('parameters')], ['getproperty', abc.name('level')]]),
        ...callback('setMessage', 'onMessage'), ...callback('echo', 'onEcho'), ...callback('broken', 'onBroken'),
        ...callback('callBroken', 'onCallBroken'), ...callback('marshal', 'onMarshal'),
        ['findpropstrict', fsq], ['pushstring', s('ready')], ['pushstring', s('yes')], ['callpropvoid', fsq, 2],
        ['returnvoid']
      ]
    },
    frames: { 0: 'frame1' }
  });
  return abc.bytes();
}
const as3Movie = () => B.swf({ version: 10, frameCount: 1, tags: [
  B.tag(B.T.FileAttributes, B.body((w) => w.u32(0x08))),
  B.tag(B.T.DoABC, B.body((w) => w.u32(1).string('').raw(as3Abc()))),
  B.tag(76, B.body((w) => w.u16(1).u16(0).string('demo.Main'))),
  show(), end()
] });
async function as3(hostOptions) {
  const p = page(hostOptions);
  p.win.broken = () => { throw new Error('page broke'); };
  const element = { id: 'legacyMovie' };
  const player = headlessPlayer({ host: p.host });
  RetroFlash.attachLegacyInterface(element, player);
  await player.load(as3Movie(), { url: 'https://site.test/as3.swf', variables: 'level=3&name=Guest' });
  const main = player.root.object.as3, v = (name) => (main.dyn ? main.dyn.get(name) : undefined);
  const reported = () => player.getDiagnostics().unsupported.map((u) => u.feature);
  return Object.assign(p, { element, player, v, reported });
}

test('AS3 ExternalInterface: call is synchronous with its receiver; available, objectID and marshallExceptions', async () => {
  const m = await as3();
  assert.deepStrictEqual([m.v('sum'), m.v('avail'), m.v('oid'), m.v('marshal'), m.v('missing')], [5, true, 'legacyMovie', false, null]);
  assert.deepStrictEqual(m.log[0], ['add', 2, 3, true]);
  assert.deepStrictEqual(m.log.filter((e) => e[0] === 'DoFSCommand'), [['DoFSCommand', 'ready', 'yes']], 'flash.system.fscommand');
  assert.ok(m.reported().includes('browser:allowDomain'), 'Security.allowDomain is accepted, reported, and grants nothing');
  m.player.destroy();
});

test('AS3 addCallback: element methods return at once; values; a null closure removes it', async () => {
  const m = await as3();
  assert.strictEqual(m.element.setMessage('Hello'), 'SWF:Hello');
  assert.deepStrictEqual(m.element.echo({ a: 1, b: 'x', c: { d: null } }), { a: 1, b: 'x', c: { d: null } });
  assert.strictEqual(m.element.echo([1, 2]), null, 'no AS3 Array yet: reported, null');
  assert.ok(m.reported().includes('avm2:externalArray'));
  assert.deepStrictEqual(m.player.getCallbacks(), ['setMessage', 'echo', 'broken', 'callBroken', 'marshal']);
  const rt = m.player.env.avm2.rt;
  m.player.env.avm2.guard('test', () => {
    const cls = rt.classByName('flash.external.ExternalInterface');
    rt.callProperty(cls, { kind: 0x07, ns: { kind: 0x16, uri: '' }, name: 'addCallback' }, 'addCallback', ['echo', null]);
  });
  assert.strictEqual(m.element.echo, undefined, 'removed from the element too');
  m.player.destroy();
});

test('AS3 marshallExceptions: off, errors are reported and give null/undefined; on, they cross the boundary', async () => {
  const m = await as3();
  assert.strictEqual(m.element.broken(0), undefined);
  assert.ok(m.reported().includes('avm2:uncaughtError'));
  assert.strictEqual(m.element.callBroken(0), null, 'a page exception gives null');
  m.element.marshal(true);
  assert.strictEqual(m.player.env.avm2.marshallExceptions, true);
  assert.throws(() => m.element.broken(0), (e) => e.name === 'ActionScriptError' && /TypeError: Error #1006/.test(e.message));
  assert.throws(() => m.element.callBroken(0), (e) => e.name === 'ActionScriptError' && /page broke/.test(e.message), 'the page error reached ActionScript, then came back');
  m.element.marshal(false);
  assert.strictEqual(m.element.callBroken(0), null);
  m.player.destroy();
});

test('AS3: loaderInfo.parameters holds the FlashVars; AVM1-only plugin methods report instead of pretending', async () => {
  const m = await as3();
  assert.strictEqual(m.v('level'), '3');
  assert.strictEqual(m.element.GetVariable('level'), null);
  m.element.SetVariable('level', '9');
  assert.ok(m.reported().includes('plugin:as3Variables'));
  assert.deepStrictEqual([m.element.TotalFrames(), m.element.CurrentFrame()], [1, 0], 'timeline methods work for AS3 movies');
  m.player.destroy();
});

test('AS3: a call the page refuses throws SecurityError #2060 in the movie, which stops that script only', async () => {
  const m = await as3({ trust: 'untrusted' });
  assert.strictEqual(m.v('sum'), undefined, 'frame 1 stopped at the refused call');
  assert.ok(m.player.getDiagnostics().unsupported.some((u) => u.feature === 'avm2:uncaughtError' && /SecurityError: Error #2060/.test(u.sources.join())));
  m.player.destroy();
});

// ---- The legacy markup bootstrap on a stand-in DOM ----

/* A tiny DOM: elements with attributes, children, replaceChild and getElementsByTagName; canvases with a context
   that ignores drawing. Enough for browser/legacy-autoplay.js. */
class StandInElement {
  constructor(tagName, attributes = {}, children = []) {
    this.tagName = tagName.toUpperCase();
    this.attributes = Object.assign({}, attributes);
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.listeners = {};
    children.forEach((c) => this.appendChild(c));
    if (attributes.id) this.id = attributes.id;
  }
  get parentElement() { return this.parentNode instanceof StandInElement ? this.parentNode : null; }
  get className() { return this.attributes.class || ''; }
  set className(v) { this.attributes.class = v; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  replaceChild(next, old) { this.children[this.children.indexOf(old)] = next; next.parentNode = this; old.parentNode = null; }
  getAttribute(n) { return n in this.attributes ? this.attributes[n] : null; }
  hasAttribute(n) { return n in this.attributes; }
  setAttribute(n, v) { this.attributes[n] = String(v); if (n === 'id') this.id = v; }
  getElementsByTagName(tag) {
    const out = [];
    (function walk(e) { e.children.forEach((c) => { if (c.tagName === tag.toUpperCase()) out.push(c); walk(c); }); })(this);
    return out;
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener() {}
  dispatchEvent() { return true; }
  getContext() { return headlessCanvas().getContext(); }
}

test('legacy HTML with zero RetroFlash calls: <object>/<embed> pages script the movie as they did the plugin', async () => {
  const swfBytes = as2Movie();
  const objectEl = new StandInElement('object', { id: 'legacyMovie', type: 'application/x-shockwave-flash', data: 'movie.swf', width: '550', height: '400' }, [
    new StandInElement('param', { name: 'movie', value: 'movie.swf' }),
    new StandInElement('param', { name: 'flashvars', value: 'level=3&name=Guest' }),
    new StandInElement('param', { name: 'allowScriptAccess', value: 'always' }),
    new StandInElement('embed', { name: 'legacyMovie', src: 'movie.swf', type: 'application/x-shockwave-flash', flashvars: 'level=3&name=Guest' })
  ]);
  const embedEl = new StandInElement('embed', { name: 'second', src: 'movie.swf?level=8', type: 'application/x-shockwave-flash', width: '100', height: '100' });
  const body = new StandInElement('body', {}, [objectEl, embedEl]);
  const all = () => { const out = []; (function walk(e) { e.children.forEach((c) => { out.push(c); walk(c); }); })(body); return out; };
  const document = {
    readyState: 'complete', body, addEventListener() {}, removeEventListener() {},
    querySelectorAll: () => all().filter((e) => e.tagName === 'OBJECT' || e.tagName === 'EMBED'),
    createElement: (tag) => new StandInElement(tag),
    getElementById: (id) => all().find((e) => e.id === id) || null
  };
  const pageLog = [];
  const saved = {};
  const globals = {
    document, location: { protocol: 'https:', href: 'https://site.test/page.html', origin: 'https://site.test' },
    fetch: async (url) => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => swfBytes.slice().buffer }),
    RetroFlashConfig: { autoplay: false },
    test: { add: (a, b) => a + b }, echo: (v) => v, viaReturn: () => 1, onReady: (n) => pageLog.push(['onReady', n]),
    legacyMovie_DoFSCommand: (c, a) => pageLog.push(['DoFSCommand', c, a]),
    console: Object.assign(Object.create(console), { info() {}, warn() {}, error: (...a) => pageLog.push(['console.error', ...a]) })
  };
  Object.keys(globals).forEach((k) => { saved[k] = Object.getOwnPropertyDescriptor(globalThis, k); globalThis[k] = globals[k]; });
  try {
    vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'browser', 'legacy-autoplay.js'), 'utf8'), { filename: 'legacy-autoplay.js' });
    const canvas = document.getElementById('legacyMovie'), second = document.second;
    assert.strictEqual(canvas.tagName, 'CANVAS', 'the page finds the movie by its id');
    assert.strictEqual(document.legacyMovie, canvas, 'and by its name, one movie for <object> and its <embed>');
    assert.strictEqual(second.tagName, 'CANVAS');
    assert.strictEqual(RetroFlash.getInstances().filter((i) => i.canvas === canvas || i.canvas === second).length, 2, 'two players, not three');
    const loaded = (c) => new Promise((resolve) => (c.retroflashPlayer.root ? resolve() : c.retroflashPlayer.on('load', resolve)));
    await loaded(canvas);
    await loaded(second);
    await new Promise((resolve) => setTimeout(resolve, 0)); // the bootstrap logs the load after it
    // What the page's own scripts do, unchanged:
    assert.strictEqual(canvas.GetVariable('/:level'), '3');
    assert.strictEqual(second.GetVariable('level'), '8', 'the query string of the movie URL');
    assert.strictEqual(canvas.GetVariable('sum'), '5');
    canvas.SetVariable('_root.message', 'Hello');
    assert.strictEqual(canvas.GetVariable('_root.message'), 'Hello');
    canvas.GotoFrame(1);
    assert.strictEqual(canvas.CurrentFrame(), 1);
    assert.strictEqual(canvas.setMessage('page'), 'SWF:page');
    assert.strictEqual(second.setMessage('two'), 'SWF:two');
    assert.ok(pageLog.some((e) => e[0] === 'DoFSCommand' && e[1] === 'ready'));
    assert.ok(pageLog.some((e) => e[0] === 'onReady' && e[1] === 42));
    canvas.retroflashPlayer.destroy();
    second.retroflashPlayer.destroy();
    assert.strictEqual(canvas.setMessage, undefined);
  } finally {
    Object.keys(globals).forEach((k) => { if (saved[k]) Object.defineProperty(globalThis, k, saved[k]); else delete globalThis[k]; });
  }
});

test('demo/interop: the committed interop.swf is the fixture generator\'s, and the page loads the manifest in order', () => {
  assert.ok(Buffer.from(buildInterop()).equals(fs.readFileSync(DEMO_FILE)), 'run node tests/fixtures/interop.js');
  const root = path.join(__dirname, '..', '..');
  const html = fs.readFileSync(path.join(root, 'demo', 'interop', 'index.html'), 'utf8');
  const scripts = Array.from(html.matchAll(/<script src="\.\.\/\.\.\/src\/([^"]+)"><\/script>/g), (m) => m[1]);
  assert.deepStrictEqual(scripts, require(path.join(root, 'src', 'modules.json')));
  assert.ok(!/RetroFlash\.|retroflash/i.test(html.replace(/<script src="[^"]+"><\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<title>[^<]*<\/title>/, '').replace(/RetroFlash\.js/g, '')),
    'the page itself makes no RetroFlash call');
});
