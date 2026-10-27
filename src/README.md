# SWF Reader (v0.5)

A dependency-free JavaScript reader for SWF file structure. It is a single classic script, `swf-reader.js`, that works on its own, and it is the foundation of the player documented below. The reader does not render anything and **never executes ActionScript**.

## Usage

Open [`../demo/index.html`](../demo/index.html) in a modern browser. No server or external libraries are required. Test files are in [`../tests/fixtures/`](../tests/fixtures/), and their expected results are in [`../tests/COMPATIBILITY.md`](../tests/COMPATIBILITY.md).

```html
<script src="swf-reader.js"></script>
<input type="file" id="swf" accept=".swf">
<script>
  document.querySelector('#swf').addEventListener('change', async (event) => {
    const movie = await SWFReader.load(event.target.files[0]);           // options are optional
    console.log(movie.width, movie.height, movie.fps, movie.tags);
    console.log(movie.getTagData(0));    // Uint8Array with the first tag's body
    console.log(movie.diagnostics);      // [{ level, code, message, path?, offset? }]
    console.log(movie.unsupported);      // [{ feature, count, reason, firstPath, firstOffset }]
    movie.walkTags((tag, parent) => {}); // every tag, including DefineSprite children
  });
</script>
```

`SWFReader.load(input, options)` accepts a `File`, `Blob`, `ArrayBuffer`, `Uint8Array`, or any other `ArrayBufferView`.

| Option | Default | Meaning |
|---|---|---|
| `maxFileBytes` | 50 MiB | Maximum declared (uncompressed) SWF length; a `Blob` is also checked before it is read |
| `maxTags` | 500 000 | Maximum number of tags indexed, nested ones included |
| `maxSpriteDepth` | 4 | `DefineSprite` nesting levels whose contents are indexed |
| `strict` | `false` | Reject the file instead of recording a diagnostic when a tag body is malformed |

### Errors and diagnostics

- **Fatal problems reject the promise with an `Error`.** Its `name` is `'SWFReaderError'`, it has a stable `code`, and its message starts with `SWFReader: `. Fatal problems include a bad signature, a truncated file, header, or tag record, a tag that extends past the file, zlib failures, length mismatches, ZWS files, and exceeded limits. `tests/COMPATIBILITY.md` lists each code.
- **Problems confined to one tag are recorded in `movie.diagnostics`** and the rest of the file is still indexed. Examples: a malformed tag body, a malformed sprite, or a tag that is not allowed inside a sprite. The tag gets status `invalid`.
- **`movie.warnings`** keeps the v0.1 format: an array of strings, now generated from the diagnostics.

### Tag objects

Each tag has these fields: `index`, `path` (for example `"3/2"` is child 2 of top-level tag 3), `level`, `code`, `name`, `offset`, `dataOffset`, `length`, `headerLength`, `longHeader`, `frame`, `status`, and `fields` when the body is decoded.

`status` is one of:

| Status | Meaning |
|---|---|
| `decoded` | The body was decoded into `fields` |
| `partial` | Some fields are decoded; the rest are named in `unparsed` |
| `indexed` | Only the record boundaries are known |
| `unknown` | The tag code is not in `SWFReader.tagNames` |
| `not-executed` | ActionScript bytecode was detected and left alone |
| `invalid` | The body does not match its declared layout |

Sprite tags also have `children`, `frames`, `actualFrameCount`, and `endFound`.

Values follow the SWF specification:

- coordinates and translations are in twips (1/20 px);
- MATRIX scale and rotate/skew terms are numbers (16.16 fixed point);
- CXFORM multiply terms are raw 8.8 integers (256 = 1.0); add terms are raw integers.

`SWFReader.BitReader` exposes the bounds-checked, MSB-first bit reader: `readUB`, `readSB`, `readFB`, `align`, `seek`, `readUI8`, `readUI16`, `readSI16`, `readUI32`, `readString`, `readRect`, `readMatrix`, `readCxform`, and `readCxformWithAlpha`.

## Coverage in v0.5

