# RetroFlash.js

<p align="center">
  <img src="./assets/RetroFlashJS.svg" alt="RetroFlash.js" width="500" style="max-width:100%">
</p>

[![CI](https://github.com/ajsoriar/RetroFlash.js/actions/workflows/ci.yml/badge.svg)](https://github.com/ajsoriar/RetroFlash.js/actions/workflows/ci.yml)
[![MIT License](./assets/badges/license.svg)](./LICENSE)
![Version](./assets/badges/version.svg)
![Runtime dependencies](./assets/badges/dependencies.svg)
![Bundle size](./assets/badges/bundle.svg)

**RetroFlash.js 1.0.0 is the first stable release.** Review the [known limitations](./LIMITATIONS.md) for current SWF and ActionScript coverage.

**RetroFlash.js** is an open-source Flash SWF player and ActionScript runtime designed to bring classic Flash content back to life in modern web browsers. Built entirely with vanilla JavaScript and HTML5 Canvas, it aims to reproduce original Flash animations, interactive applications, and games without requiring plugins, WebAssembly, or external dependencies. Its primary goal is to provide a lightweight, self-contained, drop-in replacement for the original Flash Player, allowing existing SWF content to run with minimal or no changes to the original HTML markup.

## Why RetroFlash.js?

**A lightweight, dependency-free Flash SWF player and ActionScript runtime, built entirely in JavaScript and HTML5 Canvas.**

Bringing classic Flash animations and games back to modern browsers — without plugins, WebAssembly, or native dependencies.

RetroFlash.js is built around a simple idea: **preserve the original Flash experience with as little complexity as possible.**

- **100% Pure JavaScript** — No WebAssembly, native binaries, or browser plugins.
- **Zero Dependencies** — No external runtime libraries or frameworks.
- **Drop-in Replacement** — Just import the script. Keep your existing Flash `<object>` and `<embed>` elements.
- **Single-File Distribution** — One JavaScript file. No additional runtime assets.
- **HTML5 Canvas Rendering** — Native browser rendering without requiring WebGL.
- **No Build Tools Required** — No npm, bundlers, or compilation needed to use the player.
- **Legacy-Friendly** — Designed to preserve original HTML markup, FlashVars, dimensions, and playback parameters.
- **Self-Hosted & Offline-Ready** — No CDNs, cloud services, or external runtime connections.
- **Modular Architecture** — Separate SWF parser, rendering engine, audio decoders, and ActionScript runtime.
- **Developer-Friendly** — Readable, inspectable, and debuggable JavaScript.
- **Progressive Compatibility** — Incremental support for classic SWF features and ActionScript functionality.

### One script. No plugins. No WebAssembly.

**Just JavaScript bringing Flash back to life.**

*RetroFlash.js 1.0.0 is the first stable release. SWF and ActionScript support remains limited to the features documented here.*

## Non-Invasive Flash Recovery

RetroFlash.js restores legacy Flash content without asking developers to rewrite their original HTML, adopt a player-specific API, or modify their SWF files. Add the browser bundle to the page; RetroFlash.js detects legacy `<object>` and `<embed>` elements and plays them through Canvas.

An existing page can keep its Flash markup:

```html
<object
  data="game.swf"
  type="application/x-shockwave-flash"
  width="640"
  height="480">
  <param name="movie" value="game.swf">
  <param name="quality" value="high">
</object>
```

Add the bundle:

```html
<script src="node_modules/retroflash.js/dist/retroflash-1.0.0.min.js"></script>
```

Install the stable release from npm with `npm install retroflash.js`.

The browser bootstrap associates a Canvas player with each detected Flash element and carries over its dimensions and playback parameters. No manual changes to the legacy embed code or SWF files are required.

> **RetroFlash.js — Preserve the markup. Restore the experience.**

## What it supports

RetroFlash.js supports SWF graphics, text, sound, input, and controlled AVM1 and AVM2 subsets; see [docs/README.md](./docs/README.md) for details and [LIMITATIONS.md](./LIMITATIONS.md) for current gaps.

The code lives in [`src/`](./src/) as classic scripts with no dependencies:

| File | Role |
|---|---|
| `src/swf-reader.js` | Parser (`SWFReader`, v0.6.0): FWS and CWS, a bounds-checked tag index, decoded placements, shapes, bitmap headers, fonts and text, buttons, filter lists, clip actions, and exports, and `inflate` |
| `src/core/`, `src/display/`, `src/text/`, `src/avm1/`, `src/avm2/`, `src/audio/`, `src/input/`, `src/render/`, `src/browser/` | Player modules, including automatic playback of legacy Flash markup |
| `src/retroflash.js` | Player API (`RetroFlash`, v1.0.0) |
| `src/modules.json` | The load order of every script above |

For use, build the single file `dist/retroflash-1.0.0.min.js`, which holds the reader and the player (see [Build](#build)):

```html
<canvas id="stage"></canvas>
<input id="file" type="file" accept=".swf">
<script src="dist/retroflash-1.0.0.min.js"></script>
<script>
  const player = new RetroFlash.Player({ canvas: document.getElementById('stage') });
  document.getElementById('file').addEventListener('change', async (event) => {
    await player.load(event.target.files[0]);
    player.play();
  });
</script>
```

During development, the source scripts can be loaded directly instead, in the order of `src/modules.json`. The demos do this, so they open directly, with no server and no build:

- [`demo/player.html`](./demo/player.html): the player;
- [`demo/index.html`](./demo/index.html): the structure inspector.

See [`LIMITATIONS.md`](./LIMITATIONS.md) for current compatibility gaps.

## Requirements

- **Playback:** a browser with Canvas 2D. Web Audio is optional and is used when available. Browser security rules, including CORS, govern external SWF and resource loads.
- **Build and tests:** Node.js 16 or later. Building the bundles requires `npm install` for the development-only Terser and Babel dependencies; the player has no runtime dependencies.

## Tests

```sh
node tests/run.js
```

Requires Node 16 or later and installs nothing. `npm run test:dist` builds the bundle and runs the same tests against it. The fixtures are generated by the project itself, in [`tests/fixtures/`](./tests/fixtures/). What is verified, and how, is listed in [`tests/COMPATIBILITY.md`](./tests/COMPATIBILITY.md).

```sh
npm run corpus -- some.swf folder/   # compatibility matrix by layer (parser, vm, api, render, input)
node tools/corpus.js --versions      # version-dependent AVM1 rules, SWF 4 to 10
```

Run the corpus only on SWF files you are allowed to use, and never commit third-party files.

## Build

```sh
npm install      # once: installs build dependencies
npm run build
npm run test:dist
```

The build ([`tools/build.js`](./tools/build.js)) generates two versioned bundles from the scripts of `src/modules.json`: the regular minified bundle and an ES5-syntax legacy bundle targeting Chrome 38. Both include source maps, and the build checks that their version matches `RetroFlash.version`. Before anything is written, the sources and both bundles are loaded in isolated contexts. The legacy bundle starts with small polyfills ([`tools/legacy-polyfills.js`](./tools/legacy-polyfills.js): `Object.assign`, `Array.from`, `String.fromCodePoint`, typed-array `slice`). Both bundles fall back, where a browser API is missing, to `XMLHttpRequest` for `fetch`, a JavaScript zlib/DEFLATE decoder for `DecompressionStream`, mouse events for Pointer Events, an `<img>` element for `createImageBitmap`, and point-by-point mask paths for `DOMMatrix` and `Path2D.addPath`. `npm run test:dist` runs the tests on both bundles. The bundles have no runtime dependencies.

The tests and the demos do not need `npm install`.

## Changelog

See [`CHANGELOG.md`](./CHANGELOG.md).

## License

RetroFlash.js is released under the [MIT License](./LICENSE).

## AI-Assisted Development

This project was developed extensively using AI-assisted coding tools, including **ChatGPT, OpenAI Codex, Anthropic Claude, GitHub Copilot, OpenCode, and DeepSeek**, integrated into **Visual Studio Code**.

AI was primarily responsible for generating source code, implementation details, and documentation, under human direction and supervision.

<p align="center">
  <img src="./assets/badges/ai-assisted-chatgpt.svg" alt="AI assisted: ChatGPT" height="20">
  &nbsp;&nbsp;
  <img src="./assets/badges/ai-assisted-claude.svg" alt="AI assisted: Claude" height="20">
  &nbsp;&nbsp;
  <img src="./assets/badges/ai-assisted-codex.svg" alt="AI assisted: Codex" height="20">
  &nbsp;&nbsp;
  <img src="./assets/badges/ai-assisted-github-copilot.svg" alt="AI assisted: GitHub Copilot" height="20">
  &nbsp;&nbsp;
  <img src="./assets/badges/ai-assisted-opencode.svg" alt="AI assisted: OpenCode" height="20">
  &nbsp;&nbsp;
  <img src="./assets/badges/ai-assisted-deepseek.svg" alt="AI assisted: DeepSeek" height="20">
</p>
