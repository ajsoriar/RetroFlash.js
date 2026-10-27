# SWF Reader (v0.5)

A dependency-free JavaScript reader for SWF file structure. It is a single classic script with no build step, and it is the foundation for a future Canvas renderer and ActionScript interpreter. It does not render anything and **never executes ActionScript**.

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

Load `swf-reader.js` first, then `retroflash.js`. The demo is [`../demo/player.html`](../demo/player.html).

```js
const player = new RetroFlash.Player({
  canvas, autoplay: false, loop: true,
  maxFileBytes: 50 * 1024 * 1024,   // passed to SWFReader.load
  maxBitmapPixels: 4096 * 4096,     // per bitmap
  maxTotalBitmapPixels: 4 * 4096 * 4096, // all bitmaps of a movie together
  actions: true,                    // run the AVM1 timeline-control subset
  input: true                       // pointer and keyboard on the canvas drive the movie's buttons
});
await player.load(fileOrBuffer);     // same inputs as SWFReader.load; decodes bitmaps; resolves with getInfo(),
                                     // or null when a later load() or destroy() superseded it
player.play(); player.pause(); player.stop(); player.step();
player.seek(10); player.seek('label');
player.getInfo();         // { state, version, width, height, fps, frameCount, currentFrame, rootPlaying, labels, ... }
player.getDiagnostics();  // { diagnostics (reader), unsupported (reader + player) }
player.on('load' | 'frame' | 'warning' | 'error' | 'end', fn); player.off(type, fn);
player.destroy();
```

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
- `WaitForFrame`: every frame counts as loaded.

**Ignored, but reported:**

- `GetURL`: the player never loads URLs;
- `ToggleQuality`, `StopSounds`;
- `DefineFunction` and `DefineFunction2`: their bodies are skipped.

**Everything else** is reported as `avm1:<ActionName>`:

- Actions with no timeline effect (`Push`, `SetVariable`, and so on) are skipped.
- Control flow and calls (`Jump`, `If`, `Call`, `CallFunction`, `CallMethod`, `GotoFrame2`, `SetTarget2`, `With`, `Try`, `Throw`, `Return`, `WaitForFrame2`) **end the script**, because their outcome is unknown without the full VM. AS2 code such as `_root.gotoAndPlay(3)` or `if (…) stop();` is therefore not followed yet.

**Limits:** 10,000 scripts and 100,000 actions per frame.

**Instance safety:** the player resists files whose sprites or buttons contain themselves.

- A sprite or button that would contain itself is not instantiated (`render:recursiveCharacter`).
- Nesting deeper than 32 levels, through sprites or buttons, is refused (`render:nestingLimit`).
- At most 100,000 sprite and button instances are created per step: a tick, a seek, or an input event (`render:instanceLimit`).

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
