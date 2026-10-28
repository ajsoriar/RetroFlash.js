# SWF Reader (v0.6)

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

## Coverage in v0.6

- FWS. CWS (zlib) through `DecompressionStream('deflate')`; decompression stops as soon as the output exceeds the declared length.
- Header: signature, version, declared length, stage RECT, frame rate (8.8), and frame count.
- Tag record headers in short and long form, validated against the enclosing range (the file or the sprite). A negative long length is rejected.
- Recursive index of `DefineSprite` control tags with sprite-local frames, and a check of which tags are allowed inside sprites.
- Decoded tags: `End`, `ShowFrame`, `SetBackgroundColor`, `FrameLabel` (with the named anchor from SWF 6), `FileAttributes`, `PlaceObject`, `PlaceObject2`, `PlaceObject3` (every field; the filter list is validated and kept as filter names), `ExportAssets` (since v0.6: `assets`, `{ characterId, name }`), `RemoveObject`, `RemoveObject2`, and `DefineSprite`.
- `DefineShape`, `DefineShape2`, `DefineShape3`, and `DefineShape4` are decoded (since v0.3). `fields` contains:
  - `shapeId`, `shapeVersion`, `bounds`;
  - `fillStyles`: `solid`, `linear`, `radial`, `focal`, or `bitmap`, with gradient matrices and stops;
  - `lineStyles`: `LINESTYLE`, or `LINESTYLE2` with caps, joins, and fill;
  - `records`: style changes with absolute `moveTo` and new style arrays, plus `line`/`curve` edges as deltas in twips;
  - for `DefineShape4` only: `edgeBounds` and the fill-winding and scaling-stroke flags.

  Colours are always `{r, g, b, a}`.
- Morph shapes (with `tests/fixtures/valid/fws-morph.swf`): `DefineMorphShape` and `DefineMorphShape2` give `characterId`, `morphVersion`, `startBounds`, `endBounds`, `fillStyles` and `lineStyles` as `{ start, end }` pairs in the `DefineShape` format (colours always RGBA; focal gradients in both tags), `startRecords` (with the style changes) and `endRecords` (edges and moves only; their NumFillBits and NumLineBits are not used). `DefineMorphShape2` adds `startEdgeBounds`, `endEdgeBounds`, `usesNonScalingStrokes`, `usesScalingStrokes`, and `MORPHLINESTYLE2` caps, joins and fills. The end edges are read right after the start edges.
- Bitmap headers are decoded (since v0.3, with `tests/fixtures/valid/fws-bitmaps.swf`). Pixel data stays in the tag body, and the offsets below are relative to `getTagData(tag)`.
  - `DefineBits`, `DefineBitsJPEG2`, `DefineBitsJPEG3`, and `DefineBitsJPEG4` give `characterId`, `imageStart`, `imageEnd`, and `imageFormat` (`jpeg`, `png`, `gif`, or `unknown`, sniffed). JPEG3/4 also give `alphaStart` when an alpha plane is present, and JPEG4 gives `deblockParam`.
  - `DefineBitsLossless` and `DefineBitsLossless2` give `characterId`, `losslessVersion`, `bitmapFormat` (3, 4, or 5), `width`, `height`, `colorTableSize`, and `dataStart`.
  - `JPEGTables` is marked as decoded; its body is the shared tables.
- `SWFReader.inflate(bytes, maxLength[, { truncate }])` decompresses zlib data. It stops as soon as the output would exceed `maxLength`. With `truncate`, it returns the first `maxLength` bytes instead of failing. It uses `DecompressionStream` and fails with the codes `INFLATE_UNSUPPORTED`, `INFLATE_TOO_LARGE`, or `INFLATE_FAILED`.
- Buttons (since v0.4, with `tests/fixtures/valid/fws-buttons.swf`):
  - `DefineButton` and `DefineButton2` give `buttonId`, `buttonVersion`, `trackAsMenu`, and `records`. Each record has its `up`/`over`/`down`/`hitTest` flags, `characterId`, `depth`, `matrix`, and, in v2, `colorTransform`, `filters`, and `blendMode`.
  - They also give `actions`: `{ conditions, start, end }` relative to `getTagData(tag)`. `conditions` uses the BUTTONCONDACTION bits read as a little-endian UI16, with the key code in bits 9–15. A `DefineButton` has one list, run on release (`conditions` 8). `DefineButton2.ActionOffset` locates the actions. A gap after the records is skipped and reported as `BUTTON_ACTION_OFFSET_GAP`; an offset inside the records or past the tag makes the tag invalid.
  - `DefineButtonCxform` gives `buttonId` and every `CXFORM` it holds. `DefineButtonSound` gives `buttonId` and `sounds` (see below).
  - `movie.codeTags.buttonActions` counts the action lists.
- Sounds (with `tests/fixtures/valid/fws-sound.swf`). Sample data stays in the tag body; offsets are relative to `getTagData(tag)`. `rate` is in Hz: 5512.5, 11025, 22050 or 44100, except Nellymoser 8 kHz (8000), Nellymoser 16 kHz and Speex (16000).
  - `DefineSound` gives `soundId`, `format` (0 and 3 PCM, 1 ADPCM, 2 MP3, 4–6 Nellymoser, 11 Speex), `rate`, `is16Bit`, `stereo`, `sampleCount`, `dataStart`, and for MP3 `seekSamples`.
  - `StartSound` gives `soundId` and `info`; `StartSound2` gives `className` and `info`. A `SOUNDINFO` (`info`) has `syncStop`, `syncNoMultiple`, and when present `inPoint`, `outPoint` (samples at 44.1 kHz), `loopCount`, and `envelope` (`[{ pos44, left, right }]`, levels 0–32768).
  - `DefineButtonSound` gives `buttonId` and `sounds`: four entries (OverUpToIdle, IdleToOverUp, OverUpToOverDown, OverDownToOverUp), each `null` or `{ soundId, info }`.
  - `SoundStreamHead` and `SoundStreamHead2` give the advised `playbackRate`, `playback16Bit`, and `playbackStereo`, then the stream's `format`, `rate`, `is16Bit`, `stereo`, `sampleCount` (per frame), and for MP3 `latencySeek`, which may be missing.
  - `SoundStreamBlock` is marked as decoded; its layout depends on its timeline's `SoundStreamHead`, so the player reads it.
- Fonts and text (since v0.5, with `tests/fixtures/valid/fws-text.swf`):
  - `DefineFont2` and `DefineFont3` give:
    - `fontId`, `fontVersion`, `name` (a trailing NUL is dropped), `bold`, `italic`, `smallText`, `ansi`, `shiftJIS`, `language`, and `hasLayout`;
    - `glyphs`: `{ records, code, advance[, bounds] }`, where `records` are SHAPERECORDs as in `DefineShape` and fill style 1 is the text colour. Coordinates are on a 1024-unit EM square, or 20480 in `DefineFont3`;
    - with a layout: `ascent`, `descent`, `leading`, and `kerning` (`{ left, right, adjustment }`).

    Tool variations are tolerated: a font without glyphs may omit `CodeTableOffset`, and the glyph bounds and kerning table may be missing at the end of the tag. Glyph offsets outside the tag fail with `INVALID_OFFSET`.
  - `DefineFont` gives `fontId` and `glyphs` (their codes are `null`). `DefineFontInfo` and `DefineFontInfo2` give its `name`, style flags, and `codes`.
  - `DefineFontName` gives `fontId`, `name`, and `copyright`. `DefineFontAlignZones` and `CSMTextSettings` keep only their ids and mode bits; their bodies only tune anti-aliasing.
  - `DefineFont4` gives `fontId`, `name`, `bold`, `italic`, `hasFontData`, and `dataStart`, where its OpenType (CFF) font file starts in `getTagData(tag)`.
- `DefineScalingGrid` gives `characterId` and `splitter`, the 9-slice grid as a RECT in twips (with `tests/fixtures/valid/fws-paint.swf`).
  - `DefineText` and `DefineText2` give `characterId`, `bounds`, `matrix`, and `records`.
    - Each record has the fields it sets: `fontId` with `height`, `color`, `x`, and `y`. Its `glyphs` are `{ index, advance }`.
    - A list without its end byte is accepted with a `TEXT_END_MISSING` warning.
  - `DefineEditText` gives:
    - `characterId`, `bounds`, and the flags `wordWrap`, `multiline`, `password`, `readOnly`, `autoSize`, `noSelect`, `border`, `wasStatic`, `html`, `useOutlines`;
    - when present: `fontId`, `fontClass`, `fontHeight` (also read when only `HasFontClass` is set), `color`, `maxLength`, and the layout (`align`, `leftMargin`, `rightMargin`, `indent`, and `leading`, which are signed);
    - `variableName` and `initialText`.
