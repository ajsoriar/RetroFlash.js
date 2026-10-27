# SWF Reader — Phase 1

A dependency-free JavaScript reader for SWF file structure. This standalone prototype is intended as a foundation for a future Canvas renderer and ActionScript interpreters.

## Usage

Open `index.html` in a modern browser. No server or external libraries are required.

To use the reader API in a page:

```html
<script src="swf-reader.js"></script>
<input type="file" id="swf" accept=".swf">
<script>
  document.querySelector('#swf').addEventListener('change', async (event) => {
    const movie = await SWFReader.load(event.target.files[0]);
    console.log(movie.width, movie.height, movie.fps, movie.tags);
    console.log(movie.getTagData(0)); // Uint8Array containing the first tag's data
  });
</script>
```

## Phase-one coverage

- FWS (uncompressed SWF).
- CWS (zlib) when the browser provides `DecompressionStream('deflate')`.
- Signature, validated file length, stage RECT, frame rate, and frame count.
- Tag table, frame numbers, offsets, sizes, and binary extraction with `getTagData`.
- Background color, frame labels, sprites (declared ID and frame count), and AVM1/AVM2 markers.
- Controlled errors for truncated files and unsupported ZWS.

## Limitations

- Does not play animations, audio, or games. The demo canvas only displays the stage background color.
- Does not parse sprite contents or build a display list.
- `ZWS` (LZMA) is not implemented.
- `CWS` requires native browser support for decompression; there is no JavaScript fallback.
- This is not an ActionScript sandbox: scripts are detected, never executed.
- Use only files from trusted sources. The reader validates sizes and boundaries but is not hardened against hostile input.

## Next phase

Implement an object dictionary (`DefineShape`), display list (`PlaceObject`/`RemoveObject`), and Canvas rendering on `ShowFrame`.
