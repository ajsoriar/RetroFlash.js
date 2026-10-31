'use strict';
/* Builds the versioned ES5 browser bundle and source map from src/modules.json. Usage: npm install, then
   npm run build. Terser and Babel are development dependencies; the bundle has no runtime dependencies.
   The sources and final bundle are loaded in isolated contexts, so a broken build never lands. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const babel = require('@babel/core');
const { minify } = require('terser');

const root = path.join(__dirname, '..');
const files = require(path.join(root, 'src', 'modules.json'));
const pkg = require(path.join(root, 'package.json'));
const bundleName = 'retroflash-' + pkg.version + '.min.js';
if (pkg.browser !== './dist/' + bundleName) {
  throw new Error('build: package.browser must be ./dist/' + bundleName);
}

// Runs a script the way a page would, in a fresh global object, and returns the globals it defined.
function load(code, filename) {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox, { filename });
  const { RetroFlash, SWFReader } = sandbox;
  if (!RetroFlash || !SWFReader || typeof RetroFlash.Player !== 'function' || 'RetroFlashModules' in sandbox) {
    throw new Error('build: ' + filename + ' does not define RetroFlash and SWFReader');
  }
  return { RetroFlash, SWFReader };
}

async function build() {
  const sources = {};
  files.forEach((file) => { sources['src/' + file] = fs.readFileSync(path.join(root, 'src', file), 'utf8'); });
  const { RetroFlash, SWFReader } = load(Object.values(sources).join('\n'), 'sources');
  if (RetroFlash.version !== pkg.version) {
    throw new Error('build: package version ' + pkg.version + ' does not match RetroFlash.version ' + RetroFlash.version);
  }

  const header = '/*! RetroFlash.js ' + RetroFlash.version + ' (SWFReader ' + SWFReader.version + ') | MIT License | ' +
    'Copyright (c) 2026 ajsoriar | https://github.com/ajsoriar/RetroFlash.js */';
  const modernResult = await minify(sources, {
    compress: { passes: 2 },
    mangle: true,
    format: { preamble: header, comments: false },
    sourceMap: { filename: bundleName, url: bundleName + '.map', root: '../', includeSources: true }
  });
  load(modernResult.code, 'modern build intermediate');

  // Transpile the single distributed bundle to ES5 syntax for Chrome 38 and later.
  const transpiled = await babel.transformAsync(modernResult.code, {
    babelrc: false,
    configFile: false,
    sourceMaps: true,
    inputSourceMap: JSON.parse(modernResult.map),
    presets: [[require.resolve('@babel/preset-env'), { targets: { chrome: '38' }, modules: false }]]
  });
  // The ES2015+ library functions the player calls that Chrome 38 lacks (Babel does not add them).
  const browserPolyfills = fs.readFileSync(path.join(__dirname, 'browser-polyfills.js'), 'utf8').trim();
  const result = await minify({ [bundleName]: transpiled.code }, {
    compress: { passes: 2 },
    mangle: true,
    format: { preamble: header + '\n' + browserPolyfills, comments: false },
    sourceMap: {
      filename: bundleName,
      url: bundleName + '.map',
      root: '../',
      includeSources: true,
      content: transpiled.map
    }
  });
  load(result.code, bundleName);
  return {
    bundleName,
    code: result.code + '\n',
    map: result.map,
    sourceBytes: Object.values(sources).reduce((sum, s) => sum + Buffer.byteLength(s), 0)
  };
}

if (require.main === module) {
  build().then(({ bundleName, code, map, sourceBytes }) => {
    const dist = path.join(root, 'dist');
    fs.mkdirSync(dist, { recursive: true });
    // Keep only the current versioned browser bundle in the repository and package.
    fs.readdirSync(dist).filter((name) => /^retroflash(?:-[0-9][0-9A-Za-z.+-]*)?(?:\.legacy)?\.min\.js(?:\.map)?$/.test(name))
      .filter((name) => name !== bundleName && name !== bundleName + '.map')
      .forEach((name) => fs.unlinkSync(path.join(dist, name)));
    fs.writeFileSync(path.join(dist, bundleName), code);
    fs.writeFileSync(path.join(dist, bundleName + '.map'), map);
    const kb = (bytes) => (bytes / 1024).toFixed(1) + ' KiB';
    console.log('dist/' + bundleName + ': ' + files.length + ' scripts, ' + kb(sourceBytes) + ' -> ' + kb(Buffer.byteLength(code)) + ', ES5 syntax for Chrome 38 (+ source map)');
  }, (err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { build };
