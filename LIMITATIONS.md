# Limitations

What RetroFlash.js does not do yet, or does only in part, grouped by subject. It covers SWFReader 0.6.0 and RetroFlash.Player 1.0.0-beta.2, as of 2026-10-31.

Most of these are reported at run time in `player.getDiagnostics().unsupported`; the feature name appears in brackets. The supported features are summarized in [`README.md`](./README.md), and their verification is documented in [`tests/COMPATIBILITY.md`](./tests/COMPATIBILITY.md).

## File format and reader

1. `ZWS` files (LZMA compression, SWF 13 and later) are rejected (`ZWS_UNSUPPORTED`).
2. `CWS` files (zlib) need the browser's `DecompressionStream`. There is no JavaScript fallback, so older browsers fail with `CWS_UNSUPPORTED`.
3. Strings in files older than SWF 6 used the author's locale encoding, which the file does not record. They are decoded as Latin-1.
4. Filter lists are validated and skipped. Only the filter names are kept, not their parameters.
5. `End`, and any tag after the last `ShowFrame`, report `frame = actualFrameCount + 1`.
6. `DefineMorphShape` and `DefineMorphShape2` ignore their `Offset` field: the end edges are read right after the start edges.
7. ActionScript 3 bytecode (`DoABC`) and its tags (`SymbolClass` and others) are only indexed, never run.

## Playback and timing

8. A movie is read and prepared in full before it plays. There is no progressive loading: `_framesloaded` is always the total, and `ifFrameLoaded` (`WaitForFrame`) is always true.
9. Frames follow `requestAnimationFrame` at the SWF frame rate. When the page falls behind, at most 4 frames (`maxCatchUpFrames`) are caught up per animation frame and the rest are dropped.
10. A timeline is never slowed down or sped up to follow its stream sound, as Flash Player did. A stream that drifts more than about one second from its timeline starts again where the timeline is.
11. The canvas takes the size of the stage (times `devicePixelRatio`). There are no stage scale modes: `Stage.scaleMode` is always `"showAll"`, and `Stage` sends no resize events.
12. The whole stage is redrawn every frame (no dirty rectangles), and every shape is filled again each time. Performance has not been measured or tuned.

## Vector drawing

13. Blend modes other than normal are drawn as normal [`render:blendMode`].
14. Filters (drop shadow, blur, glow, bevel, gradient glow, convolution, colour matrix, gradient bevel) are not drawn. They are reported only on button records [`render:filters`]; on `PlaceObject3` placements they are dropped without a report.
15. Linear-RGB gradient interpolation is drawn as sRGB [`render:gradientLinearRGB`].
16. A reflect or repeat gradient that would repeat more than 512 times over its fill is drawn as pad [`render:gradientSpread`].
17. Gradient and bitmap line fills need a canvas for a layer the size of the stage. Without one they take the fill's first colour [`render:lineFill`]. With one, each such stroke costs a full-canvas composite.
18. 9-slice scaling (`DefineScalingGrid`) changes only the drawing:
    - hit testing, masks, and stroke widths use the plain shape;
    - gradient and bitmap fills inside the grid are not stretched with it.
19. Non-scaling strokes (`NoHScale`, `NoVScale`) are not taken into account in hit testing.
20. Morph shapes:
    - `getBounds` interpolates the declared start and end bounds instead of measuring the drawn shape;
    - edges that do not pair up between the start and end shapes are not drawn [`render:morphEdges`].
21. Strokes are at least one device pixel wide. Anti-aliasing is the browser's, not Flash Player's.

## Bitmaps

22. Bitmaps are decoded by the browser (`createImageBitmap`). Without a browser (Node, the corpus tool) they are not decoded or drawn.
23. Per-channel colour transforms tint a copy of the bitmap. That copy is not possible when:
    - the bitmap is larger than 2048 × 2048 pixels;
    - the bitmap is a cross-origin image whose pixels the page may not read;
    - there is no canvas to tint it on.

    In those cases only the alpha multiplier is applied [`render:bitmapColorTransform`].
24. A clipped bitmap fill extends its edge pixels with stretched one-pixel strips. With smoothing on, the browser may blend slightly at the seams.
25. A bitmap larger than `maxBitmapPixels`, or past the movie's `maxTotalBitmapPixels`, is refused and not drawn [`render:bitmapDecodeFailed`].

## Text and fonts

26. Input text fields are drawn but cannot be edited [`text:input`]. There is no focus, caret, selection, or scrolling, and no `Selection` object.
27. Embedded-font text ignores kerning and letter spacing.
28. The HTML subset ignores images (`<img>`) and style sheets. Links (`<a href>`) are clickable, but:
    - they are found in the layout a field was last drawn with, so a link is not clickable before its field is drawn;
    - `event:` links (an ActionScript 3 feature) are not supported.
29. Device fonts depend on the fonts installed on the viewer's system and are never downloaded. Their metrics differ from Flash Player's, so line breaks may differ.
30. Text fields used as masks do not mask anything [`render:textMask`].
31. `DefineFont4` fonts work only in text fields that name them, through the browser's `FontFace` API. Without `FontFace`, or when the font file cannot be loaded, a device font is used [`text:font4`]. Static text (`DefineText`) cannot use their glyphs [`render:font4Text`].
32. Scripts cannot create or format text fields: there is no `TextField`, no `TextFormat`, and no `createTextField`.

## Buttons and input