- Filter lists (in `PlaceObject3` and button records) are validated by filter type and size, then skipped. An unreadable list in `PlaceObject3` leaves the placement `partial` with `unparsed: ['filterList']`, instead of invalid. The sizes follow SWF19. Only the filter names are kept.
- Clip actions (since v0.6): a `PlaceObject2`/`PlaceObject3` with the ClipActions flag gives `clipActions`, `[{ events, keyCode, start, end }]`. `events` are the names of the event flags (`load`, `enterFrame`, `unload`, `mouseDown`, `mouseUp`, `mouseMove`, `keyDown`, `keyUp`, `data`, `initialize`, `press`, `release`, `releaseOutside`, `rollOver`, `rollOut`, `dragOver`, `dragOut`, `construct`, `keyPress`); the flags are UI16 up to SWF 5 and UI32 from SWF 6. `keyCode` is set for `keyPress`. `start` and `end` locate the actions in `getTagData(tag)`. An unreadable list leaves the placement `partial` with `unparsed: ['clipActions']`. `movie.codeTags.clipActions` counts the placements with clip actions.
- Strings: UTF-8 from SWF 6; Latin-1 before SWF 6.
- `DoAction`, `DoInitAction`, and `DoABC` are counted in `movie.codeTags` and listed as unsupported, because the reader does not interpret them. Their bytes are available through `getTagData`. The player runs `DoAction` and `DoInitAction` (see below).

## Limitations

- The reader itself does not render. Playback is handled by `retroflash.js` (see below).
- Video is indexed but not decoded. Bitmap pixels and sound samples are decoded by the player.
- Filter parameters are skipped, not decoded.
- `ZWS` (LZMA) is rejected. `CWS` needs native `DecompressionStream`; there is no JavaScript inflate fallback yet, so CWS fails with `CWS_UNSUPPORTED` in older browsers.
- Strings in files older than SWF 6 used the author's locale encoding, which the file does not record; they are decoded as Latin-1.
- `End` and any tag after the last `ShowFrame` report `frame = actualFrameCount + 1`, as in v0.1.
- The reader checks bounds and limits, and the tests include controlled fuzzing. It has not had an independent security review, so treat hostile files with care.

## Tests

From the project root, run `node tests/run.js` (Node 16+, no dependencies). `node tools/corpus.js` writes the compatibility matrix of any SWF files, by layer. See [`../tests/COMPATIBILITY.md`](../tests/COMPATIBILITY.md).

# RetroFlash.Player (`retroflash.js` v0.4)

Load `../dist/retroflash.min.js` (built by `npm run build`), which holds the reader and the player. Alternatively, load the source scripts in the order of [`modules.json`](./modules.json), as the demo [`../demo/player.html`](../demo/player.html) does.

