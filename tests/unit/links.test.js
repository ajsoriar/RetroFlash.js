'use strict';
// Clickable HTML links in text fields (<a href target>, asfunction:) and the button properties of movie clips
// (enabled, useHandCursor). Movies are SWFs built in memory, driven with an InputController as the player does;
// text is laid out with a stand-in measure (10 px per character, 10 px ascent, 2 px descent).
const { test, assert } = require('../support/harness');
const { SWFReader, RetroFlash } = require('../support/load-reader');
const B = require('../support/swf-builder');
const { push, rec, str } = require('../support/avm1-asm');

const I = RetroFlash.internals;
const GET = [0x1c], SET = [0x1d], POP = [0x17];
const show = () => B.tag(B.T.ShowFrame);
const end = () => B.tag(B.T.End);
const measure = { width: (css, s) => s.length * 10, metrics: () => ({ ascent: 10, descent: 2 }) };
// function name(params) { body }
const defineFunction = (name, params, body) => {
  const code = body.flat(Infinity);
  return rec(0x9b, ...str(name), params.length & 0xff, params.length >> 8, ...params.flatMap(str), code.length & 0xff, code.length >> 8).concat(code);
};
const field = (id, html, bounds = { xMax: 4000, yMax: 1000 }) => B.defineEditText(id, { bounds, text: html, html: true, wordWrap: true, multiline: true });
const place = (depth, id, name, x = 0, y = 0) => B.tag(B.T.PlaceObject2, B.body((w) => {
  w.u8(0x02 | 0x04 | (name ? 0x20 : 0)).u16(depth).u16(id);
  B.matrix(w, { translateX: x, translateY: y });
  if (name) w.string(name);
}));

async function setup(tags) {
  const swf = await SWFReader.load(B.swf({ version: 6, tags: [...tags, show(), end()] }));
  const movie = new I.Movie(swf), reported = [], navigated = [];
  const env = I.createEnv(movie, (feature, reason, source) => reported.push([feature, source]), { host: { navigate: (r) => navigated.push(r) } });
  const root = new I.Clip(env, movie.root, 0, null);
  root.gotoFrame(1);
  env.scripts.run();
  // As the renderer does when it draws: each text field keeps its layout.
  Object.keys(movie.characters).forEach((id) => {
    const c = movie.characters[id];
    if (c.type === 'editText') c.layout = I.layoutEditText(c, movie.characters, measure, () => {});
  });
  const input = new I.InputController(env, () => root);
  const update = (changed) => { if (changed) { env.scripts.beginUpdate(); env.scripts.run(); } return changed; };
  return {
    movie, env, root, input, reported, navigated,
    move: (x, y) => update(input.move(x, y)), click: () => { update(input.down()); update(input.up()); },
    tick: () => { env.scripts.beginUpdate(); root.tick(); env.scripts.run(); if (input.afterTick()) env.scripts.run(); },
    run: (...records) => { new I.Activation(env.scripts, root, new I.ActionCode(Uint8Array.from(records.flat(Infinity)), 6), 't').run(); env.scripts.run(); },
    v: (name) => root.variables.get(name.toLowerCase())
  };
}

// ---- Parsing and layout -------------------------------------------------------------------------------------

test('HTML: <a href target> gives its text a url and target; text after it, or in <a> without href, has none', () => {
  const base = I.fieldFormat({}, {}, 8);
  const spans = I.parseHtmlText('<a href="http://example.com/?a=1&amp;b=2" target="_blank">go <u>here</u></a> then <a>plain</a>', base, true, 8, () => {});
  assert.deepStrictEqual(spans.map((s) => [s.text, s.format.url, s.format.target, s.format.underline]), [
    ['go ', 'http://example.com/?a=1&b=2', '_blank', false],
    ['here', 'http://example.com/?a=1&b=2', '_blank', true],
    [' then ', undefined, undefined, false],
    ['plain', undefined, undefined, false]
  ]);
});

test('layout: each run of link text gets a box; a link that wraps gets one per line', async () => {
  const g = await setup([field(1, '<a href="a.html">one two</a> three', { xMax: 2000, yMax: 1000 }), place(1, 1)]);
  // 2000 twips wide less the 40-twip gutters: "one two " (8 characters, 1600 twips) wraps before "three".
  const layout = g.movie.characters[1].layout;
  assert.deepStrictEqual(layout.links, [{ url: 'a.html', target: '', xMin: 40, xMax: 1440, yMin: 40, yMax: 280 }], 'the space after it is not link text');
  const wrapped = await setup([field(1, '<a href="b.html">one two three</a>', { xMax: 1700, yMax: 1000 }), place(1, 1)]);
  assert.deepStrictEqual(wrapped.movie.characters[1].layout.links.map((l) => [l.xMin, l.yMin, l.xMax - l.xMin]), [[40, 40, 1600], [40, 280, 1000]]);
});

// ---- Clicks ---------------------------------------------------------------------------------------------------