- FWS. CWS (zlib) through `DecompressionStream('deflate')`; decompression stops as soon as the output exceeds the declared length.
- Header: signature, version, declared length, stage RECT, frame rate (8.8), and frame count.
- Tag record headers in short and long form, validated against the enclosing range (the file or the sprite). A negative long length is rejected.
- Recursive index of `DefineSprite` control tags with sprite-local frames, and a check of which tags are allowed inside sprites.
- Decoded tags: `End`, `ShowFrame`, `SetBackgroundColor`, `FrameLabel` (with the named anchor from SWF 6), `FileAttributes`, `PlaceObject`, `PlaceObject2`, `PlaceObject3` (all fields except clip actions; the filter list is validated and kept as filter names), `RemoveObject`, `RemoveObject2`, and `DefineSprite`.
- `DefineShape`, `DefineShape2`, `DefineShape3`, and `DefineShape4` are decoded (since v0.3). `fields` contains:
  - `shapeId`, `shapeVersion`, `bounds`;
  - `fillStyles`: `solid`, `linear`, `radial`, `focal`, or `bitmap`, with gradient matrices and stops;
  - `lineStyles`: `LINESTYLE`, or `LINESTYLE2` with caps, joins, and fill;
  - `records`: style changes with absolute `moveTo` and new style arrays, plus `line`/`curve` edges as deltas in twips;
  - for `DefineShape4` only: `edgeBounds` and the fill-winding and scaling-stroke flags.

  Colours are always `{r, g, b, a}`.
- Bitmap headers are decoded (since v0.3, with `tests/fixtures/valid/fws-bitmaps.swf`). Pixel data stays in the tag body, and the offsets below are relative to `getTagData(tag)`.
  - `DefineBits`, `DefineBitsJPEG2`, `DefineBitsJPEG3`, and `DefineBitsJPEG4` give `characterId`, `imageStart`, `imageEnd`, and `imageFormat` (`jpeg`, `png`, `gif`, or `unknown`, sniffed). JPEG3/4 also give `alphaStart` when an alpha plane is present, and JPEG4 gives `deblockParam`.
  - `DefineBitsLossless` and `DefineBitsLossless2` give `characterId`, `losslessVersion`, `bitmapFormat` (3, 4, or 5), `width`, `height`, `colorTableSize`, and `dataStart`.
  - `JPEGTables` is marked as decoded; its body is the shared tables.
- `SWFReader.inflate(bytes, maxLength[, { truncate }])` decompresses zlib data. It stops as soon as the output would exceed `maxLength`. With `truncate`, it returns the first `maxLength` bytes instead of failing. It uses `DecompressionStream` and fails with the codes `INFLATE_UNSUPPORTED`, `INFLATE_TOO_LARGE`, or `INFLATE_FAILED`.
- Buttons (since v0.4, with `tests/fixtures/valid/fws-buttons.swf`):
  - `DefineButton` and `DefineButton2` give `buttonId`, `buttonVersion`, `trackAsMenu`, and `records`. Each record has its `up`/`over`/`down`/`hitTest` flags, `characterId`, `depth`, `matrix`, and, in v2, `colorTransform`, `filters`, and `blendMode`.
  - They also give `actions`: `{ conditions, start, end }` relative to `getTagData(tag)`. `conditions` uses the BUTTONCONDACTION bits read as a little-endian UI16, with the key code in bits 9–15. A `DefineButton` has one list, run on release (`conditions` 8). `DefineButton2.ActionOffset` locates the actions. A gap after the records is skipped and reported as `BUTTON_ACTION_OFFSET_GAP`; an offset inside the records or past the tag makes the tag invalid.
  - `DefineButtonCxform` gives `buttonId` and every `CXFORM` it holds. `DefineButtonSound` gives `buttonId` only.
  - `movie.codeTags.buttonActions` counts the action lists.
