# Changelog

Notable changes by release. See [known limitations](./LIMITATIONS.md) for current compatibility gaps.

## 1.1.2 — 2026-11-03

- Legacy `<object>`/`<embed>` markup logs the page's calls to the movie's ExternalInterface callbacks (`[RetroFlash.js] ExternalInterface callback <name>`), with `missing`, `refused` or `failed` when the call did not run, as it already logged the movie's calls to the page.

## 1.1.1 — 2026-11-03

- JavaScript ↔ ActionScript page scripting, as with the Flash Player plugin, for unchanged SWF files and pages. The full matrix, security model and limits are in [docs/interop/STATUS.md](./docs/interop/STATUS.md).
  - The canvas that replaces an `<object>`/`<embed>` gets the plugin's methods: `SetVariable`, `GetVariable` (and `$version`), `Play`, `StopPlay`, `IsPlaying`, `Rewind`, `Back`, `Forward`, `GotoFrame`, `CurrentFrame`, `TotalFrames`, `FrameLoaded`, `PercentLoaded`, `FlashVersion`, the `T*` target methods, `LoadMovie`, `Zoom`, `Pan`, `SetZoomRect`, `CallFunction` and `SetReturnValue`. It also takes the names of both an `<object>` and its inner `<embed>` in `document`. `RetroFlash.attachLegacyInterface(element, player)` and `RetroFlash.createPluginAPI(player)` do the same for players created by hand; destroying the player removes everything they added.
  - ActionScript 3: `ExternalInterface.addCallback`, `marshallExceptions`, plain objects both ways, `flash.system.fscommand`, `Security.allowDomain` (accepted, grants nothing) and `loaderInfo.parameters` (FlashVars).
  - ActionScript 2: `ExternalInterface` has only its documented members; `objectID` and `marshallExceptions` (ActionScript 3 members) now read as `undefined`.
  - The plugin's ExternalInterface XML (`<invoke>`, `<string>`, `<array>`, …) is read by a bounded parser of the player's own (`RetroFlash.flashXML`).
  - FSCommand: `player.addFSCommandHandler()` and the `onFSCommand` option run before the page's `<id>_DoFSCommand`; `<id>_FSCommand` is called when `_DoFSCommand` is missing; FSCommand requests carry `projector` for projector commands, and the `projectorCommands` option acts on `allowscale`, `fullscreen` and `quit`. `exec` is reported and never runs anything.
  - `createBrowserHost` options `trust`, `allowedFunctions`, `allowFSCommand`, `scriptUrls` (`known-calls`, `off`, `trusted-eval`) and `executeScript`, also read from `window.RetroFlashConfig` with `flashVars`, `flashVersion`, `projectorCommands` and `onFSCommand`.
  - Calls between the page and the movie may nest up to the Player option `maxBridgeDepth` (32); page values are read without calling getters and are bounded in size and depth.
  - Player: `runExternal()`, `setViewRect()`/`getViewRect()`, `getPluginAPI()`, the `destroy` event, and `load()` FlashVars as an array of pairs.
- `demo/interop/` plays a Flash-era page that scripts its movie, unchanged.

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
