/* RetroFlash.js - AVM1 timeline-control subset: frame scripts and button actions. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;
  var MAX_ACTION_BLOCKS = M.MAX_ACTION_BLOCKS, MAX_ACTION_STEPS = M.MAX_ACTION_STEPS, ACTION_NAMES = M.ACTION_NAMES,
    parseActions = M.parseActions, actionString = M.actionString, actionUI16 = M.actionUI16,
    functionCodeSize = M.functionCodeSize;

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
  // block: a DoAction tag, or a button action { bytes, offset, label }.
  function runActionBlock(env, clip, block) {
    var actions = env.actionCache.get(block), source = (block.label || 'DoAction') + ' at offset ' + block.offset;
    if (!actions) {
      actions = parseActions(block.bytes || env.swf.getTagData(block));
      env.actionCache.set(block, actions);
    }
    if (actions.truncated) env.report('avm1:malformedAction', 'An action record runs past the end of its DoAction; the rest is ignored.', source);
    var target = clip, skipUntil = -1, version = env.version;
    for (var i = 0; i < actions.length; i++) {
      var a = actions[i], n;
      if (a.offset < skipUntil) continue;
      if (++env.steps > MAX_ACTION_STEPS) return env.report('avm1:budget', 'More than ' + MAX_ACTION_STEPS + ' actions in one frame; the rest were not run.', source);
      try {
        switch (a.code) {
          case 0x04: if (target) { target.gotoFrame(target.frame + 1); target.playing = false; } break;
          case 0x05: if (target) { target.gotoFrame(target.frame - 1); target.playing = false; } break;
          case 0x06: if (target) target.playing = true; break;
          case 0x07: if (target) target.playing = false; break;
          case 0x08: case 0x09: case 0x8a: break; // ToggleQuality, StopSounds: no effect yet; WaitForFrame: every frame is loaded
          case 0x81: if (target) target.gotoFrame(actionUI16(a) + 1); break;
          case 0x8c:
            if (!target) break;
            n = target.findLabel(actionString(a, version));
            if (n) target.gotoFrame(n);
            else env.report('avm1:labelNotFound', 'GotoLabel names a frame label that does not exist; ignored.', source);
            break;
          case 0x8b:
            var path = actionString(a, version);
            target = path === '' ? clip : resolveTarget(clip, path);
            if (!target) env.report('avm1:targetNotFound', 'SetTarget names a sprite instance that does not exist; actions are ignored until the next SetTarget.', source + ': ' + path);
            break;
          case 0x83:
            env.report('avm1:GetURL', 'GetURL is ignored: the player never navigates, opens windows or loads URLs.', source);
            break;
          case 0x9b: case 0x8e:
            skipUntil = a.next + functionCodeSize(a, version);
            env.report('avm1:' + ACTION_NAMES[a.code], 'Function definitions are skipped; functions cannot be called yet.', source);
            break;
          default:
            var name = ACTION_NAMES[a.code] || 'Unknown_0x' + a.code.toString(16);
            if (STOP_ACTIONS[a.code]) {
              return env.report('avm1:' + name, 'Control flow and calls are not interpreted yet; the rest of this script was not run.', source);
            }
            env.report('avm1:' + name, 'Not interpreted yet (no timeline effect in this subset); skipped.', source);
        }
      } catch (err) {
        if (err.name !== 'SWFReaderError') throw err;
        return env.report('avm1:malformedAction', 'An action has malformed data; the rest of this script was not run.', source);
      }
    }
  }
  // Runs queued frame scripts, including the ones queued while running (gotos). Bounded per tick.
  function runActionQueue(env) {
    var blocks = 0;
    env.steps = 0;
    while (env.queue.length) {
      if (++blocks > MAX_ACTION_BLOCKS) {
        env.queue.length = 0;
        return env.report('avm1:budget', 'More than ' + MAX_ACTION_BLOCKS + ' frame scripts in one frame; the rest were dropped.', 'queue');
      }
      var item = env.queue.shift();
      for (var i = 0; i < item.tags.length; i++) runActionBlock(env, item.clip, item.tags[i]);
    }
  }

  Object.assign(M, { resolveTarget: resolveTarget, runActionQueue: runActionQueue });
})(typeof window !== 'undefined' ? window : globalThis);
