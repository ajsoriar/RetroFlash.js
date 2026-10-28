# Changelog

## Unreleased

- **Sound.** Movies play sound through an audio backend, the new Player option `audio`; by default `RetroFlash.createWebAudioBackend()` when the browser has Web Audio, and `audio: false` turns it off. The new option `volume` and `player.setVolume()`/`getVolume()` scale it; `pause()` suspends sounds and `play()` resumes them.
  - **Reader:** `DefineSound`, `StartSound`, `StartSound2`, `DefineButtonSound` (all four state sounds), `SoundStreamHead`, `SoundStreamHead2` and `SoundStreamBlock` are decoded, with their `SOUNDINFO` (in and out points, loops, envelope, sync flags).
  - **Codecs:** PCM and ADPCM are decoded in JavaScript; MP3 is decoded by the browser, ahead of playback. Nellymoser and Speex are reported, not played.
  - **Playback:** event sounds with their `SOUNDINFO`, `syncStop` and `syncNoMultiple`; button sounds on roll over, press, release and roll out; stream sounds that play while their timeline plays, stop on jumps, `stop()` and removal, and start again when they drift more than a second; `StopSounds` (`stopAllSounds()`); at most 32 sounds at once.
  - **AVM1 `Sound`:** `attachSound`, `start(offset, loops)`, `stop([name])`, `setVolume`/`getVolume`, `setPan`/`getPan`, `setTransform`/`getTransform` per clip and global, `duration`, `position`, `onSoundComplete`, and `loadSound(url, isStreaming)` with `onLoad` through the host loader (request type `'sound'`).
  - New limit `maxAudioSamples` (64 Mi decoded samples per movie). New diagnostics: `sound:noOutput`, `sound:limit`, `sound:memoryLimit`, `sound:missingCharacter`, `sound:attachMissing`, `sound:decodeFailed`, `sound:streamWithoutHead`, `sound:StartSound2`, `sound:<codec>`, `render:soundPlaced`; `sound:Sound` and `sound:DefineButtonSound` are gone.
  - New fixture `tests/fixtures/valid/fws-sound.swf`; `tools/corpus.js` plays sounds into a silent output.
- **Browser interaction.** What a movie asks of the page goes to the new Player option `host`, after the cancelable events `navigate`, `call` and `fscommand`: `getURL` to `_self`, `_blank`, `_parent`, `_top` or a named window (with the variables of a `GET` or `POST`), `javascript:` URLs read as calls of page functions with literal arguments (never evaluated), `FSCommand`, and `flash.external.ExternalInterface` (`call`, `addCallback`, `available`, `objectID`; `player.callback()` calls back into the movie). `MovieClip.getURL` works. Loads send their variables with `GET`/`POST`. `player.load(input, { url, variables })` sets `_url` and FlashVars. `RetroFlash.createBrowserHost()` does all of it with `window.open`, `location`, forms, page functions and `fetch` under CORS, honouring `allowScriptAccess`, `allowNetworking`, `base` and an optional `rewriteUrl`. New diagnostics: `browser:noHost`, `browser:blocked`, `browser:invalidURL`, `browser:functionMissing`, `browser:callFailed`, `browser:javascriptUnsupported`, `browser:callbackMissing`, `load:cors`, `load:network`, `load:http`, `load:blocked`, `load:invalidURL`; `avm1:GetURL`, `avm1:GetURL2` and `load:sendVariables` are gone.
- The browser bundle automatically replaces legacy Flash `<object>` and `<embed>` elements, playing them through the browser host with their `FlashVars`, `base`, `allowScriptAccess` and `allowNetworking`; ExternalInterface callbacks become methods of the element. Cross-origin SWFs and resources load when CORS allows them.
- The reader's `actionscript:DoAction` reason now says the reader never runs code and the player does; the player no longer logs it. The player logs initialization, load results, errors, SWF diagnostics, and unsupported features to the console.
- The Player emits and retains a bounded interaction log for requests between the movie and page, including direction, channel, outcome, and non-sensitive context. The development demo shows the latest 30 entries; URLs omit queries, and POST bodies and argument values are not retained.

### Fixed