- Fonts and text (since v0.5, with `tests/fixtures/valid/fws-text.swf`):
  - `DefineFont2` and `DefineFont3` give:
    - `fontId`, `fontVersion`, `name` (a trailing NUL is dropped), `bold`, `italic`, `smallText`, `ansi`, `shiftJIS`, `language`, and `hasLayout`;
    - `glyphs`: `{ records, code, advance[, bounds] }`, where `records` are SHAPERECORDs as in `DefineShape` and fill style 1 is the text colour. Coordinates are on a 1024-unit EM square, or 20480 in `DefineFont3`;
    - with a layout: `ascent`, `descent`, `leading`, and `kerning` (`{ left, right, adjustment }`).

    Tool variations are tolerated: a font without glyphs may omit `CodeTableOffset`, and the glyph bounds and kerning table may be missing at the end of the tag. Glyph offsets outside the tag fail with `INVALID_OFFSET`.
  - `DefineFont` gives `fontId` and `glyphs` (their codes are `null`). `DefineFontInfo` and `DefineFontInfo2` give its `name`, style flags, and `codes`.
  - `DefineFontName` gives `fontId`, `name`, and `copyright`. `DefineFontAlignZones` and `CSMTextSettings` keep only their ids and mode bits; their bodies only tune anti-aliasing.
  - `DefineText` and `DefineText2` give `characterId`, `bounds`, `matrix`, and `records`.
    - Each record has the fields it sets: `fontId` with `height`, `color`, `x`, and `y`. Its `glyphs` are `{ index, advance }`.
    - A list without its end byte is accepted with a `TEXT_END_MISSING` warning.
  - `DefineEditText` gives:
    - `characterId`, `bounds`, and the flags `wordWrap`, `multiline`, `password`, `readOnly`, `autoSize`, `noSelect`, `border`, `wasStatic`, `html`, `useOutlines`;
    - when present: `fontId`, `fontClass`, `fontHeight` (also read when only `HasFontClass` is set), `color`, `maxLength`, and the layout (`align`, `leftMargin`, `rightMargin`, `indent`, and `leading`, which are signed);
    - `variableName` and `initialText`.
- Filter lists (in `PlaceObject3` and button records) are validated by filter type and size, then skipped. An unreadable list in `PlaceObject3` leaves the placement `partial` with `unparsed: ['filterList']`, instead of invalid. The sizes follow SWF19. Only the filter names are kept.
- Strings: UTF-8 from SWF 6; Latin-1 before SWF 6.
- `DoAction`, `DoInitAction`, and `DoABC` are counted in `movie.codeTags` and listed as unsupported, because the reader does not interpret them. Their bytes are available through `getTagData`. The player runs a timeline-control subset of `DoAction` (see below).

## Limitations

- The reader itself does not render. Playback is handled by `retroflash.js` (see below).
- Sounds, video, morph shapes, and `DefineFont4` are indexed but not decoded. Bitmap pixels are decoded by the player.
- Not parsed yet: `PlaceObject2`/`PlaceObject3` clip actions. Filter parameters are skipped, not decoded.
- `ZWS` (LZMA) is rejected. `CWS` needs native `DecompressionStream`; there is no JavaScript inflate fallback yet, so CWS fails with `CWS_UNSUPPORTED` in older browsers.
- Strings in files older than SWF 6 used the author's locale encoding, which the file does not record; they are decoded as Latin-1.
- `End` and any tag after the last `ShowFrame` report `frame = actualFrameCount + 1`, as in v0.1.
- The reader checks bounds and limits, and the tests include controlled fuzzing. It has not had an independent security review, so treat hostile files with care.

## Tests

From the project root, run `node tests/run.js` (Node 16+, no dependencies). See [`../tests/COMPATIBILITY.md`](../tests/COMPATIBILITY.md).

# RetroFlash.Player (`retroflash.js` v0.4)

Load `../dist/retroflash.min.js` (built by `npm run build`), which holds the reader and the player. Alternatively, load the source scripts in the order of [`modules.json`](./modules.json), as the demo [`../demo/player.html`](../demo/player.html) does.

```js
const player = new RetroFlash.Player({
  canvas, autoplay: false, loop: true,
  maxFileBytes: 50 * 1024 * 1024,   // passed to SWFReader.load
  actions: true,                    // run the AVM1 timeline-control subset
  input: true,                      // pointer and keyboard on the canvas drive the movie's buttons
  maxActionSteps: 100000            // any of the limits below
});
await player.load(fileOrBuffer);     // same inputs as SWFReader.load; decodes bitmaps; resolves with getInfo(),
                                     // or null when a later load() or destroy() superseded it
player.play(); player.pause(); player.stop(); player.step();
player.seek(10); player.seek('label');
player.getInfo();         // { state, version, width, height, fps, frameCount, currentFrame, rootPlaying, labels, ... }
player.getDiagnostics();  // { diagnostics (reader), unsupported (reader + player) }
player.on('load' | 'frame' | 'warning' | 'error' | 'end', fn); player.off(type, fn);
player.destroy();
player.limits;            // the limits in force, frozen
```

