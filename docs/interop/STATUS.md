# JavaScript ↔ ActionScript interoperability: status

The aim: an existing SWF, its existing HTML page and a single RetroFlash.js script keep talking to each other as they did through the Flash Player plugin, without changes to the SWF, its ActionScript or the page's scripts. This page lists what works, what works in part, what does not work yet, the player hooks behind each mechanism, and how it is tested. It covers RetroFlash.Player 1.1.2.

RetroFlash.js reproduces the **JavaScript surface** of the plugin (the methods on the `<object>`/`<embed>` element, the page functions it called). It does not emulate NPAPI or ActiveX. It never evaluates text from a movie as JavaScript, unless the page passes its own executor for `javascript:` URLs (see [Security](#security-model)).

## Where it lives

| File | Role |
|---|---|
| [`src/avm1/external.js`](../../src/avm1/external.js) | `HostBridge`, one per movie: page calls, FSCommands, navigation, callbacks registered by the movie, nesting depth, `SetReturnValue`; `javascript:` URL reader; AVM1 ⇄ JavaScript values |
| [`src/avm1/globals.js`](../../src/avm1/globals.js) | ActionScript 2 `flash.external.ExternalInterface` |
| [`src/avm2/api.js`](../../src/avm2/api.js) | ActionScript 3 `ExternalInterface`, `flash.system.fscommand`, `flash.system.Security`, `LoaderInfo` (FlashVars), AVM2 ⇄ JavaScript values, `Avm2Movie.invokeCallback` |
| [`src/interop/flash-xml.js`](../../src/interop/flash-xml.js) | The plugin's ExternalInterface XML (`<invoke>`, `<string>`, `<array>`, …): a bounded parser of its own, serializers |
| [`src/interop/plugin-api.js`](../../src/interop/plugin-api.js) | The plugin methods (`SetVariable`, `GotoFrame`, `T*`, `Zoom`, `CallFunction`, …) and `attachLegacyInterface`, which installs them and the movie's callbacks on a page element |
| [`src/browser/host.js`](../../src/browser/host.js) | `createBrowserHost`: page function calls by name, `<id>_DoFSCommand`, `javascript:` modes, trust and allowlists |
| [`src/browser/legacy-autoplay.js`](../../src/browser/legacy-autoplay.js) | Replaces each `<object>`/`<embed>` by a canvas that keeps its id and name and gets the plugin interface |
| [`src/retroflash.js`](../../src/retroflash.js) | `Player.callback`, `runExternal`, `addFSCommandHandler`, `setViewRect`, FlashVars, the `destroy` event |

There is one bridge per player (`player.env.host`); nothing is shared between players, so two movies can register the same callback name.

## Compatibility matrix

Status: **implemented** (works, tested with a SWF built by the tests), **partial** (works with the limits given), **unavailable** (not implemented; reported, never faked).

### ExternalInterface

| Feature | AS2 (AVM1) | AS3 (AVM2) | Notes |
|---|---|---|---|
| `available` | implemented | implemented | True when the player has a host (`host` option; the legacy bootstrap always gives one) |
| `call(name, ...args)` | implemented | implemented | Synchronous: the page function's result is on the movie's stack in the same call. Dotted names (`app.handlers.load`) are resolved without `eval` and called with their owner as `this` |
| `addCallback` | implemented (`name, instance, method`, returns Boolean) | implemented (`name, closure`, void) | `instance` is `this` for AS2. A new registration of a name replaces the old one. AS3 `addCallback(name, null)` removes it (inferred, see below) |
| `objectID` | not part of AS2 (reads `undefined`) | implemented | The element's id, else its name |
| `marshallExceptions` | not part of AS2 (reads `undefined`) | implemented | Off: errors are reported and give `null`/`undefined`. On: a page exception becomes an AS3 `Error` with its message, and an AS3 error in a callback is thrown to the page as an `Error` named `ActionScriptError` |
| Refused call (trust, allowlist, `allowScriptAccess`) | `null`, reported `browser:blocked` | throws `SecurityError` #2060 | |
| Missing page function | `null`, reported `browser:functionMissing` | `null` | |
| Values: `null`, `undefined`, Boolean, Number (NaN, ±Infinity), String (Unicode) | implemented | implemented | |
| Values: arrays (sparse), objects, nesting | implemented | partial | AS3 has no `Array` class in the runtime yet: an array becomes `null` (`avm2:externalArray`). AS3 plain `Object`s work both ways |
| Values: `Date` | partial | partial | A page `Date` arrives as its time in milliseconds (no AVM1 `Date` or AS3 `Date` class yet) |
| Cycles, depth, size | implemented | implemented | Cycles become `null`; at most 64 levels and 100,000 objects per value; getters are never called |
| Nested calls (page → movie → page → …) | implemented | implemented | Bounded by the Player option `maxBridgeDepth` (32): a deeper movie call gives `null`, a deeper page call throws `CALL_DEPTH` |

### FSCommand

| Feature | Status | Notes |
|---|---|---|
| AS1/AS2 `fscommand(command, args)` | implemented | Compiled as `getURL("FSCommand:command", args)` |
| AS3 `flash.system.fscommand(command, args)` | implemented | |
| `getURL("fscommand:...")` (any case) | implemented | Routed to FSCommand, never to navigation |
| Player handlers | implemented | `player.addFSCommandHandler(fn)` (returns an unsubscribe function), the `onFSCommand` option and the cancelable `fscommand` event. They run first, in order; one that returns `true` handles the command |
| `<movieId>_DoFSCommand(command, args)` | implemented | Called by the browser host after the handlers. Both arguments are strings |
| `<movieId>_FSCommand` (the VBScript-era name) | implemented | Used when `_DoFSCommand` is missing. A global JavaScript function, not VBScript |
| Projector commands (`quit`, `fullscreen`, `allowscale`, `showmenu`, `exec`, `trapallkeys`) | partial | Always passed to the page, marked `projector: true`. With the Player option `projectorCommands`, `allowscale` changes the scale mode, `fullscreen` asks the browser for full screen, `quit` pauses. `exec` is reported (`browser:fscommandExec`) and never runs anything |

### `getURL` / `navigateToURL`

| Feature | Status | Notes |
|---|---|---|
| `getURL("javascript:f(...)")` / AS3 `navigateToURL(new URLRequest("javascript:..."))` | implemented | `scriptUrls: 'known-calls'` (default): calls of page functions by name (`f`, `a.b.f`) with literal arguments (strings, numbers, `true`, `false`, `null`, `undefined`), `void`, `;`-separated. The page is never navigated to the `javascript:` URL |
| Other `javascript:` code | implemented (opt-in) | Refused (`browser:javascriptUnsupported`) unless the page sets `scriptUrls: 'trusted-eval'` and gives `executeScript(source, request)`. RetroFlash.js still evaluates nothing itself |
| `scriptUrls: 'off'` | implemented | Every `javascript:` URL is refused |
| Ordinary URLs, `_self`, `_blank`, `_parent`, `_top`, named windows, GET/POST | implemented (before this branch) | Through the browser's own `location.assign`, `window.open` and form submission, under its pop-up rules |

### Legacy plugin methods on the element

All are installed on the element the page holds, as non-enumerable own methods. Frame numbers are zero-based. Before a movie loads they give `null`, `0`, `-1` or `false`.

| Method | Status | Notes |
|---|---|---|
| `SetVariable(path, value)`, `GetVariable(path)` | implemented (AS2) | AVM1 target paths: `/:name`, `/clip:name`, `_root.name`, `_level0.a.b`, `name`. Values are set as strings; `GetVariable` gives a string, or `null` when the variable does not exist. `$version` gives the emulated version (`WIN 10,3,183,90` by default; `flashVersion` option). AS3 movies: reported `plugin:as3Variables`, `null` |
| `Play`, `StopPlay`, `IsPlaying`, `Rewind`, `Back`, `Forward` | implemented | Main timeline. `Play` also starts the player's frame loop when it is paused |
| `GotoFrame(n)`, `CurrentFrame()`, `TotalFrames()`, `FrameLoaded(n)`, `PercentLoaded()` | implemented | `GotoFrame` goes and stops, running the frame's scripts. The whole movie is read before it plays, so every frame is loaded and `PercentLoaded` is 100 |
| `FlashVersion()` | implemented | Major version × 65536 + minor version of the emulated player (encoding inferred, see below) |
| `TGotoFrame`, `TGotoLabel`, `TCurrentFrame`, `TCurrentLabel`, `TPlay`, `TStopPlay` | implemented | Slash or dot paths from the root (`/`, `/menu`, `_level0.menu`); a missing target is reported `plugin:targetNotFound` |
| `TCallFrame`, `TCallLabel` | implemented (AS2) | Run the frame's scripts now without moving the playhead (as the `call()` action) |
| `TGetProperty`, `TGetPropertyAsNumber`, `TGetPropertyNum`, `TSetProperty`, `TSetPropertyNum` | implemented | AVM1 property indexes: 0 `_x`, 1 `_y`, 2 `_xscale`, 3 `_yscale`, 4 `_currentframe`, 5 `_totalframes`, 6 `_alpha`, 7 `_visible`, 8 `_width`, 9 `_height`, 10 `_rotation`, 11 `_target`, 12 `_framesloaded`, 13 `_name`, 14 `_droptarget`, 15 `_url`, 16 `_highquality`, 17 `_focusrect`, 18 `_soundbuftime`, 19 `_quality`, 20 `_xmouse`, 21 `_ymouse` (SWF 19 GetProperty order). Other indexes give `null` |
| `LoadMovie(level, url)` | partial | Level 0 replaces the movie through the host's loader; other levels are reported (`load:level`), as for `loadMovieNum` |
| `Zoom(percent)`, `SetZoomRect(l, t, r, b)`, `Pan(x, y, mode)` | partial | `Zoom(50)` shows half as much (things look twice as big), `Zoom(0)` the whole stage; `SetZoomRect` in twips; `Pan` moves a zoomed view by pixels (mode 0) or percent of the view (mode 1), within the stage. Also `player.setViewRect()` / `getViewRect()` |
| `CallFunction(xml)` | implemented | Calls a callback with the arguments of `<invoke name="..." returntype="xml|javascript">` and answers its result at once, in XML or as a JavaScript literal. A name the movie did not register answers `<undefined/>` |
| `SetReturnValue(xml)` | implemented | While the movie is calling the page, the value given becomes that call's result. Outside a call it is reported (`plugin:returnValueUnused`) |
| Callbacks as element methods | implemented | `document.getElementById('movie').setMessage('Hello')`. A name the element already uses (or a reserved one such as `constructor`) is not installed and is reported `browser:callbackName`; `player.callback(name, args)` still reaches it |

### XML protocol (`CallFunction`)

| Value | Status |
|---|---|
| `<string>`, `<number>` (with `NaN`, `Infinity`, `-Infinity`), `<true/>`, `<false/>`, `<null/>`, `<undefined/>` | implemented |
| `<array><property id="0">…</property></array>`, `<object><property id="name">…</property></object>` | implemented |
| `<date>ms</date>` | implemented |
| Exception transport (`<exception>`) | unavailable: with `marshallExceptions` an AS3 error is thrown to the caller of `CallFunction` instead |
| Other elements (`<class>`, …) | refused as `INVALID_XML` |

The parser accepts the XML declaration, comments, CDATA, the five named entities and numeric references; it refuses DTDs, unknown entities, mismatched tags and text after the root, and stops at 1,048,576 characters, 64 levels and 100,000 nodes.

### FlashVars and embedding

| Feature | Status | Notes |
|---|---|---|
| `<param name="flashvars">`, `<embed flashvars>` | implemented | Then the movie URL's query string, then `RetroFlashConfig.flashVars`; a repeated name keeps its last value |
| Decoding | implemented | `+` is a space, `%XX` UTF-8 (Latin-1 when not valid UTF-8), a pair without `=` has an empty value, an empty name is dropped, at most 1,048,576 characters |
| AS2: root variables | implemented | Set as strings before frame 1 |
| AS3: `loaderInfo.parameters` | implemented | Also `loaderInfo.url`, `loaderURL`, `swfVersion`, `frameRate`, `width`, `height`, `bytesLoaded`, `bytesTotal`, `contentType` |
| `<object>` with a nested `<embed>` | implemented | One player; the canvas takes the id, and `document[name]` for the names of both where the document does not use them |
| Several movies on a page | implemented | Each element gets functions bound to its own player |
| Disposal | implemented | `player.destroy()` (or the handle's `dispose()`) removes every method it added and gives back the element's own properties it covered; a destroyed player throws `DESTROYED` |

### Other mechanisms

| Feature | Status | Notes |
|---|---|---|
| AS3 `Security.allowDomain`, `allowInsecureDomain`, `loadPolicyFile` | implemented as no-ops | Accepted (so the script goes on), reported once as `browser:allowDomain`, grant nothing |
| AS2 `System.security.allowDomain` | unavailable | `System` is not implemented in AVM1 ([LIMITATIONS](../../LIMITATIONS.md) item 39) |
| `LocalConnection` (SWF ↔ SWF) | unavailable | Neither VM implements `LocalConnection` yet; a page bus would have nothing to deliver to |
| `loadVariables`, `LoadVars`, `URLLoader`, `XML.load` | not part of this work | Data loading, not page scripting; see the loader in `src/display/loader.js` |

## Runtime hooks

| Hook | Where | Used for |
|---|---|---|
| `HostBridge.call`, `.fscommand`, `.navigate`, `.addCallback`, `.removeCallback` | `avm1/external.js` | Both VMs reach the page only through these |
| `HostBridge.enter` / `.leave`, `.lastError`, `.setReturnValue` | `avm1/external.js` | Nesting depth, AS3 errors, `SetReturnValue` |
| `M.openURL` | `avm1/external.js` | AVM1 `GetURL`/`GetURL2`, `MovieClip.getURL`, text links, AS3 `navigateToURL`: FSCommand, `javascript:` or navigation |
| `ActionScheduler.invoke`, `.guard`, `.callFrame` | `avm1/interpreter.js` | Callbacks, page reads under the script budgets, `TCallFrame` |
| `Avm2Movie.invokeCallback`, `.parameters`, `.loaderInfo`, `.marshallExceptions` | `avm2/api.js` | AS3 callbacks and FlashVars |
| `M.getVariable` / `M.setVariable` / `M.resolvePath`, `M.getProperty` / `M.setProperty`, `Clip.gotoFrame` / `findLabel` | AVM1 and display modules | Plugin methods on real VM and timeline state |
| `Player.runExternal(body)` | `retroflash.js` | Runs a page request with a fresh budget when no script is running, then runs what it queued and redraws |
| `Player.fitStage` with `viewRect` | `retroflash.js` | `Zoom`, `Pan`, `SetZoomRect` |

## Security model

What a movie may do on the page is decided by the page, never by the movie.

| | Trusted movie (default) | `trust: 'untrusted'` |
|---|---|---|
| `ExternalInterface.call` | any page function by name, or `allowedFunctions` when given | only `allowedFunctions` (none by default) |
| Page → movie callbacks | yes | yes |
| `fscommand` → `<id>_DoFSCommand` | yes | only with `allowFSCommand: true` |
| `javascript:` plain calls | yes (`scriptUrls: 'known-calls'`) | only of allowed functions |
| Other `javascript:` code | only with `scriptUrls: 'trusted-eval'` and the page's `executeScript` | never (refused at creation) |
| Replacing the page (`_self`, `_parent`, `_top`) | yes | no |
| OS commands (`fscommand("exec")`) | never | never |

Always, whatever the trust: names are checked part by part (`constructor`, `prototype`, `__proto__` and the `__define*__` accessors are refused), functions that run text (`eval`, `Function`, `setTimeout` with a string, `document.write`) and `javascript:` arguments are never called, page values are read without calling getters, and values, nesting and XML are bounded. The browser's own same-origin, CORS, pop-up and navigation rules still apply.

**Deviation from the brief:** the `allowScriptAccess` parameter is still honoured by default (`sameDomain` when missing: a movie from another origin gets no page access). It is part of the page's own markup, so honouring it keeps the decision with the page; same-origin movies are unaffected. `RetroFlashConfig.allowScriptAccess = true` overrides it for every element.

Settings, for a page that keeps its markup: `window.RetroFlashConfig = { trust, allowedFunctions, allowFSCommand, scriptUrls, executeScript, allowScriptAccess, flashVars, flashVersion, projectorCommands, onFSCommand }`. For a player created by hand: the same names on `RetroFlash.createBrowserHost()` and the `RetroFlash.Player` options, then `RetroFlash.attachLegacyInterface(element, player)`.

## Behaviour chosen where the sources were unclear

These follow the documented API, Ruffle's reading of it, or the safest choice; none has been compared with a real Flash Player yet.

- `GotoFrame`, `TGotoFrame`, `TGotoLabel`, `Rewind`, `Back` and `Forward` stop the timeline after going.
- `Pan` moves the view **by** `x`, `y` (relative), within the stage.
- `FlashVersion()` is `major × 65536 + minor`.
- `TGetProperty` gives the property as AVM1 converts it to a string for the movie's SWF version (`true`, or `1` before SWF 5); an index outside 0–21 gives `null`.
- AS2 `addCallback(name, instance, null)` returns `false` and changes nothing; AS3 `addCallback(name, null)` removes the callback.
- FSCommand handler names are matched exactly (no case-insensitive search); `<id>_DoFSCommand` is preferred to `<id>_FSCommand`.
- Player FSCommand handlers run before the page's `<id>_DoFSCommand`.
- FlashVars from the URL query string override the same names in the `flashvars` parameter.
- A page `Date` reaches ActionScript as milliseconds; getters on page objects are not called (the property is `null`).
- A callback name the element already uses is not installed (rather than replacing a page property).

## Tests

```sh
npm test                      # every suite, from src/ (tests/unit/interop.test.js is the interop suite)
npm run test:dist             # the same against the ES5 bundle built by npm run build
node tests/fixtures/interop.js  # rewrites demo/interop/interop.swf from its generator
```

`tests/unit/interop.test.js` builds an ActionScript 2 movie ([`tests/fixtures/interop.js`](../../tests/fixtures/interop.js)) and an ActionScript 3 movie (ABC assembled in the test) and runs them in the player against a stand-in page window: ExternalInterface both ways for each VM, receivers, values, errors and `marshallExceptions`, nesting limits, FSCommand order, `javascript:` modes, trust, every plugin method on real timeline and variable state, `CallFunction`/`SetReturnValue`, the XML parser, FlashVars for both VMs, isolation of two players and disposal. The ExternalInterface, `javascript:` and `CallFunction` paths also run with `eval` and `Function` replaced by functions that throw, as under a Content Security Policy without `'unsafe-eval'`. The last tests run `src/browser/legacy-autoplay.js` against a minimal stand-in DOM with an `<object>`/`<embed>` page that makes no RetroFlash.js call, and check the committed demo SWF against its generator.

[`demo/interop/index.html`](../../demo/interop/index.html) is that page for a browser: unchanged Flash-era markup and scripts, and buttons that call the plugin methods. Serve the project over HTTP and open `/demo/interop/`. It has been run in headless Chrome (current version), where every call on the element gave the expected result; Chrome 38 and other browsers have not been tried with it.

**Not verified:** behaviour against a real Flash Player (no reference player was available), AS3 movies compiled by Adobe tools (the AS3 tests use hand-assembled ABC), and real-world pages beyond the demo.

## Backlog

- `LocalConnection` for AVM1 and AVM2, then an in-page bus between players (and a clearly named RetroFlash extension to send to it from the page).
- An AS3 `Array` (and `Date`) class, so arrays cross ExternalInterface into ActionScript 3.
- AVM1 `System` with `System.security.allowDomain` as a no-op.
- `<exception>` transport for `CallFunction`.
- Levels other than `_level0` (`LoadMovie(1, …)`, `loadMovieNum`).
- Comparison of the inferred behaviours above with a reference player.