- **`GetURL2` flags.** The decoder read them as the SWF 19 drawing shows them, so the load-into-clip flag (`0x40`, written by `loadMovie`) was taken for the `GET` method. They are now read as Flash Player and the authoring tools write them: `0x80` loads variables, `0x40` loads into a clip, the low two bits are the method (3 is read as none).

### Changed

- **The player source is split into modules.** `src/retroflash.js` is now only the public API. The rest is in `src/core/`, `src/display/`, `src/text/`, `src/avm1/`, `src/input/`, and `src/render/`, as classic scripts loaded in the order of `src/modules.json`. Behaviour and the public API do not change.
- `RetroFlash.internals` now exposes every module export.
- **Movie state is split in two.**
  - The display context (`createEnv`) keeps the dictionary, the limits, and the instance count.
  - A new `ActionScheduler` (`env.scripts`, in `src/avm1/interpreter.js`) owns the AVM1 queue, the parsed-action cache, and the budgets.
  - `runActionQueue(env)` is now `env.scripts.run()`.
  - The shared `quiet` flag is gone: a scrubbing seek and a button's hit area drop the scripts they queue (`mark()`/`dropSince()`).
  - The AVM1 modules now load before `display/`.
- `maxActionBlocks` counts every action block: two `DoAction` tags in one frame count as two. The old limit counted queue entries.
- The AVM1 budgets now cover a whole tick or input event, as documented. A tick that ran the queue twice (frame scripts, then the actions of a button that appeared under the pointer) used to get the budget twice. `env.scripts.beginUpdate()` opens a new budget.

- **AVM1 execution goes through the decoder.**
  - Each action block runs in its own `Activation`, which follows a program counter over the decoded code (`executeAVM1`). It replaces the walk over the action list in file order, which could not follow a branch.
  - `parseActions`, `actionString`, `actionUI16`, and `functionCodeSize` are replaced by `ActionCode`.
  - The executed subset is unchanged. Two malformed cases now end the script with `avm1:malformedAction`:
    - a `GotoFrame` whose operand is shorter than 2 bytes, which used to jump to an undefined frame;
    - a function definition whose body runs past the block, which used to skip silently to the end.

- **Action blocks are decoded lazily.** A record is decoded only when the script reaches it, after its step is charged to `maxActionSteps`. Before, every block was first decoded in full, so a large `DoAction` cost time and memory before any limit applied. As a result, a record that runs past its block is reported only when the script reaches it.
- **Decoded actions have a budget per movie.** It is an internal threshold of 1 MiB of bytecode, shared by every block.
  - **Costs:** each cached record counts its length once. A record with an error counts at most its 3-byte header, so a truncated record cannot use up the budget. Each cached block counts 4 bytes for its own objects.
  - **Past the threshold:** a script that needs a new record stops with `avm1:budget`, and cached blocks keep running. Blocks that decoded nothing are not cached.
  - **Memory:** filling the budget grew the heap by 40 to 58 MB in headless Chrome and by up to about 120 MB in Node.
  - **Smaller records:** records without a payload share one empty `data` view, which more than halves the memory of one-byte actions.
- **Push is interpreted, so a malformed `Push` now ends the script** (`avm1:malformedAction`), as a malformed `StoreRegister` or `ConstantPool` does. `Push`, `Pop`, `PushDuplicate`, `StackSwap`, `StoreRegister`, and `ConstantPool` are no longer reported as unsupported.
- **Text fields bound to a variable show it.** They are no longer reported as `text:variable`.
  - When a field is placed, an existing variable gives it its text; otherwise its initial text initializes the variable.
  - Each bound instance has its own layout, laid out again when its text changes.
- **`SetTarget` paths follow Flash Player's rules**, through `resolvePath` in `src/avm1/variables.js`:
  - `.` and `:` steps, `this`, and `_root` work only from SWF 5;
  - a step names a child instance, then a variable;
  - `resolveTarget` moved to that module.
