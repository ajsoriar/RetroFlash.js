/* RetroFlash.js - Pointer and keyboard input turned into button events. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;
  var IDENTITY = M.IDENTITY, BUTTON = M.BUTTON, pickButton = M.pickButton, collectButtons = M.collectButtons;

  /* Tracks the hovered and pressed button for one movie and turns pointer changes into AVM1 button events
     (Push tracking, as in Flash Player). Coordinates are stage twips. Each method
     returns true when something changed (state or queued actions); the caller then runs the action queue
     and redraws. trackAsMenu buttons are handled as push buttons. */
  function InputController(env, getRoot) {
    this.env = env;
    this.getRoot = getRoot;
    this.hovered = null;
    this.pressed = null;
    this.mouseDown = false;
    this.inside = false;
    this.x = 0;
    this.y = 0;
  }
  InputController.prototype.fire = function (target, state, condition) {
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
    var over = this.inside ? pickButton(root, IDENTITY, this.x, this.y, this.env.report) : null;
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
  InputController.prototype.move = function (x, y) {
    this.inside = true;
    this.x = x;
    this.y = y;
    return this.update(true);
  };
  InputController.prototype.leave = function () {
    this.inside = false;
    return this.update(true);
  };
  InputController.prototype.down = function () {
    if (this.mouseDown) return false;
    this.mouseDown = true;
    this.update(true);
    if (!this.hovered) return false;
    this.pressed = this.hovered;
    this.fire(this.pressed, 'down', BUTTON.OVER_UP_TO_OVER_DOWN);
    return true;
  };
  InputController.prototype.up = function () {
    if (!this.mouseDown) return false;
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
  // SWF key code (1-127): every button on stage with a matching KeyPress condition runs its actions.
  InputController.prototype.key = function (code) {
    var root = this.getRoot(), matched = false;
    if (!root || !code) return false;
    collectButtons(root, new Set()).forEach(function (obj) { if (obj.button.runActions(0, code)) matched = true; });
    return matched;
  };
  // After a frame or a script run: forget removed buttons, then re-pick only if nothing is hovered (a button
  // may have appeared under a still pointer).
  InputController.prototype.afterTick = function () {
    this.pruneRemoved();
    return this.update(false);
  };
  InputController.prototype.cursor = function () { return this.hovered || this.pressed ? 'pointer' : ''; };
  // Browser KeyboardEvent.key -> SWF key code (SWF19 KeyPress codes; printable ASCII otherwise).
  var SWF_KEYS = { ArrowLeft: 1, ArrowRight: 2, Home: 3, End: 4, Insert: 5, Delete: 6, Backspace: 8, Enter: 13, ArrowUp: 14,
    ArrowDown: 15, PageUp: 16, PageDown: 17, Tab: 18, Escape: 19 };
  function swfKeyCode(key) {
    if (SWF_KEYS[key]) return SWF_KEYS[key];
    if (typeof key === 'string' && key.length === 1) {
      var c = key.charCodeAt(0);
      if (c >= 32 && c <= 126) return c;
    }
    return 0;
  }

  Object.assign(M, { InputController: InputController, swfKeyCode: swfKeyCode });
})(typeof window !== 'undefined' ? window : globalThis);
