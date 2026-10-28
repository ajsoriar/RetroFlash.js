/* RetroFlash.js v0.4 - SWF player prototype (browser classic script): the public API, RetroFlash.Player.
   API: const player = new RetroFlash.Player({ canvas }); await player.load(file); player.play();
   Load swf-reader.js and the player modules first, in the order of src/modules.json, or load the single
   bundle dist/retroflash.min.js instead (npm run build).
   Character dictionary, display list and timelines (root and DefineSprite), DefineShape 1-4 and bitmaps
   (JPEG/PNG/GIF via the browser decoder, lossless and JPEG alpha in JS) drawn with Canvas 2D, clipDepth masks,
   text (DefineText with embedded glyphs; DefineEditText with embedded or device fonts, word wrap, alignment
   and an HTML subset), AVM1 buttons (DefineButton/DefineButton2: states, hit areas, pointer and keyboard
   events), and AVM1 (ActionScript 1 and 2) in frame scripts, button actions and clip events. It never
   evaluates JavaScript, navigates or fetches: movies, images and variables that scripts load come from the
   host page's `loader` option. Sound, video and morph shapes are not drawn yet; see
   getDiagnostics().unsupported.
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
  function now() { return global.performance && global.performance.now ? global.performance.now() : Date.now(); }
  delete global.RetroFlashModules;

  var EVENTS = { load: 1, frame: 1, warning: 1, error: 1, end: 1 };

  function Player(options) {
    options = options || {};
    if (!options.canvas || typeof options.canvas.getContext !== 'function') throw playerError('INVALID_OPTION', 'options.canvas must be a <canvas> element');
    if (options.loader !== undefined && options.loader !== null && typeof options.loader !== 'function') throw playerError('INVALID_OPTION', 'options.loader must be a function');
    this.canvas = options.canvas;
    // loader(request) gives the bytes of a URL a script loads, or null to refuse it (see src/README.md).
    this.loader = options.loader || null;
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
    this.movie = null;
    this.root = null;
    this.unsupported = [];
    this.unsupportedByFeature = Object.create(null);
    this.rafId = 0;
    this.loadSerial = 0;
    var self = this;
    this.report = function (feature, reason, source) { self.recordUnsupported(feature, reason, source); };
    this.renderer = new CanvasRenderer(this.canvas, this.report);
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
    (this.listeners[type] || []).slice().forEach(function (fn) {
      try { fn(detail); } catch (err) { if (global.console) console.error(err); }
    });
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
      if (entry.count === 1) this.emit('warning', entry);
    }
  };
  Player.prototype.assertUsable = function () {
    if (this.state === 'destroyed') throw playerError('DESTROYED', 'The player has been destroyed');
  };
  // Only the latest call wins: a load that is superseded by another load(), or by destroy(), resolves to null
  // without changing the player, even if it fails. Its diagnostics are dropped from that moment on.
  Player.prototype.load = async function (input) {
    this.assertUsable();
    if (!global.SWFReader) throw playerError('MISSING_READER', 'Load swf-reader.js before retroflash.js');
    var serial = ++this.loadSerial, self = this;
    function superseded() { return self.state === 'destroyed' || serial !== self.loadSerial; }
    function report(feature, reason, source) { if (!superseded()) self.report(feature, reason, source); }
    this.pause();
    this.closeLoads();
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
    try {
      movie = new Movie(swf);
      await movie.decodeBitmaps({ maxPixels: this.limits.maxBitmapPixels, remaining: this.limits.maxTotalBitmapPixels }, report);
      if (superseded()) { movie.release(); return null; }
      this.movie = movie;
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
    var self = this, env = this.env = createEnv(this.movie, this.report, {
      actions: this.options.actions, limits: this.limits, loader: this.loader, maxFileBytes: this.options.maxFileBytes
    });
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
    this.root.gotoFrame(1);
    this.env.scripts.run();
    var previous = this.input;
    this.input = new InputController(this.env, function () { return self.root; });
    if (previous && previous.inside) { this.input.inside = true; this.input.x = previous.x; this.input.y = previous.y; }
    if (this.input.afterTick()) this.env.scripts.run();
    if (this.movie.buttonSounds.length) this.recordUnsupported('sound:DefineButtonSound', 'Button sounds are not played (no audio yet).', this.movie.buttonSounds.join(','));
  };
  Player.prototype.render = function () {
    var swf = this.movie.swf, b = swf.bounds;
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
    this.lastTime = null;
    this.accumulator = 0;
    var self = this;
    this.rafId = global.requestAnimationFrame(function (t) { self.loop(t); });
  };
  Player.prototype.pause = function () {
    if (this.rafId) global.cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    if (this.state === 'playing') this.state = 'paused';
  };
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
    this.root.gotoFrame(n);
    scripts.dropSince(mark);
    if (this.input) this.input.pruneRemoved();
    this.render();
    this.emit('frame', this.root.frame);
  };
  Player.prototype.advance = function () {
    this.env.instances = 0;
    this.env.scripts.beginUpdate();
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
    if (this.movie) this.movie.release();
    this.movie = this.root = this.input = null;
  };

  global.RetroFlash = Object.freeze({
    version: VERSION,
    Player: Player,
    defaultLimits: DEFAULT_LIMITS,
    // Building blocks of every module, exposed for tests and tooling; not a stable API.
    internals: Object.freeze(Object.assign({}, M))
  });
})(typeof window !== 'undefined' ? window : globalThis);
