# Changelog

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
