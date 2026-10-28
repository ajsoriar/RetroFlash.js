/* RetroFlash.js - The AVM1 interpreter: frame scripts, button actions and functions. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;
  var ActionCode = M.ActionCode, ACTIONS = M.ACTIONS, UNKNOWN_VALUE = M.UNKNOWN_VALUE, toNumber = M.toNumber,
    toAvmString = M.toAvmString, toBoolean = M.toBoolean, toInt32 = M.toInt32, looseEquals = M.looseEquals,
    strictEquals = M.strictEquals, lessThan = M.lessThan, typeOf = M.typeOf, resolveTarget = M.resolveTarget,
    getVariable = M.getVariable, lookupVariable = M.lookupVariable, setVariable = M.setVariable,
    defineLocal = M.defineLocal, deleteVariable = M.deleteVariable, isClip = M.isClip, isObject = M.isObject,
    isObjectValue = M.isObjectValue, isFunction = M.isFunction, resolvePath = M.resolvePath, getProperty = M.getProperty,
    setProperty = M.setProperty, clipPath = M.clipPath, AvmObject = M.AvmObject, AvmFunction = M.AvmFunction,
    getMember = M.getMember, setMember = M.setMember, setOwn = M.setOwn, deleteMember = M.deleteMember,
    keysOf = M.keysOf, instanceOf = M.instanceOf, toPrimitive = M.toPrimitive, checkString = M.checkString,
    LimitError = M.LimitError, createRuntime = M.createRuntime, gotoFrameValue = M.gotoFrameValue,
    MAX_ARRAY_INDEX = M.MAX_ARRAY_INDEX, startDrag = M.startDrag, stopDrag = M.stopDrag;

  /* A controlled interpreter. It never evaluates JavaScript and never touches the page itself: navigation,
     javascript: URLs, FSCommand and ExternalInterface go to the host page's `host` (avm1/external.js). It
     runs AVM1 bytecode: timelines and movie clips, the stack and registers, operators, variables, control
     flow, functions, objects, with, try/catch/finally, for..in, dragging and the timer. Clip events, timers
     and listeners are queued with the frame scripts. Unknown action codes are reported and skipped. Loops and
     recursion are bounded by the limits. */

  // The highest depth duplicateMovieClip accepts, as in Flash Player.
  var MAX_SCRIPT_DEPTH = 2130706428;

  // Frame numbers above these count as not loaded by WaitForFrame and WaitForFrame2 (the most frames a SWF can
  // have, and Flash Player's off-by-one for WaitForFrame2). Every other frame counts as loaded: the whole movie is.
  var MAX_LOADED_FRAME = 16000, MAX_LOADED_FRAME_2 = 16001;

  /* Bytes of actions that one movie may decode (ActionCode budget, which also charges each cached block). The
     decoded records stay cached for the life of the movie. Filling this budget grew the heap by 40 to 58 MB in
     Chrome and by up to about 120 MB in Node, where one-byte actions cost the most. It bounds this cache only,
     not the player's total memory. */
  var MAX_DECODED_ACTION_BYTES = 1024 * 1024;

  /* Stack effect [pops, pushes] of skipped actions (SWF19). Every defined action is interpreted now; a skipped
     action that is not listed would leave the whole stack unknown. Unknown action codes have no effect, as
     Flash Player ignores them. */
  var STACK_EFFECTS = {};

  var REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);
  // SWF4 substring (StringExtract, MBStringExtract): 1-based start; a negative count, or one past the end, takes the rest.
  function extract(s, index, count) {
    var start = index >= 1 ? index - 1 : 0, end = count >= 0 && start + count <= s.length ? start + count : s.length;
    return s.slice(Math.min(start, end), end);
  }
  // Character code of the first UTF-16 unit (0 for ""); a surrogate gives U+FFFD.
  function charCode(s) {
    var c = s ? s.charCodeAt(0) : 0;
    return c >= 0xd800 && c <= 0xdfff ? 0xfffd : c;
  }
  function charOf(code, keepSurrogates) {
    code &= 0xffff;
    if (!code) return '';
    return !keepSurrogates && code >= 0xd800 && code <= 0xdfff ? REPLACEMENT_CHARACTER : String.fromCharCode(code);
  }
  function str(v, version) { return toAvmString(v, version); }
  function num(v, version) { return toNumber(v, version); }
  // Add2 concatenates when either side, after valueOf(), is a string, a movie clip or an object.
  function isText(v) { return typeof v === 'string' || isClip(v) || isObjectValue(v); }

  /* Operators: code -> [operand count, function (operands in push order, SWF version, activation) -> result].
     Results that compare or test are booleans in every SWF version, as in Flash Player. */
  var OPERATORS = {
    0x0a: [2, function (o, v) { return num(o[0], v) + num(o[1], v); }],                         // Add
    0x0b: [2, function (o, v) { return num(o[0], v) - num(o[1], v); }],                         // Subtract
    0x0c: [2, function (o, v) { return num(o[0], v) * num(o[1], v); }],                         // Multiply
    0x0d: [2, function (o, v) {                                                                 // Divide
      var d = num(o[1], v);
      return d === 0 && v < 5 ? '#ERROR#' : num(o[0], v) / d;
    }],
    0x0e: [2, function (o, v) { return num(o[0], v) === num(o[1], v); }],                       // Equals
    0x0f: [2, function (o, v) { return num(o[0], v) < num(o[1], v); }],                         // Less
    0x10: [2, function (o, v) { return toBoolean(o[0], v) && toBoolean(o[1], v); }],            // And
    0x11: [2, function (o, v) { return toBoolean(o[0], v) || toBoolean(o[1], v); }],            // Or
    0x12: [1, function (o, v) { return !toBoolean(o[0], v); }],                                 // Not
    0x13: [2, function (o, v) { return str(o[0], v) === str(o[1], v); }],                       // StringEquals
    0x14: [1, function (o, v) { return str(o[0], v).length; }],                                 // StringLength
    0x15: [3, function (o, v) { return extract(str(o[0], v), toInt32(o[1], v), toInt32(o[2], v)); }], // StringExtract
    0x18: [1, function (o, v) { return toInt32(o[0], v); }],                                    // ToInteger
    0x21: [2, function (o, v) { return checkString(str(o[0], v) + str(o[1], v)); }],            // StringAdd
    0x29: [2, function (o, v) { return str(o[0], v) < str(o[1], v); }],                         // StringLess
    0x30: [1, function (o, v, act) {                                                            // RandomNumber
      var max = num(o[0], v);
      max = max !== max ? 0 : Math.max(-2147483648, Math.min(2147483647, Math.trunc(max)));
      return max > 0 ? Math.floor(act.scheduler.random() * max) : 0;
    }],
    0x31: [1, function (o, v) { return str(o[0], v).length; }],                                 // MBStringLength
    0x32: [1, function (o, v) { return charCode(str(o[0], v)); }],                              // CharToAscii
    0x33: [1, function (o, v) { return charOf(toInt32(o[0], v), v < 6); }],                     // AsciiToChar
    0x35: [3, function (o, v) { return extract(str(o[0], v), toInt32(o[1], v), toInt32(o[2], v)); }], // MBStringExtract
    0x36: [1, function (o, v) {                                                                 // MBCharToAscii
      var s = str(o[0], v);
      return v < 6 ? (s ? s.charCodeAt(0) & 0xff : 0) : charCode(s);
    }],
    0x37: [1, function (o, v) { return charOf(toInt32(o[0], v), false); }],                     // MBAsciiToChar
    0x3f: [2, function (o, v) { return num(o[0], v) % num(o[1], v); }],                         // Modulo
    0x44: [1, function (o) { return typeOf(o[0]); }],                                           // TypeOf
    0x45: [1, function (o) { return isClip(o[0]) ? clipPath(o[0]) : undefined; }],              // TargetPath
    0x47: [2, function (o, v) {                                                                 // Add2
      var a = toPrimitive(o[0]), b = toPrimitive(o[1]);
      return isText(a) || isText(b) ? checkString(str(a, v) + str(b, v)) : num(a, v) + num(b, v);
    }],
    0x48: [2, function (o, v) { return lessThan(o[0], o[1], v); }],                             // Less2
    0x49: [2, function (o, v) { return looseEquals(o[0], o[1], v); }],                          // Equals2
    0x4a: [1, function (o, v) { return num(o[0], v); }],                                        // ToNumber
    0x4b: [1, function (o, v) { return str(o[0], v); }],                                        // ToString
    0x50: [1, function (o, v) { return num(o[0], v) + 1; }],                                    // Increment
    0x51: [1, function (o, v) { return num(o[0], v) - 1; }],                                    // Decrement
    0x54: [2, function (o, v, act) { return instanceOf(act.rt, o[0], o[1]); }],                 // InstanceOf
    0x60: [2, function (o, v) { return toInt32(o[0], v) & toInt32(o[1], v); }],                 // BitAnd
    0x61: [2, function (o, v) { return toInt32(o[0], v) | toInt32(o[1], v); }],                 // BitOr
    0x62: [2, function (o, v) { return toInt32(o[0], v) ^ toInt32(o[1], v); }],                 // BitXor
    0x63: [2, function (o, v) { return toInt32(o[0], v) << (toInt32(o[1], v) & 31); }],         // BitLShift
    0x64: [2, function (o, v) { return toInt32(o[0], v) >> (toInt32(o[1], v) & 31); }],         // BitRShift
    0x65: [2, function (o, v) {                                                                 // BitURShift
      var r = toInt32(o[0], v) >>> (toInt32(o[1], v) & 31);
      return v === 8 || v === 9 ? r | 0 : r; // signed in SWF 8 and 9, as in Flash Player
    }],
    0x66: [2, function (o) { return strictEquals(o[0], o[1]); }],                               // StrictEquals
    0x67: [2, function (o, v) { return lessThan(o[1], o[0], v); }],                             // Greater
    0x68: [2, function (o, v) { return str(o[0], v) > str(o[1], v); }],                         // StringGreater
    0x2b: [2, function (o, v, act) { return instanceOf(act.rt, o[1], o[0]) ? o[1] : null; }]    // CastOp
  };

  // A value thrown by Throw, travelling up to a Try or out of the block.
  function AvmThrow(value) { this.value = value; }
  // Thrown when a script must stop at once (too many nested calls), unwinding every activation of the block.
  function AbortError(message) { this.message = message; }

  /* Runs the AVM1 action blocks of one movie in the order they were queued: the frame scripts of the frames
     entered during a tick, then the actions of a button event. One update (a tick or an input event, opened
     by beginUpdate) may call run() more than once; all of them share one budget of limits.maxActionBlocks
     blocks and limits.maxActionSteps actions. With `enabled` false (the actions option), nothing is queued.
     `runtime` (avm1/globals.js) holds the movie's global object and its four global registers. */
  function ActionScheduler(swf, report, limits, enabled) {
    this.swf = swf;
    this.version = swf.version;
    this.report = report;
    this.limits = limits;
    this.enabled = enabled !== false;
    this.queue = [];          // { clip, blocks }
    this.cache = new Map();   // block -> ActionCode
    this.decoded = { used: 0, max: MAX_DECODED_ACTION_BYTES }; // shared by every cached block
    this.blocks = 0;          // budget used in the current update
    this.steps = 0;
    this.random = Math.random; // RandomNumber's source, in [0, 1)
    this.runtime = null;       // made on first use (runtimeOf)
    var start = Date.now();
    this.clock = function () { return Date.now() - start; }; // milliseconds since the movie started (the player sets its own)
    this.timers = new Map();   // id -> { fn, thisValue, args, interval, next, repeat } (setInterval, setTimeout)
    this.nextTimer = 1;
    this.keys = new Set();     // key codes held down (Key.isDown), set by the input controller
    this.lastKey = { code: 0, ascii: 0 }; // Key.getCode, Key.getAscii
    this.mouseHidden = false;  // Mouse.hide
    this.host = null;          // the HostBridge to the page (avm1/external.js), set by createEnv
    this.active = 0;           // blocks and calls running now (more than one when the page calls back into the movie)
  }
  // The most timers a movie can have at once; setInterval and setTimeout past it give undefined.
  var MAX_TIMERS = 10000;

  // Clip events whose AS2 handler is a method of the clip (onEnterFrame, ...); key events go to Key listeners.
  var EVENT_METHODS = {
    load: 'onLoad', unload: 'onUnload', enterFrame: 'onEnterFrame', mouseDown: 'onMouseDown', mouseUp: 'onMouseUp',
    mouseMove: 'onMouseMove', press: 'onPress', release: 'onRelease', releaseOutside: 'onReleaseOutside',
    rollOver: 'onRollOver', rollOut: 'onRollOut', dragOver: 'onDragOver', dragOut: 'onDragOut', data: 'onData'
  };
  // The events that make a movie clip act as a button.
  var BUTTON_EVENTS = ['press', 'release', 'releaseOutside', 'rollOver', 'rollOut', 'dragOver', 'dragOut'];

  /* Queues the handlers of clip event `name` for `clip`: its onClipEvent actions (run in the clip's context;
     keyPress ones only for `keyCode`), then its AS2 method (onEnterFrame, ...) called with the clip as this. */
  ActionScheduler.prototype.clipEvent = function (clip, name, keyCode) {
    if (!this.enabled || (clip.removed && name !== 'unload')) return;
    var obj = clip.object, self = this;
    if (obj && obj.clipActions) {
      obj.clipActions.forEach(function (a) {
        if (a.events.indexOf(name) >= 0 && (name !== 'keyPress' || a.keyCode === keyCode)) self.enqueue(clip, [a.block]);
      });
    }
    var method = EVENT_METHODS[name];
    if (method) {
      var fn = getMember(runtimeOf(this), clip, method);
      if (isFunction(fn)) this.queue.push({ clip: clip, call: fn, thisValue: clip, args: [], label: method, event: name });
    }
  };
  // Queues a call of `fn` (a timer, a listener) with `thisValue`.
  ActionScheduler.prototype.enqueueCall = function (clip, fn, thisValue, args, label) {
    if (this.enabled && isFunction(fn)) this.queue.push({ clip: clip, call: fn, thisValue: thisValue, args: args || [], label: label });
  };
  /* A mouse or key event for the whole movie: every clip under `root` gets it (clips created first come
     last, children before their parents), then the Mouse or Key listeners (onMouseDown, onKeyDown, ...). */
  ActionScheduler.prototype.broadcast = function (root, name, keyCode) {
    if (!this.enabled || !root) return;
    var self = this, rt = runtimeOf(this), clips = [];
    (function collect(clip) {
      clip.displayList.forEach(function (obj) { if (obj.clip) collect(obj.clip); });
      clips.push(clip);
    })(root);
    clips.forEach(function (clip) {
      if (name === 'keyDown' || name === 'keyUp' || name === 'keyPress') {
        var obj = clip.object;
        if (obj && obj.clipActions) obj.clipActions.forEach(function (a) {
          if (a.events.indexOf(name) >= 0 && (name !== 'keyPress' || a.keyCode === keyCode)) self.enqueue(clip, [a.block]);
        });
      } else {
        self.clipEvent(clip, name);
      }
    });
    var listeners = name.slice(0, 3) === 'key' ? rt.keyListeners : rt.mouseListeners;
    var method = 'on' + name.charAt(0).toUpperCase() + name.slice(1);
    listeners.slice().forEach(function (listener) { self.enqueueCall(root, getMember(rt, listener, method), listener, [], method); });
  };
  // Whether a clip acts as a button: it has onPress, onRelease, ... methods or onClipEvent(press), ... actions.
  ActionScheduler.prototype.isButtonClip = function (clip) {
    var obj = clip.object, rt = runtimeOf(this);
    if (obj && obj.clipActions && obj.clipActions.some(function (a) { return a.events.some(function (e) { return BUTTON_EVENTS.indexOf(e) >= 0; }); })) return true;
    return BUTTON_EVENTS.some(function (e) { return isFunction(getMember(rt, clip, EVENT_METHODS[e])); });
  };
  /* setInterval and setTimeout: `fn` is called with `thisValue` every `interval` ms (once for a timeout).
     Timers run between frames (runTimers), at most once per check each. Returns the timer's id. */
  ActionScheduler.prototype.addTimer = function (clip, fn, thisValue, args, interval, repeat) {
    if (this.timers.size >= MAX_TIMERS) return undefined;
    var id = this.nextTimer++;
    interval = interval > 0 ? interval : 0;
    this.timers.set(id, { clip: clip, fn: fn, thisValue: thisValue, args: args, interval: interval, next: this.clock() + interval, repeat: repeat });
    return id;
  };
  // Queues the timers that are due; true when one was.
  ActionScheduler.prototype.runTimers = function () {
    var now = this.clock(), due = false, self = this;
    this.timers.forEach(function (t, id) {
      if (now < t.next) return;
      due = true;
      if (t.repeat) t.next = now + Math.max(1, t.interval); else self.timers.delete(id);
      var fn = typeof t.fn === 'string' ? getMember(runtimeOf(self), t.thisValue, t.fn) : t.fn;
      self.enqueueCall(t.clip, fn, t.thisValue, t.args, 'interval ' + id);
    });
    return due;
  };
  // The movie's AVM1 runtime, with call and construct bound to this scheduler.
  function runtimeOf(scheduler) {
    if (!scheduler.runtime) {
      var rt = scheduler.runtime = createRuntime(scheduler);
      rt.call = function (fn, thisValue, args) { return callValue(scheduler, fn, thisValue, args, null); };
      rt.construct = function (fn, args) { return construct(scheduler, fn, args, null); };
    }
    return scheduler.runtime;
  }
  // Starts a new update with a fresh budget. A new scheduler starts with one (the movie's first frame).
  ActionScheduler.prototype.beginUpdate = function () {
    this.blocks = 0;
    this.steps = 0;
  };
  // blocks: DoAction tags, or button actions { bytes, offset, label }, run in the context of `clip`.
  ActionScheduler.prototype.enqueue = function (clip, blocks) {
    if (this.enabled && blocks.length) this.queue.push({ clip: clip, blocks: blocks });
  };
  /* mark() and dropSince(mark) discard what was queued in between: a scrubbing seek, or the creation of a
     button's hit area, enters frames without running their scripts. */
  ActionScheduler.prototype.mark = function () { return this.queue.length; };
  ActionScheduler.prototype.dropSince = function (mark) { this.queue.length = mark; };
  /* The decoded code of a block run for `clip`. Its records are decoded once, within the `decoded` budget
     shared with the movies loaded into clips. A DoAction tag is read from the SWF file of the clip's movie,
     whose version the code follows. */
  ActionScheduler.prototype.codeOf = function (block, clip) {
    var code = this.cache.get(block);
    if (!code) {
      var swf = (clip && clip.env && clip.env.swf) || this.swf;
      code = new ActionCode(block.bytes || swf.getTagData(block), swf.version, this.decoded);
      this.cache.set(block, code);
    }
    return code;
  };
  /* Runs the queue, including what is queued while running (gotos, events), within the budget of the current
     update. Items are action blocks ({ clip, blocks }) or calls of functions ({ clip, call, thisValue, args }). */
  ActionScheduler.prototype.run = function () {
    var max = this.limits.maxActionBlocks;
    while (this.queue.length) {
      var item = this.queue.shift(), blocks = item.call ? [null] : item.blocks;
      for (var i = 0; i < blocks.length; i++) {
        if (++this.blocks > max) {
          this.queue.length = 0;
          return this.report('avm1:budget', 'More than ' + max + ' action blocks in one tick or event; the rest were dropped.', 'queue');
        }
        if (item.call) callHandler(this, item);
        else executeAVM1(this, item.clip, blocks[i]);
      }
    }
  };

  /* Runs `body` for one block or handler: an exception that leaves it (an uncaught Throw, too many nested
     calls, a runtime limit) ends it and is reported. */
  function guarded(scheduler, source, body) {
    var previous = M.currentRuntime, rt = runtimeOf(scheduler), depth = rt.callDepth;
    M.currentRuntime = rt;
    scheduler.active++;
    try {
      body();
    } catch (err) {
      if (err instanceof AvmThrow) scheduler.report('avm1:uncaughtThrow', 'A Throw was not caught; the rest of the script was not run.', source);
      else if (err instanceof AbortError || err instanceof LimitError) scheduler.report('avm1:budget', err.message, source);
      else if (err instanceof RangeError) scheduler.report('avm1:budget', 'The script went past a JavaScript limit (' + err.message + '); it was stopped.', source);
      else throw err;
    } finally {
      M.currentRuntime = previous;
      scheduler.active--;
      rt.callDepth = depth;
    }
  }
  /* Calls an AVM1 function now and gives its result (undefined when it fails): a callback the page calls
     (ExternalInterface.addCallback). It shares the current update's budget; the caller opens one when no
     script is running. */
  ActionScheduler.prototype.invoke = function (fn, thisValue, args, label) {
    var result, self = this;
    guarded(this, label || 'callback', function () { result = callValue(self, fn, thisValue, args, null); });
    return result;
  };
  /* Runs one action block in the context of `clip` (the timeline that holds a frame script, or a button's
     parent). A block that decoded no record (an empty block, or one met after the decoding budget was spent)
     is not kept in the cache: the budget does not pay for it. */
  function executeAVM1(scheduler, clip, block) {
    var code = scheduler.codeOf(block, clip), source = (block.label || 'DoAction') + ' at offset ' + block.offset;
    guarded(scheduler, source, function () { new Activation(scheduler, clip, code, source).run(); });
    if (!code.records.size) scheduler.cache.delete(block);
  }
  /* Calls a queued event handler, timer or listener. Events are queued only for clips on the stage (see
     clipEvent); one queued before its clip left in the same tick still runs, as its frame came first. */
  function callHandler(scheduler, item) {
    guarded(scheduler, item.label || 'handler', function () { callValue(scheduler, item.call, item.thisValue, item.args, null); });
  }

  /* The state of one running piece of bytecode: a frame script, a button action list, or a function body
     (`call`: { start, end, scopes, thisValue, registers, constants, callee }). It holds the program counter
     within [start, end), the clip it runs for (`clip`, the base clip), the timeline actions address (`target`,
     changed by SetTarget), its own stack, its constant pool, the local registers of a DefineFunction2 function
     (the movie's four global registers otherwise), `this` and the scope chain (avm1/variables.js). It is also
     the context (`ctx`) that variables resolve in. The SWF version is the one of the movie the code comes from,
     which differs from the main movie's for a movie loaded into a clip. */
  function Activation(scheduler, clip, code, source, call) {
    this.scheduler = scheduler;
    this.rt = runtimeOf(scheduler);
    this.version = code.version;
    this.clip = clip;
    this.target = clip;
    this.root = clip ? clip.root() : null;
    this.code = code;
    this.source = source;
    this.start = call ? call.start : 0;
    this.end = call ? call.end : code.length;
    this.pc = this.start;
    this.stack = [];
    this.stackUnknown = false; // below `stack` lie values that skipped actions left in unknown number
    this.registers = call ? call.registers : null;
    this.constants = call ? call.constants : [];
    this.thisValue = call ? call.thisValue : clip;
    this.scopes = call ? call.scopes : [{ kind: 'global', obj: this.rt.global }, { kind: 'target', obj: clip }];
    this.callee = call ? call.callee : null;
    this.returnValue = undefined;
  }
  /* Popping an empty stack gives undefined, as in Flash Player, or UNKNOWN_VALUE when skipped actions may have
     left values there. */
  Activation.prototype.pop = function () {
    if (this.stack.length) return this.stack.pop();
    return this.stackUnknown ? UNKNOWN_VALUE : undefined;
  };
  Activation.prototype.peek = function () {
    if (this.stack.length) return this.stack[this.stack.length - 1];
    return this.stackUnknown ? UNKNOWN_VALUE : undefined;
  };
  // Up to `count` values popped for a call, the first popped first; the stack bounds how many there are.
  Activation.prototype.popArgs = function (count) {
    var args = [], n = Math.min(Math.max(0, count), this.stack.length);
    for (var i = 0; i < n; i++) args.push(this.pop());
    return args;
  };
  // Registers: a DefineFunction2 function's own ones, else the movie's four global registers.
  Activation.prototype.getRegister = function (n) {
    if (this.registers && n < this.registers.length) return this.registers[n];
    return n < 4 ? this.rt.registers[n] : undefined;
  };
  Activation.prototype.setRegister = function (n, value) {
    if (this.registers && n < this.registers.length) this.registers[n] = value;
    else if (n < 4) this.rt.registers[n] = value;
  };
  // The value of a Push operand. Missing registers and constants give undefined.
  Activation.prototype.pushValue = function (operand) {
    switch (operand.type) {
      case 'register': return this.getRegister(operand.value);
      case 'constant': return operand.value < this.constants.length ? this.constants[operand.value] : undefined;
      default: return operand.value;
    }
  };
  /* SetTarget: actions address `clip` (null: nothing), and variables its timeline (the root when null, as in
     Flash Player); the topmost target scope is replaced. */
  Activation.prototype.setTarget = function (clip) {
    this.target = clip;
    var scopes = this.scopes.slice();
    for (var i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i].kind === 'target') { scopes[i] = { kind: 'target', obj: clip || this.root }; break; }
    }
    this.scopes = scopes;
  };
  // Applies an operator (OPERATORS); an unknown operand gives an unknown result. False when the stack is full.
  Activation.prototype.operate = function (op) {
    var operands = new Array(op[0]), unknown = false;
    for (var i = op[0] - 1; i >= 0; i--) {
      operands[i] = this.pop();
      if (operands[i] === UNKNOWN_VALUE) unknown = true;
    }
    return this.push(unknown ? UNKNOWN_VALUE : op[1](operands, this.version, this)) || this.stackFull();
  };
  // A variable name popped from the stack, or null (reported) when it is not known.
  Activation.prototype.popName = function (action) {
    var name = this.pop();
    if (name !== UNKNOWN_VALUE) return toAvmString(name, this.version);
    this.report('avm1:unknownName', action.name + ' names a variable with a value that is not known; nothing was done.');
    return null;
  };
  Activation.prototype.setVariable = function (name, value) {
    if (!setVariable(this, name, value)) {
      this.report('avm1:variableNotSet', '_root, _parent, or a variable reached through a value that is not known, cannot be set; nothing was set.', name);
    }
  };
  /* WaitForFrame for a frame that is not loaded: the next `count` action records are skipped (records, not
     bytes). Skipping stops at ActionEndFlag or the end of the block. False when the script must end. */
  Activation.prototype.skipActions = function (count) {
    for (var i = 0; i < count && this.pc < this.end && this.code.bytes[this.pc] !== 0; i++) {
      var action = this.fetch();
      if (!action) return false;
      if (action.error && action.error.code === 'TRUNCATED_RECORD') return this.malformed();
      this.pc = action.end;
    }
    return true;
  };
  // A load into "_levelN" (loadMovieNum, loadVariablesNum): _level0 is the root; other levels are not supported.
  Activation.prototype.loadLevel = function (url, target, kind, method) {
    url = toAvmString(url, this.version);
    if (M.levelOf(target) === 0) M.loadInto(this.root, url, kind, method, this.report.bind(this), this.formVariables(method));
    else this.report('load:level', 'Movies loaded into levels other than _level0 are not supported yet; nothing was loaded.', target + ' ← ' + url);
    return true;
  };
  /* What a request with a method sends: the variables of the innermost timeline or function locals on the
     scope chain (`with` objects are passed over), as Flash Player sends them. Null without a method. */
  Activation.prototype.formScope = function () {
    for (var i = this.scopes.length - 1; i >= 0; i--) if (this.scopes[i].kind !== 'with') return this.scopes[i].obj;
    return this.clip;
  };
  Activation.prototype.formVariables = function (method) {
    return method ? M.variablesOf(this.rt, this.formScope(), this.version) : null;
  };
  // getURL to a window, an FSCommand or a javascript: URL (avm1/external.js).
  Activation.prototype.openURL = function (url, target, method) {
    M.openURL(this.scheduler, url, target, method, this.formScope(), this.version);
    return true;
  };
  // The timeline that GotoFrame2, CloneSprite, RemoveSprite and Call address: the target, or the root without one.
  Activation.prototype.targetOrRoot = function () {
    return this.target || this.root;
  };
  /* The movie clip a value names: a clip itself, or a target path from `start` (an empty path is `start` only
     when allowEmpty). Null when it names nothing; UNKNOWN_VALUE when the value is not known. */
  Activation.prototype.clipOf = function (value, start, allowEmpty) {
    if (value === UNKNOWN_VALUE || isClip(value)) return value;
    var path = toAvmString(value, this.version);
    if (!start || (!allowEmpty && path === '')) return null;
    var found = resolvePath(start, path, this.version, this);
    return found === UNKNOWN_VALUE || isClip(found) ? found : null;
  };
  // The clip GetProperty and SetProperty address: from the target, or from the base clip without one.
  Activation.prototype.propertyClip = function (value) {
    return this.target ? this.clipOf(value, this.target, true) : this.clipOf(value, this.clip, false);
  };
  // An action that needs a known value got an unknown one. False: the caller ends the script with it.
  Activation.prototype.unknownValue = function (action) {
    this.report('avm1:unknownValue', action.name + ' uses a value that is not known; it was not done.');
    return false;
  };
  // A condition that is not known ends the script: the player never guesses a branch.
  Activation.prototype.unknownCondition = function (action) {
    this.report('avm1:unknownCondition', action.name + ' tests a value that is not known; the rest of this script was not run.');
    return false;
  };
  // The frame number WaitForFrame2 pops: an integer number, or a string holding one; anything else is 0.
  function waitFrame(value, version) {
    var n = value;
    if (typeof n !== 'number' || n !== Math.floor(n)) {
      var s = toAvmString(value, version);
      n = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) ? Number(s) : 0;
      if (n !== Math.floor(n)) n = 0;
    }
    n = n | 0;
    return n === -2147483648 ? 2147483647 : n; // Flash Player's frame - 1 + 1 wraps, then saturates
  }
  // A skipped action keeps the stack in step: what it would push is unknown. False when the stack is full.
  Activation.prototype.skip = function (action) {
    var effect = ACTIONS[action.code] ? STACK_EFFECTS[action.code] : [0, 0], i;
    if (!effect) {
      this.stack.length = 0;
      this.stackUnknown = true;
      return true;
    }
    for (i = 0; i < effect[0]; i++) this.pop();
    for (i = 0; i < effect[1]; i++) if (!this.push(UNKNOWN_VALUE)) return false;
    return true;
  };
  Activation.prototype.report = function (feature, reason, detail) {
    this.scheduler.report(feature, reason, detail === undefined ? this.source : this.source + ': ' + detail);
  };
  // Runs the whole piece of bytecode, with this movie's runtime as the one objects convert through.
  Activation.prototype.run = function () {
    var previous = M.currentRuntime;
    M.currentRuntime = this.rt;
    try {
      this.loop();
    } finally {
      M.currentRuntime = previous;
    }
  };
  /* Runs from `pc` while it stays in [start, end). Each record is decoded only when it is reached, after its
     step is charged, so a large block costs no more than the actions that run. Returns false when the script
     ends (ActionEndFlag, Return, a limit, a malformed record), true when `pc` left the range. */
  Activation.prototype.loop = function () {
    var scheduler = this.scheduler, code = this.code, maxSteps = scheduler.limits.maxActionSteps;
    while (this.pc >= this.start && this.pc < this.end) {
      if (code.bytes[this.pc] === 0) return false;
      if (++scheduler.steps > maxSteps) {
        this.report('avm1:budget', 'More than ' + maxSteps + ' actions in one tick or event; the rest were not run.');
        return false;
      }
      var action = this.fetch();
      if (!action) return false;
      if (action.error && action.error.code === 'TRUNCATED_RECORD') {
        this.report('avm1:malformedAction', 'An action record runs past the end of its block; the rest is ignored.');
        return false;
      }
      this.pc = action.end;
      if (!this.step(action)) return false;
    }
    return true;
  };
  /* Runs the records in [start, end) (a with, try, catch or finally body) with this activation's state.
     Returns false when the script ended inside; otherwise `pc` is where the body left it: `end`, or the
     target of a jump out of the body. */
  Activation.prototype.runRange = function (start, end) {
    var outerStart = this.start, outerEnd = this.end;
    this.start = start;
    this.end = end;
    this.pc = start;
    try {
      return this.loop();
    } finally {
      this.start = outerStart;
      this.end = outerEnd;
    }
  };
  // The record at `pc`, or null (reported) when the movie has used up its decoding budget.
  Activation.prototype.fetch = function () {
    try {
      return this.code.at(this.pc);
    } catch (err) {
      if (err.code !== 'DECODE_BUDGET') throw err;
      this.report('avm1:budget', 'The movie decoded ' + this.code.budget.max + ' bytes of actions, its limit; this script was stopped.');
      return null;
    }
  };
  // Pushes a value; false when the stack already holds limits.maxActionStack values.
  Activation.prototype.push = function (value) {
    if (this.stack.length >= this.scheduler.limits.maxActionStack) return false;
    this.stack.push(value);
    return true;
  };
  // The stack is full: it is released and the script ends.
  Activation.prototype.stackFull = function () {
    this.stack.length = 0;
    this.report('avm1:budget', 'The stack reached ' + this.scheduler.limits.maxActionStack + ' values; the rest of this script was not run.');
    return false;
  };
  // An action the interpreter needs has malformed operands: the script ends.
  Activation.prototype.malformed = function () {
    this.report('avm1:malformedAction', 'An action has malformed data; the rest of this script was not run.');
    return false;
  };

  // ---- Functions, calls and construction -----------------------------------------------------------------

  // A function defined by DefineFunction (args.params: names) or DefineFunction2 (args.params: { register, name }).
  Activation.prototype.defineFunction = function (action) {
    var rt = this.rt, args = action.args, isFunction2 = action.code === 0x8e;
    var fn = new AvmFunction(rt.protos.Function, null, {
      code: this.code, start: args.bodyStart, end: args.bodyEnd, name: args.name, isFunction2: isFunction2,
      params: isFunction2 ? args.params : args.params.map(function (name) { return { register: 0, name: name }; }),
      registerCount: isFunction2 ? args.registerCount : 0, flags: isFunction2 ? args.flags : {},
      scopes: this.scopes.slice(), constants: this.constants, baseClip: this.clip
    });
    var proto = new AvmObject(rt.protos.Object);
    setOwn(proto, 'constructor', fn, this.version, true);
    setOwn(fn, 'prototype', proto, this.version, true);
    return fn;
  };
  /* `super` for a call on `thisValue`: its members come from the prototype above this object's own prototype,
     and calling it runs the superclass constructor (__constructor__, set by Extends). */
  function makeSuper(rt, thisValue) {
    if (!isObject(thisValue) || !thisValue.proto) return undefined;
    var zuper = new AvmObject(thisValue.proto.proto);
    zuper.superThis = thisValue;
    zuper.superConstructor = getMember(rt, thisValue.proto, '__constructor__');
    return zuper;
  }
  // Calls `fn` (a function, or `super`); anything else gives undefined. `caller` is the calling activation.
  function callValue(scheduler, fn, thisValue, args, caller) {
    if (isObject(fn) && fn.superThis) return callValue(scheduler, fn.superConstructor, fn.superThis, args, caller);
    if (!isFunction(fn)) return undefined;
    var rt = runtimeOf(scheduler);
    if (rt.callDepth >= scheduler.limits.maxCallDepth) {
      throw new AbortError('More than ' + scheduler.limits.maxCallDepth + ' nested function calls; the script was stopped.');
    }
    rt.callDepth++;
    try {
      return fn.native ? fn.native(rt, thisValue, args, fn) : callBytecode(scheduler, fn, thisValue, args, caller);
    } finally {
      rt.callDepth--;
    }
  }
  /* Runs a bytecode function. From SWF 6 it closes over the scope chain and base clip where it was defined; in
     SWF 5 it runs with the base clip of `this` (or the caller's target) and a fresh scope chain. Locals hold
     the parameters without a register, `arguments` and `super`; DefineFunction2 preloads this, arguments,
     super, _root, _parent and _global into its registers from register 1, as its flags ask. */
  function callBytecode(scheduler, fn, thisValue, args, caller) {
    var rt = scheduler.runtime, def = fn.def, version = def.code.version, flags = def.flags;
    var fallback = caller ? caller.targetOrRoot() : def.baseClip;
    var base = version >= 6 && def.baseClip && !def.baseClip.removed ? def.baseClip : isClip(thisValue) ? thisValue : fallback;
    var scopes = version >= 6 ? def.scopes.slice() : [{ kind: 'global', obj: rt.global }, { kind: 'target', obj: base }];
    var locals = new AvmObject(null);
    scopes.push({ kind: 'local', obj: locals });
    var registers = def.isFunction2 ? new Array(def.registerCount) : null;
    var inheritThis = flags.preloadThis || flags.suppressThis;
    var act = new Activation(scheduler, base, def.code, 'function ' + (def.name || '(anonymous)'), {
      start: def.start, end: def.end, scopes: scopes, registers: registers, constants: def.constants, callee: fn,
      thisValue: inheritThis && caller ? caller.thisValue : thisValue
    });
    var r = 1, put = function (value) { if (registers && r < registers.length) registers[r] = value; r++; };
    if (flags.preloadThis) put(flags.suppressThis ? undefined : thisValue);
    if (!flags.suppressArguments || flags.preloadArguments) {
      var list = rt.array(args.slice());
      setOwn(list, 'callee', fn, version, true);
      setOwn(list, 'caller', caller && caller.callee ? caller.callee : null, version, true);
      if (flags.preloadArguments) put(list); else setOwn(locals, 'arguments', list, version);
    }
    var zuper = flags.suppressSuper ? undefined : makeSuper(rt, thisValue);
    if (flags.preloadSuper) put(zuper); else if (zuper) setOwn(locals, 'super', zuper, version);
    if (flags.preloadRoot) put(base ? base.root() : undefined);
    if (flags.preloadParent && base && base.parent) put(base.parent);
    if (flags.preloadGlobal) put(rt.global);
    def.params.forEach(function (param, i) {
      var value = i < args.length ? args[i] : undefined;
      if (param.register && registers) { if (param.register < registers.length) registers[param.register] = value; }
      else setOwn(locals, param.name, value, version);
    });
    act.run();
    return act.returnValue;
  }
  /* new fn(args): a native class builds its own object; otherwise a new object with fn.prototype is passed as
     `this` (with a hidden __constructor__), and returned unless the function returns an object. */
  function construct(scheduler, fn, args, caller) {
    if (!isFunction(fn)) return undefined;
    var rt = runtimeOf(scheduler);
    if (fn.nativeConstruct) return fn.nativeConstruct(rt, args);
    var proto = getMember(rt, fn, 'prototype');
    var obj = new AvmObject(isObject(proto) ? proto : rt.protos.Object);
    setOwn(obj, '__constructor__', fn, scheduler.version, true);
    var result = callValue(scheduler, fn, obj, args, caller);
    return isObject(result) || isClip(result) ? result : obj;
  }
  /* Call(frame): runs the frame scripts of a frame of the target (or another timeline, "path:frame") now,
     without going there. */
  Activation.prototype.callFrame = function (value) {
    var clip = this.targetOrRoot(), n;
    if (!clip) return;
    if (typeof value === 'number') {
      n = value >>> 0;
    } else {
      var s = toAvmString(value, this.version), at = Math.max(s.lastIndexOf(':'), s.lastIndexOf('.'));
      if (at >= 0) {
        clip = resolvePath(clip, s.slice(0, at), this.version, this);
        s = s.slice(at + 1);
        if (!isClip(clip)) return;
      }
      n = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) ? Number(s) >>> 0 : clip.findLabel(s);
    }
    if (n < 1 || n > clip.frameCount()) return;
    var scheduler = this.scheduler, rt = this.rt;
    if (rt.callDepth >= scheduler.limits.maxCallDepth) throw new AbortError('More than ' + scheduler.limits.maxCallDepth + ' nested calls; the script was stopped.');
    rt.callDepth++;
    try {
      clip.def.frames[n - 1].forEach(function (tag) {
        if (tag.code === 12) new Activation(scheduler, clip, scheduler.codeOf(tag, clip), 'Call of frame ' + n).run();
      });
    } finally {
      rt.callDepth--;
    }
  };

  // ---- Executing one action ----------------------------------------------------------------------------------

  // Executes one action; false ends the script.
  Activation.prototype.step = function (action) {
    var target = this.target, args = action.args, version = this.version, rt = this.rt, n, a, b, c, i;
    switch (action.code) {
      // Stack, registers, constants
      case 0x96:
        if (action.error) return this.malformed();
        for (n = 0; n < args.values.length; n++) if (!this.push(this.pushValue(args.values[n]))) return this.stackFull();
        return true;
      case 0x17: this.pop(); return true;
      case 0x4c: a = this.pop(); return (this.push(a) && this.push(a)) || this.stackFull();
      case 0x4d: a = this.pop(); b = this.pop(); return (this.push(a) && this.push(b)) || this.stackFull();
      case 0x87:
        if (action.error) return this.malformed();
        this.setRegister(args.register, this.peek());
        return true;
      case 0x88:
        if (action.error) return this.malformed();
        this.constants = args.pool;
        return true;

      // Variables
      case 0x1c: // GetVariable
        n = this.popName(action);
        a = n === null ? UNKNOWN_VALUE : getVariable(this, n);
        if (a === UNKNOWN_VALUE && n !== null) {
          this.report('avm1:objectValue', 'This built-in object is not implemented yet; reading it gives an unknown value.', n);
        }
        return this.push(a) || this.stackFull();
      case 0x1d: // SetVariable
        a = this.pop();
        n = this.popName(action);
        if (n !== null) this.setVariable(n, a);
        return true;
      case 0x3c: // DefineLocal
        a = this.pop();
        n = this.popName(action);
        if (n !== null && !defineLocal(this, n, a, false)) this.report('avm1:variableNotSet', 'DefineLocal could not set this name.', n);
        return true;
      case 0x41: // DefineLocal2: creates the local as undefined when it does not exist
        n = this.popName(action);
        if (n !== null) defineLocal(this, n, undefined, true);
        return true;
      case 0x3b: // Delete2
        n = this.popName(action);
        return this.push(n === null ? UNKNOWN_VALUE : deleteVariable(this, n)) || this.stackFull();
      case 0x26: this.pop(); return true; // Trace: there is no output panel, as in a release Flash Player

      // Control flow
      case 0x99: // Jump
        if (action.error) return this.malformed();
        this.pc = args.target;
        return true;
      case 0x9d: // If
        if (action.error) return this.malformed();
        a = this.pop();
        if (a === UNKNOWN_VALUE) return this.unknownCondition(action);
        if (toBoolean(a, version)) this.pc = args.target;
        return true;
      case 0x3e: // Return: ends the function (or, outside one, the block) with the popped value
        this.returnValue = this.pop();
        return false;
      case 0x8a: // WaitForFrame
        if (action.error) return this.malformed();
        return args.frame <= MAX_LOADED_FRAME || !target || this.skipActions(args.skipCount);
      case 0x8d: // WaitForFrame2
        if (action.error) return this.malformed();
        a = this.pop();
        if (a === UNKNOWN_VALUE) return this.unknownCondition(action);
        return waitFrame(a, version) <= MAX_LOADED_FRAME_2 || !target || this.skipActions(args.skipCount);

      // Timelines
      case 0x04: if (target) { target.gotoFrame(target.frame + 1); target.playing = false; } return true;
      case 0x05: if (target) { target.gotoFrame(target.frame - 1); target.playing = false; } return true;
      case 0x06: if (target) target.playing = true; return true;
      case 0x07: if (target) target.playing = false; return true;
      case 0x08: return true; // ToggleQuality: the renderer has one quality
      case 0x09: M.audioOf(this.scheduler).stopAll(); return true; // StopSounds (stopAllSounds)
      case 0x81: // GotoFrame: go and stop, as Flash Player does
        if (!target) return true;
        if (action.error) return this.malformed();
        target.gotoFrame(args.frame + 1);
        target.playing = false;
        return true;
      case 0x8c: // GotoLabel: go and stop
        if (!target) return true;
        if (action.error) return this.malformed();
        n = target.findLabel(args.label);
        if (n) { target.gotoFrame(n); target.playing = false; }
        else this.report('avm1:labelNotFound', 'GotoLabel names a frame label that does not exist; ignored.');
        return true;
      case 0x9f: // GotoFrame2
        if (action.error) return this.malformed();
        a = this.pop();
        if (a === UNKNOWN_VALUE) return this.unknownValue(action);
        if (this.targetOrRoot()) gotoFrameValue(this.targetOrRoot(), a, args.play, args.sceneBias, version);
        return true;
      case 0x8b: // SetTarget
        if (action.error) return this.malformed();
        this.setTarget(args.path === '' ? this.clip : this.clip && resolveTarget(this.clip, args.path));
        if (!this.target) this.report('avm1:targetNotFound', 'SetTarget names a sprite instance that does not exist; actions are ignored until the next SetTarget.', args.path);
        return true;
      case 0x20: // SetTarget2: a clip or a path; undefined returns to the base clip up to SWF 6
        a = this.pop();
        if (a === UNKNOWN_VALUE) return this.unknownValue(action);
        if (a === undefined) {
          this.setTarget(version > 6 ? null : this.clip);
        } else {
          b = isClip(a) ? a : toAvmString(a, version);
          this.setTarget(isClip(b) ? (b.removed ? null : b) : b === '' ? this.clip : this.clip && resolveTarget(this.clip, b));
          if (!this.target) this.report('avm1:targetNotFound', 'SetTarget2 names a sprite instance that does not exist; actions are ignored until the next SetTarget.', String(isClip(b) ? clipPath(b) : b));
        }
        return true;
      case 0x9e: // Call: runs the scripts of another frame now
        a = this.pop();
        if (a === UNKNOWN_VALUE) return this.unknownValue(action);
        this.callFrame(a);
        return true;
      case 0x22: // GetProperty
        n = this.pop();
        a = this.pop();
        if (n === UNKNOWN_VALUE) return this.push(UNKNOWN_VALUE) || this.stackFull();
        b = this.propertyClip(a);
        n = num(n, version);
        n = isFinite(n) && n > -1 ? Math.trunc(n) : -1;
        a = b === UNKNOWN_VALUE ? UNKNOWN_VALUE : b && n >= 0 && n < 22 ? getProperty(b, n, version) : undefined;
        return this.push(a) || this.stackFull();
      case 0x23: // SetProperty
        a = this.pop();
        n = this.pop();
        b = this.propertyClip(this.pop());
        if (a === UNKNOWN_VALUE || n === UNKNOWN_VALUE || b === UNKNOWN_VALUE) { this.unknownValue(action); return true; }
        n = num(n, version);
        if (b && isFinite(n) && n > -1 && n < 22) setProperty(b, Math.trunc(n), a, version);
        return true;
      case 0x24: // CloneSprite (duplicateMovieClip)
        n = this.pop();
        a = this.pop();
        b = this.clipOf(this.pop(), this.targetOrRoot(), true);
        if (n === UNKNOWN_VALUE || a === UNKNOWN_VALUE || b === UNKNOWN_VALUE) { this.unknownValue(action); return true; }
        n = toInt32(n, version);
        if (b && b.parent && n >= 0 && n <= MAX_SCRIPT_DEPTH) b.parent.cloneChild(b.displayObject(), toAvmString(a, version), n);
        return true;
      case 0x25: // RemoveSprite (removeMovieClip): only clips created by scripts
        b = this.clipOf(this.pop(), this.targetOrRoot(), true);
        if (b === UNKNOWN_VALUE) { this.unknownValue(action); return true; }
        if (b && b.parent && b.parent.removeChild(b.displayObject()) && this.target && this.target.removed) this.setTarget(this.clip);
        return true;
      case 0x34: // GetTime: milliseconds since the movie started
        return this.push(this.scheduler.clock ? Math.floor(this.scheduler.clock()) : 0) || this.stackFull();
      case 0x27: // StartDrag: target, lockCenter, constrain, then (with constrain) bottom, right, top, left
        b = this.clipOf(this.pop(), this.targetOrRoot(), true);
        n = toInt32(this.pop(), version) === 1;
        c = null;
        if (toInt32(this.pop(), version) === 1) {
          a = [num(this.pop(), version), num(this.pop(), version), num(this.pop(), version), num(this.pop(), version)];
          c = [a[3], a[2], a[1], a[0]];
        }
        if (b === UNKNOWN_VALUE) { this.unknownValue(action); return true; }
        if (b) startDrag(b, n, c);
        return true;
      case 0x28: // EndDrag
        if (this.clip) stopDrag(this.clip.env);
        return true;
      case 0x83: // GetURL: a "_levelN" target loads a movie there (loadMovieNum); anything else goes to the page.
        if (action.error) return this.malformed();
        if (M.levelOf(args.target) >= 0) return this.loadLevel(args.url, args.target, 'movie', 0);
        return this.openURL(args.url, args.target, 0);
      case 0x9a: // GetURL2: the target is above the URL. A clip target (or a level) loads into it.
        if (action.error) return this.malformed();
        b = this.pop();
        a = this.pop();
        if (a === UNKNOWN_VALUE || b === UNKNOWN_VALUE) return this.unknownValue(action);
        a = toAvmString(a, version);
        // An FSCommand (fscommand(command, args)) carries its arguments in the target.
        if (M.fsCommandOf(a) !== null) return this.openURL(a, toAvmString(b, version), 0);
        c = args.loadVariables ? 'variables' : 'movie';
        n = args.sendVarsMethod;
        if (args.loadTarget) {
          b = this.clipOf(b, this.target || this.clip, true);
          if (b === UNKNOWN_VALUE) return this.unknownValue(action);
          M.loadInto(b, a, c, n, this.report.bind(this), this.formVariables(n));
          return true;
        }
        // loadVariables(url, _root) without the clip flag loads into the root; any other clip value opens a window.
        if (args.loadVariables && isClip(b) && b === this.root) {
          M.loadInto(b, a, c, n, this.report.bind(this), this.formVariables(n));
          return true;
        }
        b = toAvmString(b, version);
        if (M.levelOf(b) >= 0) return this.loadLevel(a, b, c, n);
        return this.openURL(a, b, n);

      // Functions and calls
      case 0x9b: case 0x8e: // DefineFunction, DefineFunction2
        if (action.error) return this.malformed();
        a = this.defineFunction(action);
        this.pc = args.bodyEnd;
        if (args.name !== '') { defineLocal(this, args.name, a, false); return true; }
        return this.push(a) || this.stackFull();
      case 0x3d: // CallFunction
        n = this.popName(action);
        c = this.popArgs(toInt32(this.pop(), version) >>> 0);
        if (n === null) return this.push(UNKNOWN_VALUE) || this.stackFull();
        b = lookupVariable(this, n);
        if (b.value === UNKNOWN_VALUE) return this.push(UNKNOWN_VALUE) || this.stackFull();
        a = callValue(this.scheduler, b.value, b.owner || this.targetOrRoot(), c, this);
        return this.push(a) || this.stackFull();
      case 0x52: // CallMethod
        n = this.pop();
        b = this.pop();
        c = this.popArgs(toInt32(this.pop(), version) >>> 0);
        if (b === UNKNOWN_VALUE || n === UNKNOWN_VALUE) return this.push(UNKNOWN_VALUE) || this.stackFull();
        if (b === undefined || b === null) return this.push(undefined) || this.stackFull();
        n = n === undefined ? '' : toAvmString(n, version);
        if (n === '') a = callValue(this.scheduler, b, undefined, c, this);
        else {
          a = getMember(rt, b, n);
          a = a === UNKNOWN_VALUE ? UNKNOWN_VALUE : callValue(this.scheduler, a, isObject(b) && b.superThis ? b.superThis : b, c, this);
        }
        return this.push(a) || this.stackFull();
      case 0x40: // NewObject
        n = this.popName(action);
        c = this.popArgs(toInt32(this.pop(), version) >>> 0);
        a = n === null ? UNKNOWN_VALUE : getVariable(this, n);
        return this.push(a === UNKNOWN_VALUE ? UNKNOWN_VALUE : construct(this.scheduler, a, c, this)) || this.stackFull();
      case 0x53: // NewMethod
        n = this.pop();
        b = this.pop();
        c = this.popArgs(toInt32(this.pop(), version) >>> 0);
        if (b === UNKNOWN_VALUE || n === UNKNOWN_VALUE) return this.push(UNKNOWN_VALUE) || this.stackFull();
        if (b === undefined || b === null) return this.push(undefined) || this.stackFull();
        n = n === undefined ? '' : toAvmString(n, version);
        a = n === '' ? b : getMember(rt, b, n);
        return this.push(a === UNKNOWN_VALUE ? UNKNOWN_VALUE : construct(this.scheduler, a, c, this)) || this.stackFull();

      // Objects
      case 0x4e: // GetMember
        n = this.pop();
        b = this.pop();
        a = b === UNKNOWN_VALUE || n === UNKNOWN_VALUE ? UNKNOWN_VALUE : getMember(rt, b, toAvmString(n, version));
        return this.push(a) || this.stackFull();
      case 0x4f: // SetMember
        a = this.pop();
        n = this.pop();
        b = this.pop();
        if (b === UNKNOWN_VALUE || n === UNKNOWN_VALUE) { this.unknownValue(action); return true; }
        setMember(rt, b, toAvmString(n, version), a);
        return true;
      case 0x3a: // Delete
        n = this.pop();
        b = this.pop();
        a = b === UNKNOWN_VALUE || n === UNKNOWN_VALUE ? UNKNOWN_VALUE : deleteMember(rt, b, toAvmString(n, version));
        return this.push(a) || this.stackFull();
      case 0x42: // InitArray
        n = num(this.pop(), version);
        if (!(n >= 0 && n <= 2147483647)) return this.push(undefined) || this.stackFull();
        n = Math.floor(n);
        if (n > this.stack.length && this.stackUnknown) { this.stack.length = 0; return this.push(UNKNOWN_VALUE) || this.stackFull(); }
        a = rt.array(this.popArgs(Math.min(n, this.stack.length)));
        a.items.length = Math.min(n, MAX_ARRAY_INDEX);
        return this.push(a) || this.stackFull();
      case 0x43: // InitObject
        n = num(this.pop(), version);
        if (!(n >= 0 && n <= 2147483647)) return this.push(undefined) || this.stackFull();
        a = new AvmObject(rt.protos.Object);
        n = Math.min(Math.floor(n), Math.ceil(this.stack.length / 2) + 1);
        for (i = 0; i < n; i++) {
          c = this.pop();
          b = this.pop();
          if (b !== UNKNOWN_VALUE) setMember(rt, a, toAvmString(b, version), c);
        }
        return this.push(a) || this.stackFull();
      case 0x46: case 0x55: // Enumerate, Enumerate2: undefined, then the names, the first to come out on top
        if (action.code === 0x46) {
          n = this.popName(action);
          b = n === null ? UNKNOWN_VALUE : getVariable(this, n);
        } else {
          b = this.pop();
        }
        if (b === UNKNOWN_VALUE) return this.unknownValue(action);
        if (!this.push(undefined)) return this.stackFull();
        c = isObject(b) || isClip(b) ? keysOf(rt, b) : [];
        for (i = c.length - 1; i >= 0; i--) if (!this.push(c[i])) return this.stackFull();
        return true;
      case 0x69: // Extends
        a = this.pop();
        b = this.pop();
        if (!isObject(a) || !isObject(b)) return true;
        c = getMember(rt, a, 'prototype');
        n = new AvmObject(isObject(c) ? c : null);
        setOwn(n, 'constructor', a, version, true);
        setOwn(n, '__constructor__', a, version, true);
        setMember(rt, b, 'prototype', n);
        return true;
      case 0x2c: // ImplementsOp: interfaces are accepted and not checked
        this.pop();
        n = toInt32(this.pop(), version);
        this.popArgs(Math.min(Math.max(0, n), this.stack.length));
        return true;
      case 0x94: // With: the body runs with the object on top of the scope chain; undefined or null skip it
        if (action.error) return this.malformed();
        a = this.pop();
        if (a === UNKNOWN_VALUE) return this.unknownValue(action);
        if (a === undefined || a === null) { this.pc = args.bodyEnd; return true; }
        b = this.scopes;
        this.scopes = b.concat([{ kind: 'with', obj: a }]);
        try {
          if (!this.runRange(args.bodyStart, args.bodyEnd)) return false;
        } finally {
          this.scopes = b;
        }
        return true;
      case 0x8f: // Try
        if (action.error) return this.malformed();
        return this.runTry(args);
      case 0x2a: // Throw
        throw new AvmThrow(this.pop());

      default:
        if (OPERATORS[action.code]) return this.operate(OPERATORS[action.code]);
        this.report('avm1:' + action.name, 'Not interpreted yet; skipped.');
        return this.skip(action) || this.stackFull();
    }
  };
  /* try/catch/finally. A Throw in the try body truncates the stack to its size before the try, binds the value
     to the catch variable or register and runs the catch body. The finally body runs in every case; a value
     still thrown then goes on up. Afterwards the script continues after the whole statement, unless a body
     jumped out of it. False when the script ended. */
  Activation.prototype.runTry = function (args) {
    var stackSize = this.stack.length, thrown = null, ok = true;
    try {
      ok = this.runRange(args.tryStart, args.tryEnd);
    } catch (err) {
      if (!(err instanceof AvmThrow)) throw err;
      thrown = err;
    }
    if (thrown && args.hasCatch) {
      this.stack.length = Math.min(this.stack.length, stackSize);
      if (args.catchInRegister) this.setRegister(args.catchRegister, thrown.value);
      else this.setVariable(args.catchName, thrown.value);
      thrown = null;
      try {
        ok = this.runRange(args.tryEnd, args.catchEnd);
      } catch (err) {
        if (!(err instanceof AvmThrow)) throw err;
        thrown = err;
      }
    }
    var pc = this.pc;
    if (args.hasFinally && args.finallyEnd > args.catchEnd) {
      var returned = this.returnValue;
      if (!this.runRange(args.catchEnd, args.finallyEnd)) return false;
      this.returnValue = returned;
    }
    if (thrown) throw thrown;
    if (!ok) return false;
    this.pc = pc >= args.tryStart && pc <= args.finallyEnd ? args.finallyEnd : pc;
    return true;
  };

  Object.assign(M, {
    ActionScheduler: ActionScheduler, Activation: Activation, executeAVM1: executeAVM1, STACK_EFFECTS: STACK_EFFECTS,
    OPERATORS: OPERATORS, runtimeOf: runtimeOf, callValue: callValue, construct: construct, AvmThrow: AvmThrow
  });
})(typeof window !== 'undefined' ? window : globalThis);
