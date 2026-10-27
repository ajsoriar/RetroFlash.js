'use strict';
// The module manifest and the demo's script list. The bundle itself is tested by npm run test:dist, which
// runs this whole suite against dist/retroflash.min.js.
const fs = require('fs');
const path = require('path');
const { test, assert } = require('../support/harness');

const root = path.join(__dirname, '..', '..');
const modules = require(path.join(root, 'src', 'modules.json'));

test('manifest: lists every source script once, the reader first and the public API last', () => {
  const found = [];
  (function walk(dir) {
    fs.readdirSync(path.join(root, 'src', dir), { withFileTypes: true }).forEach((e) => {
      const rel = dir ? dir + '/' + e.name : e.name;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.js')) found.push(rel);
    });
  })('');
  assert.deepStrictEqual(found.slice().sort(), modules.slice().sort());
  assert.strictEqual(modules[0], 'swf-reader.js');
  assert.strictEqual(modules[modules.length - 1], 'retroflash.js');
});

test('demo/player.html loads the scripts of the manifest, in order', () => {
  const html = fs.readFileSync(path.join(root, 'demo', 'player.html'), 'utf8');
  const scripts = Array.from(html.matchAll(/<script src="\.\.\/src\/([^"]+)"><\/script>/g), (m) => m[1]);
  assert.deepStrictEqual(scripts, modules);
});

test('the player modules leave no namespace behind and expose their exports as internals', () => {
  const { RetroFlash } = require('../support/load-reader');
  assert.ok(!('RetroFlashModules' in globalThis));
  ['Clip', 'Movie', 'CanvasRenderer', 'parseActions', 'layoutEditText'].forEach((name) => {
    assert.strictEqual(typeof RetroFlash.internals[name], 'function', name);
  });
});