```js
const player = new RetroFlash.Player({
  canvas, autoplay: false, loop: true,
  maxFileBytes: 50 * 1024 * 1024,   // passed to SWFReader.load
  actions: true,                    // run the AVM1 subset
  input: true,                      // pointer and keyboard on the canvas drive the movie's buttons
  loader: null,                     // gives the files that scripts load (see "Loading into clips")
  host: null,                       // what the movie asks of the page (see "Browser interaction")
  audio: undefined,                 // the audio backend; false plays no sound (see "Sound")
  volume: 1,                        // from 0 to 1
  maxActionSteps: 100000            // any of the limits below
});
await player.load(fileOrBuffer, { url, variables }); // options optional: the movie's _url and its FlashVars;
                                     // same inputs as SWFReader.load; decodes bitmaps; resolves with getInfo(),
                                     // or null when a later load() or destroy() superseded it
player.play(); player.pause(); player.stop(); player.step();
player.seek(10); player.seek('label');
player.getInfo();         // { state, version, width, height, fps, frameCount, currentFrame, rootPlaying, labels, ... }
player.getDiagnostics();  // { diagnostics (reader), unsupported (reader + player) }
player.on('load' | 'frame' | 'warning' | 'error' | 'end', fn); player.off(type, fn);
player.on('navigate' | 'call' | 'fscommand' | 'callbacks' | 'interaction', fn); // see "Browser interaction"
player.callback(name, args); player.getCallbacks(); // ExternalInterface.addCallback functions
player.getInteractionLog(); player.clearInteractionLog(); // recent page/plugin requests, bounded to 100 entries
player.setVolume(0.5); player.getVolume();
RetroFlash.createBrowserHost(options); // a `host` that uses the browser's own APIs
RetroFlash.createWebAudioBackend(options); // an `audio` backend on Web Audio (the default in browsers)
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
| `maxAudioSamples` | 64 × 1024 × 1024 | Decoded sound samples of a movie together (all channels; MP3 counted by its declared length) | `sound:memoryLimit` |
| `maxActionBlocks` | 10,000 | AVM1 action blocks (each `DoAction` or button action list) run in one tick or input event; the rest are dropped | `avm1:budget` |
| `maxActionSteps` | 100,000 | AVM1 actions executed in one tick or input event; the current block stops | `avm1:budget` |
| `maxActionStack` | 100,000 | Values on the stack of one AVM1 action block or function call; the block stops | `avm1:budget` |
| `maxCallDepth` | 256 | Nested AVM1 function calls (and `Call` actions), as in Flash Player; the whole block stops | `avm1:budget` |

### Source layout

Each player module is a classic script. It takes what it needs from the internal namespace `RetroFlashModules`, which `core/base.js` creates, and adds its own exports there. `retroflash.js` comes last: it builds the public `RetroFlash` object and removes the namespace from the global object. Every export is also available as `RetroFlash.internals`, for tests and tooling; that is not a stable API.

| Script | Contents |
|---|---|
| `swf-reader.js` | The reader (`SWFReader`) |
| `core/base.js` | The module namespace, the version, limits, and player errors |
| `core/math.js` | Matrices and colour transforms |
| `render/geometry.js` | Shape records to fill and stroke commands, shared by the renderer and hit testing |
| `render/morph.js` | The shape of a morph shape at a placement's ratio |
| `display/bitmaps.js` | Bitmap decoding and pixel budgets |
| `text/fonts.js`, `text/html.js`, `text/layout.js` | Fonts and static text, the HTML subset, and text field layout |
| `avm1/decoder.js` | AVM1 decoding (`ActionCode`) |
| `avm1/values.js`, `avm1/properties.js`, `avm1/variables.js` | AVM1 values with their conversions and comparisons; movie clip properties, bounds, and paths; target paths, timeline variables, and text fields bound to a variable |
| `avm1/objects.js`, `avm1/globals.js` | AVM1 objects, arrays, functions, and member access; the movie's runtime with the global object and the built-in classes |
| `avm1/interpreter.js` | `ActionScheduler`, with one `Activation` per block or call, which runs AVM1 bytecode |
| `audio/codecs.js`, `audio/mixer.js` | PCM and ADPCM decoding and MP3 frame headers; the `AudioController`: event sounds, streams, sound transforms, and the backend contract |
| `display/movie.js` | The character dictionary and frame lists |
| `display/clip.js`, `display/button.js` | The display context (`createEnv`), timelines and display lists, and button instances |
| `display/loader.js` | `LoadQueue`: movies, images, and variables loaded into clips through the host page's loader |
| `input/hit-test.js`, `input/input.js` | Hit testing, and pointer and keyboard input |
| `render/canvas-renderer.js` | The Canvas 2D renderer |
| `avm1/external.js` | getURL to windows, `javascript:` URLs read as page calls, FSCommand, form variables, ExternalInterface values, the `HostBridge` |
| `browser/host.js` | `RetroFlash.createBrowserHost` |
| `browser/web-audio.js` | `RetroFlash.createWebAudioBackend` |
| `retroflash.js` | `RetroFlash.Player`, the public API |
| `browser/legacy-autoplay.js` | Replaces legacy Flash `<object>`/`<embed>` markup; the only script after `retroflash.js` |

A module uses only modules listed before it in `modules.json`. The exceptions read from the namespace at run time: `display/clip.js` reads `ButtonInstance` when it creates a button, because buttons are built on clips, and `LoadQueue` when it creates a display context; `avm1/interpreter.js` and `avm1/globals.js` read `loadInto` when a script loads something, and `audioOf` when a script plays or stops a sound.

The state of one movie is split in two:

- The **display context** (`createEnv`) is shared by every timeline. It holds the dictionary, the report function, the limits, and the per-step instance count. A movie loaded into a clip gets its own context (`createMovieEnv`) with its own dictionary, exports, SWF version, and URL; the rest is the main movie's.
- The **`ActionScheduler`** (`env.scripts`) queues and runs AVM1 action blocks. It holds the queue, the parsed-action cache, and the budgets. The player opens a new budget for each tick and input event (`scripts.beginUpdate()`), and every `run()` in that update shares it. It drives timelines only through `Clip` methods, so AVM1 does not depend on the display list's internals.

A scrubbing `seek` and the creation of a button's hit area enter frames without running their scripts: the scripts they queue are dropped, with `scripts.mark()` and `scripts.dropSince(mark)`. They play no sounds either (`audio.quiet`).

The **`AudioController`** (`env.audio`, in `audio/mixer.js`) belongs to the player and is shared by every movie it shows. It decodes and caches sound samples, tracks the sounds playing, and sends them to the audio backend.

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
  - Bitmap fills are clipped or repeating, smoothed or not, as the fill type says. A clipped fill that reaches past its bitmap extends the bitmap's edge rows, columns and corner pixels over the rest of the shape, as Flash Player does. A bitmap placed directly is drawn at 20 twips per pixel.
  - **Colour transforms:** one that only scales alpha becomes the image's opacity. Any other is applied to the pixels of a copy of the bitmap (the four latest kept per bitmap); without an alpha offset the alpha multiplier stays an opacity, so fades do not make copies. A bitmap larger than 2048 × 2048 pixels, one whose pixels the page cannot read (a cross-origin image), or no canvas to tint it on, gets only the alpha multiplier (`render:bitmapColorTransform`).
  - A bitmap that cannot be decoded is reported and not drawn.
  - **Memory limits:** pixels are reserved before decoding. Lossless bitmaps use the tag's width and height. JPEG, PNG, and GIF use the size in the image header (JPEG `SOFn`, PNG `IHDR`, GIF logical screen); an image without a readable size is refused, and a decoded image larger than its header declared is discarded. Each bitmap is limited by `maxBitmapPixels`, and all bitmaps of a movie together by `maxTotalBitmapPixels`, in character id order. A refused bitmap is reported (`render:bitmapDecodeFailed`, with `BITMAP_TOO_LARGE`, `BITMAP_BUDGET`, or `BITMAP_FORMAT`) and not drawn.
  - Bitmap memory is released when the movie is replaced by another `load()` or the player is destroyed.
- **Loading into clips:** see [Loading into clips](#loading-into-clips).
- **Sound:** see [Sound](#sound).
- **Overlapping loads:** only the latest `load()` takes effect. An earlier call that is still running, or one interrupted by `destroy()`, resolves to `null` without changing the player or emitting events, even if it fails. Diagnostics it would produce after that point, such as bitmap decoding failures, are dropped.
- **Shapes:**
  - Edges are grouped by fill style, with FillStyle0 edges reversed, and linked into closed contours.
  - Fills use the even-odd rule, or non-zero when `DefineShape4` sets the winding flag.
  - Gradients use the SWF ±16384-twip gradient square, transformed by the gradient matrix. Reflect and repeat spread modes become one Canvas gradient over every period the fill reaches, each with the stops in order (reversed every other period when reflecting); a focal gradient's periods continue its cone. A gradient that would repeat more than 512 times over its fill is drawn as pad (`render:gradientSpread`). Linear-RGB interpolation is drawn as sRGB (`render:gradientLinearRGB`).
  - Colour transforms are applied exactly to vector colours.
  - Strokes are at least one device pixel wide. `DefineShape4` caps and joins are honoured.
  - `LINESTYLE2` `NoHScale` and `NoVScale` keep a stroke from scaling with its object: with both, it keeps the width it would have on the stage; with one, it scales only with the object's scale on the other axis.
  - Gradient and bitmap line fills (`LINESTYLE2` `HasFill`) are painted where the stroke is, through a layer the size of the canvas. Without a canvas for the layer they take their first colour (`render:lineFill`).
- **9-slice scaling** (`DefineScalingGrid`): a scaled sprite or button with a grid keeps the parts of its shapes outside the grid at their size. Corners keep it both ways, the edges in one direction, and the centre takes the rest; scaled below the size of its corners, the corners shrink evenly. As in Flash Player, only shapes directly in the clip follow the grid (nested clips, text and bitmaps scale normally), and a rotated or skewed clip scales normally. The grid applies to drawing; hit testing, masks and strokes use the plain shape.
- **Morph shapes** (`DefineMorphShape`, `DefineMorphShape2`): each placement draws the shape its ratio selects (PlaceObject2/3 `Ratio`; 0, also when missing, is the start shape and 65535 the end shape), and is masked, hit-tested and measured (`getBounds`, between the start and end bounds) as that shape.
  - Start and end records are walked side by side, each with its own pen: a style change (taken from the start shape) or a move in either list stands alone, and every other start edge pairs with the next end edge. A straight edge paired with a curve becomes a curve whose control point is its midpoint.
  - Points are interpolated as absolute positions and rounded to whole twips, so contours stay closed. Colours, line widths, gradient matrices, stop positions and colours, focal points, and bitmap matrices are interpolated too.
  - Edges left over in one list are not drawn and are reported once (`render:morphEdges`).
  - The interpolated shapes of the last 32 ratios used are kept per character.
- **Masks:** `clipDepth` masks use the union of the mask's fills, including sprite masks and static text glyphs, as a Canvas clip.
- **Static text** (`DefineText`, `DefineText2`): glyph outlines from `DefineFont`/`DefineFont2`/`DefineFont3` are filled (even-odd) in their record's colour, which colour transforms modify. Each glyph is scaled by height / EM (1024, or 20480 for `DefineFont3`) and placed by the text matrix, the record offsets, and the advances. Font, height, colour, and position carry over between records.
- **Text fields** (`DefineEditText`):
  - **Fonts:**
    - With `UseOutlines`, glyphs come from an embedded font with the face's name (same style first). Advances come from the font layout; kerning is not applied.
    - Otherwise, or when no embedded font has glyphs, a device font is drawn with Canvas `fillText`. `_sans`, `_serif`, and `_typewriter` map to the generic CSS families. Other names are tried as installed fonts, with a generic fallback (serif for Times New Roman, monospace for Courier-like names, sans-serif otherwise). No font is ever downloaded.
    - A `DefineFont4` font is loaded into the page with the browser's `FontFace` API during `load`, under a family name of its own, and text fields whose face is its name draw with it like a device font. Without `FontFace`, or when the file cannot be loaded, a device font is used (`text:font4`). Static text cannot use its glyphs (`render:font4Text`). The fonts are removed from the page when the movie is released.
    - A field without a font uses Times New Roman at 12 px.
  - **Format:** the default format comes from the tag: size, colour (its alpha is ignored), alignment, margins, indent, and leading. Bold and italic come from the font, except in HTML fields.
  - **Layout:**
    - Text starts 2 px inside the bounds.
    - Lines break at newlines and, with `WordWrap`, between words; a word longer than the line is split.
    - Each line is as tall as its largest ascent plus its largest descent plus the leading. Device-font ascent and descent come from the browser's font metrics.
    - Alignment (left, right, center, justify) uses the width between the margins, and never moves text left of the margin. From SWF 8, trailing spaces are ignored when aligning.
    - `AutoSize` grows the field from its left edge.
  - **HTML subset:** `<p align>`, `<br>`, `<font face size color>`, `<b>`, `<i>`, `<u>`, `<a href target>` (see **Links** below), `<li>` (a bullet and a 36 px indent), and `<textformat leftmargin rightmargin indent blockindent leading>`.
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
  - The hit area (`HIT_TEST` records) is never drawn, and sprites in it do not run frame scripts or play sounds.
  - `DefineButtonSound` sounds play on roll over (`IdleToOverUp`), press (`OverUpToOverDown`), release (`OverDownToOverUp`), and roll out or release outside (`OverUpToIdle`), with their `SOUNDINFO`.
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
  - The cursor becomes a hand over buttons and links.
  - **Links:** the text of an `<a href>` in an HTML text field is clickable where it is drawn (each line of a link that wraps is its own box). A link is not underlined unless it is also in `<u>`. A press and release on the same link follows it:
    - `asfunction:name,argument` calls the function `name`, found on the field's timeline and then on the global object, or a path whose parts are clips or members (`_root.menu.open`), with the argument as a string. A name that is no function is reported (`avm1:asfunctionMissing`);
    - any other URL goes where `getURL` sends it, to the link's `target`: `FSCommand:`, `javascript:` calls, or page navigation, through the Player option `host`.

    Text fields do not block buttons underneath them, as in Flash Player. Links are found in the layout the field was last drawn with.

### Sound

Sounds play through an **audio backend**, the Player option `audio`. By default the player uses `RetroFlash.createWebAudioBackend()` when the browser has Web Audio. With `audio: false`, or without Web Audio (Node), nothing plays, and a movie that starts a sound reports `sound:noOutput`.

Browsers start audio only after the user interacts with the page. Until then sounds are silent; the Web Audio backend resumes at the first pointer or key press on the page. `pause()` suspends every sound and `play()` resumes them. `stop()` and `load()` stop them, and `destroy()` closes the output. `volume` (and `setVolume`) scales everything.

- **Codecs:** uncompressed PCM (8-bit unsigned or 16-bit little-endian, mono or stereo) and ADPCM (2 to 5 bits per code) are decoded in JavaScript. MP3 is decoded by the browser (`decodeAudioData`); a movie's MP3 sounds and streams are decoded ahead during `load`. Nellymoser and Speex are reported (`sound:Nellymoser`, `sound:Speex`, ...) and not played. Decoded samples count against `maxAudioSamples`.
- **Event sounds:** a `StartSound` plays when its frame is entered; a `goto` plays only the sounds of the frame it lands on. `SOUNDINFO` is honoured:
  - in and out points, and envelope positions, in 44.1 kHz samples;
  - the loop count (below 1 plays once);
  - the envelope's left and right levels, linear between points, counted from the start of playback across loops;
  - `syncStop` stops every instance of the sound, and `syncNoMultiple` does not start it while it plays.

  MP3 sounds skip their `SeekSamples`. A timeline's sound belongs to its clip, but removing the clip does not stop it.
- **Stream sounds** (`SoundStreamHead`, `SoundStreamBlock`): the blocks of a timeline make one sound, which plays while its timeline plays.
  - A timeline that plays into a frame with a block starts the stream from that block.
  - A stream more than one second away from its timeline starts again where the timeline is.
  - A jump (`gotoAndPlay`, `nextFrame`, ...), `stop()`, removal, or new content stops it. It starts again when the playing timeline reaches its next block.
  - The timeline is not slowed down or sped up to follow the audio.
  - ADPCM blocks do not record their sample count, so padding bits that hold a whole code add one sample to a block.
- **At most 32 sounds** play at once, streams included; further ones are reported (`sound:limit`).
- **`StopSounds`** (`stopAllSounds()`) stops every sound. Streams of timelines that keep playing start again at their next block.
- **Reported:** a sound id that is not a sound (`sound:missingCharacter`), `StartSound2` (`sound:StartSound2`, an ActionScript 3 class), a stream without a head (`sound:streamWithoutHead`), and data the browser cannot decode (`sound:decodeFailed`).

**The backend contract.** A custom `audio` object needs `play(media, options)`, which starts a sound and returns a voice, or `null`.

- `media` is decoded samples, `{ rate, channels: [Float32Array] }`, or MP3 frames to decode, `{ rate, stereo, mp3: Uint8Array }`. The same object comes back for the same sound, so it can serve as a cache key.
- `options` is `{ start, end, loops, envelope, gains, sync, onended, onerror }`:
  - `start` and `end` are seconds in the media, and `loops` is 1 or more;
  - `envelope` is `null` or `[{ time, left, right }]`, with `time` in seconds from the start of playback and levels from 0 to 1;
  - `gains` is `[ll, lr, rl, rr]`: left from left, left from right, right from left, and right from right;
  - `sync` is true for streams, whose late start should skip what it missed;
  - `onended()` is called once, when the sound finishes by itself, and `onerror(error)` when it cannot be decoded.
- A voice has `stop()`, `setGains(gains)`, and `position()` (seconds in the media, or `null` before it starts).
- Optional methods: `prepare(media)` (decode ahead; may return a promise), `suspend()`, `resume()`, `setVolume(value)`, and `close()`.

`RetroFlash.createWebAudioBackend({ context, window })` plays into its own `AudioContext`, created with the first sound, or into `context`, which it never closes. Each voice is a buffer source split into left and right, scaled by the envelope and the four channel gains, and merged into the master volume. Buffers below 8 kHz are upsampled, because some browsers refuse such rates. It returns `null` when the window has no Web Audio.

### AVM1 (frame scripts and button actions)

The player runs the `DoAction` scripts of each frame it enters (root and sprites alike) and the actions of button events, with a controlled interpreter for ActionScript 1 and 2 bytecode. It never evaluates JavaScript and never touches the page itself: navigation, `javascript:` URLs, FSCommand and ExternalInterface go to the page's `host` (see [Browser interaction](#browser-interaction)). The reader lists `actionscript:DoAction` because the *reader* never runs code; the player does, and reports separately what it cannot run.

**Executed:**

- `Stop`, `Play`;
- `NextFrame`, `PreviousFrame` (go and stop);
- `GotoFrame` and `GotoLabel` (go and stop, as `gotoAndStop` in Flash Player); labels match case-insensitively if no exact match exists;
- `GotoFrame2`, `SetTarget2`, `GetProperty`, `SetProperty`, `TargetPath`, `CloneSprite` (`duplicateMovieClip`), and `RemoveSprite` (`removeMovieClip`) (see [Movie clips](#movie-clips));
- `SetTarget`, with the target paths described in [Variables](#variables). Instance names are case-insensitive before SWF 7;
- control flow (see [Control flow](#control-flow)): `Jump`, `If`, `Return`, `WaitForFrame`, and `WaitForFrame2`;
- the stack core: `Push`, `Pop`, `PushDuplicate`, `StackSwap`, `StoreRegister`, and `ConstantPool` (see [Stack and registers](#stack-and-registers));
- the operators on values (see [Values and operators](#values-and-operators)):
  - SWF 4: `Add`, `Subtract`, `Multiply`, `Divide`, `Equals`, `Less`, `And`, `Or`, `Not`, `StringEquals`, `StringLength`, `StringExtract`, `StringAdd`, `StringLess`, `ToInteger`, `CharToAscii`, `AsciiToChar`, the `MB` string actions, and `RandomNumber`;
  - SWF 5 and later: `Add2`, `Less2`, `Equals2`, `Greater`, `StrictEquals`, `StringGreater`, `Modulo`, `Increment`, `Decrement`, `ToNumber`, `ToString`, `TypeOf`, and the six bitwise actions;
- `GetVariable`, `SetVariable`, `DefineLocal`, and `DefineLocal2` on timeline variables (see [Variables](#variables));
- `Trace`, which prints nothing, as in a release Flash Player;
- `StartDrag`, `EndDrag`, and `GetTime` (see [Game APIs](#game-apis));
- functions, objects, and calls (see [Functions and objects](#functions-and-objects)): `DefineFunction`, `DefineFunction2`, `CallFunction`, `CallMethod`, `NewObject`, `NewMethod`, `Call`, `GetMember`, `SetMember`, `Delete`, `Delete2`, `InitArray`, `InitObject`, `Enumerate`, `Enumerate2`, `InstanceOf`, `Extends`, `CastOp`, `ImplementsOp`, `With`, `Try`, and `Throw`.

**Loads** (see [Loading into clips](#loading-into-clips)): `GetURL2` with a clip target (`loadMovie`, `unloadMovie`, `loadVariables`), and `GetURL` or `GetURL2` with the target `_level0` (`loadMovieNum`, `loadVariablesNum`).

**The page** (see [Browser interaction](#browser-interaction)): `GetURL`/`GetURL2` to a window (with the variables of a `GET` or `POST`), `javascript:` and `FSCommand:` URLs.

**Sound:** `StopSounds` stops every sound (see [Sound](#sound)). `ToggleQuality` is ignored.

**Unknown action codes** are reported as `avm1:Unknown_0x..` and skipped, as Flash Player skips them.

**Malformed actions:**

- A record that runs past its block is reported as `avm1:malformedAction` when the script reaches it, and the script stops there. Records are decoded only as the script reaches them, after the step is charged to `maxActionSteps`, so a large block costs no more than the actions that run.
- An executed action whose operands are malformed ends the script with the same report. This applies to `GotoFrame`, `GotoLabel`, `SetTarget`, `Push`, `StoreRegister`, `ConstantPool`, `Jump`, `If`, `WaitForFrame`, `WaitForFrame2`, and function definitions whose body runs past the block.
- Other actions keep the behaviour listed above, even when their operands are malformed.

**Limits:** by default, 10,000 action blocks and 100,000 actions per tick or input event, 100,000 values on the stack of one block, and 256 nested function calls (`maxActionBlocks`, `maxActionSteps`, `maxActionStack`, `maxCallDepth`; see [Limits](#limits)). An uncaught `Throw`, too many nested calls, or a string grown past its limit ends the whole block (`avm1:uncaughtThrow`, `avm1:budget`).

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

Each block, and each function call, runs in its own `Activation`. It holds the program counter, the clip the code belongs to, the `SetTarget` target, `this`, the scope chain, and its own stack and constant pool, empty at the start.

- **Values** are `undefined`, `null`, booleans, numbers, strings, movie clips, and objects (see [Functions and objects](#functions-and-objects)).
- **Registers:** the movie has four global registers (0–3), shared by every script, as in Flash Player. A `DefineFunction2` function has its own registers as well.
- **`Push`** puts its values on the stack in order. A register or constant pool index that does not exist pushes `undefined`.
- **`StoreRegister`** copies the top of the stack without popping it. Only registers 0–3 exist outside `DefineFunction2` functions, so a store to any other register is ignored.
- **`ConstantPool`** replaces the block's pool.
- **Underflow:** popping an empty stack gives `undefined`, as in Flash Player.
- **Overflow:** the stack never holds more than `maxActionStack` values. The action that would push past the limit, even halfway through a `Push`, ends the script with `avm1:budget`, and the stack is released.
- **Unknown values** (`UNKNOWN_VALUE`) come from built-in objects that are not implemented yet (see [Variables](#variables)). An operator with an unknown operand gives an unknown result. An unknown value never reaches the timeline and never decides a branch, so a value that was never computed cannot steer the movie.
- **Unknown action codes** have no effect on the stack, as in Flash Player.

#### Control flow

- **`Jump` and `If`** go to the target the decoder computed: the offset counts from the end of the branch record. A target may be the end of the block (the script ends there) or the middle of another record, which is then decoded from that byte. A branch whose target lies outside the block, or whose operand is short, ends the script with `avm1:malformedAction`.
- **`If`** pops its condition and converts it with the version's boolean rules (see [Values and operators](#values-and-operators)): before SWF 7, `"abc"` is false; from SWF 7 it is true. A condition that is an unknown value **ends the script** with `avm1:unknownCondition`: the player never guesses a branch.
- **`Return`** pops its value and, outside functions, ends the block.
- **`WaitForFrame` and `WaitForFrame2`:** the whole movie is loaded before it plays, so every frame counts as loaded, except frame numbers above 16000 (16001 for `WaitForFrame2`, as in Flash Player), the most a SWF can have.
  - For a frame that is not loaded, the next N action records are skipped (records, not bytes); skipping stops at `ActionEndFlag`.
  - `WaitForFrame2` pops the frame: an integer number, or a string holding one; anything else counts as frame 0. An unknown value ends the script (`avm1:unknownCondition`).
  - Without a target (after a `SetTarget` that found nothing), the frame counts as loaded.
- **Loops** run until they end or until `maxActionSteps` actions have run in the tick or event (`avm1:budget`). A loop that pushes values also stops at `maxActionStack`. The same script with the same variables always follows the same path.

#### Values and operators

Conversions follow Flash Player for each SWF version (`avm1/values.js`):

| Conversion | Rule |
|---|---|
| To number | `undefined` and `null` are 0 before SWF 7, NaN from SWF 7. Booleans are 1 and 0. |
| String to number | Leading whitespace is allowed. From SWF 5 the rest must be a number (`"12abc"` is NaN); SWF 4 ignores the trailing text and gives 0 for a string that is not a number. From SWF 6, `"0x1F"` is hexadecimal and `"010"` octal (32-bit integers); a sign before `0x` gives NaN. `"Infinity"` is not a number. |
| To string | `undefined` is `""` before SWF 7 and `"undefined"` from SWF 7. Booleans are `"1"` and `"0"` before SWF 5. Numbers have up to 15 significant digits, in exponent form from 1e15 up and below 1e-5 (`"1e+15"`, `"2.5e-7"`); `0.1 + 0.2` prints `"0.3"`. |
| To boolean | Before SWF 7 a string is true when it converts to a number other than 0; from SWF 7 when it is not empty. |

- **Results:** comparisons and logical operators push booleans in every version, as Flash Player does.
- **SWF 4 operators** (`Add`, `Equals`, `Less`, …) convert both operands to numbers, so two strings that are not numbers compare equal in SWF 4 (both are 0) and different from SWF 5 (both are NaN). Dividing by zero gives the string `"#ERROR#"` in SWF 4, and Infinity or NaN from SWF 5.
- **`Add2`** concatenates when either operand is a string. **`Equals2`** treats `undefined` and `null` as equal, compares a boolean as 1 or 0, and a number with a string as numbers; NaN equals NaN. **`Less2`** compares two strings by UTF-16 code units and anything else as numbers, and gives `undefined` when a number is NaN.
- **Strings:** `StringExtract` and `MBStringExtract` count from 1, and a negative length takes the rest. Lengths and character codes are in UTF-16 units; a surrogate gives U+FFFD.
- **Bitwise actions** work on 32-bit integers and use the low 5 bits of a shift count. `BitURShift` gives a signed result in SWF 8 and 9, as Flash Player does.
- **`RandomNumber`** uses `Math.random`.
- **Known differences:** Flash Player prints numbers with its own digit loop, which differs in a few last-digit rounding cases (for example `0.8000000000000005`, printed `"0.8"` here and `"0.800000000000001"` by Flash Player). Strings in SWF 5 and earlier are decoded as Latin-1, not in the system code page.

#### Variables

Variables live on timelines: the root and each sprite instance (`avm1/variables.js`). They keep their values between frames, and a sprite instance that is removed and placed again starts with none. Names are case-insensitive before SWF 7.

- **Scope:** a frame script or button action reads and sets the variables of its own timeline. After `SetTarget`, variables go to the target; after a `SetTarget` that found nothing, they go to the root, as in Flash Player.
- **Paths:** `GetVariable` and `SetVariable` accept the forms Flash Player understands:
  - `name`;
  - `path:name` and `path.name` (the right-most `:` or `.` separates the variable; `GetVariable` splits at `.` only from SWF 5);
  - `/path` without a variable, for a timeline (SWF 5 and later);
  - target paths with `/`, `..`, `_root`, `_parent`, `_level0`, and, from SWF 5, `this`, `.`, and `:`. A step names a child sprite instance first, then a variable.
- **Movie clips and properties:** a name can be a movie clip property (`_x`, `kid._alpha`, `/kid:_currentframe`; see [Movie clips](#movie-clips)), `_root`, `_parent`, `this`, or a child instance (`kid`), which reads as the movie clip itself. In SWF 4 a movie clip reads as `undefined`, as in Flash Player. A path step can be a variable that holds a movie clip.
- **Global names:** a plain name not found on the scope chain is looked up on the global object (`Math`, `Array`, `parseInt`, …; see [Functions and objects](#functions-and-objects)). Built-in objects that are not implemented yet (`Date`, `TextField`, `XML`, `System`, …) read as unknown values, reported as `avm1:objectValue`.
- **Setting:**
  - `SetVariable` on a movie clip property sets the property;
  - `SetVariable` on `_root` or `_parent`, or through a path that crosses an unknown value, sets nothing and reports `avm1:variableNotSet`;
  - a name that is an unknown value reports `avm1:unknownName`;
  - a path that leads nowhere sets nothing, as in Flash Player.
- **Locals:** outside functions, `DefineLocal` sets a variable of the scope timeline, and `DefineLocal2` creates one as `undefined` when it does not exist.

**Text fields bound to a variable** (`VariableName` of `DefineEditText`) show the variable of their timeline, or of the timeline their path names (`_root.score`, `kid:label`).

- When the field is placed, an existing variable gives the field its text. Otherwise, non-empty initial text becomes the variable's value.
- Afterwards the field shows the variable's current value, converted to a string: `score = 42` shows `42`. HTML fields read the value as HTML.
- While the variable does not exist or holds an unknown value, the field keeps its last text.
- Typing into input fields is not supported yet.

#### Movie clips

Movie clips are values (`avm1/properties.js`, `avm1/values.js`): `typeof` gives `"movieclip"`, a clip converts to its dot path (`"_level0.kid"`) and to NaN, `Add2` concatenates its path, and two clips are equal when their paths are. `TargetPath` gives the dot path, or `undefined` for anything that is not a clip. Instances placed without a name are named `instance1`, `instance2`, … in the order they are created.

**Properties**, read and set with `GetProperty`/`SetProperty` (by index) or as variables (case-insensitive names):

| # | Property | Read | Set |
|---|---|---|---|
| 0, 1 | `_x`, `_y` | position in the parent, in pixels | truncated to twips; Infinity becomes the lowest integer |
| 2, 3 | `_xscale`, `_yscale` | percent | keeps rotation and the hidden skew |
| 4, 5, 12 | `_currentframe`, `_totalframes`, `_framesloaded` | frames (every frame is loaded) | read-only |
| 6 | `_alpha` | percent of the alpha multiplier | Infinity sets 0 |
| 7 | `_visible` | boolean | through a number: 0 hides; `"false"` (NaN) does nothing |
| 8, 9 | `_width`, `_height` | size of the bounds in the parent, in pixels | scales the clip |
| 10 | `_rotation` | degrees, -180 to 180 | normalized to ±180, keeps the scale |
| 11 | `_target` | slash path (`/kid`, `/` for the root) | read-only |
| 13 | `_name` | instance name | renames the instance |
| 14, 15 | `_droptarget`, `_url` | `""` (`undefined` for `_droptarget` before SWF 6) | read-only |
| 16–19 | `_highquality`, `_focusrect`, `_soundbuftime`, `_quality` | 1, `true` (1 before SWF 6), 5, `"HIGH"` | ignored |
| 20, 21 | `_xmouse`, `_ymouse` | the pointer in the clip's own space, in pixels | read-only |

- `undefined`, `null`, and NaN set no numeric property. Scale, rotation, and skew are read from the matrix once and kept, so setting one keeps the others exactly; the matrix holds 32-bit floats, as in Flash Player.
- `_width` and `_height` use the bounds of shapes, text, text fields, bitmaps, and visible children. On a rotated clip, setting them matches the axis-aligned box of the rotated content, which can differ from Flash Player's own rule.
- An object whose matrix or colour transform a script changed is no longer moved by the timeline, as in Flash Player.
- `_visible = 0` hides the clip and its children, and they are not hit. Masks still mask. Properties of `_root` apply to the whole movie.

**Timeline actions:**

- `GotoFrame2` addresses the target (or the root). Its frame is an integer number, or a string: a frame number, a label, or `path:frame` / `path.frame` for another timeline. The scene bias is added; a frame below 1 does nothing, one past the end goes to the last frame. The clip then plays or stops. An unknown frame ends the script (`avm1:unknownValue`).
- `SetTarget2` takes a movie clip or a path. `undefined` returns to the script's own timeline up to SWF 6; from SWF 7 it leaves no target (timeline actions do nothing, and variables go to the root).
- `GetProperty` and `SetProperty` take a clip or a path; an empty path is the current target. Invalid indexes and targets read `undefined` and set nothing.
- `CloneSprite` (`duplicateMovieClip`) creates a new instance of a sprite instance's character in the same parent, at the given depth plus 16384 (script depths 0 to 2,130,706,428, as in Flash Player). It copies the matrix and colour transform, takes the new name, and replaces what was at that depth; its frame-1 script runs. The root cannot be duplicated.
- `RemoveSprite` (`removeMovieClip`) removes only clips created by `CloneSprite`. Removing the current target returns to the script's own timeline.
- Clips created by scripts stay when their parent's timeline rewinds.

#### Game APIs

**Clip events.** Every frame, each clip on stage gets its `enterFrame` event, then its timeline advances; children come before their parents, as in Flash Player. A clip placed by its parent's timeline, by `duplicateMovieClip`, or by `attachMovie` gets `initialize` and `load` after its own frame-1 script; a clip that leaves the stage, and every clip inside it, gets `unload`. An event runs:

- the clip's `onClipEvent` actions for it (`PlaceObject2`/`3` clip actions, run in the clip's own context), then
- the clip's AS2 method: `onEnterFrame`, `onLoad`, `onUnload`, `onMouseDown`, `onMouseUp`, `onMouseMove`, `onPress`, `onRelease`, `onReleaseOutside`, `onRollOver`, `onRollOut`, `onDragOver`, `onDragOut`, `onData`, called with the clip as `this`.

Events, timers, and listeners are queued with the frame scripts and share their budgets.

**Mouse and keyboard.** Mouse moves, presses, and releases go to every clip (`mouseMove`, `mouseDown`, `mouseUp`) and then to the `Mouse` listeners. Keys go to every clip's `onClipEvent(keyDown/keyUp)` and then to the `Key` listeners (`onKeyDown`, `onKeyUp`); `onClipEvent(keyPress "<key>")` runs for its key (SWF key codes, as buttons use). The player keeps arrow keys, space, page and home/end keys from scrolling the page, and releases every key when the canvas loses focus.

- `Key`: `isDown(code)` (Windows virtual key codes, as in Flash Player: `Key.LEFT` is 37), `getCode`, `getAscii`, `isToggled` (always false), the key constants, `addListener`, `removeListener`.
- `Mouse`: `hide` (the cursor becomes `none`), `show`, `addListener`, `removeListener`.
- **Clips as buttons:** a clip with `onPress`, `onRelease`, `onReleaseOutside`, `onRollOver`, `onRollOut`, `onDragOver`, or `onDragOut` (methods or clip actions) is picked like a button: its shapes are its hit area, it takes the pointer for everything inside it, the cursor becomes a hand, and the events follow the button rules. Its `enabled` member set to a false value makes it no button (no events, no hand; one being pressed or hovered is forgotten without events), and `useHandCursor` set to a false value keeps the arrow. Both follow the prototype chain, so `MovieClip.prototype.useHandCursor = false` applies to every clip.

**Timers.** `getTimer()` and `GetTime` give the milliseconds since the movie started. `setInterval(fn, ms, …)` and `setInterval(object, "method", ms, …)` call the function every `ms` milliseconds; `setTimeout` once; `clearInterval` and `clearTimeout` stop them. Timers run between frames, at most once per check each; a movie has at most 10,000 timers. `updateAfterEvent` does nothing: the player redraws after every event.

**Dragging.** `startDrag` (the action and the method) makes a clip follow the pointer, with its origin under the pointer (`lockCenter`) or keeping its offset, inside an optional rectangle in its parent's space. One clip is dragged at a time; `stopDrag` (`EndDrag`) ends it. `_droptarget` is the slash path of the deepest clip under the pointer.

**MovieClip methods:** `hitTest(x, y, shapeFlag)` (a point in `_root` coordinates, against the shapes or the bounds), `hitTest(target)` (overlapping bounds), `getBounds(space)` (an empty clip gives 6710886.35 on every side, as in Flash Player), `localToGlobal`, `globalToLocal`, `attachMovie(name, instanceName, depth, initObject)` (by `ExportAssets` name; the init object's properties are copied), `createEmptyMovieClip`, `swapDepths(depth or clip)` (both clips are then managed by scripts), `getNextHighestDepth`, `getInstanceAtDepth`, `getSWFVersion`, `startDrag`, `stopDrag`.

**Other objects:** `Stage` (`width`, `height`, `scaleMode`, `align`, `showMenu`; no resize events), `Color` (`setRGB`, `getRGB`, `setTransform`, `getTransform` on a clip's colour transform), and `Sound` (see below).

**`Sound`** plays library sounds and MP3 files through the player's audio (see [Sound](#sound)):

- `new Sound(clip)` controls the sounds of that clip, and `new Sound()` controls every sound. A `Sound` whose clip left the stage does nothing.
- Volume, pan, and transform belong to the clip, shared by every `Sound` of that clip, or, without a clip, to every sound. A sound is scaled by the transforms of the clip that owns it and of that clip's parents, then by the global one.
- `attachSound(name)` takes a sound exported with `ExportAssets` by the movie of the clip, or of the root. A name that matches no sound is reported (`sound:attachMissing`).
- `start(secondOffset, loops)` plays a new instance. `stop()` stops the clip's sounds (every sound, without a clip), and `stop(name)` stops every instance of that sound.
- `setVolume` and `getVolume` (percent), `setPan` and `getPan` (−100, left only, to 100, right only: the other side is turned down), and `setTransform` and `getTransform` (`{ ll, lr, rr, rl }` in percent).
- `duration` and `position` are in milliseconds; `position` is updated every frame. `onSoundComplete` is called when a sound the object started finishes.
- `loadSound(url, isStreaming)` loads an MP3 file through the host page's loader (request type `'sound'`), then calls `onLoad(success)`. A streaming sound starts as soon as it has arrived and plays one instance at a time. `getBytesLoaded` and `getBytesTotal` give the file's size once it is loaded. ID3 tags are skipped, not read.

**`DoInitAction`** scripts run once per movie, the first time their frame is entered, before that frame's `DoAction` scripts, on the root timeline.

#### Loading into clips

The `Player` API does not fetch files itself. A script that loads a movie, an image, or variables asks the host page, through the Player option `loader` (or, without one, `host.load`; see [Browser interaction](#browser-interaction)):

```js
const files = new Map([['visor.swf', visorFile], ['img1.jpg', photoFile]]); // Files or Uint8Arrays
const player = new RetroFlash.Player({
  canvas,
  // request: { url, type: 'movie' | 'variables' | 'sound', method: null | 'GET' | 'POST' }
  loader: (request) => files.get(request.url.split('/').pop()) || null
});
```

- **The loader** receives the URL as the script wrote it and decides whether it may be loaded and where its bytes come from. It returns, or resolves to, a `Uint8Array`, another typed array, an `ArrayBuffer`, a `Blob`, or (for variables) a string; For a movie load it may also give an image the browser decoded (`HTMLImageElement`, `ImageBitmap`, canvas). `null` or `undefined` refuses the URL (`load:refused`). An error with `code` `LOAD_CORS`, `LOAD_NETWORK`, `LOAD_HTTP`, `LOAD_BLOCKED` or `INVALID_URL` is reported as `load:cors`, `load:network`, `load:http`, `load:blocked` or `load:invalidURL`; any other as `load:failed`. Failures are recoverable: the clip stays empty.
- **Requests:** `{ url, type, method }`. With `GET` or `POST`, the variables of the script's timeline (or the clip, for its methods) are sent as strings, URL-encoded: appended to `url` for `GET`, as `body` for `POST`; `variables` holds the pairs. Without a loader, a load is reported (`load:noLoader`) and nothing changes. A loader that uses `fetch` belongs to the page, which should only allow the URLs it trusts.
- **Targets:** `GetURL2` with its load-into-clip flag names the clip by a target path or a clip value, from the script's target; the MovieClip methods `loadMovie(url, method)`, `unloadMovie()`, and `loadVariables(url, method)` load into their clip; `_level0` is the root. Other levels are not supported (`load:level`).
- **Movies:** a movie load empties the clip at once: its children leave with their `unload` events, the clip gets its own `unload`, and its variables and methods are cleared. It keeps its name, depth, transform, and clip events. When the file arrives, the clip plays the loaded movie's root timeline from frame 1 and gets `load`. The loaded movie keeps its own dictionary and SWF version: its scripts follow its version's rules (the built-in objects follow the main movie's), `getSWFVersion()` and `_url` report it, and its `_root` is the main movie's root. A failed load leaves the clip empty.
- **Images:** a JPEG, PNG, or GIF file is shown at the clip's origin, one pixel per 20 twips. Its pixels come from a budget shared by everything loaded at once (`maxBitmapPixels` per image, `maxTotalBitmapPixels` in all); a movie's bitmaps take from the same budget. Unloading or replacing the content gives them back.
- **Sounds:** `Sound.loadSound` asks for an MP3 file (request type `'sound'`); see [Sound](#sound) for what follows. A file without MP3 frames is reported (`load:failed`).
- **Variables:** the text is read as URL-encoded `name=value` pairs (UTF-8 from SWF 6, Latin-1 before; `+` is a space) and set on the clip as strings; then the clip gets `data`.
- **Timing:** what arrives is shown between frames, after the tick's scripts, or at once when the movie is not playing. A newer movie load into the same clip, or an unload, cancels an older one. At most 8 loads wait for the loader at once; more are dropped (`load:limit`). A file that is not a SWF, JPEG, PNG, or GIF, or that cannot be read, is reported (`load:failed`).
- **Cleanup:** `stop()`, `load()`, and `destroy()` free loaded content, and drop loads that finish later.

#### Browser interaction

What a movie asks of the page that embeds it goes to the Player option `host`, an object with any of these methods (each optional), and `objectID`:

| Method | Called for | Request |
|---|---|---|
| `navigate(request)` | `getURL` to a window (`GetURL`, `GetURL2`, `MovieClip.getURL`) | `{ url, target, method }`; with `GET`/`POST` also `variables` (and `body` for `POST`), as for loads |
| `call(request)` | `javascript:` URLs and `ExternalInterface.call`; its return value is the call's result | `{ kind: 'javascript' \| 'external', name, args, source }` |
| `fscommand(request)` | `fscommand(command, args)` (`FSCommand:` URLs) | `{ command, args }` |
| `load(request)` | loads, when there is no `loader` option | see [Loading into clips](#loading-into-clips) |

- **URLs** reach the host as the script wrote them; the host resolves them. An empty URL does nothing.
- **`javascript:` URLs are never evaluated.** The text (percent-decoded) is read as statements separated by `;`: calls `name(…)` or `a.b.name(…)` whose arguments are literals (numbers, strings, `true`, `false`, `null`, `undefined`), and `void …`. Each call goes to `host.call` with its name and arguments: `javascript:panorama(2)` calls `panorama` with the number 2. Any other text goes to the host with `name: null`, and the browser host refuses it (`browser:javascriptUnsupported`).
- **ExternalInterface** is available when there is a host. `call(name, args…)` converts the arguments to JavaScript (arrays, plain objects of the enumerable members; functions and cycles are `null`) and the result back; it gives `null` when the call fails. `addCallback(name, instance, method)` registers a function; the page calls it with `player.callback(name, [args])`, which runs it at once (a call made while the movie is calling the page is allowed) and redraws. The `callbacks` event gives the registered names.
- **Events:** `navigate`, `call` and `fscommand` listeners get the request before the host. A listener that calls `request.preventDefault()` handles it, and for a call may set `request.result`.
- **Interaction log:** `interaction` fires for outgoing navigation, page calls, FSCommands, `ExternalInterface.addCallback` registrations and clip loads, and for incoming `ExternalInterface` callbacks. Each frozen entry has `id`, `time` (Unix milliseconds), `direction` (`outgoing` or `incoming`), `channel`, `status`, and useful fields such as URL path, target, method, variable count, function name, argument count, resource type, or error code. Query strings, POST bodies, and argument values are omitted. `getInteractionLog()` returns the latest 100 entries; `clearInteractionLog()` clears them. The demo shows the latest 30.
- **Diagnostics:** `browser:noHost` (no host, or no method for it), `browser:blocked`, `browser:invalidURL`, `browser:functionMissing`, `browser:callFailed`, `browser:javascriptUnsupported` (from host errors with the codes `BLOCKED`, `INVALID_URL`, `FUNCTION_MISSING`, `CALL_FAILED`, `UNSUPPORTED`), `browser:callbackMissing`, and `avm1:targetNotFound` for a load whose clip does not exist.

##### The browser host

`RetroFlash.createBrowserHost(options)` implements the host with the browser's own APIs, as the Flash Player plugin did:

- `navigate`: `location.assign` for the current window, `window.open(url, target)` otherwise, a hidden form for `POST`;
- `call`: calls the page function by name with `this` set to its owner; `eval`, `Function`, `setTimeout`/`setInterval` with text, `document.write`, names through `constructor`/`prototype`/`__proto__`, and `javascript:` arguments are refused (`BLOCKED`);
- `fscommand`: calls `<objectID>_DoFSCommand(command, args)`;
- `load`: `fetch` in CORS mode. A cross-origin response the server does not allow is `LOAD_CORS`, never bypassed; a cross-origin image may still be shown (as an `<img>` would be), without the movie reading its pixels.

| Option | Default | Meaning |
|---|---|---|
| `base` | the page | Base of relative URLs (the plugin's `base` parameter) |
| `objectID` | `null` | `ExternalInterface.objectID` and the FSCommand handler name |
| `allowScriptAccess` | `true` | `false` refuses page calls, FSCommand, and replacing the page (`_self`, `_parent`, `_top`) |
| `allowNetworking` | `'all'` | `'internal'` also refuses opening pages; `'none'` also refuses loads |
| `rewriteUrl(url, request)` | none | Returns the URL to use instead of the resolved one, for example a local copy of a remote file |
| `maxFileBytes` | 50 MiB | Largest response read |

Integrating a page function, as a legacy page with `panorama(num)` did:

```js
const player = new RetroFlash.Player({ canvas, host: RetroFlash.createBrowserHost({ objectID: 'prue004' }) });
player.on('call', (r) => console.log('the movie calls', r.name, r.args)); // panorama [2]
await player.load(bytes, { url: 'example_1.swf' });
```

##### Legacy markup

The bundle replaces each Flash `<object>`/`<embed>` with a canvas that plays its SWF through the browser host. It reads `movie`/`src`/`data`, `base`, `FlashVars` (and the movie URL's query), `allowScriptAccess` (`always`, `never`, or `sameDomain`, the default: allowed when the SWF has the page's origin), `allowNetworking`, and `bgcolor`. The canvas takes the element's id; ExternalInterface callbacks become its methods. The page must be served over HTTP or HTTPS. Optional `window.RetroFlashConfig = { autoplay, base, allowScriptAccess, allowNetworking, rewriteUrl }`, set before the bundle runs, overrides them; the canvas dispatches a bubbling `retroflash:player` event (`detail: { player, element }`) before loading.

#### Functions and objects

**Objects** (`avm1/objects.js`) have a prototype and their own properties; names are case-insensitive before SWF 7. Arrays keep their elements in order and their `length` in step. Movie clips are objects too: their members are their properties (`_x`, …), `_root` and `_parent`, their variables, their child instances, and then `MovieClip.prototype`. Strings, numbers, and booleans take their members from `String.prototype` and the others; `"abc".length` is 3.

- `InitObject` and `InitArray` build objects and arrays (`{x: 1}`, `[1, 2]`); `GetMember`, `SetMember`, `Delete`, and `Delete2` read, set, and delete members.
- `for..in` (`Enumerate`, `Enumerate2`) lists own properties first, the most recently added first, as Flash Player does, then the prototype chain's. Built-in members are hidden.
- **Conversions:** an object becomes a number through its `valueOf()` and a string through its `toString()` (`"[object Object]"` by default, `"[type Function]"` for a function without one); `Add2` uses `valueOf()` and concatenates when it gives no primitive. Two objects are equal only when they are the same object.

**Functions:** `DefineFunction` and `DefineFunction2` make functions; a named one becomes a variable (a local inside a function), an anonymous one is pushed.

- **Calls:** `CallFunction` calls a function by name, with `this` set to the object it was found on (the timeline, for a timeline function) or the target. `CallMethod` calls `object.name(…)` with `this` set to the object; on `undefined` or `null` it gives `undefined`, and an empty name calls the object itself. Calling something that is not a function gives `undefined`.
- **Scope:** from SWF 6 a function closes over the scope chain and timeline where it was defined; in SWF 5 it runs on the timeline of `this` (or the caller's target) with a fresh scope chain. Parameters, `DefineLocal` names, `arguments` (with `callee` and `caller`), and `super` are locals; a plain `SetVariable` of a name that is not a local sets it on the timeline.
- **`DefineFunction2`** has its own registers and preloads `this`, `arguments`, `super`, `_root`, `_parent`, and `_global` into them from register 1, as its flags ask; parameters with a register go there.
- **`Return`** gives the call's value; a function that ends without one gives `undefined`.
- **Construction:** `NewObject` and `NewMethod` (`new`) make an object with the constructor's `prototype`, call the constructor with it as `this` (with a hidden `__constructor__`), and give it, unless the constructor returns an object. `Extends` sets up a subclass prototype; `super(…)` calls the superclass constructor and `super.method(…)` the superclass method. `InstanceOf` and `CastOp` follow the prototype chain; `ImplementsOp` is accepted without checks.
- **`with`** puts an object on top of the scope chain for its body; `with` on `undefined` or `null` skips the body.
- **`try`/`catch`/`finally`:** a `Throw` in the try body (or in a function it calls) goes to the catch body, with the stack trimmed back and the value in the catch variable or register; the finally body always runs. An uncaught `Throw` ends the block (`avm1:uncaughtThrow`).
- **`Call`** runs the frame scripts of another frame (a number, a label, or `path:frame`) at once, without going there.

**Built-ins** (`avm1/globals.js`), on the global object of each movie (`_global`):

- `Object` (`toString`, `valueOf`, `hasOwnProperty`, `isPropertyEnumerable`, `isPrototypeOf`; `addProperty` and `watch` return false), `Function` (`call`, `apply`), `Error` (`message`, `toString`);
- `Array` (`push`, `pop`, `shift`, `unshift`, `slice`, `splice`, `concat`, `join`, `reverse`, `sort` and `sortOn` with a compare function or the `CASEINSENSITIVE`, `DESCENDING`, `UNIQUESORT`, `RETURNINDEXEDARRAY`, and `NUMERIC` flags, `toString`);
- `String` (`charAt`, `charCodeAt`, `concat`, `indexOf`, `lastIndexOf`, `slice`, `substring`, `substr`, `split`, `toLowerCase`, `toUpperCase`, `String.fromCharCode`), `Number` (`toString(radix)`, the constants), `Boolean`; called as functions they convert;
- `Math` (every method and constant; `random` uses `Math.random`);
- `parseInt`, `parseFloat`, `isNaN`, `isFinite`, `escape`, `unescape`, `NaN`, `Infinity`; `trace` and `ASSetPropFlags` do nothing;
- `MovieClip` methods: `play`, `stop`, `gotoAndPlay`, `gotoAndStop`, `nextFrame`, `prevFrame`, `duplicateMovieClip`, `removeMovieClip`, `getDepth`, `getBytesLoaded`, `getBytesTotal`, `loadMovie`, `unloadMovie`, `loadVariables`, `getURL(url, window, method)`;
- `flash.external.ExternalInterface` (`available`, `objectID`, `call`, `addCallback`); other `flash` packages read as unknown values.

**Limits against hostile scripts:** prototype chains are followed for at most 256 steps; array indexes from 16,777,216 on are plain properties (an array never grows past that); a string built by concatenation, `join`, `concat`, `escape`, or `fromCharCode` that would pass 16,777,216 characters ends the block (`avm1:budget`).

**Not supported yet:** getter/setter properties (`addProperty`), `watch`, `Object.registerClass`, and the other built-in classes.

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
    - the constant pool, registers, frames, labels, paths, URLs, and the flags of `GetURL2`, `GotoFrame2`, `DefineFunction2`, and `Try`. `GetURL2`'s flags are read as Flash Player writes them, not as SWF19 draws them: `0x80` loads variables, `0x40` loads into a clip, and the low two bits are the method (1 `GET`, 2 `POST`; 3 is read as none);
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


### Not supported yet

The full list of limitations, grouped by subject, is in [`../LIMITATIONS.md`](../LIMITATIONS.md). Each of these is reported in `getDiagnostics().unsupported` when it is met:

- ActionScript outside the subset above;
- loads into levels other than `_level0`, `MovieClipLoader`, `LoadVars`, `XML` loading;
- `javascript:` URLs that are not calls with literal arguments (`browser:javascriptUnsupported`); they are never evaluated;
- characters that are placed but not drawn: video;
- static text (`DefineText`) with `DefineFont4` glyphs;
- editing input fields (`text:input`), selection, scrolling, HTML images, kerning and letter spacing, style sheets, and text fields used as masks;
- menu tracking (`trackAsMenu` buttons behave as push buttons), masks during hit testing, and buttons nested inside buttons;
- Nellymoser and Speex sound, `StartSound2`, `Sound.id3`, and slowing or speeding up a timeline to follow its stream sound;
- linear-RGB gradient interpolation;
- blend modes and filters;
- 9-slice scaling in hit testing, masks and stroke widths, and non-scaling strokes in hit testing.

Two parts are only checked by eye, through the demo:

- Pixel accuracy against a reference player has not been measured.
- Drawing is not covered by automated tests. `tests/unit/player.test.js`, `tests/unit/bitmaps-avm1.test.js`, and `tests/unit/text.test.js` cover geometry, timelines, lossless pixels, JPEG table merging, the AVM1 subset, glyph placement, HTML parsing, and text layout.

## Next steps

1. Grow the compatibility corpus (`tools/corpus.js`, see `tests/COMPATIBILITY.md`) with authorized SWF files, and fix what it finds.
2. Filters and blend modes.
