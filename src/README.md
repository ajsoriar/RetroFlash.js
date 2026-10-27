# SWF Reader — Phase 1 (v0.2)

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

## Coverage in v0.2

- FWS. CWS (zlib) through `DecompressionStream('deflate')`; decompression stops as soon as the output exceeds the declared length.
- Header: signature, version, declared length, stage RECT, frame rate (8.8), and frame count.
- Tag record headers in short and long form, validated against the enclosing range (the file or the sprite). A negative long length is rejected.
- Recursive index of `DefineSprite` control tags with sprite-local frames, and a check of which tags are allowed inside sprites.
- Decoded tags: `End`, `ShowFrame`, `SetBackgroundColor`, `FrameLabel` (with the named anchor from SWF 6), `FileAttributes`, `PlaceObject`, `PlaceObject2`, `PlaceObject3` (up to blend mode, bitmap cache, visibility, and background color), `RemoveObject`, `RemoveObject2`, and `DefineSprite`.
- Strings: UTF-8 from SWF 6; Latin-1 before SWF 6.
- `DoAction`, `DoInitAction`, and `DoABC` are counted in `movie.codeTags` and listed as unsupported. Their bytes are available through `getTagData`, and they are never executed.

## Limitations

- No rendering, display list, or playback. The demo canvas shows only the stage size and background color.
- Shapes, bitmaps, fonts, text, buttons, sounds, video, and morph shapes are indexed but not decoded.
- Not parsed yet: `PlaceObject2`/`PlaceObject3` clip actions and the `PlaceObject3` filter list. Button actions inside `DefineButton`/`DefineButton2` are not detected, so they are missing from `codeTags`.
- `ZWS` (LZMA) is rejected. `CWS` needs native `DecompressionStream`; there is no JavaScript inflate fallback yet, so CWS fails with `CWS_UNSUPPORTED` in older browsers.
- Strings in files older than SWF 6 used the author's locale encoding, which the file does not record; they are decoded as Latin-1.
- `End` and any tag after the last `ShowFrame` report `frame = actualFrameCount + 1`, as in v0.1.
- The reader checks bounds and limits, and the tests include controlled fuzzing. It has not had an independent security review, so treat hostile files with care.

## Tests

From the project root, run `node tests/run.js` (Node 16+, no dependencies). See [`../tests/COMPATIBILITY.md`](../tests/COMPATIBILITY.md).

## Next phase

- A character dictionary and a display list built from `PlaceObject*`/`RemoveObject*`.
- A deterministic timeline for the root movie and sprites.
- Then `DefineShape` rendering on Canvas.
