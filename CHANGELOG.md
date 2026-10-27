# Changelog

## Unreleased

### Changed

- **The player source is split into modules.** `src/retroflash.js` is now only the public API. The rest is in `src/core/`, `src/display/`, `src/text/`, `src/avm1/`, `src/input/`, and `src/render/`, as classic scripts loaded in the order of `src/modules.json`. Behaviour and the public API do not change.
- `RetroFlash.internals` now exposes every module export.
- **Movie state is split in two.**
  - The display context (`createEnv`) keeps the dictionary, the limits, and the instance count.
  - A new `ActionScheduler` (`env.scripts`, in `src/avm1/interpreter.js`) owns the AVM1 queue, the parsed-action cache, and the budgets.
  - `runActionQueue(env)` is now `env.scripts.run()`.
  - The shared `quiet` flag is gone: a scrubbing seek and a button's hit area drop the scripts they queue (`mark()`/`dropSince()`).
  - The AVM1 modules now load before `display/`.
- `maxActionBlocks` counts every action block: two `DoAction` tags in one frame count as two. The old limit counted queue entries.
- The AVM1 budgets now cover a whole tick or input event, as documented. A tick that ran the queue twice (frame scripts, then the actions of a button that appeared under the pointer) used to get the budget twice. `env.scripts.beginUpdate()` opens a new budget.

- **AVM1 execution goes through the decoder.**
  - Each action block runs in its own `Activation`, which follows a program counter over the decoded code (`executeAVM1`). It replaces the walk over the action list in file order, which could not follow a branch.
  - `parseActions`, `actionString`, `actionUI16`, and `functionCodeSize` are replaced by `ActionCode`.
  - The executed subset is unchanged. Two malformed cases now end the script with `avm1:malformedAction`:
    - a `GotoFrame` whose operand is shorter than 2 bytes, which used to jump to an undefined frame;
    - a function definition whose body runs past the block, which used to skip silently to the end.

### Added

- **AVM1 decoder** (`ActionCode` in `src/avm1/decoder.js`), written against SWF19. It decodes action records and their operands without executing them.
  - **Operands:** `Push` values of every type, the constant pool, registers, function definitions (with their `DefineFunction2` flags), `With` and `Try` bodies, `GetURL`/`GetURL2`, `GotoFrame2`, and `WaitForFrame`/`WaitForFrame2`.
  - **Branches:** targets are measured from the next record and checked against the block.
  - **Decoding:** records are decoded on demand at any offset, so a branch inside another record works.
  - **Errors:** `TRUNCATED_RECORD`, `INVALID_OPERANDS`, `INVALID_BRANCH`, and `INVALID_RANGE`.
  - **Versions:** each record carries the SWF version that introduced its action.
  - **Tests:** `tests/unit/avm1-decoder.test.js`.
- **Configurable limits.** `maxNesting`, `maxInstances`, `maxActionBlocks`, and `maxActionSteps` are now Player options, like `maxBitmapPixels` and `maxTotalBitmapPixels`. Each limit must be a positive integer, or the player throws `INVALID_OPTION`; earlier, 0 meant the default. `RetroFlash.defaultLimits` holds the defaults, and `player.limits` the limits in force.
- **Build:** `npm run build` writes `dist/retroflash.min.js`, one minified file with the reader and the player, and its source map. It uses terser, the project's only development dependency (`npm install`). The tests and the demos still install nothing.
- `npm run test:dist` runs the test suite against the bundle. `tests/unit/build.test.js` checks the module manifest and the demo's script list.

## RetroFlash 0.4.0 + SWFReader 0.5.0 — 2026-10-27 (text)

### Added