### Limits

Budgets against hostile or runaway files. Each limit is a Player option with the same name. Its value must be a positive integer, or the player throws a `RetroFlashError` with code `INVALID_OPTION`; `undefined` or `null` keeps the default. `RetroFlash.defaultLimits` holds the defaults.

| Option | Default | Bounds | Reported as |
|---|---|---|---|
| `maxNesting` | 32 | Levels of nested sprite and button instances | `render:nestingLimit` |
| `maxInstances` | 100,000 | Sprite and button instances created in one step: a tick, a seek, or an input event | `render:instanceLimit` |
| `maxBitmapPixels` | 4096 × 4096 | Pixels of one bitmap | `render:bitmapDecodeFailed` (`BITMAP_TOO_LARGE`) |
| `maxTotalBitmapPixels` | 4 × 4096 × 4096 | Pixels of all bitmaps of a movie together | `render:bitmapDecodeFailed` (`BITMAP_BUDGET`) |
| `maxActionBlocks` | 10,000 | AVM1 action blocks (each `DoAction` or button action list) run in one tick or input event; the rest are dropped | `avm1:budget` |
| `maxActionSteps` | 100,000 | AVM1 actions executed in one tick or input event; the current block stops | `avm1:budget` |
| `maxActionStack` | 100,000 | Values on the stack of one AVM1 action block; the block stops | `avm1:budget` |

### Source layout

Each player module is a classic script. It takes what it needs from the internal namespace `RetroFlashModules`, which `core/base.js` creates, and adds its own exports there. `retroflash.js` comes last: it builds the public `RetroFlash` object and removes the namespace from the global object. Every export is also available as `RetroFlash.internals`, for tests and tooling; that is not a stable API.

| Script | Contents |
|---|---|
| `swf-reader.js` | The reader (`SWFReader`) |
| `core/base.js` | The module namespace, the version, limits, and player errors |
| `core/math.js` | Matrices and colour transforms |
| `render/geometry.js` | Shape records to fill and stroke commands, shared by the renderer and hit testing |
| `display/bitmaps.js` | Bitmap decoding and pixel budgets |
| `text/fonts.js`, `text/html.js`, `text/layout.js` | Fonts and static text, the HTML subset, and text field layout |
| `avm1/decoder.js`, `avm1/interpreter.js` | AVM1 decoding (`ActionCode`), and `ActionScheduler` with one `Activation` per block, which runs the timeline-control subset |
| `display/movie.js` | The character dictionary and frame lists |
| `display/clip.js`, `display/button.js` | The display context (`createEnv`), timelines and display lists, and button instances |
| `input/hit-test.js`, `input/input.js` | Hit testing, and pointer and keyboard input |
| `render/canvas-renderer.js` | The Canvas 2D renderer |
| `retroflash.js` | `RetroFlash.Player`, the public API |

A module uses only modules listed before it in `modules.json`. The one exception is `display/clip.js`, which reads `ButtonInstance` from the namespace when it creates a button, because buttons are built on clips.

The state of one movie is split in two:

- The **display context** (`createEnv`) is shared by every timeline. It holds the dictionary, the report function, the limits, and the per-step instance count.
- The **`ActionScheduler`** (`env.scripts`) queues and runs AVM1 action blocks. It holds the queue, the parsed-action cache, and the budgets. The player opens a new budget for each tick and input event (`scripts.beginUpdate()`), and every `run()` in that update shares it. It drives timelines only through `Clip` methods, so AVM1 does not depend on the display list's internals.

A scrubbing `seek` and the creation of a button's hit area enter frames without running their scripts: the scripts they queue are dropped, with `scripts.mark()` and `scripts.dropSince(mark)`.

### Behaviour

