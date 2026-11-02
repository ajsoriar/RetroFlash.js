# Changelog

Notable changes by release. See [known limitations](./LIMITATIONS.md) for current compatibility gaps.

## 1.1.0 — 2026-11-02

- Legacy `<object>`/`<embed>` markup also plays on `file://` pages, where the browser lets the page read local files (TV and packaged app platforms such as webOS). The browser host reads `file:` URLs with `XMLHttpRequest`, accepts the status 0 of a local read, treats a local SWF on a local page as the same domain for `allowScriptAccess`, and reports a refused local read as `load:file`.
- Stage scale modes, as in Flash Player. Legacy markup keeps the size of its element (pixels or percent) instead of taking the stage's, and fits the movie into it by its `scale` and `salign` parameters (`showAll` by default); `window.RetroFlashConfig` can set `scaleMode`, `align` and `pixelRatio`. The Player options `scaleMode`, `align`, `width` and `height`, and `setScaleMode()`, `setSize()` and `getLayout()`, do the same for a player created by hand; without `scaleMode` the canvas still takes the size of the stage. The canvas follows window resizes, its pixels follow its displayed size times `pixelRatio`, and the pointer is read through the stage's place in the canvas.
- `RetroFlash.getInstances()`, `RetroFlash.getInstance(key)` and `RetroFlash.getEnvironment()` list the players of the page and describe the browser, for the console and tooling. Each player has an `id`.

## 1.0.1 — 2026-10-31

- The browser bundle uses ES5 syntax and compatibility fallbacks to target Chrome 38 and later.
- Where APIs are unavailable, the player falls back from `fetch` to `XMLHttpRequest`, from `DecompressionStream` to a JavaScript zlib/DEFLATE decoder, from Pointer Events to mouse events, from `createImageBitmap` and `new ImageData` to image and canvas decoding, and from `DOMMatrix` and `Path2D.addPath` to mask paths built point by point.

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
