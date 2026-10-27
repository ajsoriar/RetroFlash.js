/* RetroFlash.js - AVM1 timeline-control subset: frame scripts and button actions. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;
  var ActionCode = M.ActionCode, ACTIONS = M.ACTIONS;

  /* A controlled interpreter for frame scripts. It never evaluates JavaScript, never navigates and never touches
     the page. It runs the actions that steer timelines (Flash 3/4 style) and the stack core (Push, Pop,
     PushDuplicate, StackSwap, StoreRegister, ConstantPool), and reports everything else: other actions are
     skipped; control flow and calls end the script, because their outcome cannot be known without the full VM. */

  // Actions whose effect on what runs next is unknown without the full VM: the script stops there.
  var STOP_ACTIONS = { 0x20: 1, 0x2a: 1, 0x3d: 1, 0x3e: 1, 0x52: 1, 0x8d: 1, 0x8f: 1, 0x94: 1, 0x99: 1, 0x9d: 1, 0x9e: 1, 0x9f: 1 };

  /* Bytes of actions that one movie may decode (ActionCode budget, which also charges each cached block). The
     decoded records stay cached for the life of the movie. Filling this budget grew the heap by 40 to 58 MB in
     Chrome and by up to about 120 MB in Node, where one-byte actions cost the most. It bounds this cache only,
     not the player's total memory. */
  var MAX_DECODED_ACTION_BYTES = 1024 * 1024;

  /* Values on the stack and in registers are JavaScript primitives: undefined, null, booleans, numbers and
     strings. UNKNOWN_VALUE stands for a value that an action left without being interpreted (the result of a
     skipped GetVariable, for example), so that no later action takes it for a real value. */
  var UNKNOWN_VALUE = Object.freeze({ unknown: true });

  /* Stack effect [pops, pushes] of the skipped actions that pop and push a fixed number of values (SWF19).
     A skipped action that is not listed leaves the whole stack unknown: its counts depend on the values
     (StartDrag, NewObject, NewMethod, InitArray, InitObject, Enumerate, Enumerate2, ImplementsOp), or are not
     settled here (Delete, Delete2). Unknown action codes have no effect, as Flash Player ignores them. */
  var STACK_EFFECTS = {};
  [
    [0, 0, [0x28]],
    [0, 1, [0x34]],
    [1, 0, [0x25, 0x26, 0x41]],
    [1, 1, [0x12, 0x14, 0x18, 0x1c, 0x30, 0x31, 0x32, 0x33, 0x36, 0x37, 0x44, 0x45, 0x4a, 0x4b, 0x50, 0x51]],
    [2, 0, [0x1d, 0x3c, 0x69, 0x9a]],
    [2, 1, [0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x13, 0x21, 0x22, 0x29, 0x2b, 0x3f, 0x47, 0x48, 0x49, 0x4e,
      0x54, 0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68]],
    [3, 0, [0x23, 0x24, 0x4f]],
    [3, 1, [0x15, 0x35]]
  ].forEach(function (group) {
    group[2].forEach(function (code) { STACK_EFFECTS[code] = [group[0], group[1]]; });
  });

  /* Target paths for SetTarget: slash syntax ("/a/b", "../a", "a/b") or dot syntax ("_root.a", "_parent.b", "this").
     Returns the sprite instance's Clip or null. */
  function resolveTarget(clip, path) {
    var current = clip, root = clip.root();
    if (path.charAt(0) === '/') { current = root; path = path.slice(1); }
    var slashSyntax = path.indexOf('/') >= 0 || path.slice(0, 2) === '..';
    var parts = slashSyntax ? path.split('/') : path.split('.');
    for (var i = 0; i < parts.length && current; i++) {
      var part = parts[i], lower = part.toLowerCase();
      if (!part || lower === 'this') continue;
      if (part === '..' || lower === '_parent') current = current.parent;
      else if (lower === '_root' || lower === '_level0') current = root;
      else current = current.childByName(part);
    }
    return current || null;
  }
  /* Runs the AVM1 action blocks of one movie in the order they were queued: the frame scripts of the frames
     entered during a tick, then the actions of a button event. One update (a tick or an input event, opened
     by beginUpdate) may call run() more than once; all of them share one budget of limits.maxActionBlocks
     blocks and limits.maxActionSteps actions. With `enabled` false (the actions option), nothing is queued.
     Timelines are driven through the Clip methods gotoFrame, findLabel, root, childByName and their `frame`,
     `playing` and `parent` fields; the scheduler does not depend on the display list otherwise. */
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
  // The decoded code of a block. Its records are decoded once per movie, within the `decoded` budget.
  ActionScheduler.prototype.codeOf = function (block) {
    var code = this.cache.get(block);
    if (!code) {
      code = new ActionCode(block.bytes || this.swf.getTagData(block), this.version, this.decoded);
      this.cache.set(block, code);
    }
    return code;
  };
  // Runs the queue, including blocks queued while running (gotos), within the budget of the current update.
  ActionScheduler.prototype.run = function () {
    var max = this.limits.maxActionBlocks;
    while (this.queue.length) {
      var item = this.queue.shift();
      for (var i = 0; i < item.blocks.length; i++) {
        if (++this.blocks > max) {
          this.queue.length = 0;
          return this.report('avm1:budget', 'More than ' + max + ' action blocks in one tick or event; the rest were dropped.', 'queue');
        }
        executeAVM1(this, item.clip, item.blocks[i]);
      }
    }
  };

  /* Runs one action block in the context of `clip` (the timeline that holds a frame script, or a button's parent).
     A block that decoded no record (an empty block, or one met after the decoding budget was spent) is not
     kept in the cache: the budget does not pay for it. */
  function executeAVM1(scheduler, clip, block) {
    var code = scheduler.codeOf(block);
    new Activation(scheduler, clip, code, (block.label || 'DoAction') + ' at offset ' + block.offset).run();
    if (!code.records.size) scheduler.cache.delete(block);
  }

  /* The state of one running action block: the decoded code, the program counter, the clip the block belongs
     to, the timeline that actions address (`target`, changed by SetTarget), and the block's own stack, four
     registers and constant pool, which start empty. The full VM will add the scope chain here. */
  function Activation(scheduler, clip, code, source) {
    this.scheduler = scheduler;
    this.clip = clip;
    this.target = clip;
    this.code = code;
    this.pc = 0;
    this.source = source;
    this.stack = [];
    this.stackUnknown = false; // below `stack` lie values that skipped actions left in unknown number
    this.registers = [undefined, undefined, undefined, undefined];
    this.constants = [];
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
  // The value of a Push operand. Missing registers and constants give undefined.
  Activation.prototype.pushValue = function (operand) {
    switch (operand.type) {
      case 'register': return operand.value < this.registers.length ? this.registers[operand.value] : undefined;
      case 'constant': return operand.value < this.constants.length ? this.constants[operand.value] : undefined;
      default: return operand.value;
    }
  };
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
  /* Runs from `pc` until ActionEndFlag, the end of the block, or an action that ends the script. Each record is
     decoded only when it is reached, after its step is charged, so a large block costs no more than the actions
     that run. */
  Activation.prototype.run = function () {
    var scheduler = this.scheduler, code = this.code, maxSteps = scheduler.limits.maxActionSteps;
    while (this.pc < code.length && code.bytes[this.pc] !== 0) {
      if (++scheduler.steps > maxSteps) {
        return this.report('avm1:budget', 'More than ' + maxSteps + ' actions in one tick or event; the rest were not run.');
      }
      var action = this.fetch();
      if (!action) return;
      if (action.error && action.error.code === 'TRUNCATED_RECORD') {
        return this.report('avm1:malformedAction', 'An action record runs past the end of its block; the rest is ignored.');
      }
      this.pc = action.end;
      if (!this.step(action)) return;
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
  // An action the subset needs to execute has malformed operands: the script ends.
  Activation.prototype.malformed = function () {
    this.report('avm1:malformedAction', 'An action has malformed data; the rest of this script was not run.');
    return false;
  };
  // Executes one action; false ends the script.
  Activation.prototype.step = function (action) {
    var target = this.target, args = action.args, n, a, b;
    switch (action.code) {
      case 0x96:
        if (action.error) return this.malformed();
        for (n = 0; n < args.values.length; n++) if (!this.push(this.pushValue(args.values[n]))) return this.stackFull();
        return true;
      case 0x17: this.pop(); return true;
      case 0x4c: a = this.pop(); return (this.push(a) && this.push(a)) || this.stackFull();
      case 0x4d: a = this.pop(); b = this.pop(); return (this.push(a) && this.push(b)) || this.stackFull();
      case 0x87:
        if (action.error) return this.malformed();
        if (args.register < this.registers.length) this.registers[args.register] = this.peek();
        return true;
      case 0x88:
        if (action.error) return this.malformed();
        this.constants = args.pool;
        return true;
      case 0x04: if (target) { target.gotoFrame(target.frame + 1); target.playing = false; } return true;
      case 0x05: if (target) { target.gotoFrame(target.frame - 1); target.playing = false; } return true;
      case 0x06: if (target) target.playing = true; return true;
      case 0x07: if (target) target.playing = false; return true;
      case 0x08: case 0x09: case 0x8a: return true; // ToggleQuality, StopSounds: no effect yet; WaitForFrame: every frame is loaded
      case 0x81:
        if (!target) return true;
        if (action.error) return this.malformed();
        target.gotoFrame(args.frame + 1);
        return true;
      case 0x8c:
        if (!target) return true;
        if (action.error) return this.malformed();
        n = target.findLabel(args.label);
        if (n) target.gotoFrame(n);
        else this.report('avm1:labelNotFound', 'GotoLabel names a frame label that does not exist; ignored.');
        return true;
      case 0x8b:
        if (action.error) return this.malformed();
        this.target = args.path === '' ? this.clip : resolveTarget(this.clip, args.path);
        if (!this.target) this.report('avm1:targetNotFound', 'SetTarget names a sprite instance that does not exist; actions are ignored until the next SetTarget.', args.path);
        return true;
      case 0x83:
        this.report('avm1:GetURL', 'GetURL is ignored: the player never navigates, opens windows or loads URLs.');
        return true;
      case 0x9b: case 0x8e:
        if (action.error) return this.malformed();
        this.pc = args.bodyEnd;
        this.report('avm1:' + action.name, 'Function definitions are skipped; functions cannot be called yet.');
        // A function literal leaves the function on the stack.
        return args.name !== '' || this.push(UNKNOWN_VALUE) || this.stackFull();
      default:
        if (STOP_ACTIONS[action.code]) {
          this.report('avm1:' + action.name, 'Control flow and calls are not interpreted yet; the rest of this script was not run.');
          return false;
        }
        this.report('avm1:' + action.name, 'Not interpreted yet (no timeline effect in this subset); skipped.');
        return this.skip(action) || this.stackFull();
    }
  };

  Object.assign(M, {
    resolveTarget: resolveTarget, ActionScheduler: ActionScheduler, Activation: Activation, executeAVM1: executeAVM1,
    UNKNOWN_VALUE: UNKNOWN_VALUE, STACK_EFFECTS: STACK_EFFECTS
  });
})(typeof window !== 'undefined' ? window : globalThis);