- **States:** `idle`, `loading`, `ready`, `playing`, `paused`, `error`, `destroyed`. Player errors have `name` `'RetroFlashError'` and a `code`; load errors are the reader's `SWFReaderError`.
- **Canvas:** the canvas is resized to the stage size × `devicePixelRatio`. Its CSS width is set to the stage width with `height: auto`.
- **Timing:** `requestAnimationFrame` with a time accumulator at the SWF frame rate. When the page falls behind, at most `maxCatchUpFrames` (default 4) frames are advanced per animation frame and the rest are dropped. A rate of 0 fps plays at 12 fps and is reported.
- **Ticks:**
  - Each tick advances the sprite instances that already exist, then moves the root to its next frame.
  - Sprites placed in that frame start at their own frame 1.
  - A timeline stopped by script stays where it is, but its children keep playing.
  - The root loops by default and emits `end` each time it passes its last frame; with `loop: false` it stops there.
  - Frame scripts run after the tick, in the order their frames were entered (see AVM1 below).
- **`seek`:** a scrubbing jump that does **not** run frame scripts. Seeking backwards rebuilds the display list from frame 1. Instances whose depth still holds the same character are kept, so they keep their own playhead.
- **`stop`:** rewinds the whole movie. Every timeline restarts at frame 1 and the frame-1 scripts run again; the player stays paused.
- **Bitmaps:** all bitmaps are decoded during `load`.
  - JPEG, PNG, and GIF go through the browser decoder (`createImageBitmap`). Every `FF D9 FF D8` sequence is removed from JPEG data, and `DefineBits` is joined with `JPEGTables`.
  - The JPEG3/4 alpha plane is applied in JavaScript, treating the colour data as premultiplied, as Flash stores it.
  - Lossless formats 3, 4, and 5 are decoded in JavaScript. Lossless2 data is premultiplied and is converted for Canvas.
  - Bitmap fills are clipped or repeating, smoothed or not, as the fill type says. A bitmap placed directly is drawn at 20 twips per pixel.
  - A bitmap that cannot be decoded is reported and not drawn.
  - **Memory limits:** pixels are reserved before decoding. Lossless bitmaps use the tag's width and height. JPEG, PNG, and GIF use the size in the image header (JPEG `SOFn`, PNG `IHDR`, GIF logical screen); an image without a readable size is refused, and a decoded image larger than its header declared is discarded. Each bitmap is limited by `maxBitmapPixels`, and all bitmaps of a movie together by `maxTotalBitmapPixels`, in character id order. A refused bitmap is reported (`render:bitmapDecodeFailed`, with `BITMAP_TOO_LARGE`, `BITMAP_BUDGET`, or `BITMAP_FORMAT`) and not drawn.
  - Bitmap memory is released when the movie is replaced by another `load()` or the player is destroyed.
- **Overlapping loads:** only the latest `load()` takes effect. An earlier call that is still running, or one interrupted by `destroy()`, resolves to `null` without changing the player or emitting events, even if it fails. Diagnostics it would produce after that point, such as bitmap decoding failures, are dropped.
- **Shapes:**
  - Edges are grouped by fill style, with FillStyle0 edges reversed, and linked into closed contours.
  - Fills use the even-odd rule, or non-zero when `DefineShape4` sets the winding flag.
  - Gradients use the SWF ±16384-twip gradient square, transformed by the gradient matrix.
  - Colour transforms are applied exactly to vector colours.
  - Strokes are at least one device pixel wide. `DefineShape4` caps and joins are honoured.
