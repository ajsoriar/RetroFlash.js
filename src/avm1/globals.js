/* RetroFlash.js - The AVM1 runtime of a movie: the global object and the built-in classes and functions. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;
  var UNKNOWN_VALUE = M.UNKNOWN_VALUE, AvmObject = M.AvmObject, AvmArray = M.AvmArray, AvmFunction = M.AvmFunction,
    isObject = M.isObject, isFunction = M.isFunction, isClip = M.isClip, setOwn = M.setOwn, getMember = M.getMember,
    hasMember = M.hasMember, setMember = M.setMember, keysOf = M.keysOf, instanceOf = M.instanceOf,
    checkString = M.checkString, toNumber = M.toNumber, toAvmString = M.toAvmString, toBoolean = M.toBoolean,
    toInt32 = M.toInt32, stringToNumber = M.stringToNumber, numberToString = M.numberToString,
    resolvePath = M.resolvePath, MAX_ARRAY_INDEX = M.MAX_ARRAY_INDEX;

  /* createRuntime(scheduler) gives the movie's runtime:
       { version, scheduler, global, protos: { Object, Function, Array, String, Number, Boolean, MovieClip, Error },
         registers (the four global registers), callDepth, call(fn, this, args), construct(fn, args) }
     call and construct are set by the interpreter. Built-in methods follow the ActionScript 2.0 Language
     Reference; their properties are hidden from for..in. Natives are fn(rt, thisValue, args). */

  // Global names that exist in Flash Player but are not implemented: reading one gives an unknown value.
  var NOT_IMPLEMENTED = ['System', 'Date', 'Button', 'TextField', 'TextFormat', 'Selection', 'XML', 'XMLNode',
    'XMLSocket', 'LoadVars', 'SharedObject', 'LocalConnection', 'Camera', 'Microphone', 'Video', 'NetConnection',
    'NetStream', 'ContextMenu', 'ContextMenuItem', 'MovieClipLoader', 'Accessibility', 'AsBroadcaster',
    'getVersion', 'ASnative', 'CustomActions', 'PrintJob', 'TextSnapshot'];
  // Packages of the `flash` global other than flash.external: reading one gives an unknown value.
  var FLASH_PACKAGES = ['display', 'filters', 'geom', 'net', 'text', 'ui'];
  // Key constants (Windows virtual key codes, as Flash Player uses).
  var KEY_CODES = { BACKSPACE: 8, CAPSLOCK: 20, CONTROL: 17, DELETEKEY: 46, DOWN: 40, END: 35, ENTER: 13, ESCAPE: 27,
    HOME: 36, INSERT: 45, LEFT: 37, PGDN: 34, PGUP: 33, RIGHT: 39, SHIFT: 16, SPACE: 32, TAB: 9, UP: 38 };

  function arg(args, i) { return i < args.length ? args[i] : undefined; }
  // A boxed primitive (new String(...), ...) keeps its value in `primitive`.
  function primitiveOf(v) { return isObject(v) && 'primitive' in v ? v.primitive : v; }

  function createRuntime(scheduler) {
    var version = scheduler.version;
    var rt = {
      version: version, scheduler: scheduler, global: null, protos: {}, callDepth: 0,
      registers: [undefined, undefined, undefined, undefined], call: null, construct: null
    };
    var P = rt.protos;
    var str = function (v) { return toAvmString(v, version); };
    var num = function (v) { return toNumber(v, version); };

    P.Object = new AvmObject(null);
    P.Function = new AvmObject(P.Object);
    function fn(native, construct) {
      var f = new AvmFunction(P.Function, native);
      if (construct) f.nativeConstruct = construct;
      return f;
    }
    function hide(obj, name, value) { setOwn(obj, name, value, version, true); }
    function methods(obj, table) { Object.keys(table).forEach(function (name) { hide(obj, name, fn(table[name])); }); }
    // A class: constructor function with its prototype.
    function makeClass(name, proto, native, construct) {
      var ctor = fn(native, construct);
      hide(ctor, 'prototype', proto);
      hide(proto, 'constructor', ctor);
      hide(G, name, ctor);
      return ctor;
    }
    var G = rt.global = new AvmObject(P.Object);

    // ---- Object, Function ----
    makeClass('Object', P.Object, function (rt, self, args) {
      var v = arg(args, 0);
      return isObject(v) || isClip(v) ? v : self instanceof AvmObject && self.proto === P.Object ? self : new AvmObject(P.Object);
    });
    methods(P.Object, {
      toString: function () { return '[object Object]'; },
      valueOf: function (rt, self) { return self; },
      hasOwnProperty: function (rt, self, args) {
        var name = str(arg(args, 0));
        if (isClip(self)) return hasMember(rt, self, name);
        if (!isObject(self)) return false;
        if (self instanceof AvmArray && /^\d+$/.test(name)) return Number(name) in self.items;
        return self.props.has(version < 7 ? name.toLowerCase() : name);
      },
      isPropertyEnumerable: function (rt, self, args) {
        var entry = isObject(self) && self.props.get(version < 7 ? str(arg(args, 0)).toLowerCase() : str(arg(args, 0)));
        return !!entry && !entry.hidden;
      },
      isPrototypeOf: function (rt, self, args) {
        for (var o = arg(args, 0), d = 0; isObject(o) && d < 256; d++) { o = o.proto; if (o === self) return true; }
        return false;
      },
      addProperty: function () { return false; }, // getter/setter properties are not supported yet
      watch: function () { return false; },
      unwatch: function () { return false; }
    });
    makeClass('Function', P.Function, function () { return undefined; });
    methods(P.Function, {
      call: function (rt, self, args) { return rt.call(self, arg(args, 0), args.slice(1)); },
      apply: function (rt, self, args) {
        var list = arg(args, 1);
        return rt.call(self, arg(args, 0), list instanceof AvmArray ? list.items.slice() : []);
      }
    });

    // ---- Array ----
    P.Array = new AvmObject(P.Object);
    function array(items) { return new AvmArray(P.Array, items); }
    rt.array = array;
    function itemsOf(self) { return self instanceof AvmArray ? self.items : null; }
    function join(items, separator) {
      var out = '';
      for (var i = 0; i < items.length; i++) {
        if (i) out += separator;
        var v = items[i];
        out += v === undefined || v === null ? (v === null ? 'null' : 'undefined') : str(v);
        checkString(out);
      }
      return out;
    }
    var ArrayClass = makeClass('Array', P.Array, null, function (rt, args) {
      if (args.length === 1 && typeof args[0] === 'number') {
        var n = args[0];
        var a = array([]);
        if (n >= 0 && n === Math.floor(n)) a.items.length = Math.min(n, MAX_ARRAY_INDEX);
        return a;
      }
      return array(args.slice());
    });
    ArrayClass.native = function (rt, self, args) { return ArrayClass.nativeConstruct(rt, args); };
    [['CASEINSENSITIVE', 1], ['DESCENDING', 2], ['UNIQUESORT', 4], ['RETURNINDEXEDARRAY', 8], ['NUMERIC', 16]].forEach(function (c) { hide(ArrayClass, c[0], c[1]); });
    /* sort and sortOn: `keys` are what is compared (the items, or one field of each); `compare` is a function
       or the option flags. Sorts `items` in place and returns the array, or returns the sorted indexes
       (RETURNINDEXEDARRAY), or 0 when UNIQUESORT finds two equal keys. */
    function sortItems(rt, self, items, keys, compare, flags) {
      var cmp;
      if (isFunction(compare)) {
        cmp = function (a, b) { var r = num(rt.call(compare, undefined, [keys[a], keys[b]])); return r !== r ? 0 : r; };
      } else {
        if (typeof compare === 'number') flags = compare;
        cmp = function (a, b) {
          var x = keys[a], y = keys[b], r;
          if (flags & 16) r = num(x) - num(y);
          else {
            x = str(x); y = str(y);
            if (flags & 1) { x = x.toLowerCase(); y = y.toLowerCase(); }
            r = x < y ? -1 : x > y ? 1 : 0;
          }
          return r !== r ? 0 : r;
        };
      }
      flags = toInt32(flags, version);
      var order = keys.map(function (k, i) { return i; });
      order.sort(function (a, b) { var r = cmp(a, b); return (flags & 2 ? -r : r) || a - b; });
      if (flags & 4) for (var i = 1; i < order.length; i++) if (cmp(order[i - 1], order[i]) === 0) return 0;
      if (flags & 8) return array(order);
      var sorted = order.map(function (k) { return items[k]; });
      for (var j = 0; j < sorted.length; j++) items[j] = sorted[j];
      return self;
    }
    methods(P.Array, {
      push: function (rt, self, args) {
        var items = itemsOf(self);
        if (!items) return undefined;
        for (var i = 0; i < args.length && items.length < MAX_ARRAY_INDEX; i++) items.push(args[i]);
        return items.length;
      },
      pop: function (rt, self) { var items = itemsOf(self); return items ? items.pop() : undefined; },
      shift: function (rt, self) { var items = itemsOf(self); return items ? items.shift() : undefined; },
      unshift: function (rt, self, args) {
        var items = itemsOf(self);
        if (!items) return undefined;
        if (items.length + args.length <= MAX_ARRAY_INDEX) items.unshift.apply(items, args);
        return items.length;
      },
      slice: function (rt, self, args) {
        var items = itemsOf(self);
        if (!items) return undefined;
        return array(items.slice(args.length > 0 ? toInt32(args[0], version) : 0, args.length > 1 ? toInt32(args[1], version) : items.length));
      },
      splice: function (rt, self, args) {
        var items = itemsOf(self);
        if (!items || !args.length) return undefined;
        var start = toInt32(args[0], version), count = args.length > 1 ? Math.max(0, toInt32(args[1], version)) : items.length;
        if (start < 0) start = Math.max(0, items.length + start);
        var removed = items.splice.apply(items, [Math.min(start, items.length), count].concat(args.slice(2)));
        if (items.length > MAX_ARRAY_INDEX) items.length = MAX_ARRAY_INDEX;
        return array(removed);
      },
      concat: function (rt, self, args) {
        var items = (itemsOf(self) || []).slice();
        args.forEach(function (a) {
          if (a instanceof AvmArray) items.push.apply(items, a.items); else items.push(a);
        });
        if (items.length > MAX_ARRAY_INDEX) items.length = MAX_ARRAY_INDEX;
        return array(items);
      },
      join: function (rt, self, args) {
        var items = itemsOf(self);
        return items ? join(items, args.length && args[0] !== undefined ? str(args[0]) : ',') : undefined;
      },
      toString: function (rt, self) { var items = itemsOf(self); return items ? join(items, ',') : '[object Object]'; },
      reverse: function (rt, self) { var items = itemsOf(self); if (items) items.reverse(); return self; },
      sort: function (rt, self, args) {
        var items = itemsOf(self);
        return items ? sortItems(rt, self, items, items.slice(), arg(args, 0), arg(args, 1)) : undefined;
      },
      sortOn: function (rt, self, args) {
        var items = itemsOf(self), field = str(arg(args, 0));
        if (!items) return undefined;
        return sortItems(rt, self, items, items.map(function (o) { return getMember(rt, o, field); }), arg(args, 1), arg(args, 1));
      }
    });

    // ---- String, Number, Boolean ----
    function boxer(proto, convert) {
      return function (rt, args) {
        var o = new AvmObject(proto);
        o.primitive = convert(args.length ? args[0] : undefined);
        if (typeof o.primitive === 'string') hide(o, 'length', o.primitive.length);
        return o;
      };
    }
    P.String = new AvmObject(P.Object);
    P.Number = new AvmObject(P.Object);
    P.Boolean = new AvmObject(P.Object);
    var StringClass = makeClass('String', P.String, function (rt, self, args) { return args.length ? str(args[0]) : ''; },
      boxer(P.String, function (v) { return v === undefined ? '' : str(v); }));
    makeClass('Number', P.Number, function (rt, self, args) { return args.length ? num(args[0]) : 0; },
      boxer(P.Number, function (v) { return v === undefined ? 0 : num(v); }));
    makeClass('Boolean', P.Boolean, function (rt, self, args) { return args.length ? toBoolean(args[0], version) : false; },
      boxer(P.Boolean, function (v) { return toBoolean(v, version); }));
    hide(StringClass, 'fromCharCode', fn(function (rt, self, args) {
      return checkString(args.map(function (c) { return String.fromCharCode(toInt32(c, version) & 0xffff); }).join(''));
    }));
    function text(self) { return str(primitiveOf(self)); }
    function index(v, fallback) { return v === undefined ? fallback : toInt32(v, version); }
    methods(P.String, {
      toString: function (rt, self) { return text(self); },
      valueOf: function (rt, self) { return text(self); },
      charAt: function (rt, self, args) { var s = text(self), i = index(args[0], 0); return i >= 0 && i < s.length ? s.charAt(i) : ''; },
      charCodeAt: function (rt, self, args) { var s = text(self), i = index(args[0], 0); return i >= 0 && i < s.length ? s.charCodeAt(i) : NaN; },
      concat: function (rt, self, args) { return checkString(text(self) + args.map(str).join('')); },
      indexOf: function (rt, self, args) { return text(self).indexOf(str(arg(args, 0)), Math.max(0, index(args[1], 0))); },
      lastIndexOf: function (rt, self, args) {
        var s = text(self), from = args.length > 1 ? index(args[1], s.length) : s.length;
        return from < 0 ? -1 : s.lastIndexOf(str(arg(args, 0)), from);
      },
      slice: function (rt, self, args) { var s = text(self); return s.slice(index(args[0], 0), index(args[1], s.length)); },
      substring: function (rt, self, args) { var s = text(self); return s.substring(Math.max(0, index(args[0], 0)), Math.max(0, index(args[1], s.length))); },
      substr: function (rt, self, args) {
        var s = text(self), start = index(args[0], 0);
        if (start < 0) start = Math.max(0, s.length + start);
        var length = args.length > 1 && args[1] !== undefined ? toInt32(args[1], version) : s.length;
        return length < 0 ? '' : s.substr(start, length);
      },
      split: function (rt, self, args) {
        var s = text(self), sep = arg(args, 0), limit = args.length > 1 ? toInt32(args[1], version) : MAX_ARRAY_INDEX;
        if (sep === undefined) return array([s]);
        var parts = s.split(str(sep));
        return array(parts.slice(0, Math.max(0, Math.min(limit, MAX_ARRAY_INDEX))));
      },
      toLowerCase: function (rt, self) { return text(self).toLowerCase(); },
      toUpperCase: function (rt, self) { return text(self).toUpperCase(); }
    });
    methods(P.Number, {
      toString: function (rt, self, args) {
        var n = num(primitiveOf(self)), radix = args.length ? toInt32(args[0], version) : 10;
        if (radix === 10 || radix < 2 || radix > 36 || n !== n || !isFinite(n)) return numberToString(n);
        return (n < 0 ? '-' : '') + Math.abs(Math.trunc(n)).toString(radix);
      },
      valueOf: function (rt, self) { return num(primitiveOf(self)); }
    });
    methods(P.Boolean, {
      toString: function (rt, self) { return toBoolean(primitiveOf(self), version) ? 'true' : 'false'; },
      valueOf: function (rt, self) { return toBoolean(primitiveOf(self), version); }
    });
    var NumberClass = getMember(rt, G, 'Number');
    [['MAX_VALUE', Number.MAX_VALUE], ['MIN_VALUE', Number.MIN_VALUE], ['NaN', NaN],
      ['NEGATIVE_INFINITY', -Infinity], ['POSITIVE_INFINITY', Infinity]].forEach(function (c) { hide(NumberClass, c[0], c[1]); });

    // ---- Math ----
    var MathObject = new AvmObject(P.Object);
    hide(G, 'Math', MathObject);
    [['E', Math.E], ['LN10', Math.LN10], ['LN2', Math.LN2], ['LOG10E', Math.LOG10E], ['LOG2E', Math.LOG2E],
      ['PI', Math.PI], ['SQRT1_2', Math.SQRT1_2], ['SQRT2', Math.SQRT2]].forEach(function (c) { hide(MathObject, c[0], c[1]); });
    ['abs', 'acos', 'asin', 'atan', 'ceil', 'cos', 'exp', 'floor', 'log', 'sin', 'sqrt', 'tan'].forEach(function (name) {
      hide(MathObject, name, fn(function (rt, self, args) { return args.length ? Math[name](num(args[0])) : NaN; }));
    });
    methods(MathObject, {
      atan2: function (rt, self, args) { return Math.atan2(num(arg(args, 0)), num(arg(args, 1))); },
      pow: function (rt, self, args) { return Math.pow(num(arg(args, 0)), num(arg(args, 1))); },
      // Flash Player rounds halves up, toward +Infinity, like JavaScript.
      round: function (rt, self, args) { return args.length ? Math.round(num(args[0])) : NaN; },
      max: function (rt, self, args) { return args.length ? Math.max.apply(null, args.map(num)) : -Infinity; },
      min: function (rt, self, args) { return args.length ? Math.min.apply(null, args.map(num)) : Infinity; },
      random: function (rt) { return rt.scheduler.random(); }
    });

    // ---- Error ----
    P.Error = new AvmObject(P.Object);
    hide(P.Error, 'name', 'Error');
    hide(P.Error, 'message', 'Error');
    makeClass('Error', P.Error, function (rt, self, args) {
      if (isObject(self) && args.length) setMember(rt, self, 'message', args[0]);
      return undefined;
    });
    methods(P.Error, { toString: function (rt, self) { return str(getMember(rt, self, 'message')); } });

    // ---- Global functions and values ----
    methods(G, {
      parseInt: function (rt, self, args) {
        var s = str(arg(args, 0)).replace(/^\s+/, ''), radix = args.length > 1 ? toInt32(args[1], version) : 0;
        var negative = s.charAt(0) === '-';
        if (negative || s.charAt(0) === '+') s = s.slice(1);
        if (!radix) radix = /^0[xX]/.test(s) ? 16 : /^0\d/.test(s) && version >= 6 ? 8 : 10;
        if (radix === 16) s = s.replace(/^0[xX]/, '');
        if (radix < 2 || radix > 36) return NaN;
        var n = parseInt(s, radix);
        return negative ? -n : n;
      },
      parseFloat: function (rt, self, args) {
        var m = /^\s*([+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/.exec(str(arg(args, 0)));
        return m ? Number(m[1]) : NaN;
      },
      isNaN: function (rt, self, args) { var n = num(arg(args, 0)); return n !== n; },
      isFinite: function (rt, self, args) { return isFinite(num(arg(args, 0))); },
      // Every character but letters and digits becomes %XX: UTF-8 bytes from SWF 6, the character code before.
      escape: function (rt, self, args) {
        return checkString(str(arg(args, 0)).replace(/[^A-Za-z0-9]/g, function (c) {
          var code = c.charCodeAt(0), hex = function (n) { return '%' + (n < 16 ? '0' : '') + n.toString(16).toUpperCase(); };
          if (version < 6 || code < 128) return hex(code & 0xff);
          try { return encodeURIComponent(c); } catch (e) { return ''; }
        }));
      },
      unescape: function (rt, self, args) {
        var s = str(arg(args, 0));
        if (version >= 6) { try { return decodeURIComponent(s); } catch (e) { /* not UTF-8: by character code */ } }
        return s.replace(/%([0-9A-Fa-f]{2})/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); });
      },
      trace: function () { return undefined; },             // no output panel, as in a release Flash Player
      ASSetPropFlags: function () { return undefined; }      // property flags are not modelled
    });
    hide(G, 'NaN', NaN);
    hide(G, 'Infinity', Infinity);
    hide(G, '_global', G);
    NOT_IMPLEMENTED.forEach(function (name) { hide(G, name, UNKNOWN_VALUE); });

    // ---- MovieClip ----
    P.MovieClip = new AvmObject(P.Object);
    makeClass('MovieClip', P.MovieClip, function () { return undefined; });
    function clipMethod(body) { return function (rt, self, args) { return isClip(self) ? body(self, args, rt) : undefined; }; }
    methods(P.MovieClip, {
      play: clipMethod(function (clip) { clip.playing = true; }),
      stop: clipMethod(function (clip) { clip.playing = false; }),
      gotoAndPlay: clipMethod(function (clip, args) { gotoFrameValue(clip, arg(args, 0), true, 0, version); }),
      gotoAndStop: clipMethod(function (clip, args) { gotoFrameValue(clip, arg(args, 0), false, 0, version); }),
      nextFrame: clipMethod(function (clip) { clip.gotoFrame(clip.frame + 1); clip.playing = false; }),
      prevFrame: clipMethod(function (clip) { clip.gotoFrame(clip.frame - 1); clip.playing = false; }),
      duplicateMovieClip: clipMethod(function (clip, args) {
        var depth = toInt32(arg(args, 1), version);
        if (!clip.parent || depth < 0 || depth > 2130706428) return undefined;
        return clip.parent.cloneChild(clip.displayObject(), str(arg(args, 0)), depth) || undefined;
      }),
      removeMovieClip: clipMethod(function (clip) { if (clip.parent) clip.parent.removeChild(clip.displayObject()); }),
      getDepth: clipMethod(function (clip) { return clip.parent ? clip.displayObject().depth - M.SCRIPT_DEPTH : -16384; }),
      getBytesLoaded: clipMethod(function (clip) { return clip.env.swf.declaredLength || 0; }),
      getBytesTotal: clipMethod(function (clip) { return clip.env.swf.declaredLength || 0; }),
      // getURL(url, window, method): asks the host page to open the URL, sending this clip's variables with GET or POST.
      getURL: clipMethod(function (clip, args, rt) {
        var target = args.length > 1 && args[1] !== undefined ? str(args[1]) : '';
        M.openURL(rt.scheduler, str(arg(args, 0)), target, methodCode(arg(args, 2)), clip, version);
      }),
      // loadMovie(url, method), loadVariables(url, method) and unloadMovie(), through the host page's loader.
      loadMovie: clipMethod(function (clip, args, rt) { loadMethod(clip, args, 'movie', rt); }),
      loadVariables: clipMethod(function (clip, args, rt) { loadMethod(clip, args, 'variables', rt); }),
      unloadMovie: clipMethod(function (clip, args, rt) { loadMethod(clip, [''], 'movie', rt); }),
      startDrag: clipMethod(function (clip, args) {
        var rect = args.length >= 5 ? [num(args[1]), num(args[2]), num(args[3]), num(args[4])] : null;
        M.startDrag(clip, toBoolean(arg(args, 0), version), rect);
      }),
      stopDrag: clipMethod(function (clip) { M.stopDrag(clip.env); }),
      // hitTest(x, y, shapeFlag) in _root coordinates, or hitTest(target) by bounds.
      hitTest: clipMethod(function (clip, args) {
        if (args.length >= 2) {
          var x = num(args[0]), y = num(args[1]);
          return isFinite(x) && isFinite(y) ? M.hitTestPoint(clip, x, y, toBoolean(arg(args, 2), version)) : false;
        }
        var other = clipArg(clip, arg(args, 0));
        return other ? M.hitTestClip(clip, other) : false;
      }),
      getBounds: clipMethod(function (clip, args) {
        var b = M.boundsIn(clip, args.length ? clipArg(clip, args[0]) || clip : clip), o = new AvmObject(P.Object);
        ['xMin', 'xMax', 'yMin', 'yMax'].forEach(function (k) { setMember(rt, o, k, b[k]); });
        return o;
      }),
      localToGlobal: clipMethod(function (clip, args) { movePoint(clip, arg(args, 0), M.localToStage); }),
      globalToLocal: clipMethod(function (clip, args) { movePoint(clip, arg(args, 0), M.stageToLocal); }),
      // attachMovie(linkage name, instance name, depth, init object)
      attachMovie: clipMethod(function (clip, args) {
        var name = str(arg(args, 0)), exports = clip.env.exports, id = exports[name], depth = toInt32(arg(args, 2), version);
        if (id === undefined) Object.keys(exports).forEach(function (k) { if (id === undefined && k.toLowerCase() === name.toLowerCase()) id = exports[k]; });
        if (id === undefined || depth < 0 || depth > 2130706428) return undefined;
        var child = clip.attachChild(id, str(arg(args, 1)), depth);
        copyInit(child, arg(args, 3));
        return child || undefined;
      }),
      createEmptyMovieClip: clipMethod(function (clip, args) {
        var depth = toInt32(arg(args, 1), version);
        return depth < 0 || depth > 2130706428 ? undefined : clip.createEmptyChild(str(arg(args, 0)), depth);
      }),
      // swapDepths(depth) or swapDepths(target): moves this clip, swapping with what is there.
      swapDepths: clipMethod(function (clip, args) {
        var parent = clip.parent, v = arg(args, 0), depth;
        if (!parent) return;
        if (typeof v === 'number') depth = toInt32(v, version) + M.SCRIPT_DEPTH;
        else { var other = clipArg(clip, v); if (!other || other.parent !== parent) return; depth = other.displayObject().depth; }
        parent.swapDepths(clip.displayObject(), depth);
      }),
      getNextHighestDepth: clipMethod(function (clip) {
        var top = -1;
        clip.displayList.forEach(function (obj, depth) { top = Math.max(top, depth - M.SCRIPT_DEPTH); });
        return top + 1;
      }),
      getInstanceAtDepth: clipMethod(function (clip, args) {
        var obj = clip.displayList.get(toInt32(arg(args, 0), version) + M.SCRIPT_DEPTH);
        return obj && obj.clip ? obj.clip : undefined;
      }),
      getSWFVersion: clipMethod(function (clip) { return clip.env.version; })
    });
    // The method argument of getURL, loadMovie and loadVariables: 1 for "GET", 2 for "POST" (any case), else 0.
    function methodCode(v) {
      var method = v === undefined ? '' : str(v).toUpperCase();
      return method === 'GET' ? 1 : method === 'POST' ? 2 : 0;
    }
    function loadMethod(clip, args, kind, rt) {
      var method = methodCode(arg(args, 1));
      M.loadInto(clip, str(arg(args, 0)), kind, method, function (feature, reason, detail) {
        rt.scheduler.report(feature, reason, 'MovieClip.' + (kind === 'variables' ? 'loadVariables' : 'loadMovie') + ': ' + detail);
      }, method ? M.variablesOf(rt, clip, version) : null);
    }
    // A clip named by a value: a clip, or a target path from `clip`.
    function clipArg(clip, v) {
      if (isClip(v)) return v;
      if (!clip || v === undefined || v === null || v === UNKNOWN_VALUE) return null;
      var found = resolvePath(clip, str(v), version);
      return isClip(found) ? found : null;
    }
    // localToGlobal / globalToLocal: point.x and point.y (pixels) through `convert` (twips).
    function movePoint(clip, point, convert) {
      if (!isObject(point)) return;
      var p = convert(clip, num(getMember(rt, point, 'x')) * 20, num(getMember(rt, point, 'y')) * 20);
      setMember(rt, point, 'x', p[0] / 20);
      setMember(rt, point, 'y', p[1] / 20);
    }
    // attachMovie's init object: its properties are copied onto the new clip.
    function copyInit(child, init) {
      if (!child || !isObject(init)) return;
      keysOf(rt, init).forEach(function (k) { setMember(rt, child, k, getMember(rt, init, k)); });
    }

    // ---- Timers ----
    function addTimer(args, repeat) {
      var s = rt.scheduler;
      if (isFunction(args[0])) return s.addTimer(null, args[0], undefined, args.slice(2), num(arg(args, 1)), repeat);
      if (isObject(args[0]) || isClip(args[0])) return s.addTimer(null, str(arg(args, 1)), args[0], args.slice(3), num(arg(args, 2)), repeat);
      return undefined;
    }
    function clearTimer(rt, self, args) { rt.scheduler.timers.delete(toInt32(arg(args, 0), version)); }
    methods(G, {
      getTimer: function (rt) { return Math.floor(rt.scheduler.clock()); },
      updateAfterEvent: function () { return undefined; }, // the player redraws after every event anyway
      // setInterval(fn, ms, args...) or setInterval(object, "method", ms, args...); setTimeout likewise.
      setInterval: function (rt, self, args) { return addTimer(args, true); },
      setTimeout: function (rt, self, args) { return addTimer(args, false); },
      clearInterval: clearTimer,
      clearTimeout: clearTimer
    });

    // ---- Key, Mouse, Stage ----
    rt.keyListeners = [];
    rt.mouseListeners = [];
    function listeners(obj, list) {
      methods(obj, {
        addListener: function (rt, self, args) {
          var l = arg(args, 0);
          if ((isObject(l) || isClip(l)) && list.indexOf(l) < 0) list.push(l);
          return true;
        },
        removeListener: function (rt, self, args) {
          var i = list.indexOf(arg(args, 0));
          if (i >= 0) list.splice(i, 1);
          return i >= 0;
        }
      });
    }
    var KeyObject = new AvmObject(P.Object);
    hide(G, 'Key', KeyObject);
    Object.keys(KEY_CODES).forEach(function (k) { hide(KeyObject, k, KEY_CODES[k]); });
    methods(KeyObject, {
      isDown: function (rt, self, args) { return rt.scheduler.keys.has(toInt32(arg(args, 0), version)); },
      isToggled: function () { return false; },
      getCode: function (rt) { return rt.scheduler.lastKey.code; },
      getAscii: function (rt) { return rt.scheduler.lastKey.ascii; }
    });
    listeners(KeyObject, rt.keyListeners);
    var MouseObject = new AvmObject(P.Object);
    hide(G, 'Mouse', MouseObject);
    methods(MouseObject, {
      hide: function (rt) { var was = !rt.scheduler.mouseHidden; rt.scheduler.mouseHidden = true; return was; },
      show: function (rt) { var was = !rt.scheduler.mouseHidden; rt.scheduler.mouseHidden = false; return was; }
    });
    listeners(MouseObject, rt.mouseListeners);
    var StageObject = new AvmObject(P.Object);
    hide(G, 'Stage', StageObject);
    hide(StageObject, 'width', (scheduler.swf && scheduler.swf.width) || 0);
    hide(StageObject, 'height', (scheduler.swf && scheduler.swf.height) || 0);
    hide(StageObject, 'scaleMode', 'showAll');
    hide(StageObject, 'align', '');
    hide(StageObject, 'showMenu', true);
    listeners(StageObject, []); // the stage is never resized by scripts' standards: no onResize

    // ---- Color: setRGB, getRGB, setTransform, getTransform on a clip's colour transform ----
    P.Color = new AvmObject(P.Object);
    makeClass('Color', P.Color, function (rt, self, args) {
      if (isObject(self)) self.colorTarget = isClip(args[0]) ? args[0] : clipArg(rt.scheduler.root, args[0]);
      return undefined;
    });
    function colorObject(self) { return isObject(self) && self.colorTarget && !self.colorTarget.removed ? self.colorTarget.displayObject() : null; }
    function setCx(obj, cx) { obj.cx = cx; obj.scriptTransformed = true; }
    methods(P.Color, {
      setRGB: function (rt, self, args) {
        var obj = colorObject(self), rgb = toInt32(arg(args, 0), version);
        if (obj) setCx(obj, [0, 0, 0, obj.cx[3], (rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff, obj.cx[7]]);
      },
      getRGB: function (rt, self) {
        var obj = colorObject(self);
        return obj ? ((Math.round(obj.cx[4]) & 0xff) << 16) | ((Math.round(obj.cx[5]) & 0xff) << 8) | (Math.round(obj.cx[6]) & 0xff) : 0;
      },
      // { ra, rb, ga, gb, ba, bb, aa, ab }: multipliers in percent and offsets; missing ones are kept.
      setTransform: function (rt, self, args) {
        var obj = colorObject(self), t = arg(args, 0);
        if (!obj || !isObject(t)) return;
        var cx = obj.cx.slice();
        ['r', 'g', 'b', 'a'].forEach(function (c, i) {
          if (hasMember(rt, t, c + 'a')) cx[i] = num(getMember(rt, t, c + 'a')) / 100;
          if (hasMember(rt, t, c + 'b')) cx[i + 4] = num(getMember(rt, t, c + 'b'));
        });
        setCx(obj, cx);
      },
      getTransform: function (rt, self) {
        var obj = colorObject(self), o = new AvmObject(P.Object), cx = obj ? obj.cx : [1, 1, 1, 1, 0, 0, 0, 0];
        ['r', 'g', 'b', 'a'].forEach(function (c, i) { setMember(rt, o, c + 'a', cx[i] * 100); setMember(rt, o, c + 'b', cx[i + 4]); });
        return o;
      }
    });

    /* ---- Sound: library sounds (attachSound) and MP3 files (loadSound), played by the player's audio. A Sound
       made with a movie clip controls the sounds of that clip, and its volume and pan are the clip's; one made
       without a target controls every sound. Once its clip has left the stage it does nothing. ---- */
    P.Sound = new AvmObject(P.Object);
    makeClass('Sound', P.Sound, function (rt, self, args) {
      if (!isObject(self)) return undefined;
      self.isSound = true;
      self.soundTarget = isClip(arg(args, 0)) ? arg(args, 0) : null;
      return undefined;
    });
    hide(P.Sound, 'duration', 0);
    hide(P.Sound, 'position', 0);
    function audio() { return M.audioOf(rt.scheduler); }
    function liveSound(self) { return isObject(self) && self.isSound && !(self.soundTarget && self.soundTarget.removed) ? self : null; }
    function transformOf(self) {
      var clip = self.soundTarget;
      if (!clip) return audio().transform;
      return clip.soundTransform || (clip.soundTransform = M.newSoundTransform());
    }
    // A sound character exported (ExportAssets) under `name` by the movie of the Sound's target, or of the root.
    function exportedSound(self, name) {
      var env = (self.soundTarget || rt.scheduler.root).env, exports = env.exports, id = exports[name];
      if (id === undefined) Object.keys(exports).forEach(function (k) { if (id === undefined && k.toLowerCase() === name.toLowerCase()) id = exports[k]; });
      var sound = id === undefined ? null : env.characters[id];
      return sound && sound.type === 'sound' ? sound : null;
    }
    function useSound(self, sound) {
      self.sound = sound;
      self.instance = null;
      self.soundDuration = Math.round(sound.sampleCount / sound.rate * 1000);
      hide(self, 'duration', self.soundDuration);
      hide(self, 'position', 0);
    }
    function startSound(self, offset, loops) {
      if (self.streaming && self.instance) audio().remove(self.instance); // a streaming sound plays once at a time
      var inst = audio().start(self.sound, { inPoint: offset > 0 ? Math.floor(offset * 44100) : 0, loopCount: loops }, self.soundTarget, self);
      if (inst) self.instance = inst;
    }
    methods(P.Sound, {
      attachSound: function (rt, self, args) {
        var s = liveSound(self), sound = s && exportedSound(s, str(arg(args, 0)));
        if (sound) { useSound(s, sound); s.streaming = false; }
        else if (s) rt.scheduler.report('sound:attachMissing', 'Sound.attachSound names no exported sound; nothing is attached.', str(arg(args, 0)));
      },
      // start(secondOffset, loops): a new instance of the sound, from secondOffset seconds, played loops times.
      start: function (rt, self, args) {
        var s = liveSound(self);
        if (!s || !s.sound) return;
        var loops = num(arg(args, 1));
        startSound(s, num(arg(args, 0)), s.streaming || !(loops >= 1) ? 1 : Math.min(65535, Math.floor(loops)));
      },
      // stop(): the sounds of the target (every sound without one); stop(name): every instance of that sound.
      stop: function (rt, self, args) {
        var s = liveSound(self);
        if (!s) return;
        if (arg(args, 0) !== undefined) {
          var sound = exportedSound(s, str(args[0]));
          if (sound) audio().stopSound(sound);
        } else if (s.soundTarget) audio().stopOwned(s.soundTarget);
        else audio().stopAll();
      },
      getVolume: function (rt, self) { var s = liveSound(self); return s ? transformOf(s).volume : undefined; },
      setVolume: function (rt, self, args) {
        var s = liveSound(self);
        if (!s) return;
        transformOf(s).volume = toInt32(arg(args, 0), version);
        audio().refresh();
      },
      // Pan -100 (left only) to 100 (right only): the other side is turned down.
      getPan: function (rt, self) { var s = liveSound(self), t = s && transformOf(s); return t ? t.rr - t.ll : undefined; },
      setPan: function (rt, self, args) {
        var s = liveSound(self);
        if (!s) return;
        var t = transformOf(s), pan = toInt32(arg(args, 0), version);
        t.ll = pan > 0 ? 100 - pan : 100;
        t.rr = pan < 0 ? 100 + pan : 100;
        t.lr = t.rl = 0;
        audio().refresh();
      },
      // { ll, lr, rr, rl }: percent of the left and right input sent to the left and right output.
      getTransform: function (rt, self) {
        var s = liveSound(self);
        if (!s) return undefined;
        var t = transformOf(s), o = new AvmObject(P.Object);
        ['ll', 'lr', 'rr', 'rl'].forEach(function (k) { setMember(rt, o, k, t[k]); });
        return o;
      },
      setTransform: function (rt, self, args) {
        var s = liveSound(self), value = arg(args, 0);
        if (!s || !isObject(value)) return;
        var t = transformOf(s);
        ['ll', 'lr', 'rr', 'rl'].forEach(function (k) { if (hasMember(rt, value, k)) t[k] = toInt32(getMember(rt, value, k), version); });
        audio().refresh();
      },
      getBytesLoaded: function (rt, self) { return isObject(self) && self.bytesLoaded !== undefined ? self.bytesLoaded : 0; },
      getBytesTotal: function (rt, self) { return isObject(self) && self.bytesTotal !== undefined ? self.bytesTotal : 0; },
      /* loadSound(url, isStreaming): an MP3 file, through the host page's loader. onLoad(success) follows; a
         streaming sound starts playing as soon as it has arrived. */
      loadSound: function (rt, self, args) {
        var s = liveSound(self), url = str(arg(args, 0)), root = rt.scheduler.root;
        if (!s || !root) return;
        var streaming = toBoolean(arg(args, 1), version), token = s.loadToken = {};
        s.streaming = streaming;
        if (!root.env.loads) return rt.scheduler.report('load:noLoader', 'Loading a URL needs a loader from the host page (the Player option `loader` or `host.load`); nothing was loaded.', url);
        root.env.loads.request(s.soundTarget || root, url, 'sound', 0, null, function (result, error) {
          if (s.loadToken !== token) return;
          if (result) {
            useSound(s, result.sound);
            s.bytesLoaded = s.bytesTotal = result.bytes;
            if (streaming && liveSound(s)) startSound(s, 0, 1);
          }
          rt.scheduler.enqueueCall(rt.scheduler.root, getMember(rt, s, 'onLoad'), s, [!error], 'onLoad');
        });
      }
    });

    // ---- flash.external.ExternalInterface: calls into the host page, and callbacks the page can call ----
    var bridge = M.hostOf(scheduler), FlashPackage = new AvmObject(P.Object), External = new AvmObject(P.Object);
    var ExternalInterface = new AvmObject(P.Object);
    hide(G, 'flash', FlashPackage);
    hide(FlashPackage, 'external', External);
    FLASH_PACKAGES.forEach(function (name) { hide(FlashPackage, name, UNKNOWN_VALUE); });
    hide(External, 'ExternalInterface', ExternalInterface);
    hide(ExternalInterface, 'available', bridge.available);
    hide(ExternalInterface, 'objectID', bridge.objectID);
    hide(ExternalInterface, 'marshallExceptions', false);
    methods(ExternalInterface, {
      // call(name, args...): the page function's result, or null when the call could not be made.
      call: function (rt, self, args) {
        if (!bridge.available || !args.length) return null;
        var result = bridge.call({
          kind: 'external', name: str(args[0]), source: str(args[0]),
          args: args.slice(1).map(function (v) { return M.toHostValue(rt, v); })
        });
        return result ? M.fromHostValue(rt, result.value) : null;
      },
      // addCallback(name, instance, method): the page can call method with instance as `this` (Player.callback).
      addCallback: function (rt, self, args) {
        var name = str(arg(args, 0)), method = arg(args, 2);
        if (!bridge.available || !name || !isFunction(method)) return false;
        bridge.addCallback(name, arg(args, 1), method);
        return true;
      }
    });
    return rt;
  }

  /* gotoAndPlay/gotoAndStop and GotoFrame2: the frame is an integer number, or a string: "path:frame" or
     "path.frame" (another timeline), a frame number or a frame label. `sceneBias` is added; a frame below 1
     does nothing. The clip then plays or stops. */
  function gotoFrameValue(clip, value, play, sceneBias, version) {
    var n;
    if (typeof value === 'number' && value === Math.floor(value)) {
      n = value | 0;
    } else {
      var s = toAvmString(value, version), at = Math.max(s.lastIndexOf(':'), s.lastIndexOf('.'));
      if (at >= 0) {
        clip = resolvePath(clip, s.slice(0, at), version);
        s = s.slice(at + 1);
        if (!isClip(clip)) return;
      }
      if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) n = Number(s) | 0;
      else n = clip.findLabel(s);
    }
    var frame = (n + sceneBias) | 0;
    if (frame <= 0) return;
    clip.gotoFrame((frame & 0xffff) || 1); // Flash Player keeps 16-bit frame numbers
    clip.playing = play;
  }

  Object.assign(M, { createRuntime: createRuntime, gotoFrameValue: gotoFrameValue });
})(typeof window !== 'undefined' ? window : globalThis);