- **Reader 0.5.0:**
  - `DefineFont`, `DefineFont2`, and `DefineFont3`: glyph outlines, codes, advances, layout, bounds, and kerning;
  - `DefineFontInfo` and `DefineFontInfo2`, and `DefineFontName`;
  - `DefineFontAlignZones` and `CSMTextSettings` (ids only);
  - `DefineText` and `DefineText2`, and `DefineEditText` (all flags and fields);
  - real-file variations are tolerated: a missing `CodeTableOffset` in fonts without glyphs, missing glyph bounds or kerning tables, and a NUL at the end of font names;
  - a `DefineText` without its end byte is accepted with a `TEXT_END_MISSING` warning;
  - `BitReader.readSI16` and `BitReader.seek`.
- **Static text:** `DefineText`/`DefineText2` are drawn with the font's glyph outlines (1024 or 20480 EM), the text matrix, record offsets and advances, and record colours under colour transforms. Static text also works as a mask.
- **Text fields** (`DefineEditText`):
  - fonts: embedded glyphs with `UseOutlines`; otherwise device fonts through Canvas, with `_sans`/`_serif`/`_typewriter` and generic fallbacks, and nothing downloaded;
  - layout: the 2 px gutter, word wrap, line metrics, leading, margins, indent, alignment (left, right, center, justify), and `AutoSize`;
  - an HTML subset: `<p align>`, `<br>`, `<font face size color>`, `<b>`, `<i>`, `<u>`, `<a>`, `<li>`, `<textformat>`, and entities. It is parsed in a single linear scan, so hostile markup cannot cause quadratic work, and tags longer than 4,096 characters are dropped;
  - drawing: border and background, password masking, and clipping to the field;
  - as in Flash Player, device-font fields are not drawn when rotated, skewed, or mirrored.
- **Reports:** `text:variable` (fields bound to variables show their initial text), `text:input` (no editing), `text:htmlImage`, `text:deviceFallback`, `text:missingGlyph`, `render:missingFont`, and `render:textMask`.
- **Hit testing:** text is hit by its bounds, inside button hit areas too.
- **Tests:** fixture `valid/fws-text.swf` (fonts drawn by the project) and `tests/unit/text.test.js`.

### Changed

- The demo ignores a load that a newer file has superseded.

### Fixed

- A load superseded while its bitmaps were decoding could still report bitmap failures into the newer movie's diagnostics. Its reports are now dropped once it is superseded.

## RetroFlash 0.3.0 + SWFReader 0.4.0 — 2026-10-27 (buttons)

### Added

- **Buttons** (`DefineButton`, `DefineButton2`).
  - States: up/over/down children, persistent across state changes, with animated sprites inside.
  - A hit area that is never drawn.
  - Colour transforms from `DefineButtonCxform`.
- **Input:**
  - pointer events become roll over/out, press, release, drag out/in, and release outside, with their condition actions;
  - `KeyPress` conditions from the keyboard;
  - the hand cursor;
  - button actions run in the parent timeline's context through the AVM1 subset;
  - new option `input`.
- **Hit testing:** points are tested against fills (even-odd/non-zero), curves, and strokes. `RetroFlash.internals.pointInShape` and `pickButton` are exposed.
- **Reader 0.4.0:**
  - decodes `DefineButton`, `DefineButton2`, `DefineButtonCxform`, and `DefineButtonSound`;
  - validates and skips filter lists by size;
  - adds `codeTags.buttonActions`.
- Fixture `valid/fws-buttons.swf` and `tests/unit/buttons.test.js`.

### Changed

- `PlaceObject3` filter lists are now decoded (as filter names) instead of leaving the placement partial. Blend mode and the later fields are therefore read too.
- `valid/fws-unsupported.swf` now carries a valid blur filter list.
- `.gitattributes` marks `*.swf`, `*.jpg`, and `*.png` as binary.

### Fixed (pre-commit review)

- **Hostile files:** sprites and buttons that contain themselves, even several times per level (exponential growth), no longer overflow the stack or exhaust memory.
  - Recursion is refused (`render:recursiveCharacter`).
  - Nesting is bounded through buttons as well (`render:nestingLimit`).
  - At most 100,000 instances are created per step (`render:instanceLimit`).
  - A runtime error while building the movie now sets the state to `error` and emits `error`, instead of leaving the player in `loading`.
