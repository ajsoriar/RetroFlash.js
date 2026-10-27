'use strict';
// Fonts and text: decoding (DefineFont/2/3, DefineFontInfo, DefineText/2, DefineEditText) and layout without a
// canvas. Device fonts use a deterministic stand-in measure: every character is 0.5 em wide, ascent 0.8 em,
// descent 0.2 em. Drawing itself is checked in a browser with demo/player.html.
const fs = require('fs');
const path = require('path');
const { test, assert } = require('../support/harness');
const { SWFReader, RetroFlash } = require('../support/load-reader');
const { FIXTURE_DIR } = require('../fixtures/build-fixtures');
const B = require('../support/swf-builder');

const I = RetroFlash.internals;
const loadText = () => SWFReader.load(new Uint8Array(fs.readFileSync(path.join(FIXTURE_DIR, 'valid/fws-text.swf'))));
const byId = (swf, code, id) => swf.tags.find((t) => t.code === code && t.fields && (t.fields.characterId === id || t.fields.fontId === id));
const sizeOf = (css) => parseFloat(/([\d.]+)px/.exec(css)[1]);
const measure = { width: (css, text) => text.length * sizeOf(css) * 0.5, metrics: (css, size) => ({ ascent: size * 0.8, descent: size * 0.2 }) };
const runText = (line) => line.runs.map((r) => r.text).join('');

async function movieAndLayouts() {
  const swf = await loadText(), movie = new I.Movie(swf), reported = [];
  const report = (feature, reason, source) => reported.push([feature, String(source)]);
  const layout = (id) => I.layoutEditText(movie.characters[id], movie.characters, measure, report);
  return { swf, movie, reported, report, layout };
}

test('DefineFont2/3: glyphs, codes, layout, kerning, name without its NUL; fonts without glyphs', async () => {
  const swf = await loadText();
  const f1 = byId(swf, 48, 1).fields;
  assert.strictEqual(f1.name, 'RetroSans');
  assert.deepStrictEqual(f1.glyphs.map((g) => [g.code, g.advance]), [[72, 700], [73, 400], [79, 700], [32, 300]]);
  assert.deepStrictEqual([f1.ascent, f1.descent, f1.leading, f1.hasLayout], [800, 224, 0, true]);
  assert.deepStrictEqual(f1.kerning, [{ left: 72, right: 73, adjustment: -20 }]);
  assert.deepStrictEqual(f1.glyphs[1].bounds, { nBits: f1.glyphs[1].bounds.nBits, xMin: 100, xMax: 300, yMin: -700, yMax: 0 });
  assert.strictEqual(f1.glyphs[3].records.length, 0, 'space has no outline');
  const f2 = byId(swf, 75, 2).fields;
  assert.deepStrictEqual([f2.fontVersion, f2.name, f2.glyphs.length, f2.ascent], [3, 'RetroSans3', 1, 16000]);
  assert.deepStrictEqual(byId(swf, 48, 3).fields.glyphs, []);
  const verdana = byId(swf, 48, 4);
  assert.strictEqual(verdana.status, 'decoded', 'zero glyphs without CodeTableOffset');
  assert.deepStrictEqual([verdana.fields.name, verdana.fields.bold, verdana.fields.glyphs.length], ['Verdana', true, 0]);
});

test('DefineText/DefineText2: records carry font and height; RGB and RGBA colours', async () => {
  const swf = await loadText();
  const t = byId(swf, 11, 10).fields;
  assert.deepStrictEqual(t.records.map((r) => [r.fontId, r.height, r.color, r.x, r.y, r.glyphs.length]), [
    [1, 400, { r: 220, g: 38, b: 38, a: 255 }, 0, 0, 4],
    [undefined, undefined, { r: 37, g: 99, b: 235, a: 255 }, 0, 500, 2]
  ]);
  assert.deepStrictEqual(t.records[0].glyphs[2], { index: 3, advance: 117 });
  assert.deepStrictEqual(byId(swf, 33, 11).fields.records[0].color, { r: 22, g: 163, b: 74, a: 128 });
});

