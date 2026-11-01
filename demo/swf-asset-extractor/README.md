# SWF Asset Extractor

A standalone page that opens a local `.swf` file and lists the resources stored in it: bitmaps (PNG and the original JPEG, PNG, or GIF), vector shapes (SVG), morph shapes (start and end SVG), sounds and stream sounds (MP3 or WAV), fonts, texts, binary data, and ActionScript bytecode. Each resource row also explains what was converted and what was not. The file is read in the browser and never uploaded. ActionScript is extracted as bytes and never run.

Serve the folder over HTTP (for example `npx http-server` or `python -m http.server` from the project root) and open `demo/swf-asset-extractor/index.html`. The page needs nothing outside this folder.

| File | Role |
|---|---|
| `index.html`, `extractor.css` | The page |
| `app.js` | File selection, progress, and the resource table (built with `textContent` only) |
| `extract.js` | Finds and converts the resources (`SWFAssetExtractor.analyze`) |
| `swf-extractor-core.js` | **Generated.** The project's SWF reader and decoders (`src/`), bundled for this page |
| `build-core.js` | Rebuilds `swf-extractor-core.js` |

`swf-extractor-core.js` holds copies of `src/swf-reader.js`, `src/core/base.js`, `src/core/math.js`, `src/render/geometry.js`, `src/render/morph.js`, `src/display/bitmaps.js`, `src/audio/codecs.js`, and `src/text/fonts.js`. Rebuild it whenever one of them changes:

```sh
node demo/swf-asset-extractor/build-core.js           # write the bundle
node demo/swf-asset-extractor/build-core.js --check   # fail when it is out of date
```

The modules run with a private global object. The page itself only gets `window.SWFExtractorCore` and `window.SWFAssetExtractor`.