- `UNKNOWN_VALUE` moved to `src/avm1/values.js`.
- **The four AVM1 registers are global to the movie**, shared by every script as in Flash Player; before, each block had its own. `DefineFunction2` functions have their own registers too.
- **Function definitions, calls, objects, `with`, `try`/`throw`, and `Call` are interpreted**: they are no longer reported, and no longer end the script. Function literals are real functions instead of unknown values.
- **`GotoFrame` and `GotoLabel` now stop the clip**, as `gotoAndStop` does in Flash Player. Before, the clip kept its play state: in the `fws-actions` fixture the sprite sent to frame 7 now stays there.
- **Movie clips are values**: `kid`, `_root`, and `_parent` read as the clip, not as an unknown value; properties (`_x`, …) read and set the clip instead of being reported.
- **`Jump`, `If`, `Return`, and `WaitForFrame2` no longer end the script:** they are followed, and no longer reported as unsupported. A frame script with a `Jump` now reaches what follows the jump target.

### Added

- **Loading into clips:**
  - new Player option `loader`: a function from the host page that gives the bytes of a URL a script loads, or refuses it; the player itself still never fetches or navigates;
  - `loadMovie` and `unloadMovie` (`GetURL2` with a clip target, `GetURL`/`GetURL2` with `_level0`, and the MovieClip methods): a SWF file plays inside the clip with its own dictionary and SWF version, and the clip keeps its place and clip events (`unload` when emptied, `load` when the movie arrives); a JPEG, PNG, or GIF file is shown at the clip's origin;
  - `loadVariables` into a clip, with its `data` event; `_url`, `getSWFVersion()`, `getBytesLoaded()`, and `getBytesTotal()` describe the loaded content;
  - loaded bitmaps share one pixel budget and are freed when unloaded, on `stop()`, on `load()`, and on `destroy()`; a failed bitmap decode now gives its pixels back to the budget;
  - `src/display/loader.js` (`LoadQueue`); the demo plays a SWF with the extra files it loads, and `tools/corpus.js --resources DIR` answers loads from a folder;
  - **Tests:** `tests/unit/avm1-load.test.js`.
- **Compatibility corpus (Hito H):**
  - `tools/corpus.js` (`npm run corpus -- files…`) runs SWF files in Node, the same way every time (fixed clock, fixed random sequence, 60 frames, a pointer probe), and writes a Markdown or JSON matrix that sorts every diagnostic into a layer: parser, vm, api, render, or input;
  - the version matrix (`--versions`): one bytecode probe per version-dependent rule, run in SWF 4 to 10;
  - the fixture matrix is committed in `tests/corpus/` (`npm run corpus:fixtures` regenerates it);
  - **Tests:** `tests/unit/corpus.test.js`.
- **Reader 0.6.0:** `PlaceObject2`/`PlaceObject3` clip actions (`clipActions`: events, key code, and the action byte range) and `ExportAssets` (`assets`). Clip actions are no longer listed as unsupported.
- **AVM1 game APIs (Hito G):**
  - clip events: `onClipEvent` actions and AS2 methods (`onEnterFrame`, `onLoad`, `onUnload`, mouse events, `onPress`, …) in Flash Player's order; clips with button handlers act as buttons;
  - `Key` (`isDown`, `getCode`, `getAscii`, listeners) with keyboard state kept by the player (`keyup` and focus loss included), `Mouse` (`hide`, `show`, listeners), mouse and key events to every clip;
  - `getTimer`/`GetTime`, `setInterval`, `setTimeout`, `clearInterval`, `clearTimeout`, run between frames;
  - dragging (`StartDrag`, `EndDrag`, `startDrag`, `stopDrag`, `_droptarget`);
  - MovieClip methods: `hitTest`, `getBounds`, `localToGlobal`, `globalToLocal`, `attachMovie`, `createEmptyMovieClip`, `swapDepths`, `getNextHighestDepth`, `getInstanceAtDepth`, `getSWFVersion`;
  - `Stage`, `Color`, a silent `Sound`, and `DoInitAction`;
  - the `fws-game.swf` fixture, a mini game played by the tests and in Chrome;
  - **Tests:** `tests/unit/avm1-game.test.js`.