- **Input:**
  - Pressing outside every button and releasing over one now gives that button its roll over.
  - Removed buttons are checked after frames, scripts, and seeks, no longer on every pointer move.
- **Hit areas:** sprites inside a hit area no longer run frame scripts.
- **`play()`** on a finished non-looping movie restarts it like `stop()`, so frame-1 scripts run again.
- **Reader:**
  - An unreadable `PlaceObject3` filter list keeps the placement, which becomes `partial` with `unparsed: ['filterList']`.
  - `DefineButton2` finds its actions through `ActionOffset`; a gap after the records is skipped and reported as `BUTTON_ACTION_OFFSET_GAP`.
  - `SWFReader.inflate(bytes, max, { truncate: true })` keeps the first `max` bytes. Bitmaps use it, so extra zlib output no longer drops the bitmap.
- **Undecodable definitions** (shapes, bitmaps, buttons) still define their id, so placements report them as `(invalid)` instead of missing.
- **Bitmap memory:**
  - The size of a JPEG, PNG, or GIF is read from its header (JPEG `SOFn`, PNG `IHDR`, GIF logical screen) and checked against `maxBitmapPixels` **before** the browser decodes it. Images without a readable size are refused (`BITMAP_FORMAT`). A decoded image larger than its header declared is discarded.
  - New option `maxTotalBitmapPixels` (default 4 × 4096 × 4096): one pixel budget for all bitmaps of a movie, taken in character id order. Bitmaps past it are reported (`BITMAP_BUDGET`) and not drawn.
  - At most 4 bitmaps decode at a time.
  - Decoded bitmaps are released (`ImageBitmap.close`) when a movie is replaced or the player is destroyed.
- **Overlapping loads:** only the latest `load()` wins. A load superseded by another `load()` or by `destroy()` resolves to `null` and changes nothing, even if it fails (before, an older load finishing last replaced the newer movie, and a failed load after `destroy()` set the state back to `error`).
- `tests/unit/robustness.test.js` covers these cases, and also pins that the body of `DefineFunction`/`DefineFunction2` follows the action record (its `Length` does not include it), so the next action runs.

## RetroFlash 0.2.0 — 2026-10-27 (bitmaps + AVM1 timeline control)

### Added

- **Bitmaps:**
  - `DefineBits` + `JPEGTables`, `DefineBitsJPEG2/3/4`, and `DefineBitsLossless/Lossless2` are decoded during `load`.
  - JPEG, PNG, and GIF use the browser decoder. The JPEG3/4 alpha plane and lossless formats 3, 4, and 5 are decoded in JavaScript, with premultiplied data converted.
  - Erroneous `FF D9 FF D8` JPEG headers are removed.
  - Bitmap fills are drawn clipped or repeating, smoothed or not, and with the alpha multiplier of colour transforms. Bitmaps placed directly are drawn too.
  - New option `maxBitmapPixels`.
- **AVM1 timeline-control subset**, a controlled interpreter that never evaluates JavaScript or navigates:
  - frame scripts run after each tick;
  - executed: `Stop`, `Play`, `NextFrame`, `PreviousFrame`, `GotoFrame`, `GotoLabel`, `SetTarget` (slash and dot paths), and `WaitForFrame`;
  - `GetURL` is ignored and reported;
  - function bodies are skipped;
  - control flow and calls end the script and are reported;
  - per-frame budgets apply;
  - new option `actions`, and `getInfo().rootPlaying`.
- Fixtures `valid/fws-bitmaps.swf` and `valid/fws-actions.swf`, plus the asset `fixtures/assets/gradient-32.jpg`.
- `tests/unit/bitmaps-avm1.test.js`.
- Reader 0.3.0:
  - bitmap header decoding;
  - `SWFReader.inflate`;
  - `BitReader.skipRemaining`.

### Changed

- `stop()` now rewinds the whole movie, so frame-1 scripts run again.
- `seek()` does not run frame scripts.
- Bitmap and JPEGTables tags now have status `decoded`.
- The fixture writer embeds zlib data with stored blocks, so fixtures stay byte-identical across zlib versions.

