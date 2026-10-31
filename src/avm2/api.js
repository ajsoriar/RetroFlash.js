/* RetroFlash.js - ActionScript 3 in a movie: the builtin classes the runtime provides (a small part of the
   Flash API: display objects, events, URLRequest and navigateToURL, ExternalInterface) and Avm2Movie, which
   links an AVM2 runtime to the movie's timelines, buttons and host page. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;
  var Runtime = M.Avm2Runtime, Klass = M.Avm2Klass, AObject = M.Avm2Object, Avm2Error = M.Avm2Error,
    Avm2Throw = M.Avm2Throw, Avm2Unsupported = M.Avm2Unsupported, LimitError = M.LimitError, V = M.avm2;
  var toStr = V.toStr, toInt32 = V.toInt32, toBoolean = V.toBoolean, isFunction = V.isFunction,
    publicKey = V.publicKey, qkey = V.qkey;

  function arg(args, i, fallback) { return i < args.length ? args[i] : fallback; }
  function argumentError(message) { return new Avm2Error('ArgumentError', message); }

  /* Defines a builtin class "package.Name" extending `superKlass`. spec: { dynamic, final, init(rt, obj, args),
     methods, getters, setters (name -> function (rt, self, args)), constants (name -> value), staticMethods,
     staticGetters }. Its class object goes into the runtime's builtin global. */
  function defineNative(rt, qualified, superKlass, spec, klass) {
    var dot = qualified.lastIndexOf('.'), pkg = dot < 0 ? '' : qualified.slice(0, dot), short = qualified.slice(dot + 1);
    klass = klass || new Klass(pkg ? pkg + '::' + short : short, superKlass, spec.dynamic);
    klass.final = !!spec.final;
    if (spec.init) klass.init = { native: spec.init };
    Object.keys(spec.methods || {}).forEach(function (n) { klass.traits.set(publicKey(n), { kind: 'method', native: spec.methods[n] }); });
    Object.keys(spec.getters || {}).forEach(function (n) { klass.addAccessor(publicKey(n), 'get', { native: spec.getters[n] }); });
    Object.keys(spec.setters || {}).forEach(function (n) { klass.addAccessor(publicKey(n), 'set', { native: spec.setters[n] }); });
    var statics = new Klass(klass.name + '$', rt.classKlass, true);
    Object.keys(spec.constants || {}).forEach(function (n) { statics.addSlot(publicKey(n), 0, null, spec.constants[n], true); });
    Object.keys(spec.staticMethods || {}).forEach(function (n) { statics.traits.set(publicKey(n), { kind: 'method', native: spec.staticMethods[n] }); });
    Object.keys(spec.staticGetters || {}).forEach(function (n) { statics.addAccessor(publicKey(n), 'get', { native: spec.staticGetters[n] }); });
    var classObject = rt.classObjectFor(klass, statics);
    classObject.slots = statics.slotDefaults.slice();
    defineGlobal(rt, qkey(pkg, short), classObject);
    return klass;
  }
  // A constant of the builtin global object (a class or a package-level function).
  function defineGlobal(rt, key, value) {
    var g = rt.nativeGlobal, binding = g.klass.addSlot(key, 0, null, value, true);
    g.slots[binding.index] = value;
  }

  // ---- Values passed to and from the page (ExternalInterface) ----

  function toHostValue(v) { return v instanceof AObject ? null : v; }
  function fromHostValue(v) { return v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null; }

  // Event types the player itself sends (from button pointer events); listeners for other player events are reported.
  var MOUSE_EVENTS = { click: 1, mouseDown: 1, mouseUp: 1, mouseOver: 1, mouseOut: 1, rollOver: 1, rollOut: 1 };
  var PLAYER_EVENTS = ['enterFrame', 'exitFrame', 'frameConstructed', 'added', 'addedToStage', 'removed', 'removedFromStage',
    'render', 'activate', 'deactivate', 'keyDown', 'keyUp', 'mouseMove', 'mouseWheel', 'doubleClick', 'focusIn', 'focusOut',
    'resize', 'complete', 'ioError', 'progress', 'open', 'init', 'timer'];

  /* The builtin classes. `movie` is the Avm2Movie, which knows the display objects behind them. */
  function installNatives(rt, movie) {
    var scheduler = rt.scheduler;
    defineNative(rt, 'Object', null, { init: function () {} }, rt.objectKlass);

    // ---- flash.events ----
    var eventDispatcher = defineNative(rt, 'flash.events.EventDispatcher', rt.objectKlass, {
      init: function () {},
      methods: {
        addEventListener: function (rt, self, args) {
          var type = toStr(arg(args, 0)), fn = arg(args, 1), capture = toBoolean(arg(args, 2, false)), priority = toInt32(arg(args, 3, 0));
          if (!isFunction(fn)) throw new Avm2Error('TypeError', 'Error #2007: Parameter listener must be non-null.');
          var map = self.listeners || (self.listeners = new Map()), list = map.get(type) || [];
          if (list.some(function (l) { return l.fn === fn && l.capture === capture; })) return;
          var at = list.length;
          while (at > 0 && list[at - 1].priority < priority) at--;
          list.splice(at, 0, { fn: fn, capture: capture, priority: priority });
          map.set(type, list);
          if (PLAYER_EVENTS.indexOf(type) >= 0) {
            rt.reportOnce('avm2:eventNotSent', 'A listener waits for an event the player does not send yet (only button mouse events and dispatchEvent() are sent).', type);
          }
        },
        removeEventListener: function (rt, self, args) {
          var type = toStr(arg(args, 0)), fn = arg(args, 1), capture = toBoolean(arg(args, 2, false)), list = self.listeners && self.listeners.get(type);
          if (list) self.listeners.set(type, list.filter(function (l) { return l.fn !== fn || l.capture !== capture; }));
        },
        hasEventListener: function (rt, self, args) { return hasListeners(self, toStr(arg(args, 0))); },
        willTrigger: function (rt, self, args) {
          var type = toStr(arg(args, 0));
          return movie.pathOf(self).some(function (node) { return hasListeners(node, type); });
        },
        dispatchEvent: function (rt, self, args) {
          var event = arg(args, 0);
          if (!(event instanceof AObject) || !event.klass.isSubclassOf(eventKlass)) throw new Avm2Error('TypeError', 'Error #2007: Parameter event must be non-null.');
          return dispatch(rt, movie.pathOf(self), event);
        }
      }
    });
    var eventState = function (self) { return self.state || (self.state = { type: '', bubbles: false, cancelable: false, target: null, currentTarget: null, phase: 0 }); };
    var eventKlass = defineNative(rt, 'flash.events.Event', rt.objectKlass, {
      init: function (rt, self, args) {
        var s = eventState(self);
        s.type = toStr(arg(args, 0));
        s.bubbles = toBoolean(arg(args, 1, false));
        s.cancelable = toBoolean(arg(args, 2, false));
      },
      getters: {
        type: function (rt, self) { return eventState(self).type; },
        bubbles: function (rt, self) { return eventState(self).bubbles; },
        cancelable: function (rt, self) { return eventState(self).cancelable; },
        target: function (rt, self) { return eventState(self).target; },
        currentTarget: function (rt, self) { return eventState(self).currentTarget; },
        eventPhase: function (rt, self) { return eventState(self).phase; }
      },
      methods: {
        stopPropagation: function (rt, self) { eventState(self).stop = true; },
        stopImmediatePropagation: function (rt, self) { var s = eventState(self); s.stop = s.stopNow = true; },
        preventDefault: function (rt, self) { var s = eventState(self); if (s.cancelable) s.prevented = true; },
        isDefaultPrevented: function (rt, self) { return !!eventState(self).prevented; },
        toString: function (rt, self) { var s = eventState(self); return '[' + self.klass.shortName() + ' type="' + s.type + '" bubbles=' + s.bubbles + ' cancelable=' + s.cancelable + ']'; }
      },
      constants: { ENTER_FRAME: 'enterFrame', EXIT_FRAME: 'exitFrame', ADDED: 'added', ADDED_TO_STAGE: 'addedToStage', REMOVED: 'removed', REMOVED_FROM_STAGE: 'removedFromStage', COMPLETE: 'complete', CHANGE: 'change', INIT: 'init', RESIZE: 'resize' }
    });
    var mouseEventKlass = defineNative(rt, 'flash.events.MouseEvent', eventKlass, {
      init: function (rt, self, args) {
        var s = eventState(self);
        s.type = toStr(arg(args, 0));
        s.bubbles = toBoolean(arg(args, 1, true));
        s.cancelable = toBoolean(arg(args, 2, false));
      },
      constants: { CLICK: 'click', MOUSE_DOWN: 'mouseDown', MOUSE_UP: 'mouseUp', MOUSE_OVER: 'mouseOver', MOUSE_OUT: 'mouseOut', ROLL_OVER: 'rollOver', ROLL_OUT: 'rollOut', MOUSE_MOVE: 'mouseMove', DOUBLE_CLICK: 'doubleClick', MOUSE_WHEEL: 'mouseWheel' }
    });

    // ---- flash.display: only objects the timeline made (scripts cannot create display objects yet) ----
    function timelineOnly(rt, self) {
      if (!self.display) throw new Avm2Unsupported('avm2:construct', 'new ' + self.klass.name + '() from a script (only the timeline creates display objects)');
    }
    var displayObject = defineNative(rt, 'flash.display.DisplayObject', eventDispatcher, {
      init: timelineOnly,
      getters: {
        name: function (rt, self) { return self.display && self.display.name !== undefined ? self.display.name : null; },
        parent: function (rt, self) { return movie.parentOf(self); },
        visible: function (rt, self) { return !self.display || self.display.visible !== false; }
      },
      setters: { visible: function (rt, self, args) { if (self.display) self.display.visible = toBoolean(arg(args, 0)); } }
    });
    var interactiveObject = defineNative(rt, 'flash.display.InteractiveObject', displayObject, {});
    var container = defineNative(rt, 'flash.display.DisplayObjectContainer', interactiveObject, {
      getters: { numChildren: function (rt, self) { return self.clip ? self.clip.displayList.size : 0; } },
      methods: {
        getChildByName: function (rt, self, args) {
          var name = toStr(arg(args, 0)), found = null;
          if (self.clip) self.clip.displayList.forEach(function (record) { if (!found && record.name === name) found = record; });
          return found ? movie.wrapperFor(found, self.clip) : null;
        }
      }
    });
    var sprite = defineNative(rt, 'flash.display.Sprite', container, {});
    function goto(self, args, play) {
      var clip = self.clip;
      if (!clip) return;
      var frame = arg(args, 0), scene = arg(args, 1, null), offset = 0, n;
      if (scene !== null && scene !== undefined) {
        var found = movie.sceneByName(clip, toStr(scene));
        if (!found) throw argumentError('Error #2108: Scene ' + toStr(scene) + ' was not found.');
        offset = found.offset;
      } else {
        offset = movie.sceneOf(clip, clip.frame).offset;
      }
      if (typeof frame === 'string' && !/^\d+$/.test(frame)) {
        n = clip.def.labels[frame];
        if (!n) throw argumentError('Error #2109: Frame label ' + frame + ' not found in scene ' + (scene || movie.sceneOf(clip, clip.frame).name) + '.');
      } else {
        n = offset + toInt32(frame);
      }
      clip.playing = play;
      clip.gotoFrame(n);
    }
    var movieClip = defineNative(rt, 'flash.display.MovieClip', sprite, {
      dynamic: true,
      methods: {
        // addFrameScript(frameIndex, fn, ...): fn runs each time the timeline enters that frame (0-based); null removes it.
        addFrameScript: function (rt, self, args) {
          for (var i = 0; i + 1 < args.length; i += 2) {
            var index = toInt32(args[i]);
            if (index < 0 || index >= 16000) continue;
            (self.frameScripts || (self.frameScripts = []))[index] = isFunction(args[i + 1]) ? args[i + 1] : null;
          }
        },
        stop: function (rt, self) { if (self.clip) self.clip.playing = false; },
        play: function (rt, self) { if (self.clip) self.clip.playing = true; },
        gotoAndPlay: function (rt, self, args) { goto(self, args, true); },
        gotoAndStop: function (rt, self, args) { goto(self, args, false); },
        nextFrame: function (rt, self) { if (self.clip) { self.clip.playing = false; self.clip.gotoFrame(self.clip.frame + 1); } },
        prevFrame: function (rt, self) { if (self.clip) { self.clip.playing = false; self.clip.gotoFrame(self.clip.frame - 1); } }
      },
      getters: {
        currentFrame: function (rt, self) { return self.clip ? self.clip.frame - movie.sceneOf(self.clip, self.clip.frame).offset : 1; },
        totalFrames: function (rt, self) { return self.clip ? self.clip.frameCount() : 1; }
      }
    });
    var simpleButton = defineNative(rt, 'flash.display.SimpleButton', interactiveObject, {});
    var shape = defineNative(rt, 'flash.display.Shape', displayObject, {});

    // ---- flash.net ----
    var requestState = function (self) { return self.state || (self.state = { url: null, method: 'GET', data: null }); };
    var urlRequest = defineNative(rt, 'flash.net.URLRequest', rt.objectKlass, {
      final: true,
      init: function (rt, self, args) { var v = arg(args, 0, null); requestState(self).url = v === null || v === undefined ? null : toStr(v); },
      getters: {
        url: function (rt, self) { return requestState(self).url; },
        method: function (rt, self) { return requestState(self).method; },
        data: function (rt, self) { return requestState(self).data; }
      },
      setters: {
        url: function (rt, self, args) { var v = arg(args, 0); requestState(self).url = v === null || v === undefined ? null : toStr(v); },
        method: function (rt, self, args) {
          var v = toStr(arg(args, 0));
          if (v !== 'GET' && v !== 'POST') throw argumentError('Error #2008: Parameter method must be one of the accepted values.');
          requestState(self).method = v;
        },
        data: function (rt, self, args) { requestState(self).data = arg(args, 0, null); }
      }
    });
    // navigateToURL(request, window = null): opens the URL through the host page, in a new window when no window is named.
    defineGlobal(rt, qkey('flash.net', 'navigateToURL'), rt.makeFunction({
      native: function (rt, self, args) {
        var request = arg(args, 0), target = arg(args, 1, null);
        if (!(request instanceof AObject) || request.klass !== urlRequest) throw new Avm2Error('TypeError', 'Error #2007: Parameter request must be non-null.');
        var s = requestState(request);
        if (s.url === null) throw new Avm2Error('TypeError', 'Error #2007: Parameter url must be non-null.');
        if (s.data !== null || s.method !== 'GET') rt.reportOnce('avm2:urlRequestData', 'URLRequest data and POST are not sent yet; the page opens without them.', s.url);
        M.openURL(scheduler, s.url, target === null || target === undefined ? '_blank' : toStr(target), 0, null, movie.env.version);
      }
    }));

    // ---- flash.external ----
    defineNative(rt, 'flash.external.ExternalInterface', rt.objectKlass, {
      final: true,
      init: function () { throw new Avm2Error('ArgumentError', 'Error #2012: ExternalInterface class cannot be instantiated.'); },
      staticGetters: {
        available: function () { return M.hostOf(scheduler).available; },
        objectID: function () { return M.hostOf(scheduler).objectID; }
      },
      staticMethods: {
        // call(functionName, ...arguments): the page function's result (primitives; other values become null).
        call: function (rt, self, args) {
          var bridge = M.hostOf(scheduler);
          if (!bridge.available) throw new Avm2Error('Error', 'Error #2067: The ExternalInterface is not available in this container.');
          var name = toStr(arg(args, 0));
          var result = bridge.call({ kind: 'external', name: name, source: name, args: args.slice(1).map(toHostValue) });
          return result ? fromHostValue(result.value) : null;
        },
        addCallback: function () { throw new Avm2Unsupported('avm2:addCallback', 'ExternalInterface.addCallback'); }
      }
    });

    return {
      eventDispatcher: eventDispatcher, event: eventKlass, mouseEvent: mouseEventKlass, displayObject: displayObject,
      movieClip: movieClip, simpleButton: simpleButton, shape: shape, urlRequest: urlRequest
    };
  }

  function hasListeners(obj, type) {
    var list = obj && obj.listeners && obj.listeners.get(type);
    return !!(list && list.some(function (l) { return !l.capture; }));
  }
  /* Sends `event` along `path` (the target, then its ancestors): the target's listeners, then, for a bubbling
     event, each ancestor's, in priority and registration order, until a listener stops it. Capture listeners
     are kept but not called (there is no capture phase yet). Returns false when the default was prevented. */
  function dispatch(rt, path, event) {
    var s = event.state;
    s.target = path[0];
    s.stop = s.stopNow = false;
    try {
      for (var i = 0; i < path.length && !(i > 0 && !s.bubbles); i++) {
        var list = path[i].listeners && path[i].listeners.get(s.type);
        if (!list || !list.length) continue;
        s.currentTarget = path[i];
        s.phase = i === 0 ? 2 : 3;
        list = list.slice();
        for (var k = 0; k < list.length && !s.stopNow; k++) if (!list[k].capture) rt.call(list[k].fn, null, [event]);
        if (s.stop) break;
      }
    } finally {
      s.currentTarget = null;
      s.phase = 0;
    }
    return !s.prevented;
  }

  /* The AVM2 side of one movie (env.avm2). It loads the DoABC blocks, links SymbolClass classes to characters
     (character 0 is the main timeline), wraps display objects in ActionScript objects when a script needs them
     (`record.as3`), runs constructors and addFrameScript scripts in the scheduler's queue, and turns button
     pointer changes into MouseEvents. Every piece of code runs inside guard(): an error stops that script only
     and is reported (avm2:*), with the method and bytecode offset. */
  function Avm2Movie(env, movie) {
    this.env = env;
    this.movie = movie;
    this.scheduler = env.scripts;
    this.rt = new Runtime({ scheduler: env.scripts, limits: env.limits, report: env.report, env: env });
    this.classes = installNatives(this.rt, this);
    this.linked = new Map(); // character id -> Klass
    this.pointerEvents = null;
  }
  // The movie's name in diagnostics.
  Avm2Movie.prototype.label = function () {
    var url = this.env.url || '';
    return url ? url.split(/[?#]/)[0].split('/').pop() : 'movie';
  };
  Avm2Movie.prototype.report = function (feature, reason, source) { this.env.report(feature, reason, source); };
  Avm2Movie.prototype.guard = function (label, body) {
    var rt = this.rt, scheduler = this.scheduler, depth = rt.depth;
    scheduler.active++;
    try {
      body();
    } catch (err) {
      this.fail(err, label);
    } finally {
      scheduler.active--;
      rt.depth = depth;
    }
  };
  Avm2Movie.prototype.fail = function (err, label) {
    var where = this.label() + ': ' + (err && err.where ? err.where : label);
    if (err instanceof Avm2Unsupported) this.report(err.feature, 'ActionScript 3 code needs something RetroFlash.js does not implement yet; that script was stopped.', where + ': ' + err.message);
    else if (err instanceof Avm2Error) this.report('avm2:uncaughtError', 'An ActionScript 3 error was not caught; the rest of that script was not run.', where + ': ' + err.type + ': ' + err.message);
    else if (err instanceof Avm2Throw) this.report('avm2:uncaughtError', 'An ActionScript 3 error was not caught; the rest of that script was not run.', where + ': ' + toStr(err.value));
    else if (err instanceof LimitError) this.report('avm2:budget', err.message, where);
    else if (err instanceof RangeError) this.report('avm2:budget', 'The script went past a JavaScript limit (' + err.message + '); it was stopped.', where);
    else if (err && err.code === 'AVM2_ABC_INVALID') this.report('avm2:invalidAbc', 'A DoABC block is malformed; none of its code runs.', where + ': ' + err.message);
    else throw err;
  };
  Avm2Movie.prototype.enqueue = function (clip, label, body) {
    var self = this;
    this.scheduler.enqueueTask(clip, function () { self.guard(label, body); }, label);
  };

  /* Before the root's first frame: loads every DoABC block (each block's last script, its entry point, runs
     at once unless the block is lazy), resolves the SymbolClass classes, and wraps the root in an instance
     of the document class, whose constructor is queued before the frame-1 scripts. */
  Avm2Movie.prototype.start = function (root) {
    var self = this, movie = this.movie, rt = this.rt;
    this.root = root;
    this.guard('ActionScript 3 initialization', function () {
      movie.abcBlocks.forEach(function (block, i) {
        var label = 'DoABC' + (block.name ? ' "' + block.name + '"' : ' ' + (i + 1));
        var abc;
        try {
          abc = movie.abcOf(block, self.env.limits.maxAbcBytes);
        } catch (err) {
          return self.fail(err, label);
        }
        var scripts = rt.loadAbc(abc, label);
        if (!block.lazy && scripts.length) self.guard(label, function () { rt.ensureScript(scripts[scripts.length - 1]); });
      });
      Object.keys(movie.symbolClasses).forEach(function (id) {
        var name = movie.symbolClasses[id];
        self.guard('SymbolClass ' + name, function () {
          var cls = rt.classByName(name);
          if (cls) self.linked.set(Number(id), cls.instanceKlass);
          else self.report('avm2:missingClass', 'A SymbolClass names a class the ActionScript 3 code does not define; the character uses its builtin class.', name);
        });
      });
    });
    this.wrapperFor(root.displayObject(), null);
  };
  // The linked class of a display object of this movie (SymbolClass), or null.
  Avm2Movie.prototype.linkedKlass = function (record) {
    var character = this.movie.characters[record.characterId];
    if (record.characterId === 0 && record.clip === this.root) return this.linked.get(0) || null;
    return character && record.character === character ? this.linked.get(record.characterId) || null : null;
  };
  /* The ActionScript object of a display object record (made on first need): an instance of its linked class,
     whose constructor is queued, or of MovieClip, SimpleButton or Shape. `parentClip` is the timeline that
     holds it. A new container's named children are assigned to its properties. */
  Avm2Movie.prototype.wrapperFor = function (record, parentClip) {
    if (record.as3) return record.as3;
    var c = this.classes, linked = this.linkedKlass(record);
    var klass = linked || (record.clip ? c.movieClip : record.button ? c.simpleButton : c.shape);
    var obj = new AObject(klass);
    obj.display = record;
    obj.clip = record.clip || null;
    obj.parentClip = parentClip || null;
    obj.constructed = !linked;
    record.as3 = obj;
    if (linked) {
      var self = this;
      this.enqueue(obj.clip || parentClip, klass.name + ' constructor', function () { self.construct(obj); });
    }
    if (obj.clip) this.syncChildren(obj.clip);
    return obj;
  };
  Avm2Movie.prototype.construct = function (obj) {
    if (obj.constructed) return;
    obj.constructed = true;
    if (obj.clip) this.syncChildren(obj.clip);
    this.rt.initialize(obj.klass, obj, []);
  };
  // A display object was created on `parentClip`'s timeline (before its own first frame): linked ones get their object now.
  Avm2Movie.prototype.created = function (record, parentClip) {
    if (this.linkedKlass(record)) this.wrapperFor(record, parentClip);
  };
  /* Named children become properties of their timeline's object, as Flash Player does for stage instances:
     declared slots, or dynamic properties of dynamic classes. */
  Avm2Movie.prototype.syncChildren = function (clip) {
    var parent = clip.object && clip.object.as3, self = this;
    if (!parent) return;
    clip.displayList.forEach(function (record) {
      if (!record.name) return;
      var child = self.wrapperFor(record, clip), b = parent.klass.traits.get(publicKey(record.name));
      if (b && b.kind === 'slot' && !b.constant) parent.slots[b.index] = child;
      else if (!b && parent.klass.dynamic) (parent.dyn || (parent.dyn = new Map())).set(record.name, child);
    });
  };
  /* A timeline entered frame `n`: its children are linked, and its frame script (addFrameScript) is queued,
     as is a check for objects still waiting for their constructor (which may add one). */
  Avm2Movie.prototype.frameEntered = function (clip, n) {
    var obj = clip.object && clip.object.as3, self = this, rt = this.rt;
    if (!obj) return;
    this.syncChildren(clip);
    if (obj.constructed && !(obj.frameScripts && obj.frameScripts[n - 1])) return;
    this.enqueue(clip, obj.klass.name + ' frame ' + n, function () {
      var fn = obj.frameScripts && obj.frameScripts[n - 1];
      if (!clip.removed && clip.frame === n && obj.constructed && fn) rt.call(fn, obj, []);
    });
  };
  // The display object holding `obj` (null for the root).
  Avm2Movie.prototype.parentOf = function (obj) {
    var clip = obj.parentClip;
    return clip ? this.wrapperFor(clip.displayObject(), clip.parent) : null;
  };
  // An object and its ancestors, for event dispatch.
  Avm2Movie.prototype.pathOf = function (obj) {
    var path = [obj];
    for (var p = this.parentOf(obj); p && path.length < 64; p = this.parentOf(p)) path.push(p);
    return path;
  };
  /* A button changed state under the pointer (input/input.js, `condition` a BUTTON transition): the matching
     MouseEvents are queued for the button's object when it or an ancestor listens. */
  Avm2Movie.prototype.pointerEvent = function (record, condition) {
    var B = M.BUTTON, events = this.pointerEvents;
    if (!events) {
      events = this.pointerEvents = {};
      events[B.IDLE_TO_OVER_UP] = events[B.OUT_DOWN_TO_OVER_DOWN] = ['mouseOver', 'rollOver'];
      events[B.OVER_UP_TO_IDLE] = events[B.OVER_DOWN_TO_OUT_DOWN] = ['mouseOut', 'rollOut'];
      events[B.OVER_UP_TO_OVER_DOWN] = ['mouseDown'];
      events[B.OVER_DOWN_TO_OVER_UP] = ['mouseUp', 'click'];
    }
    var types = events[condition];
    if (!types || !(record.button || record.clip)) return;
    var parentClip = record.button ? record.button.parentClip : record.clip.parent;
    var path = this.pathOf(this.wrapperFor(record, parentClip)), self = this, rt = this.rt;
    types.forEach(function (type) {
      var bubbles = type !== 'rollOver' && type !== 'rollOut', nodes = bubbles ? path : path.slice(0, 1);
      if (!nodes.some(function (node) { return hasListeners(node, type); })) return;
      self.enqueue(parentClip, 'MouseEvent ' + type, function () {
        rt.allocate();
        var event = new AObject(self.classes.mouseEvent);
        event.state = { type: type, bubbles: bubbles, cancelable: false, target: null, currentTarget: null, phase: 0 };
        dispatch(rt, path, event);
      });
    });
  };
  // Scenes of the main timeline (DefineSceneAndFrameLabelData, offsets 0-based); other timelines have one.
  Avm2Movie.prototype.sceneOf = function (clip, frame) {
    var scenes = clip === this.root ? this.movie.scenes : null, found = { name: '', offset: 0 };
    if (scenes) scenes.forEach(function (s) { if (frame > s.offset) found = s; });
    return found;
  };
  Avm2Movie.prototype.sceneByName = function (clip, name) {
    var scenes = clip === this.root ? this.movie.scenes : null;
    if (!scenes) return null;
    for (var i = 0; i < scenes.length; i++) if (scenes[i].name === name) return scenes[i];
    return null;
  };

  Object.assign(M, { Avm2Movie: Avm2Movie, avm2Natives: installNatives, avm2Dispatch: dispatch });
})(typeof window !== 'undefined' ? window : globalThis);