- **AVM1 functions and objects (Hito F):**
  - objects, arrays, and functions (`src/avm1/objects.js`) with prototypes, hidden built-in members, and `for..in` in Flash Player's order; strings, numbers, and booleans have their methods; objects convert through `valueOf()` and `toString()`;
  - `DefineFunction`/`DefineFunction2` (closures from SWF 6, `this`, `arguments`, `super`, local and preloaded registers), `CallFunction`, `CallMethod`, `NewObject`, `NewMethod`, `Return` values, `Extends`, `InstanceOf`, `CastOp`, `ImplementsOp`, `With`, `Try`/`Throw`, `Call`, `GetMember`, `SetMember`, `Delete`, `Delete2`, `InitArray`, `InitObject`, `Enumerate`, `Enumerate2`;
  - the movie's runtime (`src/avm1/globals.js`): `Object`, `Function`, `Array`, `String`, `Number`, `Boolean`, `Math`, `Error`, the global functions, and the `MovieClip` methods (`gotoAndPlay`, `duplicateMovieClip`, …), so `_root.gotoAndPlay("label")` works (the `visita.swf` menu buttons now navigate);
  - new limit `maxCallDepth` (256 nested calls); limits on prototype chains, array length, and string length against hostile scripts; uncaught throws end the block (`avm1:uncaughtThrow`);
  - **Tests:** `tests/unit/avm1-functions.test.js`.
- **AVM1 timelines and movie clips (Hito E):**
  - movie clips as values, with conversions, comparisons, `typeof`, and `TargetPath`; paths through variables that hold clips; default instance names `instanceN`;
  - the 22 movie clip properties (`src/avm1/properties.js`), through `GetProperty`/`SetProperty` and as variables, with Flash Player's rules for scale, rotation, twips, and invalid values; objects transformed by a script are no longer moved by the timeline; `_visible` is honoured by drawing and hit testing; properties of `_root` move the whole movie;
  - `GotoFrame2` (numbers, labels, `path:frame`, scene bias, play or stop) and `SetTarget2`;
  - `CloneSprite` and `RemoveSprite` (`duplicateMovieClip`, `removeMovieClip`) at script depths, kept across timeline rewinds;
  - **Tests:** `tests/unit/avm1-clips.test.js`.
- **AVM1 control flow (Hito D):**
  - `Jump` and `If` follow their branch, including to the end of the block and into the middle of a record. `If` converts its condition with the version's boolean rules.
  - `Return` ends the block outside functions.
  - `WaitForFrame` and `WaitForFrame2` count every frame as loaded up to frame 16000 (16001), as for a fully loaded movie in Flash Player, and otherwise skip their records.
  - A condition that is an unknown value ends the script (`avm1:unknownCondition`) instead of guessing a branch. Malformed branches end it (`avm1:malformedAction`).
  - Loops are bounded by `maxActionSteps` and `maxActionStack`.
  - **Tests:** `tests/unit/avm1-control.test.js`. Test helpers for action records, an assembler with labels, and a block runner are in `tests/support/avm1.js`.

- **AVM1 values, operators, and variables (Hito C).**
  - **Values** (`src/avm1/values.js`): conversions to number, string, and boolean, and the `Equals2`, `StrictEquals`, and `Less2` comparisons, each following Flash Player for the SWF version:
    - `undefined` is 0 before SWF 7;
    - from SWF 5, a string with trailing text is NaN;
    - from SWF 6, `"0x1F"` and `"010"` are hexadecimal and octal integers;
    - numbers print with 15 significant digits.
  - **Operators:** every SWF 4 to SWF 7 operator on primitive values: arithmetic, comparisons, logic, strings and `MB` strings, character codes, bitwise actions, `ToInteger`/`ToNumber`/`ToString`, `TypeOf`, and `RandomNumber`. `Trace` prints nothing. An unknown operand gives an unknown result.
  - **Variables** (`src/avm1/variables.js`):
    - `GetVariable`, `SetVariable`, `DefineLocal`, and `DefineLocal2` on the variables of each timeline (`Clip.variables`);
    - Flash Player's paths: `a`, `/path:a`, `path.a`, `_root.kid.a`, `../:a`;
    - names case-insensitive before SWF 7, and `SetTarget` scoping.
  - **Not values yet:** movie clips, their properties, and global objects read as unknown values (`avm1:objectValue`); setting a property is reported (`avm1:variableNotSet`).
  - **Tests:** `tests/unit/avm1-values.test.js` and `tests/unit/avm1-expressions.test.js`.

