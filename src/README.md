# SWF Reader (v0.3)

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

`SWFReader.BitReader` exposes the bounds-checked, MSB-first bit reader: `readUB`, `readSB`, `readFB`, `align`, `readUI8`, `readUI16`, `readUI32`, `readString`, `readRect`, `readMatrix`, `readCxform`, and `readCxformWithAlpha`.

## Coverage in v0.3

- FWS. CWS (zlib) through `DecompressionStream('deflate')`; decompression stops as soon as the output exceeds the declared length.
- Header: signature, version, declared length, stage RECT, frame rate (8.8), and frame count.
- Tag record headers in short and long form, validated against the enclosing range (the file or the sprite). A negative long length is rejected.
- Recursive index of `DefineSprite` control tags with sprite-local frames, and a check of which tags are allowed inside sprites.
- Decoded tags: `End`, `ShowFrame`, `SetBackgroundColor`, `FrameLabel` (with the named anchor from SWF 6), `FileAttributes`, `PlaceObject`, `PlaceObject2`, `PlaceObject3` (up to blend mode, bitmap cache, visibility, and background color), `RemoveObject`, `RemoveObject2`, and `DefineSprite`.
- `DefineShape`, `DefineShape2`, `DefineShape3`, and `DefineShape4` are decoded (since v0.3). `fields` contains:
  - `shapeId`, `shapeVersion`, `bounds`;
  - `fillStyles`: `solid`, `linear`, `radial`, `focal`, or `bitmap`, with gradient matrices and stops;
  - `lineStyles`: `LINESTYLE`, or `LINESTYLE2` with caps, joins, and fill;
  - `records`: style changes with absolute `moveTo` and new style arrays, plus `line`/`curve` edges as deltas in twips;
  - for `DefineShape4` only: `edgeBounds` and the fill-winding and scaling-stroke flags.

  Colours are always `{r, g, b, a}`.
- Strings: UTF-8 from SWF 6; Latin-1 before SWF 6.
- `DoAction`, `DoInitAction`, and `DoABC` are counted in `movie.codeTags` and listed as unsupported. Their bytes are available through `getTagData`, and they are never executed.

## Limitations

- The reader itself does not render. Playback is handled by `retroflash.js` (see below).
- Bitmaps, fonts, text, buttons, sounds, video, and morph shapes are indexed but not decoded.
- Not parsed yet: `PlaceObject2`/`PlaceObject3` clip actions and the `PlaceObject3` filter list. Button actions inside `DefineButton`/`DefineButton2` are not detected, so they are missing from `codeTags`.
- `ZWS` (LZMA) is rejected. `CWS` needs native `DecompressionStream`; there is no JavaScript inflate fallback yet, so CWS fails with `CWS_UNSUPPORTED` in older browsers.
- Strings in files older than SWF 6 used the author's locale encoding, which the file does not record; they are decoded as Latin-1.
- `End` and any tag after the last `ShowFrame` report `frame = actualFrameCount + 1`, as in v0.1.
- The reader checks bounds and limits, and the tests include controlled fuzzing. It has not had an independent security review, so treat hostile files with care.

## Tests

From the project root, run `node tests/run.js` (Node 16+, no dependencies). See [`../tests/COMPATIBILITY.md`](../tests/COMPATIBILITY.md).

# RetroFlash.Player — milestone 1 (`retroflash.js` v0.1)

Load `swf-reader.js` first, then `retroflash.js`. The demo is [`../demo/player.html`](../demo/player.html).

```js
const player = new RetroFlash.Player({ canvas, autoplay: false, loop: true, maxFileBytes: 50 * 1024 * 1024 });
await player.load(fileOrBuffer);     // same inputs as SWFReader.load; resolves with getInfo()
player.play(); player.pause(); player.stop(); player.step();
player.seek(10); player.seek('label');
player.getInfo();         // { state, version, width, height, fps, frameCount, currentFrame, labels, ... }
player.getDiagnostics();  // { diagnostics (reader), unsupported (reader + player) }
player.on('load' | 'frame' | 'warning' | 'error' | 'end', fn); player.off(type, fn);
player.destroy();
```

### Behaviour

- **States:** `idle`, `loading`, `ready`, `playing`, `paused`, `error`, `destroyed`. Player errors have `name` `'RetroFlashError'` and a `code`; load errors are the reader's `SWFReaderError`.
- **Canvas:** the canvas is resized to the stage size × `devicePixelRatio`. Its CSS width is set to the stage width with `height: auto`.
- **Timing:** `requestAnimationFrame` with a time accumulator at the SWF frame rate. When the page falls behind, at most `maxCatchUpFrames` (default 4) frames are advanced per animation frame and the rest are dropped. A rate of 0 fps plays at 12 fps and is reported.
- **Ticks:** each tick advances the sprite instances that already exist, then moves the root to its next frame. Sprites placed in that frame start at their own frame 1. The root loops by default and emits `end` each time it passes its last frame; with `loop: false` it stops there.
- **Seeking:** `seek` backwards rebuilds the display list from frame 1. Instances whose depth still holds the same character are kept, so they keep their own playhead.
- **Shapes:**
  - Edges are grouped by fill style, with FillStyle0 edges reversed, and linked into closed contours.
  - Fills use the even-odd rule, or non-zero when `DefineShape4` sets the winding flag.
  - Gradients use the SWF ±16384-twip gradient square, transformed by the gradient matrix.
  - Colour transforms are applied exactly to vector colours.
  - Strokes are at least one device pixel wide. `DefineShape4` caps and joins are honoured.
- **Masks:** `clipDepth` masks use the union of the mask's fills, including sprite masks, as a Canvas clip.

### Not supported yet

Each of these is reported in `getDiagnostics().unsupported` when it is met:

- ActionScript (never executed);
- characters that are placed but not drawn: bitmaps, text, buttons, morph shapes, video;
- bitmap fills;
- gradient spread modes other than pad, and linear-RGB interpolation;
- gradient and bitmap line fills (drawn with their first colour);
- blend modes, filters, and non-scaling strokes;
- 9-slice scaling, sound, and input.

Two parts are only checked by eye, through the demo:

- Pixel accuracy against Flash Player or Ruffle has not been measured.
- Drawing is not covered by automated tests; `tests/unit/player.test.js` covers geometry and timelines.

## Next steps

1. Bitmaps: `DefineBitsJPEG2/3` and `DefineBitsLossless[2]`, plus bitmap fills.
2. A minimal AVM1 for timeline control: `stop`, `play`, `gotoAndPlay`/`gotoAndStop`, `nextFrame`/`prevFrame`.
3. Buttons (`DefineButton2`), with hit testing and their actions.