## RetroFlash 0.1.0 + SWFReader 0.3.0 — 2026-10-27 (milestone 1: vector playback)

### Added

- `src/retroflash.js` with `RetroFlash.Player`:
  - `load`, `play`, `pause`, `stop`, `step`, `seek` (by frame number or label), `getInfo`, `getDiagnostics`, `on`/`off`, and `destroy`;
  - the states and events described in `src/README.md`.
- Character dictionary, a display list per timeline, root and `DefineSprite` timelines that run independently (also nested), and rewind that keeps matching instances.
- Canvas 2D rendering of `DefineShape` 1–4:
  - edges linked into contours per fill style;
  - solid fills, and linear, radial, and focal gradients;
  - line styles, including `LINESTYLE2` caps and joins;
  - exact colour transforms on vector colours.
- `clipDepth` masks, including masks made of sprites.
- Not drawn yet, and reported in `getDiagnostics().unsupported`: bitmap fills, gradient spread modes, blend modes, and placed characters such as bitmaps, text, and buttons.
- The reader decodes `DefineShape`/`DefineShape2`/`DefineShape3`/`DefineShape4`: fill and line style arrays, gradients, and shape records. `BitReader.readFixed8` is new.
- `demo/player.html`, plus the inspector now links to it.
- Fixture `valid/fws-animation.swf`, generated by `tests/fixtures/animation.js`.
- `tests/unit/player.test.js`, covering geometry, the dictionary, the display list, and timelines.

### Changed

- `DefineShape*` tags now have status `decoded` instead of `indexed`, and no longer appear in `movie.unsupported`.

## SWFReader 0.2.0 — 2026-10-27

The public API `SWFReader.load(input)` and the v0.1 result fields are preserved.

### Project layout

The reader moved from `swf-reader-phase1/` to `src/swf-reader.js`, and its demo to `demo/index.html`. Tests are in `tests/`. Pages that load the reader must use the new path.

### Added

- Bounds-checked, MSB-first bit reader `SWFReader.BitReader`: UB/SB/FB with widths 0–32, aligned integer reads, and strings that depend on the SWF version. It also reads RECT, MATRIX, CXFORM, and CXFORMWITHALPHA.
- Recursive indexing of `DefineSprite` control tags, with sprite-local frames, `path` and `level` on every tag, `walkTags()`, and `totalTagCount`/`spriteCount`.
- Decoded tag bodies (`tag.fields`) for `PlaceObject`, `PlaceObject2`, `PlaceObject3` (partial), `RemoveObject`, `RemoveObject2`, `FrameLabel`, `SetBackgroundColor`, `FileAttributes`, and `DefineSprite`.
- `tag.status` on every tag.
- `movie.diagnostics` (structured) and `movie.unsupported` (with counts and reasons). `movie.warnings` is now generated from the diagnostics.
- Options `maxFileBytes`, `maxTags`, `maxSpriteDepth`, and `strict`.
- Error codes: `SWFReaderError` errors carry `err.code`.
- Tests: `node tests/run.js`, using generated fixtures and `tests/COMPATIBILITY.md`. `tests/inspect.js` is a command-line inspector.

### Changed

- Validation:
  - a negative SI32 long tag length is rejected;
  - a tag that is longer than its enclosing sprite is reported;
  - the minimum declared length is now 13 bytes;
  - a declared length above `maxFileBytes` is rejected before decompression;
  - decompression stops once the output exceeds the declared length.
- Bytes after the declared length of an FWS file now produce a warning instead of an error.
- A malformed tag body is now recorded as a diagnostic instead of being ignored silently. Use `strict` to reject such files instead.
- CWS decompression no longer depends on `Blob`/`Response`.
- Error messages are now in English, matching the demo and the documentation.
- The demo now shows diagnostics, unsupported features, the tag tree with sprite contents, and the decoded fields.
