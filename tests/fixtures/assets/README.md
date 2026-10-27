# Fixture assets

## `gradient-32.jpg`

A 32×32 baseline JPEG (SOF0), 1311 bytes, created for this project on 2026-10-27. It contains:

- a diagonal gradient from `#1e3a8a` to `#14b8a6`;
- a yellow (`#facc15`) circle of radius 9 at the centre;
- a red (`#ef4444`) 8×8 square in the top-left corner.

It was drawn on a Canvas 2D in headless Chrome and exported with `canvas.toDataURL('image/jpeg', 0.92)`. No third-party content.

`tests/fixtures/bitmaps.js` embeds it in `DefineBitsJPEG2` and `DefineBitsJPEG3`. It also splits it into `JPEGTables` (DQT/DHT) plus `DefineBits`, which it can do because the file is baseline with separate table segments.