test('DefineEditText: flags, font, colour, layout, variable and initial text', async () => {
  const swf = await loadText();
  const f = byId(swf, 37, 20).fields;
  assert.deepStrictEqual([f.fontId, f.fontHeight, f.align, f.leading, f.readOnly, f.noSelect, f.html, f.useOutlines, f.initialText],
    [3, 300, 2, 40, true, true, false, false, 'Device text, centered']);
  const input = byId(swf, 37, 24).fields;
  assert.deepStrictEqual([input.readOnly, input.password, input.border, input.variableName, input.initialText], [false, true, true, 'secret', 'hidden']);
  assert.strictEqual(byId(swf, 37, 23).fields.autoSize, true);
  assert.strictEqual(byId(swf, 37, 22).fields.html, true);
});

test('DefineFont + DefineFontInfo: codes, name and style come from the info tag', async () => {
  const glyph = B.glyphShape([{ move: [0, -500], fill1: 1 }, { to: [300, -500] }, { to: [300, 0] }, { to: [0, -500] }]);
  const font = B.tag(10, B.body((w) => w.u16(5).u16(4).u16(4 + glyph.length).raw(glyph).raw(glyph)));
  const info = B.tag(13, B.body((w) => w.u16(5).u8(4).raw(Buffer.from('Info')).u8(0x02 | 0x04).u8(65).u8(66)));
  const swf = await SWFReader.load(B.swf({ version: 6, tags: [font, info, B.tag(B.T.ShowFrame), B.tag(B.T.End)] }));
  assert.strictEqual(swf.tags[0].fields.glyphs.length, 2);
  assert.deepStrictEqual(swf.tags[1].fields, { fontId: 5, name: 'Info', smallText: false, shiftJIS: false, ansi: false, italic: true, bold: true, codes: [65, 66] });
  const c = new I.Movie(swf).characters[5];
  assert.deepStrictEqual([c.fontName, c.bold, c.italic, c.em, c.byCode.get(66)], ['Info', true, true, 1024, 1]);
});

test('malformed text tags: missing end of records is a warning; a bad font offset makes the tag invalid', async () => {
  const text = B.defineText(9, { bounds: { xMax: 10, yMax: 10 }, noEnd: true, records: [{ fontId: 1, height: 20, glyphs: [[0, 1]] }] });
  const badFont = B.tag(48, B.body((w) => w.u16(8).u8(0).u8(0).u8(1).raw([0x41]).u16(1).u16(400).u16(4)));
  const swf = await SWFReader.load(B.swf({ version: 6, tags: [text, badFont, B.tag(B.T.ShowFrame), B.tag(B.T.End)] }));
  assert.strictEqual(swf.tags[0].status, 'decoded');
  assert.deepStrictEqual(swf.diagnostics.map((d) => d.code), ['TEXT_END_MISSING', 'INVALID_OFFSET']);
  assert.strictEqual(swf.tags[1].status, 'invalid');
});

test('glyph outlines: a ring glyph has two contours (its hole), and an empty glyph none', async () => {
  const { movie } = await movieAndLayouts();
  const font = movie.characters[1], ring = I.glyphCommands(font.glyphs[2]);
  let moves = 0;
  for (let i = 0; i < ring.length; i += ring[i] === 2 ? 5 : 3) if (ring[i] === 0) moves++;
  assert.strictEqual(moves, 2, 'outer contour and hole');
  assert.deepStrictEqual(I.glyphCommands(font.glyphs[3]), []);
});

test('static text: glyph positions, scale (1024 and 20480 EM) and colours carried between records', async () => {
  const { movie, report } = await movieAndLayouts();
  const placed = I.staticTextGlyphs(movie.characters[10], movie.characters, report);
  assert.deepStrictEqual(placed.map((p) => [p.glyph.code, p.x, p.y, p.color.b]), [
    [72, 0, 0, 38], [73, 273, 0, 38], [32, 429, 0, 38], [79, 546, 0, 38], [79, 0, 500, 235], [72, 273, 500, 235]
  ]);
  assert.strictEqual(placed[0].scale, 400 / 1024);
  assert.strictEqual(I.staticTextGlyphs(movie.characters[11], movie.characters, report)[0].scale, 400 / 20480);
  const missing = [];
  I.staticTextGlyphs({ id: 99, text: { records: [{ fontId: 77, height: 20, glyphs: [{ index: 0, advance: 5 }] }] } }, movie.characters, (f, r, s) => missing.push([f, s]));
  assert.deepStrictEqual(missing, [['render:missingFont', '99 → 77']]);
});