- **Masks:** `clipDepth` masks use the union of the mask's fills, including sprite masks and static text glyphs, as a Canvas clip.
- **Static text** (`DefineText`, `DefineText2`): glyph outlines from `DefineFont`/`DefineFont2`/`DefineFont3` are filled (even-odd) in their record's colour, which colour transforms modify. Each glyph is scaled by height / EM (1024, or 20480 for `DefineFont3`) and placed by the text matrix, the record offsets, and the advances. Font, height, colour, and position carry over between records.
- **Text fields** (`DefineEditText`):
  - **Fonts:**
    - With `UseOutlines`, glyphs come from an embedded font with the face's name (same style first). Advances come from the font layout; kerning is not applied.
    - Otherwise, or when no embedded font has glyphs, a device font is drawn with Canvas `fillText`. `_sans`, `_serif`, and `_typewriter` map to the generic CSS families. Other names are tried as installed fonts, with a generic fallback (serif for Times New Roman, monospace for Courier-like names, sans-serif otherwise). No font is ever downloaded.
    - A field without a font uses Times New Roman at 12 px.
  - **Format:** the default format comes from the tag: size, colour (its alpha is ignored), alignment, margins, indent, and leading. Bold and italic come from the font, except in HTML fields.
  - **Layout:**
    - Text starts 2 px inside the bounds.
    - Lines break at newlines and, with `WordWrap`, between words; a word longer than the line is split.
    - Each line is as tall as its largest ascent plus its largest descent plus the leading. Device-font ascent and descent come from the browser's font metrics.
    - Alignment (left, right, center, justify) uses the width between the margins, and never moves text left of the margin. From SWF 8, trailing spaces are ignored when aligning.
    - `AutoSize` grows the field from its left edge.
  - **HTML subset:** `<p align>`, `<br>`, `<font face size color>`, `<b>`, `<i>`, `<u>`, `<a>` (drawn as plain text), `<li>` (a bullet and a 36 px indent), and `<textformat leftmargin rightmargin indent blockindent leading>`.
    - Entities are decoded. Unknown tags keep the current format, and end tags that do not close the innermost tag are ignored.
    - HTML fields start left-aligned unless the SWF is version 8 or later and the field has initial text.
    - Up to SWF 7, whitespace-only text between tags is dropped. Up to SWF 6, HTML fields always behave as multiline.
  - **Drawing:**
    - Text is clipped to the bounds, narrowed by the gutter horizontally.
    - `Border` draws a white background with a black frame.
    - `Password` shows `*`.
    - As in Flash Player, a field that uses device fonts is not drawn when it is rotated, skewed, or mirrored.
  - **Hit testing:** text is hit-tested by its bounds.
- **Buttons:** `DefineButton` and `DefineButton2`:
  - Each instance shows the records of its current state. Children that keep their depth and character persist across state changes.
  - Sprites inside a button keep playing.
  - The hit area (`HIT_TEST` records) is never drawn, and sprites in it do not run frame scripts.
- **Input:** with the default `input: true`, the player listens to pointer and keyboard events on the canvas.
  - The hovered button is the topmost one whose hit area contains the pointer. Hit testing uses the even-odd (or non-zero) fill rule, curves, and strokes at least 1 px wide. As in AVM1, shapes and bitmaps above a button never block it.
  - Pointer changes become button events:

    | Event | New state | Condition |
    |---|---|---|
    | Roll over | over | `IdleToOverUp` |
    | Roll out | up | `OverUpToIdle` |
    | Press | down | `OverUpToOverDown` |
    | Release | over | `OverDownToOverUp` |
    | Drag out | over | `OverDownToOutDown` |
    | Drag in | down | `OutDownToOverDown` |
    | Release outside | up | `OutDownToIdle` |

  - Keys map to SWF `KeyPress` codes (arrows, Home/End, Enter, Escape, and so on, or printable ASCII) and run the matching actions of every button on stage. The canvas takes focus when it is pressed.
  - Button actions run through the same AVM1 subset, in the context of the button's parent timeline, right after the event; then the movie is redrawn.
  - Buttons that leave the stage are forgotten without events. A button that appears under a still pointer gets its roll-over after the next frame.
  - The cursor becomes a hand over buttons.

### AVM1 subset (frame scripts and button actions)

The player runs the `DoAction` scripts of each frame it enters (root and sprites alike) and the actions of button events, with a controlled interpreter. It never evaluates JavaScript, never navigates, and never touches the page.

**Executed:**