- **AVM1 stack core.** Each action block has its own stack, four registers, and constant pool. `Push` (every value type, registers, and constants), `Pop`, `PushDuplicate`, `StackSwap`, `StoreRegister`, and `ConstantPool` are executed. Popping an empty stack gives `undefined`.
  - Skipped actions keep the stack in step: they pop their operands and push unknown values (`UNKNOWN_VALUE`), so no later action takes their results for real values. An action whose counts depend on the values leaves the whole stack unknown.
  - New limit `maxActionStack` (default 100,000 values per block). It is checked on every push, so even a single `Push` stops at the limit.
  - **Tests:** `tests/unit/avm1-stack.test.js`.
- **AVM1 decoder** (`ActionCode` in `src/avm1/decoder.js`), written against SWF19. It decodes action records and their operands without executing them.
  - **Operands:** `Push` values of every type, the constant pool, registers, function definitions (with their `DefineFunction2` flags), `With` and `Try` bodies, `GetURL`/`GetURL2`, `GotoFrame2`, and `WaitForFrame`/`WaitForFrame2`.
  - **Branches:** targets are measured from the next record and checked against the block.
  - **Decoding:** records are decoded on demand at any offset, so a branch inside another record works.
  - **Errors:** `TRUNCATED_RECORD`, `INVALID_OPERANDS`, `INVALID_BRANCH`, and `INVALID_RANGE`.
  - **Versions:** each record carries the SWF version that introduced its action.
  - **Tests:** `tests/unit/avm1-decoder.test.js`.
- **Configurable limits.** `maxNesting`, `maxInstances`, `maxActionBlocks`, and `maxActionSteps` are now Player options, like `maxBitmapPixels` and `maxTotalBitmapPixels`. Each limit must be a positive integer, or the player throws `INVALID_OPTION`; earlier, 0 meant the default. `RetroFlash.defaultLimits` holds the defaults, and `player.limits` the limits in force.
- **Build:** `npm run build` writes `dist/retroflash.min.js`, one minified file with the reader and the player, and its source map. It uses terser, the project's only development dependency (`npm install`). The tests and the demos still install nothing.
- `npm run test:dist` runs the test suite against the bundle. `tests/unit/build.test.js` checks the module manifest and the demo's script list.

## RetroFlash 0.4.0 + SWFReader 0.5.0 — 2026-10-27 (text)

### Added

- **Reader 0.5.0:**
  - `DefineFont`, `DefineFont2`, and `DefineFont3`: glyph outlines, codes, advances, layout, bounds, and kerning;
  - `DefineFontInfo` and `DefineFontInfo2`, and `DefineFontName`;
  - `DefineFontAlignZones` and `CSMTextSettings` (ids only);
  - `DefineText` and `DefineText2`, and `DefineEditText` (all flags and fields);
  - real-file variations are tolerated: a missing `CodeTableOffset` in fonts without glyphs, missing glyph bounds or kerning tables, and a NUL at the end of font names;
  - a `DefineText` without its end byte is accepted with a `TEXT_END_MISSING` warning;
  - `BitReader.readSI16` and `BitReader.seek`.
- **Static text:** `DefineText`/`DefineText2` are drawn with the font's glyph outlines (1024 or 20480 EM), the text matrix, record offsets and advances, and record colours under colour transforms. Static text also works as a mask.
- **Text fields** (`DefineEditText`):
  - fonts: embedded glyphs with `UseOutlines`; otherwise device fonts through Canvas, with `_sans`/`_serif`/`_typewriter` and generic fallbacks, and nothing downloaded;
  - layout: the 2 px gutter, word wrap, line metrics, leading, margins, indent, alignment (left, right, center, justify), and `AutoSize`;
  - an HTML subset: `<p align>`, `<br>`, `<font face size color>`, `<b>`, `<i>`, `<u>`, `<a>`, `<li>`, `<textformat>`, and entities. It is parsed in a single linear scan, so hostile markup cannot cause quadratic work, and tags longer than 4,096 characters are dropped;
  - drawing: border and background, password masking, and clipping to the field;
  - as in Flash Player, device-font fields are not drawn when rotated, skewed, or mirrored.