test('HTML subset: paragraphs, font colour/size, styles, entities, bullets, mismatched end tags', () => {
  const base = { face: '_sans', size: 12, color: { r: 0, g: 0, b: 0 }, bold: false, italic: false, underline: false, align: 0, leftMargin: 0, rightMargin: 0, indent: 0, blockIndent: 0, leading: 0, bullet: false };
  const spans = I.parseHtmlText('<P ALIGN="right"><font color="#0000FF" size="+6">Blue</font> <b>b</i>old</b></p><p>x &amp; y&#33;<br/>z</p><li>Item</li>', base, true, 8, () => {});
  assert.deepStrictEqual(spans.map((s) => s.text), ['Blue', ' ', 'b', 'old', '\n', 'x & y!', '\n', 'z', '\n', 'Item', '\n']);
  assert.deepStrictEqual([spans[0].format.align, spans[0].format.color, spans[0].format.size], [1, { r: 0, g: 0, b: 255 }, 18]);
  assert.strictEqual(spans[3].format.bold, true, '</i> did not close <b>');
  assert.strictEqual(spans[5].format.align, 0);
  assert.strictEqual(spans[9].format.bullet, true);
  // Up to SWF 7 whitespace-only text is dropped; up to SWF 6 fields are always multiline.
  assert.deepStrictEqual(I.parseHtmlText('<b>a</b> <b>b</b><br>c', base, false, 7, () => {}).map((s) => s.text), ['a', 'b', 'c']);
  assert.deepStrictEqual(I.parseHtmlText('a<br>b', base, false, 6, () => {}).map((s) => s.text), ['a', '\n', 'b']);
  assert.strictEqual(I.parseHtmlText('<font size="500">x</font>', base, true, 8, () => {})[0].format.size, 127);
  const reported = [];
  I.parseHtmlText('<img src="x.png">a', base, true, 8, (f) => reported.push(f));
  assert.deepStrictEqual(reported, ['text:htmlImage']);
});

test('hostile text stays linear: unclosed tags, long tags, unterminated comments, long space runs', async () => {
  const base = I.fieldFormat({ html: true }, {}, 8), started = Date.now();
  assert.deepStrictEqual(I.parseHtmlText('<b>x' + '<a'.repeat(200000), base, true, 8, () => {}).map((s) => s.text.length), [1 + 400000]);
  assert.deepStrictEqual(I.parseHtmlText('<font color="' + 'a="'.repeat(50000) + '">y</font>', base, true, 8, () => {}).map((s) => s.text), ['y']);
  assert.deepStrictEqual(I.parseHtmlText('z<!--' + '<!--'.repeat(100000), base, true, 8, () => {}).map((s) => s.text), ['z']);
  assert.deepStrictEqual(I.parseHtmlText('1 < 2 > 0', base, true, 8, () => {}).map((s) => s.text), ['1 < 2 > 0']);
  const { movie } = await movieAndLayouts();
  const field = Object.assign({}, movie.characters[20].field, { initialText: ' '.repeat(200000) + 'x', align: 1 });
  const l = I.layoutEditText(Object.assign({}, movie.characters[20], { field, layout: null }), movie.characters, measure, () => {});
  assert.strictEqual(l.lines.length, 1);
  assert.ok(Date.now() - started < 5000, 'bounded time');
});

test('field formats and device font families', () => {
  const font = { type: 'font', fontName: 'Verdana', bold: true, italic: false };
  const f = I.fieldFormat({ fontId: 1, fontHeight: 300, html: false, align: 2, leading: 40, color: { r: 1, g: 2, b: 3, a: 0 } }, { 1: font }, 6);
  assert.deepStrictEqual([f.face, f.size, f.bold, f.align, f.leading, f.color], ['Verdana', 15, true, 2, 2, { r: 1, g: 2, b: 3 }]);
  const html = I.fieldFormat({ fontId: 1, fontHeight: 300, html: true, align: 2, initialText: 'x' }, { 1: font }, 7);
  assert.deepStrictEqual([html.bold, html.align], [false, 0], 'HTML: no inherited bold, left before SWF 8');
  assert.strictEqual(I.fieldFormat({ html: true, align: 2, initialText: 'x' }, {}, 8).align, 2);
  assert.deepStrictEqual([I.fieldFormat({}, {}, 8).face, I.fieldFormat({}, {}, 8).size], ['Times New Roman', 12]);
  assert.strictEqual(I.cssFontFamily('_sans'), 'sans-serif, sans-serif');
  assert.strictEqual(I.cssFontFamily('Times New Roman'), '"Times New Roman", serif');
  assert.strictEqual(I.cssFontFamily('Courier New, _typewriter'), '"Courier New", monospace, monospace');
  assert.strictEqual(I.cssFontFamily('Bad"; x{}'), '"Bad x", sans-serif');
});