- `Stop`, `Play`;
- `NextFrame`, `PreviousFrame` (go and stop);
- `GotoFrame`;
- `GotoLabel`, matched case-insensitively if no exact match exists;
- `SetTarget`, with slash paths (`/a/b`, `../a`) and dot paths (`_root.a`, `_parent`, `this`). Instance names are case-insensitive before SWF 7;
- `WaitForFrame`: every frame counts as loaded;
- the stack core: `Push`, `Pop`, `PushDuplicate`, `StackSwap`, `StoreRegister`, and `ConstantPool` (see [Stack and registers](#stack-and-registers)).

**Ignored, but reported:**

- `GetURL`: the player never loads URLs;
- `ToggleQuality`, `StopSounds`;
- `DefineFunction` and `DefineFunction2`: their bodies are skipped.

**Everything else** is reported as `avm1:<ActionName>`:

- Other actions (`SetVariable`, `GetVariable`, `Add`, and so on) are skipped. The values they would push are unknown.
- Control flow and calls (`Jump`, `If`, `Call`, `CallFunction`, `CallMethod`, `GotoFrame2`, `SetTarget2`, `With`, `Try`, `Throw`, `Return`, `WaitForFrame2`) **end the script**, because their outcome is unknown without the full VM. AS2 code such as `_root.gotoAndPlay(3)` or `if (…) stop();` is therefore not followed yet.

**Malformed actions:**

- A record that runs past its block is reported as `avm1:malformedAction` when the script reaches it, and the script stops there. Records are decoded only as the script reaches them, after the step is charged to `maxActionSteps`, so a large block costs no more than the actions that run.
- An executed action whose operands are malformed ends the script with the same report. This applies to `GotoFrame`, `GotoLabel`, `SetTarget`, `Push`, `StoreRegister`, `ConstantPool`, and function definitions whose body runs past the block.
- Other actions keep the behaviour listed above, even when their operands are malformed.

**Limits:** by default, 10,000 action blocks and 100,000 actions per tick or input event, and 100,000 values on the stack of one block (`maxActionBlocks`, `maxActionSteps`, `maxActionStack`; see [Limits](#limits)).

**Decoding budget:** decoded records stay cached for the life of the movie, so a block that runs again is not decoded again. The blocks of a movie share a budget of 1 MiB of bytecode. This is an internal limit, not a Player option.

- **What counts:**
  - each decoded record counts its length once, however often it runs;
  - a record with an error keeps no operands, so it counts at most its 3-byte header, whatever length it declares;
  - each cached block also counts 4 bytes for its own objects (about 350 bytes of memory).
- **Threshold:** the budget is a threshold, not a strict maximum. A record is decoded while the count is below 1 MiB, so the record that crosses it is kept and the count can end above 1 MiB by one record (at most 64 KiB).
- **Once the budget is spent:** a script that reaches a record not decoded yet stops there, with `avm1:budget`. Records already decoded keep running. A block that decoded no record, because it is empty or was met after the budget was spent, is not kept in the cache.
- **Measured memory:** filling the budget grew the heap by 40 to 58 MB in headless Chrome. That covers one 4 MiB block of one-byte actions, 400,000 blocks of one action, and 400,000 blocks with a truncated record. In Node 16 and 22 it grew by up to about 120 MB. This bounds the action cache only, not the player's total memory: bitmaps have their own budget.
- **Restarts:** `stop` and every restart start a new cache with a new budget.

#### Stack and registers

Each block runs in its own `Activation`. It holds the program counter, the clip the block belongs to, the `SetTarget` target, and its own stack, four registers, and constant pool, all empty at the start. The full VM will add the scope chain there.

- **Values** are `undefined`, `null`, booleans, numbers, and strings. Objects come with the full VM.
- **`Push`** puts its values on the stack in order. A register or constant pool index that does not exist pushes `undefined`.
- **`StoreRegister`** copies the top of the stack without popping it. Only registers 0–3 exist outside `DefineFunction2`, so a store to any other register is ignored.
- **`ConstantPool`** replaces the block's pool.
- **Underflow:** popping an empty stack gives `undefined`, as in Flash Player.
- **Overflow:** the stack never holds more than `maxActionStack` values. The action that would push past the limit, even halfway through a `Push`, ends the script with `avm1:budget`, and the stack is released.
- **Skipped actions** keep the stack in step:
  - an action with a fixed count pops its operands and pushes an *unknown value* (`UNKNOWN_VALUE`) for each result;
  - a function literal (`DefineFunction` with no name) pushes an unknown value;
  - an action whose count depends on the values (`InitArray`, `NewObject`, `Enumerate`, and so on) leaves the whole stack unknown, and every later pop past the known values gives an unknown value;
  - an unknown action code has no effect, as in Flash Player.

  An unknown value never reaches the timeline, so a value that was never computed cannot steer the movie. No action that the player executes reads the stack yet.

#### Decoder

`ActionCode` (`avm1/decoder.js`) decodes an action block without running it. It is written against the "Actions" chapter of SWF19.

- **Decoding on demand:** `at(offset)` decodes the record at any offset and caches it. A branch into the middle of a record, as some tools emit, therefore decodes from that point.
- **Budget:** an optional `{ used, max }` object can be shared by several `ActionCode`s.
  - Each newly decoded record adds its cost to `used`: its length, or at most 3 for a record with an error.
  - A block's first record adds `ACTION_BLOCK_COST` (4) more.
  - Once `used` reaches `max`, decoding a new record throws `DECODE_BUDGET`. Records already decoded stay available.
- **Linear list:** `list()` decodes from offset 0 up to `ActionEndFlag`. It also gives `endFound`, `endOffset`, `trailingBytes`, and `truncated`.
- **Records:** each one is `{ code, name, since, offset, end, data, args, error }`:
  - `since` is the SWF version that introduced the action;
  - `end` is the offset of the next record;
  - `args` holds the operands:
    - `Push` values, typed as `string`, `number`, `null`, `undefined`, `register`, `boolean`, or `constant`;
    - the constant pool, registers, frames, labels, paths, URLs, and the flags of `GetURL2`, `GotoFrame2`, `DefineFunction2`, and `Try`;
    - function, `With`, and `Try` bodies as offset ranges;
    - branch `offset` and absolute `target`.
- **Errors:** a record that cannot be used carries an `error`:
  - `TRUNCATED_RECORD`: the header or the declared length runs past the block;
  - `INVALID_OPERANDS`: the payload does not hold the operands;
  - `INVALID_BRANCH`: a target outside the block;
  - `INVALID_RANGE`: a body that runs past the block.
- **Encoding details:**
  - Strings are Latin-1 before SWF 6 and UTF-8 from SWF 6.
  - A double is stored as two little-endian 32-bit words, the high word first. Push integers are signed.
  - Bytes after the operands are ignored, and unknown codes are skipped by their length, as in Flash Player.

**Instance safety:** the player resists files whose sprites or buttons contain themselves.

- A sprite or button that would contain itself is not instantiated (`render:recursiveCharacter`).
- Nesting deeper than `maxNesting` levels (32 by default), through sprites or buttons, is refused (`render:nestingLimit`).
- At most `maxInstances` sprite and button instances (100,000 by default) are created per step: a tick, a seek, or an input event (`render:instanceLimit`).

**Not run:** `DoInitAction` and clip event actions.

### Not supported yet

Each of these is reported in `getDiagnostics().unsupported` when it is met:

- ActionScript outside the subset above;
- characters that are placed but not drawn: morph shapes, video, `DefineFont4` text;
- text fields bound to a variable (`text:variable`; they show their initial text), editing input fields (`text:input`), selection, scrolling, HTML images, kerning and letter spacing, style sheets, and text fields used as masks;
- button sounds (`DefineButtonSound`), menu tracking (`trackAsMenu` buttons behave as push buttons), masks during hit testing, and buttons nested inside buttons;
- per-channel colour transforms on bitmaps (only the alpha multiplier is applied);
- clipped bitmap fills beyond the bitmap's edges (Flash repeats the edge pixels there; the player leaves them empty);
- gradient spread modes other than pad, and linear-RGB interpolation;
- gradient and bitmap line fills (drawn with their first colour);
- blend modes, filters, and non-scaling strokes;
- 9-slice scaling and sound.

Two parts are only checked by eye, through the demo:

- Pixel accuracy against a reference player has not been measured.
- Drawing is not covered by automated tests. `tests/unit/player.test.js`, `tests/unit/bitmaps-avm1.test.js`, and `tests/unit/text.test.js` cover geometry, timelines, lossless pixels, JPEG table merging, the AVM1 subset, glyph placement, HTML parsing, and text layout.

## Next steps

1. The full AVM1 stack machine (phase 5), so AS2 control flow and method calls such as `_root.gotoAndPlay()` (used by the `visita.swf` menu buttons) are followed. Variables would also feed text fields bound to them.
2. Sound.
3. Morph shapes and filters.
