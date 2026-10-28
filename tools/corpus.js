'use strict';
/* Compatibility corpus: runs SWF files through the reader and the player in Node and writes a reproducible
   matrix of what each file uses and where it falls short, by layer:
     parser  the reader (diagnostics, tags it does not decode),
     vm      the AVM1 interpreter (budgets, malformed or unknown actions, uncaught throws),
     api     built-in objects and policies (objects not implemented, navigation, loads, sound),
     render  drawing and text (characters or features not drawn),
     input   buttons and pointer handling.
   Each file runs the same way every time: a fixed clock (the frame rate), a fixed random sequence, a fixed
   number of frames, and a pointer probe (move to the centre, press, release) halfway. Bitmaps are not decoded
   (that needs a browser), and drawing goes to a stand-in canvas, so pixels are not compared.
   With --resources DIR, a URL a script loads (loadMovie, loadVariables) is answered with the file of DIR named
   like its last path segment; images are then only checked by their header. Without it, loads are refused.
   Loads are shown at the next frame boundary, after the host answered.

   Usage: node tools/corpus.js [--frames N] [--resources DIR] [--json file] [--md file] [--versions] <file.swf | folder>...
   Only run it on SWF files you are allowed to use; never commit third-party files. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LAYERS = ['parser', 'vm', 'api', 'render', 'input'];

// Node has no Canvas: a stand-in context, Path2D and DOMMatrix let the renderer run its drawing code.
function installCanvasStandIns() {
  if (!globalThis.Path2D) globalThis.Path2D = class { addPath() {} moveTo() {} lineTo() {} quadraticCurveTo() {} bezierCurveTo() {} closePath() {} rect() {} };
  if (!globalThis.DOMMatrix) globalThis.DOMMatrix = class { constructor(m) { this.m = m; } };
}
function standInCanvas() {
  const metrics = () => ({ width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0, fontBoundingBoxAscent: 0, fontBoundingBoxDescent: 0, addColorStop() {} });
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : metrics), set: (t, k, v) => { t[k] = v; return true; } });
  return { getContext: () => ctx, style: {}, width: 0, height: 0 };
}

// The layer of a diagnostic feature name.
function layerOf(feature) {
  if (/^(tag:|actionscript:DoABC|timeline:)/.test(feature) || /^[A-Z]\w*\.\w+$/.test(feature)) return 'parser';
  if (feature === 'avm1:objectValue' || /^avm1:GetURL/.test(feature) || /^(sound|load):/.test(feature)) return 'api';
  if (/^avm1:/.test(feature)) return 'vm';
  if (/^(render|text):/.test(feature)) return 'render';
  if (/^input:/.test(feature)) return 'input';
  return feature === 'actionscript:DoAction' || feature === 'actionscript:DoInitAction' ? null : 'parser';
}
// A fixed sequence in [0, 1) for RandomNumber and Math.random (a linear congruential generator).
function fixedRandom(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// A host loader that answers each URL with the file of `dir` named like its last path segment, or refuses it.
function folderLoader(dir) {
  return (request) => {
    let file = String(request.url).split(/[?#]/)[0];
    file = file.slice(file.lastIndexOf('/') + 1);
    try { file = decodeURIComponent(file); } catch (err) { /* keep it as written */ }
    const full = path.join(dir, path.basename(file));
    return file && fs.existsSync(full) && fs.statSync(full).isFile() ? new Uint8Array(fs.readFileSync(full)) : null;
  };
}
// Images loaded in Node are checked by their header only (no browser decoder); their pixels are reserved.
async function headerOnlyImage(bytes, limits, name) {
  const { RetroFlash } = require('../tests/support/load-reader');
  const I = RetroFlash.internals, size = I.imageSize(bytes, I.imageFormat(bytes));
  if (!size) throw new Error('No image size found in the header of ' + name);
  const reserved = I.reservePixels(limits, size.width, size.height);
  return { source: { width: size.width, height: size.height, close() {} }, width: size.width, height: size.height, reserved };
}