test('layout: device font centered inside the gutter; alignment never goes left of the margin', async () => {
  const { layout, movie } = await movieAndLayouts();
  const l = layout(20), run = l.lines[0].runs[0];
  // 21 characters × 7.5 px = 157.5 px = 3150 twips; room = 4000 - 80 = 3920.
  assert.strictEqual(run.text, 'Device text, centered');
  assert.strictEqual(run.x, -40 + 40 + (3920 - 3150) / 2);
  assert.strictEqual(run.baseline, -40 + 40 + 15 * 0.8 * 20);
  assert.strictEqual(run.face.css, '15px sans-serif, sans-serif');
  const narrow = Object.assign({}, movie.characters[20], { layout: null, field: Object.assign({}, movie.characters[20].field, { bounds: { xMin: 0, xMax: 400, yMin: 0, yMax: 400 } }) });
  assert.strictEqual(I.layoutEditText(narrow, movie.characters, measure, () => {}).lines[0].runs[0].x, 40, 'too wide: starts at the margin');
});

test('layout: embedded font with word wrap, glyph advances and leading', async () => {
  const { layout } = await movieAndLayouts();
  const l = layout(21), k = 400 / 1024;
  assert.deepStrictEqual(l.lines.map(runText), ['HI HO ', 'OH IH ', 'OHIO']);
  assert.ok(l.lines[0].runs[0].face.font, 'embedded glyphs');
  const ascent = 800 * k, descent = 224 * k;
  assert.deepStrictEqual(l.lines.map((line) => line.runs[0].baseline), [0, 1, 2].map((n) => -40 + 40 + ascent + n * (ascent + descent + 40)));
  assert.strictEqual(l.lines[0].runs[0].width, (700 + 400 + 300 + 700 + 700 + 300) * k);
});

test('layout: HTML paragraphs, alignment per paragraph, bullet, styles', async () => {
  const { layout } = await movieAndLayouts();
  const l = layout(22);
  assert.deepStrictEqual(l.lines.map(runText), ['Blue and bold', 'Second & last', '•Item']);
  const [first, second, third] = l.lines, room = 7640 - 80;
  const right = first.runs[first.runs.length - 1];
  assert.strictEqual(right.x + right.width, -40 + 40 + room, 'right-aligned');
  assert.strictEqual(first.runs[0].format.size, 18);
  assert.ok(second.runs[0].format.underline);
  assert.ok(third.runs[1].x - third.runs[0].x >= 720, 'bullet text is indented');
  assert.match(first.runs.find((r) => r.text === 'bold').face.css, /^bold 14px/);
});

test('layout: AutoSize grows the field; password text is masked', async () => {
  const { layout } = await movieAndLayouts();
  const auto = layout(23);
  // "Auto-sized box": 14 × 6 px = 84 px = 1680 twips, plus the gutters.
  assert.deepStrictEqual(auto.bounds, { xMin: -40, xMax: -40 + 1680 + 80, yMin: -40, yMax: auto.bounds.yMax });
  assert.ok(Math.abs(auto.bounds.yMax - (-40 + 12 * 20 + 80)) < 1e-9, 'one line of 12 px plus the gutters');
  assert.strictEqual(runText(layout(24).lines[0]), '******');
});

test('placing text fields reports variables and input; text hit-tests by its bounds', async () => {
  const { movie } = await movieAndLayouts();
  const reported = [];
  const env = I.createEnv(movie, (feature, reason, source) => reported.push([feature, source]));
  const root = new I.Clip(env, movie.root, 0, null);
  root.gotoFrame(1);
  assert.deepStrictEqual(reported, [['text:variable', 24], ['text:input', 24]]);
  const obj = root.displayList.get(1), world = obj.matrix; // text 10 at (400, 1000), bounds 0..830 × -280..500
  assert.strictEqual(I.hitTestObject(obj, world, 400 + 100, 1000 - 100), true);
  assert.strictEqual(I.hitTestObject(obj, world, 400 + 900, 1000), false);
  const field = root.displayList.get(4);
  assert.strictEqual(I.hitTestObject(field, field.matrix, 200 + 3900, 1700 + 100), true);
});
