/* RetroFlash.js - Pointer and keyboard input turned into button events. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;
  var IDENTITY = M.IDENTITY, BUTTON = M.BUTTON, pickButton = M.pickButton, collectButtons = M.collectButtons;

  /* Tracks the hovered and pressed button for one movie and turns pointer changes into AVM1 button events
     (Push tracking, as in Flash Player). A "button" is a button instance, or a movie clip with button handlers
     (onPress, onRelease, ...). It also keeps the keys held down (Key.isDown), sends mouse and key events to
     every clip and to the Mouse and Key listeners, and moves a dragged clip. Coordinates are stage twips. Each
     method returns true when something changed (state or queued actions); the caller then runs the action
     queue and redraws. trackAsMenu buttons are handled as push buttons. */
  function InputController(env, getRoot) {
    this.env = env;
    this.getRoot = getRoot;
    this.hovered = null;
    this.pressed = null;
    this.mouseDown = false;
    this.inside = false;
    this.x = 0;
    this.y = 0;
    env.input = this; // the pointer position for _xmouse and _ymouse
  }
  // Button conditions -> the clip events of a movie clip acting as a button.
  var CLIP_BUTTON_EVENTS = {};
  CLIP_BUTTON_EVENTS[BUTTON.IDLE_TO_OVER_UP] = 'rollOver';
  CLIP_BUTTON_EVENTS[BUTTON.OVER_UP_TO_IDLE] = 'rollOut';
  CLIP_BUTTON_EVENTS[BUTTON.OVER_UP_TO_OVER_DOWN] = 'press';
  CLIP_BUTTON_EVENTS[BUTTON.OVER_DOWN_TO_OVER_UP] = 'release';
  CLIP_BUTTON_EVENTS[BUTTON.OVER_DOWN_TO_OUT_DOWN] = 'dragOut';
  CLIP_BUTTON_EVENTS[BUTTON.OUT_DOWN_TO_OVER_DOWN] = 'dragOver';
  CLIP_BUTTON_EVENTS[BUTTON.OUT_DOWN_TO_IDLE] = 'releaseOutside';
  InputController.prototype.fire = function (target, state, condition) {
    if (!target.button) {
      if (target.clip) this.env.scripts.clipEvent(target.clip, CLIP_BUTTON_EVENTS[condition]);
      return;
    }
    target.button.runActions(condition);
    target.button.setState(state);
    if (target.button.character.trackAsMenu) this.env.report('input:trackAsMenu', 'Menu-tracking buttons are handled as push buttons.', target.characterId);
  };
  // Buttons that left the stage are forgotten without events, as Flash does. The display list only changes
  // in ticks, frame scripts and seeks, so this runs after those (afterTick, Player.seek), not on every move.
  InputController.prototype.pruneRemoved = function () {
    var root = this.getRoot();
    if (!root || (!this.hovered && !this.pressed)) return;
    var live = collectButtons(root, new Set());
    if (this.hovered && !live.has(this.hovered)) this.hovered = null;
    if (this.pressed && !live.has(this.pressed)) this.pressed = null;
  };
  InputController.prototype.update = function (moved) {
    var root = this.getRoot();
    if (!root) return false;
    if (!moved && this.hovered) return false;
    var top = root.displayObject ? root.displayObject() : null; // what scripts set on _root
    var over = this.inside && !(top && top.visible === false) ? pickButton(root, top ? top.matrix : IDENTITY, this.x, this.y, this.env.report) : null;
    if (over === this.hovered) return false;
    var previous = this.hovered;
    this.hovered = over;
    if (this.mouseDown) {
      // While the button is held only the pressed button gets drag events; no roll events in AVM1.
      if (this.pressed && previous === this.pressed) this.fire(this.pressed, 'over', BUTTON.OVER_DOWN_TO_OUT_DOWN);
      else if (this.pressed && over === this.pressed) this.fire(this.pressed, 'down', BUTTON.OUT_DOWN_TO_OVER_DOWN);
    } else {
      if (previous) this.fire(previous, 'up', BUTTON.OVER_UP_TO_IDLE);
      if (over) this.fire(over, 'over', BUTTON.IDLE_TO_OVER_UP);
    }
    return true;
  };
  /* Runs body() and sends event `name` to every clip and listener; true when either queued or changed something. */
  InputController.prototype.withEvent = function (name, keyCode, body) {
    var scripts = this.env.scripts, before = scripts.queue.length, changed = body ? body.call(this) : false;
    scripts.broadcast(this.getRoot(), name, keyCode);
    return changed || scripts.queue.length > before;
  };
  InputController.prototype.move = function (x, y) {
    this.inside = true;
    this.x = x;
    this.y = y;
    return this.withEvent('mouseMove', 0, function () { var dragged = M.updateDrag(this.env); return this.update(true) || dragged; });
  };
  InputController.prototype.leave = function () {
    this.inside = false;
    return this.update(true);
  };
  InputController.prototype.down = function () {
    if (this.mouseDown) return false;
    return this.withEvent('mouseDown', 0, this.pressButton);
  };
  InputController.prototype.pressButton = function () {
    this.mouseDown = true;
    this.update(true);
    if (!this.hovered) return false;
    this.pressed = this.hovered;
    this.fire(this.pressed, 'down', BUTTON.OVER_UP_TO_OVER_DOWN);
    return true;
  };
  InputController.prototype.up = function () {
    if (!this.mouseDown) return false;
    return this.withEvent('mouseUp', 0, this.releaseButton);
  };
  InputController.prototype.releaseButton = function () {
    this.mouseDown = false;
    var pressed = this.pressed;
    this.pressed = null;
    if (!pressed) {
      // Pressed outside every button: the button now under the pointer (entered silently while the mouse
      // was down) gets its roll over on release.
      if (this.hovered) { this.fire(this.hovered, 'over', BUTTON.IDLE_TO_OVER_UP); return true; }
      return this.update(true);
    }
    if (this.hovered === pressed) {
      this.fire(pressed, 'over', BUTTON.OVER_DOWN_TO_OVER_UP);
    } else {
      this.fire(pressed, 'up', BUTTON.OUT_DOWN_TO_IDLE);
      if (this.hovered) this.fire(this.hovered, 'over', BUTTON.IDLE_TO_OVER_UP);
    }
    return true;
  };
  /* SWF key code (1-127): every button on stage with a matching KeyPress condition runs its actions, and
     clips get their onClipEvent(keyPress) for it. */
  InputController.prototype.key = function (code) {
    var root = this.getRoot(), matched = false;
    if (!root || !code) return false;
    collectButtons(root, new Set()).forEach(function (obj) { if (obj.button && obj.button.runActions(0, code)) matched = true; });
    return this.withEvent('keyPress', code) || matched;
  };
  /* A key goes down or up: `code` is the Flash key code (Key.LEFT is 37, ...), `ascii` its character code (0
     when none). Key.isDown follows; clips get keyDown/keyUp, then the Key listeners. */
  InputController.prototype.keyDown = function (code, ascii) {
    var scripts = this.env.scripts;
    scripts.keys.add(code);
    scripts.lastKey = { code: code, ascii: ascii };
    return this.withEvent('keyDown', code);
  };
  InputController.prototype.keyUp = function (code) {
    var scripts = this.env.scripts;
    scripts.keys.delete(code);
    scripts.lastKey = { code: code, ascii: scripts.lastKey.ascii };
    return this.withEvent('keyUp', code);
  };
  // The page lost the keyboard: every key counts as released, without events.
  InputController.prototype.releaseKeys = function () { this.env.scripts.keys.clear(); };
  // After a frame or a script run: forget removed buttons, then re-pick only if nothing is hovered (a button
  // may have appeared under a still pointer).
  InputController.prototype.afterTick = function () {
    this.pruneRemoved();
    return this.update(false);
  };
  InputController.prototype.cursor = function () {
    if (this.env.scripts.mouseHidden) return 'none';
    return this.hovered || this.pressed ? 'pointer' : '';
  };
  // Browser KeyboardEvent.key -> SWF key code (SWF19 KeyPress codes; printable ASCII otherwise).
  var SWF_KEYS = { ArrowLeft: 1, ArrowRight: 2, Home: 3, End: 4, Insert: 5, Delete: 6, Backspace: 8, Enter: 13, ArrowUp: 14,
    ArrowDown: 15, PageUp: 16, PageDown: 17, Tab: 18, Escape: 19 };
  /* KeyboardEvent -> Flash key code (Windows virtual key codes: letters as upper case, digits, arrows 37-40,
     ...), and its character code for Key.getAscii. */
  var FLASH_KEYS = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13, ' ': 32, Escape: 27, Shift: 16,
    Control: 17, Alt: 18, Tab: 9, Backspace: 8, Delete: 46, Home: 36, End: 35, PageUp: 33, PageDown: 34, Insert: 45, CapsLock: 20 };
  function flashKeyCode(e) {
    if (FLASH_KEYS[e.key]) return FLASH_KEYS[e.key];
    if (e.keyCode) return e.keyCode;
    return typeof e.key === 'string' && e.key.length === 1 ? e.key.toUpperCase().charCodeAt(0) : 0;
  }
  function keyAscii(e) {
    if (typeof e.key === 'string' && e.key.length === 1) return e.key.charCodeAt(0);
    return { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Delete: 127 }[e.key] || 0;
  }
  function swfKeyCode(key) {
    if (SWF_KEYS[key]) return SWF_KEYS[key];
    if (typeof key === 'string' && key.length === 1) {
      var c = key.charCodeAt(0);
      if (c >= 32 && c <= 126) return c;
    }
    return 0;
  }

  Object.assign(M, { InputController: InputController, swfKeyCode: swfKeyCode, flashKeyCode: flashKeyCode, keyAscii: keyAscii });
})(typeof window !== 'undefined' ? window : globalThis);