- **Reports:** `text:variable` (fields bound to variables show their initial text), `text:input` (no editing), `text:htmlImage`, `text:deviceFallback`, `text:missingGlyph`, `render:missingFont`, and `render:textMask`.
- **Hit testing:** text is hit by its bounds, inside button hit areas too.
- **Tests:** fixture `valid/fws-text.swf` (fonts drawn by the project) and `tests/unit/text.test.js`.

### Changed

- The demo ignores a load that a newer file has superseded.

### Fixed

- A load superseded while its bitmaps were decoding could still report bitmap failures into the newer movie's diagnostics. Its reports are now dropped once it is superseded.

## RetroFlash 0.3.0 + SWFReader 0.4.0 — 2026-10-27 (buttons)

### Added

- **Buttons** (`DefineButton`, `DefineButton2`).
  - States: up/over/down children, persistent across state changes, with animated sprites inside.
  - A hit area that is never drawn.
  - Colour transforms from `DefineButtonCxform`.
- **Input:**
  - pointer events become roll over/out, press, release, drag out/in, and release outside, with their condition actions;
  - `KeyPress` conditions from the keyboard;
  - the hand cursor;
  - button actions run in the parent timeline's context through the AVM1 subset;
  - new option `input`.
- **Hit testing:** points are tested against fills (even-odd/non-zero), curves, and strokes. `RetroFlash.internals.pointInShape` and `pickButton` are exposed.
- **Reader 0.4.0:**
  - decodes `DefineButton`, `DefineButton2`, `DefineButtonCxform`, and `DefineButtonSound`;
  - validates and skips filter lists by size;
  - adds `codeTags.buttonActions`.
- Fixture `valid/fws-buttons.swf` and `tests/unit/buttons.test.js`.

### Changed

- `PlaceObject3` filter lists are now decoded (as filter names) instead of leaving the placement partial. Blend mode and the later fields are therefore read too.
- `valid/fws-unsupported.swf` now carries a valid blur filter list.
- `.gitattributes` marks `*.swf`, `*.jpg`, and `*.png` as binary.

### Fixed (pre-commit review)

- **Hostile files:** sprites and buttons that contain themselves, even several times per level (exponential growth), no longer overflow the stack or exhaust memory.
  - Recursion is refused (`render:recursiveCharacter`).
  - Nesting is bounded through buttons as well (`render:nestingLimit`).
  - At most 100,000 instances are created per step (`render:instanceLimit`).
  - A runtime error while building the movie now sets the state to `error` and emits `error`, instead of leaving the player in `loading`.
- **Input:**
  - Pressing outside every button and releasing over one now gives that button its roll over.
  - Removed buttons are checked after frames, scripts, and seeks, no longer on every pointer move.
- **Hit areas:** sprites inside a hit area no longer run frame scripts.
- **`play()`** on a finished non-looping movie restarts it like `stop()`, so frame-1 scripts run again.
- **Reader:**
  - An unreadable `PlaceObject3` filter list keeps the placement, which becomes `partial` with `unparsed: ['filterList']`.
  - `DefineButton2` finds its actions through `ActionOffset`; a gap after the records is skipped and reported as `BUTTON_ACTION_OFFSET_GAP`.
  - `SWFReader.inflate(bytes, max, { truncate: true })` keeps the first `max` bytes. Bitmaps use it, so extra zlib output no longer drops the bitmap.
- **Undecodable definitions** (shapes, bitmaps, buttons) still define their id, so placements report them as `(invalid)` instead of missing.
- **Bitmap memory:**
  - The size of a JPEG, PNG, or GIF is read from its header (JPEG `SOFn`, PNG `IHDR`, GIF logical screen) and checked against `maxBitmapPixels` **before** the browser decodes it. Images without a readable size are refused (`BITMAP_FORMAT`). A decoded image larger than its header declared is discarded.
  - New option `maxTotalBitmapPixels` (default 4 × 4096 × 4096): one pixel budget for all bitmaps of a movie, taken in character id order. Bitmaps past it are reported (`BITMAP_BUDGET`) and not drawn.
  - At most 4 bitmaps decode at a time.
  - Decoded bitmaps are released (`ImageBitmap.close`) when a movie is replaced or the player is destroyed.