/* Runs one SWF. Returns { name, sha256, status, version, avm, width, height, fps, frames, tags, codeTags,
   actions, layers: { parser|vm|api|render|input: { status, features: { name: count } } }, error }.
   options: { frames (60), resources (a folder that answers loads) }. */
async function analyze(bytes, name, { frames = 60, resources = null } = {}) {
  installCanvasStandIns();
  const { SWFReader, RetroFlash } = require('../tests/support/load-reader');
  const I = RetroFlash.internals;
  const result = {
    name, sha256: crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16), status: 'ok',
    layers: {}, error: null
  };
  LAYERS.forEach((l) => { result.layers[l] = { status: 'ok', features: {} }; });
  const note = (feature, count = 1) => {
    const layer = layerOf(feature);
    if (!layer) return;
    const f = result.layers[layer].features;
    f[feature] = (f[feature] || 0) + count;
    result.layers[layer].status = 'degraded';
  };
  const fail = (layer, err) => {
    result.layers[layer].status = 'failed';
    result.status = 'failed';
    result.error = layer + ': ' + (err && err.message ? err.message : String(err));
  };

  let swf;
  try {
    swf = await SWFReader.load(bytes);
  } catch (err) {
    fail('parser', err);
    return result;
  }
  Object.assign(result, {
    version: swf.version, avm: swf.fileAttributes && swf.fileAttributes.actionScript3 ? 2 : 1, width: swf.width, height: swf.height,
    fps: swf.fps, frames: swf.frameCount, tags: swf.tags.length, codeTags: Object.assign({}, swf.codeTags)
  });
  swf.diagnostics.forEach((d) => note(d.code));
  swf.unsupported.forEach((u) => note(u.feature, u.count));
  if (result.avm === 2) {
    fail('vm', new Error('AVM2 (ActionScript 3) is not supported'));
    return finish(result);
  }

  const reported = new Map();
  const report = (feature) => reported.set(feature, (reported.get(feature) || 0) + 1);
  let movie, env, root, input, renderer;
  const duration = 1000 / (swf.fps > 0 ? swf.fps : 12);
  let now = 0;
  try {
    movie = new I.Movie(swf);
    env = I.createEnv(movie, report, { loader: resources ? folderLoader(resources) : null });
    env.loads.decodeImage = headerOnlyImage;
    env.loads.decodeBitmaps = false; // as for the main movie: bitmaps need a browser
    env.scripts.clock = () => now;
    env.scripts.random = fixedRandom(0x5eed);
    root = new I.Clip(env, movie.root, 0, null);
    input = new I.InputController(env, () => root);
    renderer = new I.CanvasRenderer(standInCanvas(), report);
  } catch (err) {
    fail('vm', err);
    return finish(result);
  }
  const b = swf.bounds, stage = {
    background: swf.background, xMin: b.xminTwips, yMin: b.yminTwips, characters: movie.characters,
    widthTwips: Math.max(1, b.xmaxTwips - b.xminTwips), heightTwips: Math.max(1, b.ymaxTwips - b.yminTwips)
  };
  // Each update starts a new budget; the steps of the previous one are added to the total first.
  let steps = 0;
  const begin = () => { steps += env.scripts.steps; env.scripts.beginUpdate(); };
  const update = () => { begin(); env.scripts.run(); if (input.afterTick()) env.scripts.run(); };
  // What arrived from the loader is shown at the frame boundary, as the player does.
  const loads = async () => {
    await env.loads.idle();
    if (env.loads.apply()) { env.scripts.run(); if (input.afterTick()) env.scripts.run(); }
  };
  const draw = () => {
    try { renderer.render(stage, root); } catch (err) { fail('render', err); }
  };
  try {
    root.gotoFrame(1);
    update();
    draw();
    const centre = [(b.xminTwips + b.xmaxTwips) / 2, (b.yminTwips + b.ymaxTwips) / 2];
    for (let f = 1; f <= frames && result.status !== 'failed'; f++) {
      now = f * duration;
      env.instances = 0;
      begin();
      root.tick();
      env.scripts.run();
      if (input.afterTick()) env.scripts.run();
      if (env.scripts.runTimers()) update();
      if (f === Math.ceil(frames / 2)) {
        if (input.move(centre[0], centre[1])) update();
        if (input.down()) update();
        if (input.up()) update();
      }
      await loads();
      if (f % 10 === 0 || f === frames) draw();
    }
    env.loads.close();
    result.actions = { steps: steps + env.scripts.steps, cachedBlocks: env.scripts.cache.size, decodedBytes: env.scripts.decoded.used };
  } catch (err) {
    fail('vm', err);
  }
  reported.forEach((count, feature) => note(feature, count));
  return finish(result);
}
function finish(result) {
  if (result.status !== 'failed' && LAYERS.some((l) => result.layers[l].status === 'degraded')) result.status = 'degraded';
  return result;
}