33. Menu-tracking buttons (`trackAsMenu`) behave as push buttons [`input:trackAsMenu`].
34. Masks are ignored in hit testing, and buttons nested inside buttons are not supported.
35. There is no right-click context menu: `ContextMenu` is not implemented, and `Stage.showMenu` has no effect.
36. The mouse wheel is not delivered to the movie (no `Mouse.onMouseWheel`).
37. `Key.isToggled` is always `false`. There is no IME or composed text input.
38. `enabled` and `useHandCursor` work on clips that act as buttons, but not on `DefineButton` instances, which scripts cannot reach (`Button` is not implemented). `hitArea`, and tab navigation (`tabIndex`, `tabEnabled`, `focusEnabled`), are not supported.

## ActionScript (AVM1)

39. These built-in globals are not implemented and read as unknown values [`avm1:objectValue`]:
    - `System`, `Date`, `Button`, `TextField`, `TextFormat`, `Selection`;
    - `XML`, `XMLNode`, `XMLSocket`, `LoadVars`, `SharedObject`, `LocalConnection`;
    - `Camera`, `Microphone`, `Video`, `NetConnection`, `NetStream`;
    - `ContextMenu`, `ContextMenuItem`, `MovieClipLoader`, `Accessibility`, `AsBroadcaster`;
    - `getVersion`, `ASnative`, `CustomActions`, `PrintJob`, `TextSnapshot`;
    - the `flash` packages other than `flash.external`.
40. Getter/setter properties are not supported: `Object.addProperty` and `watch` return `false`. Neither is `Object.registerClass`, so AS2 classes compiled with getters and setters, and components that depend on them, may misbehave.
41. These `MovieClip` features are missing:
    - the drawing API (`beginFill`, `lineStyle`, `moveTo`, `lineTo`, `curveTo`, `clear`, …);
    - `createTextField`, `setMask`, `attachBitmap`, `getRect`;
    - the `filters`, `blendMode`, `cacheAsBitmap`, `transform`, and `scale9Grid` properties;
    - `_lockroot`.
42. `trace` does nothing, and `ToggleQuality` is ignored. `_quality`, `_highquality`, `_focusrect`, and `_soundbuftime` can be read but setting them has no effect.
43. An `if` or `ifFrameLoaded` whose condition is an unknown value (from an unimplemented built-in) ends its script [`avm1:unknownCondition`].
44. Scripts run under budgets per tick or input event: `maxActionBlocks`, `maxActionSteps`, `maxActionStack`, and `maxCallDepth`, plus 1 MiB of decoded bytecode per movie. A heavy script that exceeds them stops [`avm1:budget`].
45. Strings stop at 16,777,216 characters, and array indexes from 16,777,216 on are plain properties.

## Sound

46. Nellymoser and Speex sound data is not decoded [`sound:Nellymoser`, `sound:Speex`, …].
47. `StartSound2` (an ActionScript 3 sound class) is not played [`sound:StartSound2`].
48. `Sound.id3` and `onID3` are not supported: ID3 tags are skipped, not read.
49. `Sound.loadSound` accepts MP3 files only. It plays them only once the whole file has arrived (no progressive streaming), and `getBytesLoaded` is 0 until then.
50. At most 32 sounds play at once [`sound:limit`]. All decoded samples of a movie share the `maxAudioSamples` budget [`sound:memoryLimit`].
51. Browsers keep sound silent until the user clicks or presses a key on the page.
52. ADPCM stream blocks do not record their sample count, so padding bits can add one sample per block.
53. MP3 is decoded by the browser (`decodeAudioData`), so how its encoder delay is handled depends on the browser.
54. Without Web Audio (or with `audio: false`) nothing plays [`sound:noOutput`].

## Loading, networking, and the page

55. Loads into levels other than `_level0` (`loadMovieNum(url, 1)`, …) are not supported [`load:level`].
56. At most 8 loads can wait for the host at once; more are dropped [`load:limit`].
57. The player never fetches anything by itself: without a `loader` or `host.load`, nothing loads [`load:noLoader`]. With the browser host, cross-origin files load only when CORS allows them [`load:cors`]. A cross-origin image can be shown, but its pixels cannot be read.
58. `javascript:` URLs run only calls of page functions with literal arguments. Anything else is refused [`browser:javascriptUnsupported`] and is never evaluated.
59. `SharedObject` is not implemented, so nothing a movie saves persists.
60. Legacy `<object>`/`<embed>` markup:
    - it plays only on pages served over HTTP or HTTPS (not `file://`);
    - only `movie`/`src`/`data`, `base`, `FlashVars`, `allowScriptAccess`, `allowNetworking`, and `bgcolor` are honoured; `scale`, `salign`, `wmode`, `quality`, `menu`, `play`, `loop`, and the other parameters are ignored;
    - the canvas takes the stage size once the movie loads.
61. Pop-up windows from `getURL` are subject to the browser's pop-up blocker.

## Video and ActionScript 3

62. Video is not played: `DefineVideoStream` is placed but not drawn, `VideoFrame` is ignored, and `NetStream` is not implemented.
63. ActionScript 3 (AVM2) movies do not run. Their bytecode is detected and reported [`actionscript:DoABC`].

## Verification and quality

64. Pixel accuracy has not been compared with a reference player.
65. Drawing is tested with stand-in canvases in Node, and checked by eye and by sampled pixels in headless Chrome only. Firefox, Safari, and mobile browsers have not been checked.
66. Sound has not been checked by ear. MP3 has been tested only with silent frames, because the project has no MP3 encoder.
67. The corpus of real files is small: four authorized files of one kind (virtual tours).
68. The reader and the player check bounds and limits against hostile files, and the tests include controlled fuzzing, but there has been no independent security review.
