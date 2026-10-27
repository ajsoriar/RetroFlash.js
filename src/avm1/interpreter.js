/* RetroFlash.js - AVM1 timeline-control subset: frame scripts and button actions. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;
  var ActionCode = M.ActionCode;

  /* A controlled interpreter for frame scripts. It never evaluates JavaScript, never navigates and never touches
     the page. It runs the actions that only steer timelines (Flash 3/4 style) and reports everything else:
     plain actions without timeline effect are skipped; control flow and calls end the script, because their
     outcome cannot be known without the full VM (phase 5). */

  // Actions whose effect on what runs next is unknown without the full VM: the script stops there.
  var STOP_ACTIONS = { 0x20: 1, 0x2a: 1, 0x3d: 1, 0x3e: 1, 0x52: 1, 0x8d: 1, 0x8f: 1, 0x94: 1, 0x99: 1, 0x9d: 1, 0x9e: 1, 0x9f: 1 };

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
  // The decoded code of a block, decoded once per movie.
  ActionScheduler.prototype.codeOf = function (block) {
    var code = this.cache.get(block);
    if (!code) {
      code = new ActionCode(block.bytes || this.swf.getTagData(block), this.version);
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

  // Runs one action block in the context of `clip` (the timeline that holds a frame script, or a button's parent).
  function executeAVM1(scheduler, clip, block) {
    new Activation(scheduler, clip, scheduler.codeOf(block), (block.label || 'DoAction') + ' at offset ' + block.offset).run();
  }

  /* The state of one running action block: the decoded code, the program counter, the clip the block belongs
     to and the timeline that actions address (`target`, changed by SetTarget). The full VM will add the
     stack, registers, constant pool and scope chain here. */
  function Activation(scheduler, clip, code, source) {
    this.scheduler = scheduler;
    this.clip = clip;
    this.target = clip;
    this.code = code;
    this.pc = 0;
    this.source = source;
  }
  Activation.prototype.report = function (feature, reason, detail) {
    this.scheduler.report(feature, reason, detail === undefined ? this.source : this.source + ': ' + detail);
  };
  // Runs from `pc` until ActionEndFlag, the end of the block, or an action that ends the script.
  Activation.prototype.run = function () {
    var scheduler = this.scheduler, code = this.code, maxSteps = scheduler.limits.maxActionSteps;
    if (code.list().truncated) this.report('avm1:malformedAction', 'An action record runs past the end of its DoAction; the rest is ignored.');
    while (this.pc < code.length) {
      var action = code.at(this.pc);
      if (action.code === 0 || (action.error && action.error.code === 'TRUNCATED_RECORD')) return;
      if (++scheduler.steps > maxSteps) return this.report('avm1:budget', 'More than ' + maxSteps + ' actions in one tick or event; the rest were not run.');
      this.pc = action.end;
      if (!this.step(action)) return;
    }
  };
  // An action the subset needs to execute has malformed operands: the script ends.
  Activation.prototype.malformed = function () {
    this.report('avm1:malformedAction', 'An action has malformed data; the rest of this script was not run.');
    return false;
  };
  // Executes one action; false ends the script.
  Activation.prototype.step = function (action) {
    var target = this.target, args = action.args, n;
    switch (action.code) {
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
        return true;
      default:
        if (STOP_ACTIONS[action.code]) {
          this.report('avm1:' + action.name, 'Control flow and calls are not interpreted yet; the rest of this script was not run.');
          return false;
        }
        this.report('avm1:' + action.name, 'Not interpreted yet (no timeline effect in this subset); skipped.');
        return true;
    }
  };

  Object.assign(M, { resolveTarget: resolveTarget, ActionScheduler: ActionScheduler, Activation: Activation, executeAVM1: executeAVM1 });
})(typeof window !== 'undefined' ? window : globalThis);
