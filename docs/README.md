# What it supports

RetroFlash.js plays SWF animations on Canvas 2D:

- `DefineShape` 1–4: solid fills, linear, radial and focal gradients (pad, reflect, repeat), and lines, including gradient and bitmap line fills and non-scaling strokes;
- morph shapes (`DefineMorphShape`/`DefineMorphShape2`), drawn at each placement's ratio;
- 9-slice scaling (`DefineScalingGrid`);
- bitmaps:
  - `DefineBits` with `JPEGTables`;
  - `DefineBitsJPEG2/3/4` (JPEG, PNG, or GIF, and JPEG with an alpha plane);
  - `DefineBitsLossless/Lossless2`;
  - bitmap fills, clipped (with their edges extended) or repeating, and colour transforms on bitmaps;
- the display list, built from `PlaceObject`/`RemoveObject`;
- the timelines of the root movie and of nested `DefineSprite` instances;
- `clipDepth` masks;
- **text**:
  - `DefineText` drawn with the glyph outlines of `DefineFont`/`DefineFont2`/`DefineFont3`;
  - `DefineEditText` fields with embedded, device, or `DefineFont4` fonts, word wrap, alignment, margins, borders, `AutoSize`, and an HTML subset;
- **sound**: event sounds, button sounds and stream sounds in PCM, ADPCM and MP3, through Web Audio;
- **buttons** (`DefineButton`/`DefineButton2`): up/over/down states, hit areas, the hand cursor, and pointer and keyboard events with their actions;
- a controlled **AVM1 subset** for frame scripts and button actions. Browser interactions go through explicit host APIs; SWF-provided text is never evaluated as JavaScript. It covers:
  - timeline control: `stop`, `play`, `nextFrame`/`prevFrame`, `gotoAndPlay`/`gotoAndStop` by frame or label, and `tellTarget`/`setTarget`;
  - the stack, registers, and constant pool;
  - arithmetic, comparison, logical, string, and bitwise operators, with Flash Player's conversions for each SWF version;
  - timeline variables (`x = 5`, `_root.score`, `/clip:name`), which text fields bound to a variable display;
  - movie clips as values and their properties (`_x`, `_alpha`, `_visible`, `_currentframe`, …), `gotoAndPlay`/`gotoAndStop` with computed frames, `tellTarget` with computed targets, and `duplicateMovieClip`/`removeMovieClip`;
  - control flow: `if`/`else` and loops (bounded per frame), `return`, and `ifFrameLoaded`;
  - functions, closures, objects and arrays, classes (`new`, prototypes, `extends`, `super`), `with`, `try`/`catch`/`finally`, `for..in`, the built-in `Object`, `Array`, `String`, `Number`, `Boolean`, `Math` and `Error`, and the `MovieClip` methods (`_root.gotoAndPlay("label")`);
  - game APIs: clip events (`onClipEvent`, `onEnterFrame`, `onPress`, …), `Key` and `Mouse` with listeners, timers (`setInterval`, `getTimer`), dragging, `hitTest`, `attachMovie`, `createEmptyMovieClip`, `swapDepths`, `Color`, `Stage`, `Sound` (library sounds and `loadSound`), and `DoInitAction`;
  - `loadMovie`, `unloadMovie`, and `loadVariables` into clips: other SWF files and JPEG, PNG, or GIF images. The host page gives them through the `loader` option; legacy `<object>`/`<embed>` markup in the bundle gets a browser loader automatically, under CORS.
- a small **AVM2 / ActionScript 3 subset** for document and timeline classes, frame scripts, button mouse events, `navigateToURL`, `ExternalInterface` (`call`, `addCallback`, `objectID`, `marshallExceptions`), `fscommand`, `Security.allowDomain` (accepted, grants nothing) and `loaderInfo.parameters`. It is intended for simple timeline movies, not general AS3 applications.
- **page scripting**, as with the Flash plugin: `ExternalInterface` in both directions for ActionScript 2 and 3, `fscommand` with `<id>_DoFSCommand`, `getURL("javascript:...")` as calls of page functions, FlashVars, and the plugin's methods on the movie element (`SetVariable`, `GetVariable`, `Play`, `GotoFrame`, the `T*` family, `Zoom`, `CallFunction`, `SetReturnValue`, …). See [interop/STATUS.md](./interop/STATUS.md).

The [`fws-game.swf` fixture](../tests/fixtures/valid/fws-game.swf), a mini game with a hero moved by the arrow keys and a score, plays in the player. Current gaps, including editable input fields, filters, blend modes, video, and most of ActionScript 3, are listed in [`LIMITATIONS.md`](../LIMITATIONS.md) and reported at run time in `getDiagnostics().unsupported`.
