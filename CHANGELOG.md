# Changelog

Notable changes by release. See [known limitations](./LIMITATIONS.md) for current compatibility gaps.

## Unreleased

- Added `dist/retroflash-<version>.legacy.min.js`, an ES5 bundle for older browsers such as Chrome 38, with the few ES2015 functions the player calls (`tools/legacy-polyfills.js`).
- Where a browser lacks them, the player now falls back from `fetch` to `XMLHttpRequest`, from `DecompressionStream` to a JavaScript zlib/DEFLATE decoder, from Pointer Events to mouse events, from `createImageBitmap` and `new ImageData` to an `<img>` element and `createImageData`, and from `DOMMatrix` and `Path2D.addPath` to mask paths built point by point.

## 1.0.0 — 2026-10-31

- First stable version.
- Added a minimal ActionScript 3 (AVM2) runtime: ABC parsing with checks before anything runs, document and `SymbolClass` timeline classes, `addFrameScript`, timeline control, button mouse events, `navigateToURL`, and `ExternalInterface.call` through the host page. Unsupported code is reported with its method and bytecode offset. See [known limitations](./LIMITATIONS.md).
- The reader decodes `SymbolClass`, `DefineSceneAndFrameLabelData`, and the `DoABC` header.
- The canvas that replaces legacy `<object>`/`<embed>` markup carries the SWF path from that markup in `data-original-source`.

## 1.0.0-beta.2 — 2026-10-31

- Added a minimal browser-only npm package and automated GitHub Release publishing with provenance.
- Updated release documentation and refreshed project badges.

## 1.0.0-beta.1 — 2026-10-28

- Added automatic playback for legacy `<object>` and `<embed>` elements, browser navigation and page communication, and CORS-aware external loading.
- Expanded AVM1 support with functions, objects, clip events, and common game APIs. SWF code is interpreted and is never evaluated as JavaScript.
- Added text fields, buttons, bitmap and morph rendering, and Web Audio playback.
- Added resource and execution limits, diagnostics, and a privacy-conscious interaction log.
- Published the versioned browser bundle and npm package metadata.

## 0.4.0 — 2026-10-27

- Added static text, editable text fields, font handling, and HTML text formatting.

## 0.3.0 — 2026-10-27

- Added interactive buttons, pointer and keyboard input, and hit testing.
- Improved limits and recovery for malformed or resource-intensive SWF files.

## 0.2.0 — 2026-10-27

- Added bitmap decoding and rendering, plus basic AVM1 timeline control.

## 0.1.0 — 2026-10-27

- Added the first Canvas player for vector shapes, display lists, and timelines.

## SWFReader 0.2.0 — 2026-10-27

- Added structured SWF tag decoding, sprite indexing, diagnostics, and configurable input limits.
