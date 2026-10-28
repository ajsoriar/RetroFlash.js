/* RetroFlash.js - Loading movies, images and variables into clips (loadMovie, unloadMovie, loadVariables).
   The player never fetches anything: the host page gives it a loader function (the Player option `loader`, or
   the `load` method of its `host`), which decides whether a URL may be loaded and returns its bytes. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;

  var MAX_PENDING_LOADS = 8; // loads waiting for the host at once; more are dropped (a script cannot flood the host)
  var METHODS = [null, 'GET', 'POST'];

  function loadError(code, message) {
    var err = new Error(message);
    err.code = code;
    return err;
  }
  // The data a host loader returned, as bytes: a Uint8Array, another typed array or DataView, an ArrayBuffer or a Blob.
  function toBytes(data) {
    if (data instanceof Uint8Array) return Promise.resolve(data);
    if (ArrayBuffer.isView(data)) return Promise.resolve(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    if (data instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(data));
    if (data && typeof data.arrayBuffer === 'function') return data.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    return Promise.reject(loadError('LOAD_DATA', 'The host loader returned ' + (typeof data) + ', not bytes'));
  }
  function isSWF(b) {
    return b.length >= 3 && (b[0] === 0x46 || b[0] === 0x43 || b[0] === 0x5a) && b[1] === 0x57 && b[2] === 0x53;
  }
  // Text of loaded variables: UTF-8 from SWF 6, Latin-1 before (as Flash Player reads them).
  function decodeText(bytes, version) {
    if (version >= 6 && typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return s;
  }
  // A URL-encoded name or value: '+' is a space; %XX escapes that are not UTF-8 are read as Latin-1.
  function decodePart(s) {
    s = s.replace(/\+/g, ' ');
    try {
      return decodeURIComponent(s);
    } catch (err) {
      return s.replace(/%([0-9a-f]{2})/gi, function (m, hex) { return String.fromCharCode(parseInt(hex, 16)); });
    }
  }
  // URL-encoded name=value pairs, as loadVariables reads them: [[name, value], ...] in order.
  function parseVariables(text) {
    var pairs = [];
    text.split('&').forEach(function (part) {
      if (!part) return;
      var at = part.indexOf('=');
      var name = decodePart(at < 0 ? part : part.slice(0, at)), value = at < 0 ? '' : decodePart(part.slice(at + 1));
      if (name) pairs.push([name, value]);
    });
    return pairs;
  }

  // A drawable image a host gave instead of bytes (an HTMLImageElement, ImageBitmap or canvas), or null.
  function drawableOf(data) {
    if (!data || typeof data !== 'object' || data instanceof ArrayBuffer || ArrayBuffer.isView(data) || typeof data.arrayBuffer === 'function') return null;
    var width = data.naturalWidth || data.width, height = data.naturalHeight || data.height;
    var drawable = typeof data.naturalWidth === 'number' || typeof data.getContext === 'function' || typeof data.close === 'function';
    return drawable && width > 0 && height > 0 ? { width: width, height: height } : null;
  }
  // Errors a host loader throws, by `code`: [feature, reason]. Any other error is load:failed.
  var LOAD_ERRORS = {
    LOAD_REFUSED: ['load:refused', 'The host page did not give a URL a script loads.'],
    LOAD_CORS: ['load:cors', 'The server did not let this page read a URL a script loads (CORS), or it could not be reached; nothing was loaded.'],
    LOAD_NETWORK: ['load:network', 'A URL a script loads could not be reached; nothing was loaded.'],
    LOAD_HTTP: ['load:http', 'The server answered a URL a script loads with an error; nothing was loaded.'],
    LOAD_BLOCKED: ['load:blocked', 'The host page does not let the movie load URLs (allowNetworking); nothing was loaded.'],
    INVALID_URL: ['load:invalidURL', 'A script loads a URL that is not valid; nothing was loaded.']
  };

  /* The loads of one movie (env.loads). request() asks the host for a URL; what arrives is kept until apply(),
     which the player calls between frames, so content changes at a frame boundary as in Flash Player.
     - host(request): request is { url, type: 'movie' | 'variables', method: null | 'GET' | 'POST' }; with a
       method it also has `variables` ([[name, value], ...], sent as Flash Player sends them: added to the URL
       for GET, and as `body`, URL-encoded, for POST). It returns (or resolves to) a Uint8Array, an ArrayBuffer,
       a typed array, a Blob, or, for variables, a string; for a movie load it may also give an image the
       browser already decoded (HTMLImageElement, ImageBitmap or canvas). null or undefined refuses the URL.
       The URL is passed as the script wrote it; the host resolves it. A host error with a `code` of
       LOAD_ERRORS is reported as such.
     - Movies are SWF files; images are JPEG, PNG or GIF files. Their bitmaps share one pixel budget
       (limits.maxBitmapPixels per image, limits.maxTotalBitmapPixels for everything loaded at once), given back
       when the content is unloaded. */
  function LoadQueue(host, report, limits, maxFileBytes, interaction) {
    this.host = typeof host === 'function' ? host : null;
    this.report = report;
    this.interaction = typeof interaction === 'function' ? interaction : null;
    this.maxFileBytes = maxFileBytes;
    this.pixels = { maxPixels: limits.maxBitmapPixels, remaining: limits.maxTotalBitmapPixels };
    this.pending = 0;
    this.done = [];            // finished loads waiting for apply()
    this.serial = 0;
    this.closed = false;
    this.contents = new Set(); // clips showing loaded content
    this.waiters = [];
    this.onSettled = null;     // called when a load has finished (the player applies it if it is not playing)
    this.decodeImage = M.decodeImage; // browser only; tools without a browser decoder replace it
    this.decodeBitmaps = true;        // decode the bitmaps of loaded movies (browser only)
  }
  /* loadMovie (kind 'movie') or loadVariables (kind 'variables') of `url` into `clip`. A movie load empties the
     clip at once; an empty URL only empties it (unloadMovie). A newer movie load into the same clip, or an
     unload, cancels the older one. Without a host loader nothing changes. `variables` are the pairs a load with
     a method (1 GET, 2 POST) sends. */
  LoadQueue.prototype.request = function (clip, url, kind, method, variables) {
    if (kind === 'movie' && url === '') {
      clip.loadToken = ++this.serial;
      clip.clearContent();
      return;
    }
    var self = this, request = { url: url, type: kind, method: METHODS[method] || null };
    if (request.method) M.addForm(request, variables || []);
    url = request.url;
    request = Object.freeze(request);
    var interaction = {
      direction: 'outgoing', channel: 'load', status: 'requested', url: String(url).split(/[?#]/)[0],
      resourceType: kind, method: request.method || 'GET', variableCount: request.variables ? request.variables.length : 0
    };
    if (!this.host) {
      interaction.status = 'no-host';
      if (this.interaction) this.interaction(interaction);
      return this.report('load:noLoader', 'Loading a URL needs a loader from the host page (the Player option `loader` or `host.load`); nothing was loaded.', url);
    }
    if (this.pending >= MAX_PENDING_LOADS) {
      interaction.status = 'limited';
      if (this.interaction) this.interaction(interaction);
      return this.report('load:limit', 'More than ' + MAX_PENDING_LOADS + ' loads were waiting at once; this one was dropped.', url);
    }
    var token = ++this.serial, version = clip.env.version;
    if (this.interaction) this.interaction({
      direction: 'outgoing', channel: 'load', status: 'requested', url: String(url).split(/[?#]/)[0],
      resourceType: kind, method: request.method || 'GET', variableCount: request.variables ? request.variables.length : 0
    });
    if (kind === 'movie') {
      clip.loadToken = token;
      clip.clearContent();
    }
    this.pending++;
    Promise.resolve()
      .then(function () { return self.host(request); })
      .then(function (data) { return self.prepare(kind, data, version, url); })
      .then(function (result) { return { result: result }; }, function (error) { return { error: error }; })
      .then(function (outcome) {
        self.pending--;
        Object.assign(outcome, { clip: clip, token: token, kind: kind, url: url });
        if (self.interaction) self.interaction({
          direction: 'outgoing', channel: 'load', status: self.closed ? 'discarded' : outcome.error ? 'failed' : 'received',
          url: String(url).split(/[?#]/)[0], resourceType: kind, method: request.method || 'GET',
          variableCount: request.variables ? request.variables.length : 0, errorCode: outcome.error && outcome.error.code
        });
        if (self.closed) discard(outcome, self);
        else self.done.push(outcome);
        if (!self.pending) self.waiters.splice(0).forEach(function (resolve) { resolve(); });
        if (!self.closed && self.onSettled) self.onSettled();
      });
  };
  // Turns what the host returned into a movie, an image or variables, ready to show.
  LoadQueue.prototype.prepare = function (kind, data, version, url) {
    var self = this;
    if (data === null || data === undefined) return Promise.reject(loadError('LOAD_REFUSED', 'The host page did not give this URL.'));
    if (kind === 'variables' && typeof data === 'string') return Promise.resolve({ variables: parseVariables(data) });
    var drawable = kind === 'movie' && drawableOf(data);
    if (drawable) {
      // Decoded by the browser (for example a cross-origin image the page may show but not read).
      var reserved = M.reservePixels(this.pixels, drawable.width, drawable.height);
      return Promise.resolve({ image: { source: data, width: drawable.width, height: drawable.height, reserved: reserved } });
    }
    return toBytes(data).then(function (bytes) {
      if (self.maxFileBytes && bytes.length > self.maxFileBytes) throw loadError('LOAD_TOO_LARGE', bytes.length + ' bytes exceed options.maxFileBytes');
      if (kind === 'variables') return { variables: parseVariables(decodeText(bytes, version)) };
      if (isSWF(bytes)) {
        return global.SWFReader.load(bytes, self.maxFileBytes ? { maxFileBytes: self.maxFileBytes } : undefined).then(function (swf) {
          var movie = new M.Movie(swf);
          if (!self.decodeBitmaps) return { movie: movie };
          return movie.decodeBitmaps(self.pixels, self.report).then(function () { return { movie: movie }; });
        });
      }
      if (M.imageFormat(bytes)) return self.decodeImage(bytes, self.pixels, url).then(function (image) { return { image: image }; });
      throw loadError('LOAD_TYPE', 'The data is not a SWF, JPEG, PNG or GIF file.');
    });
  };
  // Shows what has arrived since the last call; true when a clip changed or got variables.
  LoadQueue.prototype.apply = function () {
    var done = this.done, changed = false, self = this;
    this.done = [];
    done.forEach(function (outcome) {
      var clip = outcome.clip, result = outcome.result;
      if (clip.removed || (outcome.kind === 'movie' && clip.loadToken !== outcome.token)) return discard(outcome, self);
      if (outcome.error) {
        var code = outcome.error.code, known = LOAD_ERRORS[code] || ['load:failed', 'A loaded URL could not be used.'];
        self.report(known[0], known[1], outcome.url + (code === 'LOAD_REFUSED' ? '' : ': ' + outcome.error.message));
        return;
      }
      changed = true;
      if (result.variables) {
        var rt = M.runtimeOf(clip.env.scripts);
        result.variables.forEach(function (pair) { M.setMember(rt, clip, pair[0], pair[1]); });
        clip.env.scripts.clipEvent(clip, 'data');
        return;
      }
      if (result.movie) clip.showMovie(result.movie, outcome.url);
      else clip.showImage(result.image, outcome.url);
      self.contents.add(clip);
    });
    return changed;
  };
  // Resolves once no load is waiting for the host (tests and tools).
  LoadQueue.prototype.idle = function () {
    var self = this;
    return this.pending ? new Promise(function (resolve) { self.waiters.push(resolve); }) : Promise.resolve();
  };
  // The player is done with this movie: loaded content is freed, and loads that finish later are dropped.
  LoadQueue.prototype.close = function () {
    this.closed = true;
    var self = this;
    this.done.splice(0).forEach(function (outcome) { discard(outcome, self); });
    this.contents.forEach(function (clip) { clip.releaseContent(); });
    this.contents.clear();
  };
  // Frees a load that will not be shown.
  function discard(outcome, queue) {
    var result = outcome.result;
    if (!result) return;
    if (result.movie) queue.pixels.remaining += result.movie.release();
    else if (result.image) { M.releaseSource(result.image); queue.pixels.remaining += result.image.reserved; }
  }

  /* Starts a load from a script: GetURL/GetURL2 with a level or clip target, and the MovieClip methods.
     `clip` is the target, or null when it names nothing. Level targets other than _level0 are not supported.
     `variables` are what a load with a method sends. */
  function loadInto(clip, url, kind, method, report, variables) {
    if (!clip) return report('avm1:targetNotFound', 'The target of a load does not exist; nothing was loaded.', url);
    if (!clip.env.loads) return report('load:noLoader', 'Loading a URL needs a loader from the host page (the Player option `loader` or `host.load`); nothing was loaded.', url);
    clip.env.loads.request(clip, url, kind, method, variables);
  }
  // The level number of a "_levelN" target, or -1.
  function levelOf(target) {
    var m = /^_level(\d+)$/i.exec(target);
    return m ? Number(m[1]) : -1;
  }

  Object.assign(M, { LoadQueue: LoadQueue, loadInto: loadInto, levelOf: levelOf, parseVariables: parseVariables, MAX_PENDING_LOADS: MAX_PENDING_LOADS });
})(typeof window !== 'undefined' ? window : globalThis);