test('a link shows the hand and, clicked (press and release on it), opens its URL in its target through the host', async () => {
  const g = await setup([field(1, 'Read <a href="http://example.com/page" target="_blank">more</a>.'), place(1, 1, null, 2000, 1000)]);
  // "Read " is 5 characters (1000 twips): "more" spans 1040-1840 in the field, 3040-3840 on the stage.
  g.move(2500, 1150);
  assert.strictEqual(g.input.cursor(), '', 'over plain text');
  g.move(3400, 1150);
  assert.strictEqual(g.input.cursor(), 'pointer');
  g.tick();
  assert.ok(g.input.hovered && g.input.hovered.link, 'still hovered after a frame');
  g.input.down();
  g.tick();
  g.input.up();
  assert.deepStrictEqual(g.navigated.map((r) => [r.url, r.target, r.method]), [['http://example.com/page', '_blank', null]]);
  g.input.down();
  g.move(2500, 1150);
  g.input.up();
  assert.strictEqual(g.navigated.length, 1, 'released off the link: nothing');
  g.move(3400, 900);
  assert.strictEqual(g.input.hovered, null, 'outside the field');
});

test('asfunction: calls a function of the field\'s timeline (or by path) with its argument; a missing one is reported', async () => {
  const g = await setup([
    field(1, '<a href="asfunction:hello,world">a</a> <a href="asfunction:_root.box.say,x">b</a> <a href="asfunction:nothing">c</a>'),
    B.doAction(
      defineFunction('hello', ['who'], [push('got', 'who'), GET, SET]),
      push('box', 0, 'Object'), [0x40], SET,
      push('box'), GET, push('say'), defineFunction('', ['v'], [push('_root.said', 'v'), GET, SET]), [0x4f]
    ),
    place(1, 1)
  ]);
  // Up to SWF 7 the spaces between the links are dropped: "a" at 40-240, "b" at 240-440, "c" at 440-640.
  g.move(100, 150); g.click();
  g.move(300, 150); g.click();
  g.move(500, 150); g.click();
  assert.deepStrictEqual([g.v('got'), g.v('said')], ['world', 'x']);
  assert.deepStrictEqual(g.reported.filter((r) => r[0] === 'avm1:asfunctionMissing'), [['avm1:asfunctionMissing', 'nothing']]);
  assert.deepStrictEqual(g.navigated, []);
});

test('a link in a field inside a sprite resolves asfunction: from the sprite; javascript: links go to the host as calls', async () => {
  const sprite = B.tag(B.T.DefineSprite, Buffer.concat([B.body((w) => w.u16(2).u16(1)), place(1, 1),
    B.doAction(defineFunction('ping', [], [push('_root.pinged', 1), SET])), show(), end()]));
  const g = await setup([field(1, '<a href="asfunction:ping">p</a> <a href="javascript:panorama(2)">q</a>'), sprite, place(1, 2, 'holder', 1000, 0)]);
  g.env.host.host.call = (r) => { g.called = [r.name, r.args]; return null; };
  g.move(1100, 150); g.click();
  g.move(1300, 150); g.click(); // "q" right after "p" (the space between them is dropped up to SWF 7)
  assert.deepStrictEqual([g.v('pinged'), g.called], [1, ['panorama', [2]]]);
});

// ---- enabled and useHandCursor ----------------------------------------------------------------------------------

const square = B.defineShape(5, { version: 1, bounds: { xMax: 400, yMax: 400 }, fills: [{ color: [255, 0, 0] }],
  records: [{ move: [0, 0], fill1: 1 }, { to: [400, 0] }, { to: [400, 400] }, { to: [0, 400] }, { to: [0, 0] }] });
const buttonClip = () => [square, B.tag(B.T.DefineSprite, Buffer.concat([B.body((w) => w.u16(6).u16(1)), place(1, 5), show(), end()])), place(1, 6, 'btn', 1000, 1000),
  B.doAction(push('btn'), GET, push('onRelease'), defineFunction('', [], [push('_root.clicks', '_root.clicks'), GET, [0x50], SET]), [0x4f])];

test('enabled = false: a clip with button handlers takes no button events and shows no hand; true again restores it', async () => {
  const g = await setup(buttonClip());
  g.move(1200, 1200);
  assert.strictEqual(g.input.cursor(), 'pointer');
  g.click();
  assert.strictEqual(g.v('clicks'), 1);
  g.run(push('btn'), GET, push('enabled', false), [0x4f]);
  g.tick();
  assert.deepStrictEqual([g.input.hovered, g.input.cursor()], [null, ''], 'forgotten without events');
  g.click();
  assert.strictEqual(g.v('clicks'), 1, 'no onRelease');
  g.run(push('btn'), GET, push('enabled', true), [0x4f]);
  g.tick();
  g.click();
  assert.strictEqual(g.v('clicks'), 2);
});

test('useHandCursor = false keeps the arrow over a clip button (on the clip, or for every clip on MovieClip.prototype)', async () => {
  const g = await setup(buttonClip());
  g.move(1200, 1200);
  g.run(push('btn'), GET, push('useHandCursor', false), [0x4f]);
  assert.strictEqual(g.input.cursor(), '');
  g.click();
  assert.strictEqual(g.v('clicks'), 1, 'still a button');
  g.run(push('btn'), GET, push('useHandCursor'), [0x3a], POP); // delete btn.useHandCursor
  assert.strictEqual(g.input.cursor(), 'pointer');
  g.run(push('MovieClip'), GET, push('prototype'), [0x4e], push('useHandCursor', false), [0x4f]);
  assert.strictEqual(g.input.cursor(), '', 'MovieClip.prototype.useHandCursor = false');
});
