'use strict';
// Buttons: decoding, state children, hit areas, pointer/keyboard events and their actions (no browser needed).
const fs = require('fs');
const path = require('path');
const { test, assert } = require('../support/harness');
const { SWFReader, RetroFlash } = require('../support/load-reader');
const { FIXTURE_DIR } = require('../fixtures/build-fixtures');

const I = RetroFlash.internals;
const load = () => SWFReader.load(new Uint8Array(fs.readFileSync(path.join(FIXTURE_DIR, 'valid/fws-buttons.swf'))));

// Button 20 sits at (3800, 2000): up/over/down rectangles ±1200×±400, hit rectangle ±1300×±500.
// Button 21 sits at (5600, 3400): ±400 square. Lamp sprite at (1600, 2000).
const AT_BUTTON = [3800, 2000], IN_HIT_ONLY = [3800 + 1250, 2000], OUTSIDE = [200, 200], AT_RESET = [5600, 3400];

async function setup() {
  const movie = new I.Movie(await load());
  const reported = [];
  const env = I.createEnv(movie, (feature) => reported.push(feature));
  const root = new I.Clip(env, movie.root, 0, null);
  root.gotoFrame(1);
  env.scripts.run();
  const input = new I.InputController(env, () => root);
  // Like Player.afterInput and Player.advance: one budget per input event or tick.
  const run = (changed) => { if (changed) { env.scripts.beginUpdate(); env.scripts.run(); } return changed; };
  return {
    movie, root, env, input, reported,
    button: () => root.displayList.get(2), reset: () => root.displayList.get(3), lamp: () => root.displayList.get(1).clip,
    move: (p) => run(input.move(p[0], p[1])), down: () => run(input.down()), up: () => run(input.up()),
    key: (k) => run(input.key(I.swfKeyCode(k))),
    tick: () => { env.scripts.beginUpdate(); root.tick(); env.scripts.run(); if (input.afterTick()) env.scripts.run(); }
  };
}
const shownCharacter = (obj) => obj.button.displayList.get(1).characterId;

test('button tags: records, conditions and DefineButtonCxform', async () => {
  const swf = await load();
  const b2 = swf.tags.find((t) => t.code === 34).fields;
  assert.strictEqual(b2.buttonId, 20);
  assert.deepStrictEqual(b2.records.map((r) => [r.up, r.over, r.down, r.hitTest, r.characterId]),
    [[true, false, false, false, 1], [false, true, false, false, 2], [false, false, true, false, 3], [false, false, false, true, 4]]);
  assert.deepStrictEqual(b2.actions.map((a) => a.conditions), [1, 2, 8 | (13 << 9)]);
  const b1 = swf.tags.find((t) => t.code === 7).fields;
  assert.deepStrictEqual(b1.actions.map((a) => a.conditions), [8], 'DefineButton runs on release');
  assert.strictEqual(swf.codeTags.buttonActions, 4);
  const movie = new I.Movie(swf);
  assert.deepStrictEqual(movie.characters[21].records[0].cx, [1, 0.5, 0.5, 1, 0, 0, 0, 0], 'v1 record tinted by DefineButtonCxform');
});

test('button instance: up state drawn, separate hit area, root stopped on frame 1', async () => {
  const { root, button, lamp } = await setup();
  assert.strictEqual(root.frame, 1);
  assert.strictEqual(root.playing, false);
  assert.strictEqual(button().button.state, 'up');
  assert.strictEqual(shownCharacter(button()), 1);
  assert.deepStrictEqual([...button().button.hitList.values()].map((o) => o.characterId), [4]);
  assert.strictEqual(lamp().frame, 1);
});

test('hover: roll over shows the over state and runs its action (setTarget on the lamp); roll out undoes it', async () => {
  const { input, button, lamp, move } = await setup();
  assert.strictEqual(move(OUTSIDE), false, 'nothing under the pointer');
  assert.strictEqual(move(AT_BUTTON), true);
  assert.strictEqual(input.hovered, button());
  assert.strictEqual(button().button.state, 'over');
  assert.strictEqual(shownCharacter(button()), 2);
  assert.strictEqual(lamp().frame, 2, 'roll-over action lit the lamp');
  assert.strictEqual(input.cursor(), 'pointer');
  assert.strictEqual(move(IN_HIT_ONLY), false, 'still inside the larger hit area');
  move(OUTSIDE);
  assert.strictEqual(button().button.state, 'up');
  assert.strictEqual(lamp().frame, 1);
  assert.strictEqual(input.cursor(), '');
});