- **Overlapping loads:** only the latest `load()` wins. A load superseded by another `load()` or by `destroy()` resolves to `null` and changes nothing, even if it fails (before, an older load finishing last replaced the newer movie, and a failed load after `destroy()` set the state back to `error`).
- `tests/unit/robustness.test.js` covers these cases, and also pins that the body of `DefineFunction`/`DefineFunction2` follows the action record (its `Length` does not include it), so the next action runs.

## RetroFlash 0.2.0 — 2026-10-27 (bitmaps + AVM1 timeline control)

### Added

- **Bitmaps:**
  - `DefineBits` + `JPEGTables`, `DefineBitsJPEG2/3/4`, and `DefineBitsLossless/Lossless2` are decoded during `load`.
  - JPEG, PNG, and GIF use the browser decoder. The JPEG3/4 alpha plane and lossless formats 3, 4, and 5 are decoded in JavaScript, with premultiplied data converted.
  - Erroneous `FF D9 FF D8` JPEG headers are removed.
  - Bitmap fills are drawn clipped or repeating, smoothed or not, and with the alpha multiplier of colour transforms. Bitmaps placed directly are drawn too.
  - New option `maxBitmapPixels`.
- **AVM1 timeline-control subset**, a controlled interpreter that never evaluates JavaScript or navigates:
  - frame scripts run after each tick;
  - executed: `Stop`, `Play`, `NextFrame`, `PreviousFrame`, `GotoFrame`, `GotoLabel`, `SetTarget` (slash and dot paths), and `WaitForFrame`;
  - `GetURL` is ignored and reported;
  - function bodies are skipped;
  - control flow and calls end the script and are reported;
  - per-frame budgets apply;
  - new option `actions`, and `getInfo().rootPlaying`.
- Fixtures `valid/fws-bitmaps.swf` and `valid/fws-actions.swf`, plus the asset `fixtures/assets/gradient-32.jpg`.
- `tests/unit/bitmaps-avm1.test.js`.
- Reader 0.3.0:
  - bitmap header decoding;
  - `SWFReader.inflate`;
  - `BitReader.skipRemaining`.

### Changed

- `stop()` now rewinds the whole movie, so frame-1 scripts run again.
- `seek()` does not run frame scripts.
- Bitmap and JPEGTables tags now have status `decoded`.
- The fixture writer embeds zlib data with stored blocks, so fixtures stay byte-identical across zlib versions.

## RetroFlash 0.1.0 + SWFReader 0.3.0 — 2026-10-27 (milestone 1: vector playback)

### Added

- `src/retroflash.js` with `RetroFlash.Player`:
  - `load`, `play`, `pause`, `stop`, `step`, `seek` (by frame number or label), `getInfo`, `getDiagnostics`, `on`/`off`, and `destroy`;
  - the states and events described in `src/README.md`.
- Character dictionary, a display list per timeline, root and `DefineSprite` timelines that run independently (also nested), and rewind that keeps matching instances.
- Canvas 2D rendering of `DefineShape` 1–4:
  - edges linked into contours per fill style;
  - solid fills, and linear, radial, and focal gradients;
  - line styles, including `LINESTYLE2` caps and joins;
  - exact colour transforms on vector colours.
- `clipDepth` masks, including masks made of sprites.
- Not drawn yet, and reported in `getDiagnostics().unsupported`: bitmap fills, gradient spread modes, blend modes, and placed characters such as bitmaps, text, and buttons.
- The reader decodes `DefineShape`/`DefineShape2`/`DefineShape3`/`DefineShape4`: fill and line style arrays, gradients, and shape records. `BitReader.readFixed8` is new.
- `demo/player.html`, plus the inspector now links to it.
- Fixture `valid/fws-animation.swf`, generated by `tests/fixtures/animation.js`.
- `tests/unit/player.test.js`, covering geometry, the dictionary, the display list, and timelines.

### Changed

- `DefineShape*` tags now have status `decoded` instead of `indexed`, and no longer appear in `movie.unsupported`.

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
