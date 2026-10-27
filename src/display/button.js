/* RetroFlash.js - Button instances (DefineButton, DefineButton2): states, hit areas and actions. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;
  var Clip = M.Clip;

  // BUTTONCONDACTION condition bits (little-endian UI16; bits 9-15 hold a key code).
  var BUTTON = {
    IDLE_TO_OVER_UP: 1 << 0, OVER_UP_TO_IDLE: 1 << 1, OVER_UP_TO_OVER_DOWN: 1 << 2, OVER_DOWN_TO_OVER_UP: 1 << 3,
    OVER_DOWN_TO_OUT_DOWN: 1 << 4, OUT_DOWN_TO_OVER_DOWN: 1 << 5, OUT_DOWN_TO_IDLE: 1 << 6
  };

  /* An AVM1 button instance placed in `parentClip`. Its display list holds the children of the current state
     (up/over/down); children that stay at the same depth with the same character persist across state changes.
     The hit area (HIT_TEST records) is a separate list that is never drawn. Button actions run in the
     context of the parent timeline. */
  function ButtonInstance(parentClip, character, level, ancestry) {
    this.parentClip = parentClip;
    this.character = character;
    this.env = parentClip.env;
    this.level = level === undefined ? parentClip.level + 1 : level;
    this.ancestry = ancestry || parentClip.ancestry().concat(character.id);
    this.state = null;
    this.displayList = new Map();
    this.hitList = new Map();
    // Hit-area children are never drawn or ticked, so sprites in it must not run frame scripts either: the
    // scripts queued while they are created are dropped.
    var self = this, scripts = this.env.scripts, mark = scripts.mark();
    character.records.forEach(function (r) { if (r.hitTest) self.hitList.set(r.depth, self.child(r, null)); });
    scripts.dropSince(mark);
    this.setState('up');
  }
  ButtonInstance.prototype.child = function (record, existing) {
    var obj = existing && existing.characterId === record.characterId ? existing : this.parentClip.createObject(record.characterId, this.level, this.ancestry);
    obj.depth = record.depth;
    obj.matrix = record.matrix;
    obj.cx = record.cx;
    obj.blendMode = record.blendMode;
    if (record.filters) this.env.report('render:filters', 'Filters are not drawn yet.', this.character.id);
    return obj;
  };
  ButtonInstance.prototype.setState = function (state) {
    if (state === this.state) return;
    var next = new Map(), self = this;
    this.character.records.forEach(function (r) {
      if (r[state]) next.set(r.depth, self.child(r, self.displayList.get(r.depth)));
    });
    this.displayList = next;
    this.state = state;
  };
  ButtonInstance.prototype.depths = Clip.prototype.depths;
  ButtonInstance.prototype.tick = function () {
    this.displayList.forEach(function (obj) {
      if (obj.clip) obj.clip.tick();
      else if (obj.button) obj.button.tick();
    });
  };
  // Queues the actions whose conditions match: a transition bit, or a key code (bits 9-15).
  ButtonInstance.prototype.runActions = function (condition, keyCode) {
    var scripts = this.env.scripts, clip = this.parentClip, matched = false;
    this.character.actions.forEach(function (a) {
      var match = keyCode ? ((a.conditions >> 9) & 0x7f) === keyCode : (a.conditions & condition) !== 0;
      if (!match) return;
      matched = true;
      scripts.enqueue(clip, [a]);
    });
    return matched;
  };

  Object.assign(M, { BUTTON: BUTTON, ButtonInstance: ButtonInstance });
})(typeof window !== 'undefined' ? window : globalThis);
