| File | SWF | Frames | AVM1 steps | Status | Parser | VM | API | Render | Input | Features |
|---|---|---|---|---|---|---|---|---|---|---|
| cws-minimal.swf | 10 | 1 | 0 | ok | ok | ok | ok | ok | ok |  |
| fws-actions.swf | 6 | 6 | 13 | partial | ok | ok | partial | ok | ok | browser:noHost |
| fws-animation.swf | 8 | 48 | 0 | ok | ok | ok | ok | ok | ok |  |
| fws-bitmaps.swf | 8 | 1 | 0 | ok | ok | ok | ok | ok | ok |  |
| fws-browser.swf | 7 | 3 | 18 | partial | ok | ok | partial | ok | ok | load:noLoader ×2 |
| fws-buttons.swf | 6 | 2 | 8 | ok | ok | ok | ok | ok | ok |  |
| fws-game.swf | 6 | 1 | 1808 | ok | ok | ok | ok | ok | ok |  |
| fws-minimal.swf | 10 | 1 | 0 | ok | ok | ok | ok | ok | ok |  |
| fws-nested-sprite.swf | 10 | 1 | 0 | partial | partial | ok | ok | ok | ok | SPRITE_FRAME_COUNT_MISMATCH, SPRITE_MISSING_END, TAG_NOT_ALLOWED_IN_SPRITE ×2 |
| fws-sound.swf | 6 | 12 | 18 | ok | ok | ok | ok | ok | ok |  |
| fws-text.swf | 10 | 1 | 0 | partial | ok | ok | ok | partial | ok | text:input |
| fws-timeline.swf | 10 | 2 | 1 | ok | ok | ok | ok | ok | ok |  |
| fws-unsupported.swf | 10 | 1 | 0 | partial | partial | ok | ok | partial | ok | actionscript:DoABC, tag:Unknown_1000, render:blendMode ×7, render:missingCharacter ×2 |
| fws-bytes-after-end.swf | 10 | 1 | 0 | partial | partial | ok | ok | ok | ok | TRAILING_BYTES_AFTER_END |
| fws-extra-file-bytes.swf | 10 | 1 | 0 | partial | partial | ok | ok | ok | ok | TRAILING_FILE_BYTES |
| fws-frame-count-mismatch.swf | 10 | 3 | 0 | partial | partial | ok | ok | ok | ok | FRAME_COUNT_MISMATCH |
| fws-invalid-bodies.swf | 10 | 1 | 0 | partial | partial | ok | ok | ok | ok | TAG_EXTRA_BYTES, TRUNCATED_DATA ×3 |
| fws-missing-end.swf | 10 | 1 | 0 | partial | partial | ok | ok | ok | ok | MISSING_END |
| fws-sprite-overflow.swf | 10 | 1 | 0 | partial | partial | ok | ok | ok | ok | TAG_OUT_OF_BOUNDS |
| bad-signature.swf |  |  |  | **failed** | **failed** | ok | ok | ok | ok |  — parser: SWFReader: Unknown SWF signature: "XWS" |
| cws-corrupt.swf |  |  |  | **failed** | **failed** | ok | ok | ok | ok |  — parser: SWFReader: Could not decompress CWS (zlib): incorrect header check |
| cws-declared-too-long.swf |  |  |  | **failed** | **failed** | ok | ok | ok | ok |  — parser: SWFReader: Declared length is 40 bytes but the decompressed SWF has 36 |
| cws-declared-too-short.swf |  |  |  | **failed** | **failed** | ok | ok | ok | ok |  — parser: SWFReader: Decompressed CWS data exceeds the declared length (24 bytes) |
| cws-truncated.swf |  |  |  | **failed** | **failed** | ok | ok | ok | ok |  — parser: SWFReader: Could not decompress CWS (zlib): unexpected end of file |
| declared-length-huge.swf |  |  |  | **failed** | **failed** | ok | ok | ok | ok |  — parser: SWFReader: Declared length 4294967295 exceeds options.maxFileBytes (52428800) |
| declared-length-too-small.swf |  |  |  | **failed** | **failed** | ok | ok | ok | ok |  — parser: SWFReader: Declared length 10 is smaller than the minimal SWF header (13 bytes) |
| empty.swf |  |  |  | **failed** | **failed** | ok | ok | ok | ok |  — parser: SWFReader: File is too short (0 bytes) to hold an SWF header |
| fws-long-header-truncated.swf |  |  |  | **failed** | **failed** | ok | ok | ok | ok |  — parser: SWFReader: Long header of JPEGTables at offset 23 is truncated |
| fws-long-tag-negative.swf |  |  |  | **failed** | **failed** | ok | ok | ok | ok |  — parser: SWFReader: DoAction at offset 21 declares a negative SI32 length (-1) |
| fws-long-tag-out-of-bounds.swf |  |  |  | **failed** | **failed** | ok | ok | ok | ok |  — parser: SWFReader: DoAction at offset 21 declares 2147483647 byte(s) but only 1 remain in the file |
| fws-tag-out-of-bounds.swf |  |  |  | **failed** | **failed** | ok | ok | ok | ok |  — parser: SWFReader: SetBackgroundColor at offset 21 declares 10 byte(s) but only 2 remain in the file |
| fws-truncated-file.swf |  |  |  | **failed** | **failed** | ok | ok | ok | ok |  — parser: SWFReader: File is truncated: declared 36 bytes, got 20 |
| fws-truncated-rect.swf |  |  |  | **failed** | **failed** | ok | ok | ok | ok |  — parser: SWFReader: SWF header is incomplete: RECT.Xmax needs 31 bit(s) at byte 12 but only 4 remain |
| fws-truncated-tag-header.swf |  |  |  | **failed** | **failed** | ok | ok | ok | ok |  — parser: SWFReader: Tag header at offset 23 is truncated (1 byte left in the file) |
| zws.swf |  |  |  | **failed** | **failed** | ok | ok | ok | ok |  — parser: SWFReader: ZWS uses LZMA compression, which is not implemented yet |
