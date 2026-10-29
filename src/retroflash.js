/* RetroFlash.js v1.0.0-beta.1 - SWF player (browser classic script): the public API, RetroFlash.Player.
   API: const player = new RetroFlash.Player({ canvas }); await player.load(file); player.play();
   Load swf-reader.js and the player modules first, in the order of src/modules.json, or load the single
   bundle dist/retroflash-<version>.min.js instead (npm run build).
   A bundled browser bootstrap also replaces legacy Flash object/embed elements and loads their SWF, cross-origin
   ones when CORS allows it.
   Character dictionary, display list and timelines (root and DefineSprite), DefineShape 1-4 and bitmaps
   (JPEG/PNG/GIF via the browser decoder, lossless and JPEG alpha in JS) drawn with Canvas 2D, clipDepth masks,
   text (DefineText with embedded glyphs; DefineEditText with embedded or device fonts, word wrap, alignment
   and an HTML subset), AVM1 buttons (DefineButton/DefineButton2: states, hit areas, pointer and keyboard
   events), AVM1 (ActionScript 1 and 2) in frame scripts, button actions and clip events, and sound (event
   sounds, button sounds, stream sounds and the AVM1 Sound object; PCM, ADPCM and MP3) through an audio backend,
   Web Audio by default (RetroFlash.createWebAudioBackend). It never
   evaluates JavaScript and never fetches or navigates by itself: what a movie asks of the page (getURL,
   javascript: URLs, FSCommand, ExternalInterface, loads) goes to the host page's `host` and `loader`
   options, after the cancelable events 'navigate', 'call' and 'fscommand'. RetroFlash.createBrowserHost()
   gives a host that does it with the browser's own APIs; the legacy markup bootstrap uses it. Morph shapes
   are drawn at their placement's ratio. Video is not drawn yet; see getDiagnostics().unsupported.
*/
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;
  if (!M || !M.CanvasRenderer) throw new Error('RetroFlash: load the scripts listed in src/modules.json, in order, before retroflash.js');
  var VERSION = M.VERSION, DEFAULT_LIMITS = M.DEFAULT_LIMITS, playerError = M.playerError,
    resolveLimits = M.resolveLimits, Movie = M.Movie, Clip = M.Clip, createEnv = M.createEnv,
    InputController = M.InputController, swfKeyCode = M.swfKeyCode, flashKeyCode = M.flashKeyCode, keyAscii = M.keyAscii,
    CanvasRenderer = M.CanvasRenderer;
  // Keys that would scroll the page (space, page up/down, end, home, arrows): the movie keeps them.
  var NAVIGATION_KEYS = { 32: 1, 33: 1, 34: 1, 35: 1, 36: 1, 37: 1, 38: 1, 39: 1, 40: 1 };
  function isVolume(v) { return typeof v === 'number' && v >= 0 && v <= 1; }
  function now() { return global.performance && global.performance.now ? global.performance.now() : Date.now(); }
  function consoleWarn(message, detail) {
    if (!global.console || !global.console.warn) return;
    if (detail) global.console.warn('[RetroFlash.js] ' + message, detail);
    else global.console.warn('[RetroFlash.js] ' + message);
  }
  function consoleError(message, error) {
    if (!global.console || !global.console.error) return;
    if (error) global.console.error('[RetroFlash.js] ' + message, error);
    else global.console.error('[RetroFlash.js] ' + message);
  }
  function logSwfDiagnostics(player, swf) {
    var unsupported = swf.unsupported || [], diagnostics = (swf.diagnostics || []).filter(function (entry) {
      return entry.level !== 'info';
    });
    if (player.options.actions) unsupported = unsupported.filter(function (entry) { return !PLAYER_RUNS[entry.feature]; });
    unsupported.slice(0, 10).forEach(function (entry) { player.logUnsupported(entry); });
    if (unsupported.length > 10) consoleWarn((unsupported.length - 10) + ' additional unsupported feature type(s) omitted.');
    diagnostics.slice(0, 8).forEach(function (entry) {
      consoleWarn('SWF ' + entry.level + (entry.code ? ' [' + entry.code + ']' : '') + ': ' + entry.message, entry);
    });
    if (diagnostics.length > 8) consoleWarn((diagnostics.length - 8) + ' additional SWF diagnostic(s) omitted.');
  }
  // FlashVars: name=value pairs (a query string, or an object's own properties) set on the root as strings.
  function setRootVariables(root, variables) {
    if (variables === undefined || variables === null || variables === '') return;
    var pairs = typeof variables === 'string' ? M.parseVariables(variables.replace(/^\?/, ''))
      : Object.keys(variables).map(function (k) { return [k, variables[k]]; });
    var rt = M.runtimeOf(root.env.scripts);
    pairs.forEach(function (p) { M.setMember(rt, root, String(p[0]), String(p[1])); });
  }
  delete global.RetroFlashModules;

  var EVENTS = { load: 1, frame: 1, warning: 1, error: 1, end: 1, navigate: 1, call: 1, fscommand: 1, callbacks: 1, interaction: 1 };
  var MAX_INTERACTION_LOG = 100;
  // The reader lists ActionScript tags as unsupported (it never runs them); the player runs AVM1 itself.
  var PLAYER_RUNS = { 'actionscript:DoAction': 1, 'actionscript:DoInitAction': 1 };

  function Player(options) {
    options = options || {};
    if (!options.canvas || typeof options.canvas.getContext !== 'function') throw playerError('INVALID_OPTION', 'options.canvas must be a <canvas> element');
    if (options.loader !== undefined && options.loader !== null && typeof options.loader !== 'function') throw playerError('INVALID_OPTION', 'options.loader must be a function');
    if (options.host !== undefined && options.host !== null && typeof options.host !== 'object') throw playerError('INVALID_OPTION', 'options.host must be an object');
    if (options.audio !== undefined && options.audio !== null && options.audio !== false && (typeof options.audio !== 'object' || typeof options.audio.play !== 'function')) {
      throw playerError('INVALID_OPTION', 'options.audio must be false or an audio backend with a play method');
    }
    if (options.volume !== undefined && !isVolume(options.volume)) throw playerError('INVALID_OPTION', 'options.volume must be a number from 0 to 1');
    this.canvas = options.canvas;
    // host: what the movie asks of the page (navigate, call, fscommand, load, objectID; see src/README.md).
    this.host = options.host || null;
    // loader(request) gives the bytes of a URL a script loads, or null to refuse it (see src/README.md).
    this.loader = options.loader || (this.host && typeof this.host.load === 'function' ? this.host.load.bind(this.host) : null);
    this.movieOptions = {};
    this.options = {
      autoplay: !!options.autoplay,
      loop: options.loop !== false,
      maxFileBytes: options.maxFileBytes,
      actions: options.actions !== false,
      input: options.input !== false,
      pixelRatio: options.pixelRatio || global.devicePixelRatio || 1,
      maxCatchUpFrames: options.maxCatchUpFrames || 4
    };
    // Budgets against hostile files: maxNesting, maxInstances, maxBitmapPixels, maxTotalBitmapPixels,
    // maxActionBlocks and maxActionSteps (RetroFlash.defaultLimits).
    this.limits = resolveLimits(options);
    this.state = 'idle';
    this.listeners = {};
    this.interactionLog = [];
    this.interactionSequence = 0;
    this.loggedErrors = Object.create(null);
    this.loggedUnsupported = Object.create(null);
    this.movie = null;
    this.root = null;
    this.unsupported = [];
    this.unsupportedByFeature = Object.create(null);
    this.rafId = 0;
    this.loadSerial = 0;
    var self = this;
    this.report = function (feature, reason, source) { self.recordUnsupported(feature, reason, source); };
    this.renderer = new CanvasRenderer(this.canvas, this.report);
    // audio: the backend that plays sounds (see src/README.md); false plays none. By default Web Audio, when
    // the browser has it.
    var backend = options.audio === false ? null : options.audio || M.createWebAudioBackend();
    this.audio = new M.AudioController(backend, this.report, this.limits);
    this.audio.setVolume(options.volume === undefined ? 1 : options.volume);
    this.input = null;
    this.domHandlers = [];
    if (this.options.input && typeof this.canvas.addEventListener === 'function') this.attachInput();
  }
  // Pointer and keyboard on the canvas drive the movie's buttons. The canvas gets focus when pressed.
  Player.prototype.attachInput = function () {
    var self = this, canvas = this.canvas;
    if (canvas.tabIndex < 0) canvas.tabIndex = 0;
    function on(type, fn) { canvas.addEventListener(type, fn); self.domHandlers.push([type, fn]); }
    function point(e) {
      var rect = canvas.getBoundingClientRect(), b = self.movie.swf.bounds;
      return [b.xminTwips + ((e.clientX - rect.left) / rect.width) * (b.xmaxTwips - b.xminTwips),
        b.yminTwips + ((e.clientY - rect.top) / rect.height) * (b.ymaxTwips - b.yminTwips)];
    }
    function ready() {
      if (!self.input || !self.root || self.state === 'loading' || self.state === 'destroyed') return false;
      self.env.instances = 0;
      return true;
    }
    on('pointermove', function (e) { if (ready()) { var p = point(e); if (self.input.move(p[0], p[1])) self.afterInput(); } });
    on('pointerleave', function () { if (ready() && !self.input.mouseDown && self.input.leave()) self.afterInput(); });
    on('pointerdown', function (e) {
      if (!ready() || e.button !== 0) return;
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* capture is optional */ }
      if (canvas.focus) canvas.focus({ preventScroll: true });
      var p = point(e);
      var changed = self.input.move(p[0], p[1]);
      if (self.input.down() || changed) self.afterInput();
    });
    on('pointerup', function (e) {
      if (!ready() || e.button !== 0) return;
      var p = point(e), inside = p[0] >= self.movie.swf.bounds.xminTwips && p[0] <= self.movie.swf.bounds.xmaxTwips &&
        p[1] >= self.movie.swf.bounds.yminTwips && p[1] <= self.movie.swf.bounds.ymaxTwips;
      if (inside) self.input.move(p[0], p[1]); else self.input.leave();
      if (self.input.up()) self.afterInput();
    });
    on('pointercancel', function () { if (ready() && self.input.up()) self.afterInput(); });
    // Keys: Key.isDown and the key events of clips and listeners, then the KeyPress actions of buttons.
    on('keydown', function (e) {
      if (!ready()) return;
      var code = flashKeyCode(e), changed = self.input.keyDown(code, keyAscii(e));
      if (self.input.key(swfKeyCode(e.key))) changed = true;
      if (changed || NAVIGATION_KEYS[code]) e.preventDefault();
      if (changed) self.afterInput();
    });
    on('keyup', function (e) { if (ready() && self.input.keyUp(flashKeyCode(e))) self.afterInput(); });
    on('blur', function () { if (self.input) self.input.releaseKeys(); });
  };
  // Runs the actions queued by a button event, re-checks the hovered button, redraws.
  Player.prototype.afterInput = function () {
    this.env.scripts.beginUpdate();
    this.env.scripts.run();
    if (this.input.afterTick()) this.env.scripts.run();
    this.render();
    this.canvas.style.cursor = this.input.cursor();
    this.emit('frame', this.root.frame);
  };
  Player.prototype.on = function (type, fn) {
    if (!EVENTS[type]) throw playerError('INVALID_EVENT', 'Unknown event ' + type);
    (this.listeners[type] || (this.listeners[type] = [])).push(fn);
    return this;
  };
  Player.prototype.off = function (type, fn) {
    var list = this.listeners[type];
    if (list) this.listeners[type] = list.filter(function (f) { return f !== fn; });
    return this;
  };
  Player.prototype.emit = function (type, detail) {
    if (type === 'error') this.logError(detail);
    (this.listeners[type] || []).slice().forEach(function (fn) {
      try { fn(detail); } catch (err) { if (global.console) console.error(err); }
    });
  };
  /* The cancelable events of what the movie asks of the page ('navigate', 'call', 'fscommand'): listeners get
     the request first, and one that calls request.preventDefault() handles it, so the host is not asked.
     Requests of a movie the player has left are dropped. */
  Player.prototype.dispatch = function (env, type, request) {
    if (this.env !== env || this.state === 'destroyed') return false;
    this.emit(type, request);
    return !request.defaultPrevented;
  };
  // A bounded, query-free history of the movie/page boundary. Values and POST bodies are never retained.
  Player.prototype.recordInteraction = function (entry) {
    var item = Object.freeze(Object.assign({ id: ++this.interactionSequence, time: Date.now() }, entry));
    this.interactionLog.push(item);
    if (this.interactionLog.length > MAX_INTERACTION_LOG) this.interactionLog.shift();
    this.emit('interaction', item);
    return item;
  };
  Player.prototype.getInteractionLog = function () { return this.interactionLog.slice(); };
  Player.prototype.clearInteractionLog = function () { this.interactionLog.length = 0; return this; };
  /* Calls a function the movie registered with ExternalInterface.addCallback(name, ...), as a page called the
     plugin's method. `args` (an array) and the result are converted between JavaScript and AVM1 values. When no
     script is running the call gets its own budget, and the movie is redrawn after it; a call made while the
     movie is calling the page shares the running script's. A name the movie did not register is reported as
     browser:callbackMissing and gives undefined. */
  Player.prototype.callback = function (name, args) {
    this.assertUsable();
    if (!this.root) throw playerError('NOT_LOADED', 'No movie loaded');
    var env = this.env, scripts = env.scripts, entry = env.host.callbacks.get(String(name));
    var list = Array.isArray(args) ? args : args === undefined ? [] : [args];
    if (!entry) {
      this.recordInteraction({ direction: 'incoming', channel: 'ExternalInterface.callback', status: 'missing', name: String(name), argumentCount: list.length });
      this.recordUnsupported('browser:callbackMissing', 'The page called a callback the movie did not register with ExternalInterface.addCallback.', String(name));
      return undefined;
    }
    var rt = M.runtimeOf(scripts), outer = scripts.active === 0;
    if (outer) { env.instances = 0; scripts.beginUpdate(); }
    var value = scripts.invoke(entry.fn, entry.thisValue, list.map(function (a) { return M.fromHostValue(rt, a); }), 'callback ' + name);
    var result = M.toHostValue(rt, value);
    this.recordInteraction({ direction: 'incoming', channel: 'ExternalInterface.callback', status: 'called', name: String(name), argumentCount: list.length, resultType: result === null ? 'null' : typeof result });
    if (outer && this.env === env && this.root) {
      scripts.run();
      if (this.input && this.input.afterTick()) scripts.run();
      this.render();
      this.emit('frame', this.root.frame);
    }
    return result;
  };
  // The names the movie registered with ExternalInterface.addCallback.
  Player.prototype.getCallbacks = function () {
    return this.env && this.env.host ? Array.from(this.env.host.callbacks.keys()) : [];
  };
  Player.prototype.logError = function (error) {
    var message = error && error.message ? error.message : String(error || 'Unknown player error');
    var key = (error && error.code ? error.code + ':' : '') + message;
    if (this.loggedErrors[key]) return;
    this.loggedErrors[key] = true;
    consoleError(message, error);
  };
  Player.prototype.logUnsupported = function (entry) {
    var key = String(entry.feature) + '\n' + String(entry.reason);
    if (this.loggedUnsupported[key]) return;
    this.loggedUnsupported[key] = true;
    consoleWarn('Unsupported SWF feature "' + entry.feature + '": ' + entry.reason, entry);
  };
  // Aggregated per feature; `count` is the number of distinct sources (character ids, depths).
  Player.prototype.recordUnsupported = function (feature, reason, source) {
    var entry = this.unsupportedByFeature[feature];
    if (!entry) {
      entry = this.unsupportedByFeature[feature] = { feature: feature, reason: reason, count: 0, sources: [] };
      this.unsupported.push(entry);
    }
    var key = String(source);
    if (entry.sources.indexOf(key) === -1) {
      entry.sources.push(key);
      entry.count++;
      if (entry.count === 1) {
        this.logUnsupported(entry);
        this.emit('warning', entry);
      }
    }
  };
  Player.prototype.assertUsable = function () {
    if (this.state === 'destroyed') throw playerError('DESTROYED', 'The player has been destroyed');
  };
  /* Only the latest call wins: a load that is superseded by another load(), or by destroy(), resolves to null
     without changing the player, even if it fails. Its diagnostics are dropped from that moment on.
     options: { url (the movie's URL, its _url), variables (FlashVars: a query string or an object, set on the
     root as strings before its first frame) }. */
  Player.prototype.load = async function (input, options) {
    this.assertUsable();
    if (options !== undefined && options !== null && typeof options !== 'object') throw playerError('INVALID_OPTION', 'load options must be an object');
    var variables = options ? options.variables : undefined;
    if (variables !== undefined && variables !== null && typeof variables !== 'string' && typeof variables !== 'object') throw playerError('INVALID_OPTION', 'load options.variables must be a string or an object');
    var movieOptions = { url: options && options.url ? String(options.url) : '', variables: variables };
    this.loggedErrors = Object.create(null);
    this.loggedUnsupported = Object.create(null);
    if (!global.SWFReader) throw playerError('MISSING_READER', 'Load swf-reader.js before retroflash.js');
    var serial = ++this.loadSerial, self = this;
    function superseded() { return self.state === 'destroyed' || serial !== self.loadSerial; }
    function report(feature, reason, source) { if (!superseded()) self.report(feature, reason, source); }
    this.pause();
    this.closeLoads();
    this.audio.clear();
    if (this.movie) this.movie.release();
    this.state = 'loading';
    this.movie = this.root = null;
    this.unsupported = [];
    this.unsupportedByFeature = Object.create(null);
    var swf, movie = null;
    try {
      swf = await global.SWFReader.load(input, this.options.maxFileBytes ? { maxFileBytes: this.options.maxFileBytes } : undefined);
    } catch (err) {
      if (superseded()) return null;
      this.state = 'error';
      this.emit('error', err);
      throw err;
    }
    if (superseded()) return null;
    logSwfDiagnostics(this, swf);
    try {
      movie = new Movie(swf);
      await movie.decodeBitmaps({ maxPixels: this.limits.maxBitmapPixels, remaining: this.limits.maxTotalBitmapPixels }, report);
      await movie.loadFonts(report);
      if (superseded()) { movie.release(); return null; }
      this.movie = movie;
      this.movieOptions = movieOptions;
      this.audio.prepare(movie);
      this.fps = swf.fps > 0 ? swf.fps : 12;
      if (!(swf.fps > 0)) this.recordUnsupported('timeline:zeroFps', 'The file declares 0 fps; playing at 12 fps.', 'header');
      this.restart();
      this.resize();
      this.render();
    } catch (err) {
      if (movie) movie.release();
      if (superseded()) return null;
      // Never leave the player stuck in 'loading' (for example a runtime error on a hostile file).
      this.movie = this.root = null;
      this.state = 'error';
      this.emit('error', err);
      throw err;
    }
    this.state = 'ready';
    this.emit('load', this.getInfo());
    if (this.options.autoplay) this.play();
    return this.getInfo();
  };
  Player.prototype.resize = function () {
    var swf = this.movie.swf, ratio = this.options.pixelRatio;
    var width = Math.max(1, swf.width), height = Math.max(1, swf.height);
    this.canvas.width = Math.max(1, Math.min(8192, Math.round(width * ratio)));
    this.canvas.height = Math.max(1, Math.min(8192, Math.round(height * ratio)));
    if (this.canvas.style) { this.canvas.style.width = width + 'px'; this.canvas.style.height = 'auto'; }
  };
  // Fresh root timeline at frame 1, with its frame scripts run (as when the movie starts).
  Player.prototype.restart = function () {
    this.closeLoads();
    this.audio.reset();
    var self = this, previous = this.env;
    var env = this.env = createEnv(this.movie, this.report, {
      actions: this.options.actions, limits: this.limits, loader: this.loader, maxFileBytes: this.options.maxFileBytes, audio: this.audio,
      host: this.host, dispatch: function (type, request) { return self.dispatch(env, type, request); },
      interaction: function (entry) { if (self.env === env) self.recordInteraction(entry); }
    });
    env.url = this.movieOptions.url || '';
    env.host.onCallbacks = function (names) { if (self.env === env) self.emit('callbacks', names); };
    if (previous && previous.host && previous.host.callbacks.size) this.emit('callbacks', []);
    // A load that finishes while the movie is not playing is shown at once; while playing, at the next frame.
    env.loads.onSettled = function () {
      if (self.env !== env || !self.root || self.state === 'playing' || self.state === 'loading' || self.state === 'destroyed') return;
      try {
        env.instances = 0;
        env.scripts.beginUpdate();
        if (!self.applyLoads()) return;
        self.render();
      } catch (err) {
        self.emit('error', err);
        return;
      }
      self.emit('frame', self.root.frame);
    };
    var started = now();
    this.env.scripts.clock = function () { return now() - started; }; // getTimer: milliseconds since the start
    this.root = new Clip(this.env, this.movie.root, 0, null);
    this.root.loop = this.options.loop;
    setRootVariables(this.root, this.movieOptions.variables);
    this.root.gotoFrame(1);
    this.env.scripts.run();
    var previous = this.input;
    this.input = new InputController(this.env, function () { return self.root; });
    if (previous && previous.inside) { this.input.inside = true; this.input.x = previous.x; this.input.y = previous.y; }
    if (this.input.afterTick()) this.env.scripts.run();
  };
  // Shows the result of an update. Stream sounds of timelines that stopped or left the stage end here too.
  Player.prototype.render = function () {
    var swf = this.movie.swf, b = swf.bounds;
    this.audio.sync();
    this.renderer.render({
      background: swf.background, xMin: b.xminTwips, yMin: b.yminTwips, characters: this.movie.characters,
      widthTwips: Math.max(1, b.xmaxTwips - b.xminTwips), heightTwips: Math.max(1, b.ymaxTwips - b.yminTwips)
    }, this.root);
  };
  Player.prototype.play = function () {
    this.assertUsable();
    if (!this.root || this.state === 'playing') return;
    // A finished non-looping movie restarts like stop(): timelines rebuilt and frame-1 scripts run again.
    if (!this.options.loop && this.root.frame === this.root.frameCount()) { this.restart(); this.render(); }
    this.state = 'playing';
    this.audio.resume();
    this.lastTime = null;
    this.accumulator = 0;
    var self = this;
    this.rafId = global.requestAnimationFrame(function (t) { self.loop(t); });
  };
  Player.prototype.pause = function () {
    if (this.rafId) global.cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    if (this.state === 'playing') this.state = 'paused';
    this.audio.suspend();
  };
  // Volume of the movie's sounds, from 0 to 1 (the Player option `volume`).
  Player.prototype.setVolume = function (volume) {
    if (!isVolume(volume)) throw playerError('INVALID_OPTION', 'volume must be a number from 0 to 1');
    this.audio.setVolume(volume);
    return this;
  };
  Player.prototype.getVolume = function () { return this.audio.volume; };
  // Rewinds to the start: every timeline is rebuilt at frame 1 and frame-1 scripts run again; stays paused.
  Player.prototype.stop = function () {
    this.assertUsable();
    this.pause();
    if (!this.root) return;
    this.restart();
    this.render();
    this.emit('frame', this.root.frame);
  };
  // Advances exactly one frame (root and every sprite instance), then renders.
  Player.prototype.step = function () {
    this.assertUsable();
    if (!this.root) return;
    this.advance();
    this.runTimers();
    this.render();
    this.emit('frame', this.root.frame);
  };
  // frame: 1-based number or frame label. A debugging/scrubbing jump: frame scripts are NOT run, and sprite
  // instances that persist keep their own playhead.
  Player.prototype.seek = function (frame) {
    this.assertUsable();
    if (!this.root) throw playerError('NOT_LOADED', 'No movie loaded');
    var n = typeof frame === 'string' ? this.movie.root.labels[frame] : frame;
    if (!Number.isFinite(n)) throw playerError('INVALID_FRAME', 'Unknown frame ' + JSON.stringify(frame));
    var scripts = this.env.scripts, mark = scripts.mark();
    this.env.instances = 0;
    this.audio.quiet++;
    try { this.root.gotoFrame(n); } finally { this.audio.quiet--; }
    scripts.dropSince(mark);
    if (this.input) this.input.pruneRemoved();
    this.render();
    this.emit('frame', this.root.frame);
  };
  Player.prototype.advance = function () {
    this.env.instances = 0;
    this.env.scripts.beginUpdate();
    this.audio.collect(this.env.scripts);
    var ended = this.root.tick();
    this.env.scripts.run();
    if (this.input && this.input.afterTick()) {
      this.env.scripts.run();
      this.canvas.style.cursor = this.input.cursor();
    }
    this.applyLoads();
    if (ended) {
      this.emit('end', this.root.frame);
      if (!this.options.loop) this.pause();
    }
  };
  /* Shows what loads have brought (display/loader.js) and runs the scripts that queued: the new content's
     frame-1 scripts and load events. True when something changed. */
  Player.prototype.applyLoads = function () {
    var scripts = this.env.scripts;
    if (!this.env.loads || !this.env.loads.apply()) return false;
    scripts.run();
    if (this.input && this.input.afterTick()) {
      scripts.run();
      if (this.canvas.style) this.canvas.style.cursor = this.input.cursor();
    }
    return true;
  };
  // Frees what scripts loaded into clips; loads still waiting for the host are dropped when they finish.
  Player.prototype.closeLoads = function () {
    if (this.env && this.env.loads) this.env.loads.close();
  };
  // Runs the setInterval/setTimeout timers that are due, between frames; true when one ran.
  Player.prototype.runTimers = function () {
    var scripts = this.env.scripts;
    if (!scripts.runTimers()) return false;
    this.env.instances = 0;
    scripts.beginUpdate();
    scripts.run();
    if (this.input && this.input.afterTick()) scripts.run();
    return true;
  };
  Player.prototype.loop = function (time) {
    if (this.state !== 'playing') return;
    var self = this, duration = 1000 / this.fps, steps = 0;
    if (this.lastTime !== null) this.accumulator += time - this.lastTime;
    this.lastTime = time;
    while (this.accumulator >= duration && steps < this.options.maxCatchUpFrames && this.state === 'playing') {
      this.advance();
      this.accumulator -= duration;
      steps++;
    }
    if (steps === this.options.maxCatchUpFrames) this.accumulator = Math.min(this.accumulator, duration); // drop frames, don't spiral
    var timed = this.state === 'playing' && this.runTimers();
    if (steps || timed) { this.render(); this.emit('frame', this.root.frame); }
    if (this.state === 'playing') this.rafId = global.requestAnimationFrame(function (t) { self.loop(t); });
  };
  Player.prototype.getInfo = function () {
    var swf = this.movie && this.movie.swf;
    return {
      state: this.state, playerVersion: VERSION,
      signature: swf ? swf.signature : null, version: swf ? swf.version : null,
      width: swf ? swf.width : 0, height: swf ? swf.height : 0, fps: swf ? this.fps : 0,
      frameCount: this.root ? this.root.frameCount() : 0, currentFrame: this.root ? this.root.frame : 0,
      rootPlaying: this.root ? this.root.playing : false,
      labels: this.movie ? Object.assign({}, this.movie.root.labels) : {}
    };
  };
  Player.prototype.getDiagnostics = function () {
    var swf = this.movie && this.movie.swf;
    return {
      diagnostics: swf ? swf.diagnostics.slice() : [],
      unsupported: (swf ? swf.unsupported : []).concat(this.unsupported.map(function (u) {
        return { feature: u.feature, reason: u.reason, count: u.count, sources: u.sources.slice() };
      }))
    };
  };
  Player.prototype.destroy = function () {
    var canvas = this.canvas;
    this.pause();
    this.domHandlers.forEach(function (h) { canvas.removeEventListener(h[0], h[1]); });
    this.domHandlers = [];
    this.state = 'destroyed';
    this.listeners = {};
    this.closeLoads();
    this.audio.close();
    if (this.movie) this.movie.release();
    this.movie = this.root = this.input = null;
  };

  global.RetroFlash = Object.freeze({
    version: VERSION,
    Player: Player,
    defaultLimits: DEFAULT_LIMITS,
    createBrowserHost: M.createBrowserHost,
    createWebAudioBackend: M.createWebAudioBackend,
    // Building blocks of every module, exposed for tests and tooling; not a stable API.
    internals: Object.freeze(Object.assign({}, M))
  });
})(typeof window !== 'undefined' ? window : globalThis);