test('click: press shows down; release over the button runs gotoLabel("done")', async () => {
  const { root, button, move, down, up } = await setup();
  move(AT_BUTTON);
  down();
  assert.strictEqual(button().button.state, 'down');
  assert.strictEqual(shownCharacter(button()), 3);
  assert.strictEqual(root.frame, 1, 'press has no action');
  up();
  assert.strictEqual(button().button.state, 'over');
  assert.strictEqual(root.frame, 2);
  assert.strictEqual(root.playing, false, 'frame 2 stop()');
  assert.ok(root.displayList.has(4), 'green bar placed on frame 2');
});

test('drag out and release outside: no release action, state back to up', async () => {
  const { root, button, move, down, up } = await setup();
  move(AT_BUTTON);
  down();
  move(OUTSIDE);
  assert.strictEqual(button().button.state, 'over', 'Flash shows "over" while a pressed button is dragged out');
  move(AT_BUTTON);
  assert.strictEqual(button().button.state, 'down', 'dragged back in');
  move(OUTSIDE);
  up();
  assert.strictEqual(button().button.state, 'up');
  assert.strictEqual(root.frame, 1, 'release outside does not run the release action');
});

test('keyboard: the Enter KeyPress condition runs without the pointer', async () => {
  const { root, key } = await setup();
  assert.strictEqual(key('a'), false);
  assert.strictEqual(key('Enter'), true);
  assert.strictEqual(root.frame, 2);
});

test('DefineButton (v1) release runs gotoFrame(1); the frame-2 bar is removed', async () => {
  const { root, move, down, up, key } = await setup();
  key('Enter');
  assert.strictEqual(root.frame, 2);
  move(AT_RESET);
  down();
  up();
  assert.strictEqual(root.frame, 1);
  assert.ok(!root.displayList.has(4));
});

test('ticks: a button that leaves the stage is forgotten; one that appears under a still pointer is rolled over', async () => {
  const { root, env, input, move } = await setup();
  move(AT_BUTTON);
  const first = input.hovered;
  // Rebuild the root (as player.stop() does): the old instance is gone.
  const fresh = new I.Clip(env, root.def, 0, null);
  fresh.gotoFrame(1);
  env.scripts.run();
  const input2 = new I.InputController(env, () => fresh);
  input2.inside = true; input2.x = AT_BUTTON[0]; input2.y = AT_BUTTON[1];
  assert.strictEqual(input2.afterTick(), true, 'new button under the pointer gets a roll over');
  assert.notStrictEqual(input2.hovered, first);
  assert.strictEqual(input2.hovered.button.state, 'over');
});

test('hit testing: fills (even-odd), curves and strokes', async () => {
  const { movie } = await setup();
  const geometryOf = (id) => I.buildShapeGeometry(movie.characters[id].shape);
  const rect = geometryOf(1);
  assert.strictEqual(I.pointInShape(rect, 0, 0), true);
  assert.strictEqual(I.pointInShape(rect, 1199, 399), true);
  assert.strictEqual(I.pointInShape(rect, 1201, 0), false);
  const circle = geometryOf(5);
  assert.strictEqual(I.pointInShape(circle, 0, 490), true);
  assert.strictEqual(I.pointInShape(circle, 400, 400), false, 'outside the curved edge');
  const stroke = { groups: [{ fills: [], lines: [{ style: { width: 100 }, commands: [0, 0, 0, 1, 1000, 0] }] }], fillRule: 'evenodd' };
  assert.strictEqual(I.pointInShape(stroke, 500, 40), true);
  assert.strictEqual(I.pointInShape(stroke, 500, 60), false);
});

test('SWF key codes', () => {
  assert.deepStrictEqual(['ArrowLeft', 'Enter', 'Escape', 'a', 'A', ' ', 'Shift'].map(I.swfKeyCode), [1, 13, 19, 97, 65, 32, 0]);
});