// Every .swf under the given files and folders, sorted.
function collect(inputs) {
  const files = [];
  for (const input of inputs) {
    const stat = fs.statSync(input);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(input).sort()) {
        const full = path.join(input, entry);
        if (fs.statSync(full).isDirectory()) files.push(...collect([full]));
        else if (/\.swf$/i.test(entry)) files.push(full);
      }
    } else {
      files.push(input);
    }
  }
  return files;
}
async function matrix(files, options) {
  const rows = [];
  for (const file of files) rows.push(await analyze(new Uint8Array(fs.readFileSync(file)), path.basename(file), options));
  return rows;
}

// The matrix as Markdown: one row per file, a column per layer, then the features found.
function toMarkdown(rows) {
  const mark = { ok: 'ok', degraded: 'partial', failed: '**failed**' };
  const lines = [
    '| File | SWF | Frames | AVM1 steps | Status | Parser | VM | API | Render | Input | Features |',
    '|---|---|---|---|---|---|---|---|---|---|---|'
  ];
  for (const r of rows) {
    const features = LAYERS.flatMap((l) => Object.keys(r.layers[l].features).sort().map((f) => f + (r.layers[l].features[f] > 1 ? ' ×' + r.layers[l].features[f] : '')));
    lines.push('| ' + [r.name, r.version || '', r.frames || '', r.actions ? r.actions.steps : '', mark[r.status],
      ...LAYERS.map((l) => mark[r.layers[l].status]), (features.join(', ') || '') + (r.error ? ' — ' + r.error : '')].join(' | ') + ' |');
  }
  return lines.join('\n') + '\n';
}

module.exports = { analyze, matrix, collect, toMarkdown, layerOf, LAYERS };

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2), options = {}, inputs = [];
    let json = null, md = null;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--frames') options.frames = Number(args[++i]);
      else if (args[i] === '--resources') options.resources = args[++i];
      else if (args[i] === '--json') json = args[++i];
      else if (args[i] === '--md') md = args[++i];
      else if (args[i] === '--versions') inputs.push('--versions');
      else inputs.push(args[i]);
    }
    let rows;
    if (inputs[0] === '--versions') {
      const { versionMatrix } = require('../tests/corpus/versions');
      const table = await versionMatrix();
      process.stdout.write(table.markdown);
      return;
    }
    if (!inputs.length) {
      console.error('Usage: node tools/corpus.js [--frames N] [--resources DIR] [--json file] [--md file] <file.swf | folder>...  |  --versions');
      process.exit(2);
    }
    rows = await matrix(collect(inputs), options);
    if (json) fs.writeFileSync(json, JSON.stringify(rows, null, 2) + '\n');
    if (md) fs.writeFileSync(md, toMarkdown(rows));
    if (!json && !md) process.stdout.write(toMarkdown(rows));
  })().catch((err) => { console.error(err); process.exit(1); });
}
