/* RetroFlash.js - The methods the Flash Player plugin gave the page on the movie's <object>/<embed> element
   (Netscape/NPAPI and ActiveX scripting), and the facade that puts them, and the callbacks the movie registers
   with ExternalInterface.addCallback, on the element the page holds:

     var movie = document.getElementById('legacyMovie');
     movie.SetVariable('/:message', 'Hello');  movie.GotoFrame(9);  movie.TPlay('/menu');  movie.setMessage('x');

   RetroFlash.createPluginAPI(player) gives the methods as a plain object; RetroFlash.attachLegacyInterface(
   element, player) installs them on an element (the legacy markup bootstrap does it for the canvas that takes
   the place of each <object>/<embed>). Frame numbers are zero-based, as in the plugin. Properties are the
   AVM1 GetProperty/SetProperty indexes (0 _x ... 21 _ymouse). Methods that need a movie give null, 0 or false
   until one is loaded; methods ActionScript 3 movies do not support (variables) report and give null. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;

  var METHOD_NAMES = ['SetVariable', 'GetVariable', 'Play', 'StopPlay', 'IsPlaying', 'Rewind', 'Back', 'Forward', 'GotoFrame',
    'CurrentFrame', 'TotalFrames', 'FrameLoaded', 'PercentLoaded', 'FlashVersion', 'TGotoFrame', 'TGotoLabel', 'TCurrentFrame',
    'TCurrentLabel', 'TPlay', 'TStopPlay', 'TCallFrame', 'TCallLabel', 'TGetProperty', 'TGetPropertyAsNumber', 'TGetPropertyNum',
    'TSetProperty', 'TSetPropertyNum', 'LoadMovie', 'Zoom', 'Pan', 'SetZoomRect', 'CallFunction', 'SetReturnValue'];
  // Callback names that would reach the prototype chain or the facade's bookkeeping: never installed.
  var RESERVED_NAMES = { __proto__: 1, constructor: 1, prototype: 1, __defineGetter__: 1, __defineSetter__: 1, __lookupGetter__: 1,
    __lookupSetter__: 1, hasOwnProperty: 1, retroflashPlayer: 1, retroflashInterface: 1 };
  // The version the plugin methods and $version report (an emulated player, not an installed Adobe plugin).
  var DEFAULT_FLASH_VERSION = '10,3,183,90';
  var MIN_ZOOM_TWIPS = 20;

  function versionParts(text) {
    var parts = String(text || DEFAULT_FLASH_VERSION).split(/[,.]/).map(function (p) { return parseInt(p, 10) || 0; });
    while (parts.length < 4) parts.push(0);
    return parts.slice(0, 4);
  }
  function frameIndex(value) {
    var n = Number(value);
    return n === n ? Math.floor(n) : NaN;
  }

  /* The plugin methods for `player`. options: { flashVersion: 'major,minor,build,revision' (default
     10,3,183,90), platform: the $version prefix (default 'WIN') }. */
  function createPluginAPI(player, options) {
    options = options || {};
    var version = versionParts(options.flashVersion), platform = String(options.platform || 'WIN');

    function report(feature, reason, source) { player.recordUnsupported(feature, reason, source); }
    // The AVM1 context of the main timeline, as a frame script of _level0 resolves names.
    function contextOf(env, root) {
      var rt = M.runtimeOf(env.scripts);
      return { rt: rt, version: env.version, root: root, thisValue: root, scopes: [{ kind: 'global', obj: rt.global }, { kind: 'target', obj: root }] };
    }
    /* Runs `body(env, root)` against the loaded movie as the page's request (Player.runExternal: the movie is
       updated and redrawn after it); `fallback` without a movie. */
    function withMovie(fallback, body) {
      player.assertUsable();
      if (!player.root) return fallback;
      return player.runExternal(body);
    }
    // The timeline a T* method names: a slash path ("/", "/menu/item") or a dot path ("_level0.menu"); null when missing.
    function targetOf(env, root, path, method) {
      path = path === undefined || path === null ? '' : String(path);
      var found = path === '' || path === '/' ? root : M.resolvePath(root, path, env.version, env.as3 ? undefined : contextOf(env, root));
      if (M.isClip(found)) return found;
      report('plugin:targetNotFound', 'The page named a timeline the movie does not have (' + method + '); nothing was done.', path);
      return null;
    }
    function avm1Only(env, method) {
      if (!env.as3) return true;
      report('plugin:as3Variables', 'ActionScript 3 movies have no timeline variables for the page (' + method + '); nothing was done.', method);
      return false;
    }
    // Goes to frame n (1-based, kept within the timeline) and stops; a frame that is not a number does nothing.
    function goTo(clip, n) {
      if (n !== n) return report('plugin:frameNotFound', 'The page asked for a frame number that is not a number.', String(n));
      clip.gotoFrame(Math.max(1, Math.min(clip.frameCount(), n)));
      clip.playing = false;
    }
    function labelAt(clip, frame) {
      var labels = clip.def.labels, names = Object.keys(labels);
      for (var i = 0; i < names.length; i++) if (labels[names[i]] === frame) return names[i];
      return '';
    }
    function property(env, root, target, index, method) {
      var clip = targetOf(env, root, target, method), n = frameIndex(index), value = null;
      if (!clip) return null;
      if (!(n >= 0 && n < M.PROPERTY_NAMES.length)) {
        report('plugin:propertyIndex', 'The page asked for a property index that does not exist (0 to ' + (M.PROPERTY_NAMES.length - 1) + ').', String(index));
        return null;
      }
      env.scripts.guard(method, function () { value = M.getProperty(clip, n, env.version); });
      return value;
    }
    function setProperty(env, root, target, index, value, method) {
      var clip = targetOf(env, root, target, method), n = frameIndex(index);
      if (!clip) return;
      if (!(n >= 0 && n < M.PROPERTY_NAMES.length)) return report('plugin:propertyIndex', 'The page set a property index that does not exist (0 to ' + (M.PROPERTY_NAMES.length - 1) + ').', String(index));
      env.scripts.guard(method, function () { M.setProperty(clip, n, value, env.version); });
    }
    function callFrame(env, root, target, n, method) {
      var clip = targetOf(env, root, target, method);
      if (clip && !(n >= 1 && env.scripts.callFrame(clip, n, method + ' of frame ' + n))) {
        report('plugin:frameNotFound', 'The page called the scripts of a frame the timeline does not have (' + method + ').', String(target) + ' ' + n);
      }
    }
    // The visible part of the stage, in twips: the zoom rectangle, else the whole stage.
    function viewOf() {
      var b = player.movie.swf.bounds, z = player.getViewRect();
      return z || { x: b.xminTwips, y: b.yminTwips, width: b.xmaxTwips - b.xminTwips, height: b.ymaxTwips - b.yminTwips };
    }

    return {
      // SetVariable(path, value): sets a timeline variable ("/:name", "/clip:name", "_root.name", "name") as a string.
      SetVariable: function (path, value) {
        withMovie(undefined, function (env, root) {
          if (!avm1Only(env, 'SetVariable')) return;
          var ctx = contextOf(env, root), name = String(path);
          env.scripts.guard('SetVariable', function () {
            if (!M.setVariable(ctx, name, value === undefined || value === null ? '' : String(value))) {
              report('plugin:variableNotSet', 'The page set a variable the movie cannot set (SetVariable); nothing was set.', name);
            }
          });
        });
      },
      // GetVariable(path): the variable as a string, or null when it does not exist. "$version" is the emulated player.
      GetVariable: function (path) {
        var name = String(path);
        if (name.toLowerCase() === '$version') return platform + ' ' + version.join(',');
        return withMovie(null, function (env, root) {
          if (!avm1Only(env, 'GetVariable')) return null;
          var out = null, ctx = contextOf(env, root);
          env.scripts.guard('GetVariable', function () {
            var value = M.getVariable(ctx, name);
            if (value !== undefined && value !== M.UNKNOWN_VALUE) out = M.toAvmString(value, env.version);
          });
          return out;
        });
      },
      Play: function () {
        withMovie(undefined, function (env, root) { root.playing = true; });
        if (player.root && player.state !== 'playing') player.play();
      },
      StopPlay: function () { withMovie(undefined, function (env, root) { root.playing = false; }); },
      IsPlaying: function () { return !!(player.root && player.root.playing && player.state === 'playing'); },
      Rewind: function () { withMovie(undefined, function (env, root) { goTo(root, 1); }); },
      Back: function () { withMovie(undefined, function (env, root) { goTo(root, root.frame - 1); }); },
      Forward: function () { withMovie(undefined, function (env, root) { goTo(root, root.frame + 1); }); },
      // GotoFrame(n): the main timeline goes to zero-based frame n and stops.
      GotoFrame: function (n) {
        withMovie(undefined, function (env, root) {
          var i = frameIndex(n);
          if (i >= 0) goTo(root, i + 1);
          else report('plugin:frameNotFound', 'The page asked for a frame number that is not a frame (GotoFrame).', String(n));
        });
      },
      CurrentFrame: function () { return player.root ? player.root.frame - 1 : -1; },
      TotalFrames: function () { return player.root ? player.root.frameCount() : 0; },
      // The whole movie is read before it plays: every frame is loaded once there is a movie.
      FrameLoaded: function (n) { var i = frameIndex(n); return !!player.root && i >= 0 && i < player.root.frameCount(); },
      PercentLoaded: function () { return player.root ? 100 : 0; },
      // FlashVersion(): the emulated major version in the high 16 bits and minor version in the low 16 bits.
      FlashVersion: function () { return version[0] * 65536 + version[1]; },

      TGotoFrame: function (target, n) {
        withMovie(undefined, function (env, root) { var clip = targetOf(env, root, target, 'TGotoFrame'); if (clip) goTo(clip, frameIndex(n) + 1); });
      },
      TGotoLabel: function (target, label) {
        withMovie(undefined, function (env, root) {
          var clip = targetOf(env, root, target, 'TGotoLabel'), n = clip ? clip.findLabel(String(label)) : 0;
          if (n) goTo(clip, n);
          else if (clip) report('plugin:frameNotFound', 'The page asked for a frame label the timeline does not have (TGotoLabel).', String(target) + ' ' + label);
        });
      },
      TCurrentFrame: function (target) {
        return withMovie(-1, function (env, root) { var clip = targetOf(env, root, target, 'TCurrentFrame'); return clip ? clip.frame - 1 : -1; });
      },
      // The label of the current frame of the target, or '' when that frame has none.
      TCurrentLabel: function (target) {
        return withMovie(null, function (env, root) { var clip = targetOf(env, root, target, 'TCurrentLabel'); return clip ? labelAt(clip, clip.frame) : null; });
      },
      TPlay: function (target) { withMovie(undefined, function (env, root) { var clip = targetOf(env, root, target, 'TPlay'); if (clip) clip.playing = true; }); },
      TStopPlay: function (target) { withMovie(undefined, function (env, root) { var clip = targetOf(env, root, target, 'TStopPlay'); if (clip) clip.playing = false; }); },
      // TCallFrame(target, n): runs the scripts of zero-based frame n of the target now, without going there.
      TCallFrame: function (target, n) {
        withMovie(undefined, function (env, root) { if (avm1Only(env, 'TCallFrame')) callFrame(env, root, target, frameIndex(n) + 1, 'TCallFrame'); });
      },
      TCallLabel: function (target, label) {
        withMovie(undefined, function (env, root) {
          if (!avm1Only(env, 'TCallLabel')) return;
          var clip = targetOf(env, root, target, 'TCallLabel');
          if (clip) callFrame(env, root, target, clip.findLabel(String(label)), 'TCallLabel');
        });
      },
      // TGetProperty(target, index): the property as a string; TGetPropertyAsNumber / TGetPropertyNum as a number.
      TGetProperty: function (target, index) {
        return withMovie(null, function (env, root) {
          var value = property(env, root, target, index, 'TGetProperty');
          return value === null ? null : M.toAvmString(value, env.version);
        });
      },
      TGetPropertyAsNumber: function (target, index) {
        return withMovie(null, function (env, root) {
          var value = property(env, root, target, index, 'TGetPropertyAsNumber');
          return value === null ? null : M.toNumber(value, env.version);
        });
      },
      TGetPropertyNum: function (target, index) { return this.TGetPropertyAsNumber(target, index); },
      TSetProperty: function (target, index, value) {
        withMovie(undefined, function (env, root) { setProperty(env, root, target, index, value === undefined || value === null ? '' : String(value), 'TSetProperty'); });
      },
      TSetPropertyNum: function (target, index, value) {
        withMovie(undefined, function (env, root) { setProperty(env, root, target, index, Number(value), 'TSetPropertyNum'); });
      },

      // LoadMovie(level, url): level 0 replaces the movie through the host's loader, as loadMovieNum does.
      LoadMovie: function (level, url) {
        withMovie(undefined, function (env, root) {
          var n = frameIndex(level);
          if (n !== 0) return report('load:level', 'Movies loaded into levels other than _level0 are not supported yet; nothing was loaded.', '_level' + level + ' ← ' + url);
          M.loadInto(root, String(url), 'movie', 0, function (f, r, s) { report(f, r, s); }, null);
        });
      },
      /* Zoom(percent): the view shows percent/100 times as much of the stage around its centre (Zoom(50) doubles
         the size of what is shown); Zoom(0) shows the whole stage again. */
      Zoom: function (percent) {
        if (!player.root) return;
        var p = Number(percent);
        if (!(p >= 0) || !isFinite(p)) return;
        if (p === 0) return player.setViewRect(null);
        var v = viewOf(), w = Math.max(MIN_ZOOM_TWIPS, v.width * p / 100), h = Math.max(MIN_ZOOM_TWIPS, v.height * p / 100);
        player.setViewRect({ x: v.x + (v.width - w) / 2, y: v.y + (v.height - h) / 2, width: w, height: h });
      },
      // SetZoomRect(left, top, right, bottom): the part of the stage shown, in twips.
      SetZoomRect: function (left, top, right, bottom) {
        if (!player.root) return;
        var l = Number(left), t = Number(top), r = Number(right), b = Number(bottom);
        if (!(r - l >= 1 && b - t >= 1) || !isFinite(r - l + b - t)) return report('plugin:zoomRect', 'The page gave SetZoomRect an empty rectangle; the view was not changed.', [left, top, right, bottom].join(','));
        player.setViewRect({ x: l, y: t, width: r - l, height: b - t });
      },
      /* Pan(x, y, mode): moves a zoomed-in view by x and y, in pixels of the element (mode 0) or percent of the
         view (mode 1), without going past the stage. Nothing happens when the view is not zoomed. */
      Pan: function (x, y, mode) {
        var z = player.root && player.getViewRect();
        if (!z) return;
        var layout = player.getLayout(), b = player.movie.swf.bounds, dx = Number(x) || 0, dy = Number(y) || 0;
        if (Number(mode) === 1) { dx = dx * z.width / 100; dy = dy * z.height / 100; }
        else if (layout.scale) { dx = dx * 20 / layout.scale.x; dy = dy * 20 / layout.scale.y; }
        var clamp = function (v, min, size, total) { return size >= total ? v : Math.max(min, Math.min(min + total - size, v)); };
        player.setViewRect({
          x: clamp(z.x + dx, b.xminTwips, z.width, b.xmaxTwips - b.xminTwips),
          y: clamp(z.y + dy, b.yminTwips, z.height, b.ymaxTwips - b.yminTwips),
          width: z.width, height: z.height
        });
      },

      /* CallFunction(xml): calls an ExternalInterface.addCallback function with the arguments of an <invoke>
         and answers its result in XML (or as a JavaScript literal for returntype="javascript"), at once. */
      CallFunction: function (xml) {
        var invoke = M.parseInvoke(xml);
        var value = player.callback(invoke.name, invoke.args);
        return invoke.returnType === 'javascript' ? M.toJSLiteral(value) : M.toXMLValue(value);
      },
      /* SetReturnValue(xml): while the movie is calling the page (ExternalInterface.call), the value in XML
         becomes that call's result, as the plugin's page glue answered it. */
      SetReturnValue: function (xml) {
        var value = M.fromXMLValue(xml), host = player.env && player.env.host;
        if (!host || !host.setReturnValue(value)) report('plugin:returnValueUnused', 'The page called SetReturnValue while the movie was not calling it; the value was dropped.', 'SetReturnValue');
      }
    };
  }

  /* Installs the plugin methods and the movie's ExternalInterface callbacks on `element` (the object the page
     holds: the canvas that replaced an <object>/<embed>, or any element or object), as the plugin did. The
     player's callbacks follow addCallback; a callback whose name the element already uses for something else
     (or a reserved name) is not installed and is reported as browser:callbackName. Two players never share
     methods: each element gets functions bound to its own player. Returns { element, player, api, dispose() };
     dispose() (also run when the player is destroyed) removes everything it added and gives back the element's
     own properties it covered. options: { methods: false (callbacks only), flashVersion, platform }. */
  function attachLegacyInterface(element, player, options) {
    options = options || {};
    if (!element || (typeof element !== 'object' && typeof element !== 'function')) throw M.playerError('INVALID_OPTION', 'attachLegacyInterface needs an element');
    if (element.retroflashInterface && typeof element.retroflashInterface.dispose === 'function') element.retroflashInterface.dispose();
    var api = createPluginAPI(player, options), saved = [], installed = Object.create(null), callbacks = [], disposed = false;

    function own(name) { return Object.prototype.hasOwnProperty.call(element, name); }
    function install(name, fn) {
      if (!(name in installed)) saved.push({ name: name, had: own(name), descriptor: own(name) ? Object.getOwnPropertyDescriptor(element, name) : null });
      Object.defineProperty(element, name, { value: fn, configurable: true, writable: true, enumerable: false });
      installed[name] = fn;
    }
    function uninstall(name) {
      if (!(name in installed)) return;
      for (var i = saved.length - 1; i >= 0; i--) {
        if (saved[i].name !== name) continue;
        var s = saved.splice(i, 1)[0];
        if (s.had) Object.defineProperty(element, name, s.descriptor); else delete element[name];
      }
      delete installed[name];
    }
    if (options.methods !== false) {
      METHOD_NAMES.forEach(function (name) {
        install(name, function () { return api[name].apply(api, arguments); });
      });
    }
    function syncCallbacks(names) {
      if (disposed) return;
      callbacks.forEach(function (name) { if (names.indexOf(name) < 0) uninstall(name); });
      callbacks = names.filter(function (name) {
        if (callbacks.indexOf(name) >= 0) return true;
        if (RESERVED_NAMES[name] || METHOD_NAMES.indexOf(name) >= 0 || name in element) {
          player.recordUnsupported('browser:callbackName', 'The movie registered a callback whose name the page element already uses; the page cannot call it as a method (use player.callback).', name);
          return false;
        }
        return true;
      });
      callbacks.forEach(function (name) {
        if (installed[name]) return;
        install(name, function () { return player.callback(name, Array.prototype.slice.call(arguments)); });
      });
    }
    function onDestroy() { handle.dispose(); }
    var handle = {
      element: element, player: player, api: api,
      dispose: function () {
        if (disposed) return;
        disposed = true;
        player.off('callbacks', syncCallbacks);
        player.off('destroy', onDestroy);
        Object.keys(installed).forEach(uninstall);
        if (element.retroflashInterface === handle) delete element.retroflashInterface;
      }
    };
    player.on('callbacks', syncCallbacks);
    player.on('destroy', onDestroy);
    Object.defineProperty(element, 'retroflashInterface', { value: handle, configurable: true, writable: true, enumerable: false });
    syncCallbacks(player.getCallbacks());
    return handle;
  }

  Object.assign(M, {
    createPluginAPI: createPluginAPI, attachLegacyInterface: attachLegacyInterface, PLUGIN_METHODS: METHOD_NAMES,
    DEFAULT_FLASH_VERSION: DEFAULT_FLASH_VERSION
  });
})(typeof window !== 'undefined' ? window : globalThis);
