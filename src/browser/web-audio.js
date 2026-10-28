/* RetroFlash.js - The Web Audio output: RetroFlash.createWebAudioBackend(options) plays a movie's sounds with
   the browser's Web Audio API (the Player option `audio`, see audio/mixer.js for the contract). The player
   makes one itself when the browser has Web Audio. Browsers only let a page start audio after the user
   interacts with it: until then sounds are silent, and the output starts at the first pointer or key press on
   the page. MP3 is decoded by the browser (decodeAudioData). */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;

  var MIN_BUFFER_RATE = 8000; // the lowest buffer rate every browser accepts; 5.5 kHz sounds are upsampled
  var DECODE_RATE = 44100;    // rate of the context that decodes MP3 ahead of playback
  var GESTURES = ['pointerdown', 'mousedown', 'touchend', 'keydown'];
  function ignore() {}

  /* options:
     - context: an AudioContext to play into (the backend never closes it); by default the backend makes its
       own when the first sound plays;
     - window: the window whose Web Audio API is used (default the global one).
     Returns null when the window has no Web Audio. */
  function createWebAudioBackend(options) {
    options = options || {};
    var win = options.window || global;
    var Context = win.AudioContext || win.webkitAudioContext, Offline = win.OfflineAudioContext || win.webkitOfflineAudioContext;
    if (!options.context && typeof Context !== 'function') return null;
    var ctx = null, master = null, decoder = null, volume = 1, paused = false, closed = false, waiting = false;
    var voices = new Set(), buffers = new WeakMap();

    function context() {
      if (!ctx) {
        ctx = options.context || new Context();
        master = ctx.createGain();
        master.gain.value = volume;
        master.connect(ctx.destination);
        if (paused) ctx.suspend().catch(ignore);
        else if (ctx.state !== 'running') waitForGesture();
      }
      return ctx;
    }
    // Buffers are made by a context of their own when the browser has one, so decoding ahead does not create
    // the playing context before the user has interacted with the page.
    function decodingContext() {
      if (ctx) return ctx;
      if (!decoder && typeof Offline === 'function') {
        try { decoder = new Offline(1, 1, DECODE_RATE); } catch (err) { decoder = null; }
      }
      return decoder || context();
    }
    function onGesture() {
      if (closed || paused || !ctx) return stopWaiting();
      ctx.resume().then(function () { if (ctx && ctx.state === 'running') stopWaiting(); }, ignore);
    }
    function waitForGesture() {
      if (waiting || !win.addEventListener) return;
      waiting = true;
      GESTURES.forEach(function (type) { win.addEventListener(type, onGesture, true); });
    }
    function stopWaiting() {
      if (!waiting) return;
      waiting = false;
      GESTURES.forEach(function (type) { win.removeEventListener(type, onGesture, true); });
    }

    // ---- Buffers ----
    function bufferOf(media) {
      var promise = buffers.get(media);
      if (!promise) {
        promise = media.mp3 ? decode(media.mp3) : new Promise(function (resolve) { resolve(pcmBuffer(media)); });
        buffers.set(media, promise);
      }
      return promise;
    }
    function decode(bytes) {
      var data = bytes.slice().buffer; // decodeAudioData takes ownership of its buffer
      return new Promise(function (resolve, reject) {
        var result = decodingContext().decodeAudioData(data, resolve, function (err) { reject(err || new Error('decodeAudioData failed')); });
        if (result && typeof result.then === 'function') result.then(resolve, reject);
      });
    }
    function pcmBuffer(media) {
      var factor = media.rate < MIN_BUFFER_RATE ? Math.ceil(MIN_BUFFER_RATE / media.rate) : 1;
      var frames = media.channels[0].length;
      var buffer = decodingContext().createBuffer(media.channels.length, Math.max(1, frames * factor), media.rate * factor);
      media.channels.forEach(function (samples, c) {
        var out = buffer.getChannelData(c);
        if (factor === 1) { out.set(samples); return; }
        for (var i = 0; i < frames; i++) {
          var a = samples[i], b = i + 1 < frames ? samples[i + 1] : a;
          for (var k = 0; k < factor; k++) out[i * factor + k] = a + (b - a) * k / factor;
        }
      });
      return buffer;
    }

    // ---- Voices ----
    /* One playing sound: source -> left/right envelope gains -> four channel gains (ll, lr, rl, rr) -> merger
       -> master volume. A mono source feeds both sides. */
    function Voice(settings) {
      this.settings = settings;
      this.gains = settings.gains;
      this.stopped = false;
      this.source = null;
      this.nodes = null;
    }
    Voice.prototype.begin = function (buffer, late) {
      var s = this.settings, end = Math.min(s.end, buffer.duration), start = Math.min(s.start, end), segment = end - start;
      var total = segment * s.loops;
      if (segment <= 0 || late >= total) return this.finish();
      var c = context(), source = c.createBufferSource(), left = c.createGain(), right = c.createGain();
      source.buffer = buffer;
      if (buffer.numberOfChannels === 1) { source.connect(left); source.connect(right); }
      else {
        var splitter = c.createChannelSplitter(2);
        source.connect(splitter);
        splitter.connect(left, 0);
        splitter.connect(right, 1);
      }
      var merger = c.createChannelMerger(2), channel = [c.createGain(), c.createGain(), c.createGain(), c.createGain()];
      left.connect(channel[0]); channel[0].connect(merger, 0, 0);
      right.connect(channel[1]); channel[1].connect(merger, 0, 0);
      left.connect(channel[2]); channel[2].connect(merger, 0, 1);
      right.connect(channel[3]); channel[3].connect(merger, 0, 1);
      merger.connect(master);
      this.nodes = [source, left, right, merger].concat(channel);
      this.channel = channel;
      this.setGains(this.gains);
      var when = c.currentTime;
      if (s.envelope) {
        envelope(left.gain, s.envelope, 'left', when, late);
        envelope(right.gain, s.envelope, 'right', when, late);
      }
      var self = this;
      source.onended = function () { self.finish(); };
      if (s.loops > 1) {
        source.loop = true;
        source.loopStart = start;
        source.loopEnd = end;
        source.start(when, start + late % segment);
        source.stop(when + total - late);
      } else {
        source.start(when, start + late, segment - late);
      }
      this.source = source;
      this.when = when - late;
      this.start = start;
      this.segment = segment;
      this.total = total;
    };
    // Envelope points are linear ramps from the start of playback; the level before the first is the first's.
    function envelope(param, points, side, when, late) {
      param.setValueAtTime(points[0][side], when);
      points.forEach(function (p) {
        var at = when + p.time - late;
        if (at > when) param.linearRampToValueAtTime(p[side], at);
        else param.setValueAtTime(p[side], when);
      });
    }
    Voice.prototype.setGains = function (gains) {
      this.gains = gains;
      if (this.channel) this.channel.forEach(function (node, i) { node.gain.value = gains[i]; });
    };
    Voice.prototype.position = function () {
      if (!this.source || !ctx) return null;
      var elapsed = Math.max(0, ctx.currentTime - this.when);
      if (elapsed >= this.total) return this.start + this.segment;
      return this.start + elapsed % this.segment;
    };
    Voice.prototype.release = function () {
      this.stopped = true;
      voices.delete(this);
      if (!this.source) return;
      this.source.onended = null;
      try { this.source.stop(); } catch (err) { /* not started or already stopped */ }
      this.nodes.forEach(function (node) { node.disconnect(); });
      this.source = null;
      this.channel = null;
    };
    Voice.prototype.stop = function () { if (!this.stopped) this.release(); };
    // Finished by itself: tells the player once.
    Voice.prototype.finish = function () {
      if (this.stopped) return;
      this.release();
      if (this.settings.onended) this.settings.onended();
    };

    return {
      kind: 'web-audio',
      play: function (media, settings) {
        if (closed) return null;
        var voice = new Voice(settings), requested = context().currentTime;
        voices.add(voice);
        bufferOf(media).then(function (buffer) {
          if (voice.stopped || closed) return;
          voice.begin(buffer, settings.sync ? Math.max(0, ctx.currentTime - requested) : 0);
        }).catch(function (err) {
          if (voice.stopped) return;
          voice.release();
          if (settings.onerror) settings.onerror(err);
        });
        return voice;
      },
      prepare: function (media) { return closed ? Promise.resolve() : bufferOf(media).then(ignore); },
      suspend: function () {
        paused = true;
        stopWaiting();
        if (ctx) ctx.suspend().catch(ignore);
      },
      resume: function () {
        paused = false;
        if (!ctx) return;
        ctx.resume().catch(ignore);
        if (ctx.state !== 'running') waitForGesture();
      },
      setVolume: function (value) {
        volume = value;
        if (master) master.gain.value = value;
      },
      close: function () {
        closed = true;
        stopWaiting();
        voices.forEach(function (voice) { voice.release(); });
        if (ctx && !options.context) ctx.close().catch(ignore);
        else if (master) master.disconnect();
        ctx = master = decoder = null;
      }
    };
  }

  Object.assign(M, { createWebAudioBackend: createWebAudioBackend });
})(typeof window !== 'undefined' ? window : globalThis);
