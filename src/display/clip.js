/* RetroFlash.js - Timelines (the root and DefineSprite instances) and their display lists. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;
  var resolveLimits = M.resolveLimits, IDENTITY = M.IDENTITY, toMatrix = M.toMatrix, CX_IDENTITY = M.CX_IDENTITY,
    toColorTransform = M.toColorTransform, ActionScheduler = M.ActionScheduler;

  /* A Clip is a running timeline (the root or a sprite instance) with its display list keyed by depth.
     `env` is the movie's display context (createEnv). Display objects are { depth, characterId, character,
     matrix, cx, ratio, name, clipDepth, blendMode, clip }. `playing` is the timeline's own play state (AVM1
     stop/play). */
  function Clip(env, def, level, parent) {
    this.env = env;
    this.def = def;
    this.level = level;
    this.parent = parent || null;
    this.frame = 0;
    this.loop = true;
    this.playing = true;
    this.displayList = new Map();
  }
  /* The display context shared by every Clip of one movie: the dictionary, report(feature, reason, source),
     the limits (resolveLimits), `instances` (sprite and button instances created in the current step; the
     player resets it at each tick, seek and input event), and `scripts`, the movie's ActionScheduler.
     options: { limits, actions } (actions: false queues no scripts). */
  function createEnv(movie, report, options) {
    options = options || {};
    var limits = options.limits || resolveLimits();
    return {
      characters: movie.characters, swf: movie.swf, version: movie.swf.version, report: report, limits: limits,
      instances: 0, scripts: new ActionScheduler(movie.swf, report, limits, options.actions)
    };
  }
  // Character ids of the sprites containing this clip (the root is 0).
  Clip.prototype.ancestry = function () {
    var ids = [];
    for (var clip = this; clip; clip = clip.parent) ids.push(clip.def.id);
    return ids;
  };
  /* `level` and `ancestry` describe the container: they default to this clip's; button children pass the
     button's, so content nested through buttons is bounded too. Hostile files can make sprites or buttons
     contain themselves (possibly several times per level, which grows exponentially), so containers are
     refused when they would contain themselves, nest deeper than limits.maxNesting, or exceed
     limits.maxInstances in one step (env.instances). */
  Clip.prototype.createObject = function (characterId, level, ancestry) {
    var env = this.env, character = env.characters[characterId], limits = env.limits;
    var obj = { characterId: characterId, character: character || null, matrix: IDENTITY, cx: CX_IDENTITY, clip: null };
    var container = character && (character.type === 'sprite' || character.type === 'button');
    level = level === undefined ? this.level : level;
    if (container) ancestry = ancestry || this.ancestry();
    if (!character) {
      env.report('render:missingCharacter', 'A placement refers to a character id that is not defined; nothing is drawn.', characterId);
    } else if (container && ancestry.indexOf(characterId) >= 0) {
      env.report('render:recursiveCharacter', 'A sprite or button that contains itself is not instantiated again.', characterId);
    } else if (container && level + 1 > limits.maxNesting) {
      env.report('render:nestingLimit', 'Sprite and button instances nested deeper than ' + limits.maxNesting + ' levels are not created.', characterId);
    } else if (container && ++env.instances > limits.maxInstances) {
      env.report('render:instanceLimit', 'More than ' + limits.maxInstances + ' sprite and button instances in one step; further ones are not created.', characterId);
    } else if (character.type === 'sprite') {
      obj.clip = new Clip(env, character, level + 1, this);
      obj.clip.gotoFrame(1);
    } else if (character.type === 'button') {
      obj.button = new M.ButtonInstance(this, character, level + 1, ancestry.concat(characterId));
    } else if (character.type === 'editText') {
      if (character.field.variableName) env.report('text:variable', 'Text fields bound to a variable show their initial text; ActionScript variables are not implemented yet.', characterId);
      if (!character.field.readOnly) env.report('text:input', 'Input text fields are drawn but cannot be edited yet.', characterId);
    } else if (character.type === 'font') {
      env.report('render:fontPlaced', 'A font is not a display object; the placement draws nothing.', characterId);
    } else if (character.type === 'unsupported') {
      env.report('render:' + character.name, character.name + ' characters are placed but not drawn yet.', characterId);
    }
    return obj;
  };
  // Applies one control tag to `list` (a Map depth -> object); `make(characterId)` creates new objects.
  function applyControlTag(list, tag, make, report) {
    var f = tag.fields;
    if (!f) return;
    var code = tag.code;
    if (code === 5 || code === 28) { list.delete(f.depth); return; }
    if (code !== 4 && code !== 26 && code !== 70) return;
    var existing = list.get(f.depth), hasCharacter = f.characterId !== undefined, obj;
    if (code === 4) {
      obj = make(f.characterId);
    } else if (f.move) {
      if (existing && hasCharacter && f.characterId !== existing.characterId) {
        obj = make(f.characterId);
        ['matrix', 'cx', 'ratio', 'name', 'clipDepth', 'blendMode'].forEach(function (k) { if (existing[k] !== undefined) obj[k] = existing[k]; });
      } else if (existing) {
        obj = existing;
      } else if (hasCharacter) {
        obj = make(f.characterId);
      } else {
        return report('timeline:moveWithoutObject', 'PlaceObject2/3 moves a depth that is empty; ignored.', f.depth);
      }
    } else if (hasCharacter) {
      obj = make(f.characterId);
    } else {
      return report('timeline:placeWithoutCharacter', 'PlaceObject2/3 without Move or CharacterId; ignored.', f.depth);
    }
    obj.depth = f.depth;
    if (f.matrix) obj.matrix = toMatrix(f.matrix);
    if (f.colorTransform) obj.cx = toColorTransform(f.colorTransform);
    if (f.ratio !== undefined) obj.ratio = f.ratio;
    if (f.name !== undefined) obj.name = f.name;
    if (f.clipDepth !== undefined) obj.clipDepth = f.clipDepth;
    if (f.blendMode !== undefined) obj.blendMode = f.blendMode;
    list.set(f.depth, obj);
  }
  Clip.prototype.frameCount = function () { return this.def.frames.length; };
  Clip.prototype.gotoFrame = function (n) {
    var count = this.def.frames.length, self = this, report = this.env.report;
    n = Math.max(1, Math.min(count, Math.floor(n)));
    if (n === this.frame) return;
    var make = function (id) { return self.createObject(id); };
    if (n > this.frame) {
      for (var k = this.frame + 1; k <= n; k++) {
        this.def.frames[k - 1].forEach(function (tag) { applyControlTag(self.displayList, tag, make, report); });
      }
    } else {
      // Rewind: rebuild the target state from frame 1, then keep existing objects whose depth still holds
      // the same character (sprite instances keep running), replace or remove the rest.
      var plan = new Map(), plain = function (id) { return { characterId: id, matrix: IDENTITY, cx: CX_IDENTITY }; };
      for (var j = 1; j <= n; j++) {
        this.def.frames[j - 1].forEach(function (tag) { applyControlTag(plan, tag, plain, report); });
      }
      this.displayList.forEach(function (obj, depth) {
        var target = plan.get(depth);
        if (!target || target.characterId !== obj.characterId) self.displayList.delete(depth);
      });
      plan.forEach(function (target, depth) {
        var obj = self.displayList.get(depth) || self.createObject(target.characterId);
        ['depth', 'matrix', 'cx', 'ratio', 'name', 'clipDepth', 'blendMode'].forEach(function (k) { obj[k] = target[k]; });
        self.displayList.set(depth, obj);
      });
    }
    this.frame = n;
    this.queueFrameActions(n);
  };
  // Frame scripts (DoAction) of the frame just entered run after the current tick, in queue order.
  Clip.prototype.queueFrameActions = function (n) {
    this.env.scripts.enqueue(this, this.def.frames[n - 1].filter(function (tag) { return tag.code === 12; }));
  };
  // One tick: existing child sprites advance first; then this timeline moves to its next frame (children it
  // places now start at their frame 1). A stopped timeline stays put but its children keep playing.
  // Returns true when the last frame was passed (looped or stopped there).
  Clip.prototype.tick = function () {
    this.displayList.forEach(function (obj) {
      if (obj.clip) obj.clip.tick();
      else if (obj.button) obj.button.tick();
    });
    var count = this.def.frames.length;
    if (!this.playing || count < 2) return false;
    if (this.frame < count) { this.gotoFrame(this.frame + 1); return false; }
    if (this.loop) this.gotoFrame(1);
    return true;
  };
  Clip.prototype.depths = function () {
    return Array.from(this.displayList.keys()).sort(function (a, b) { return a - b; });
  };
  Clip.prototype.root = function () {
    var clip = this;
    while (clip.parent) clip = clip.parent;
    return clip;
  };
  // Child sprite instance by instance name (case-insensitive before SWF 7, as in Flash Player).
  Clip.prototype.childByName = function (name) {
    var found = null, insensitive = this.env.version < 7, wanted = insensitive ? name.toLowerCase() : name;
    this.displayList.forEach(function (obj) {
      if (found || !obj.clip || obj.name === undefined) return;
      if ((insensitive ? obj.name.toLowerCase() : obj.name) === wanted) found = obj.clip;
    });
    return found;
  };
  Clip.prototype.findLabel = function (label) {
    var labels = this.def.labels;
    if (label in labels) return labels[label];
    var lower = label.toLowerCase(), names = Object.keys(labels);
    for (var i = 0; i < names.length; i++) if (names[i].toLowerCase() === lower) return labels[names[i]];
    return 0;
  };

  Object.assign(M, { Clip: Clip, createEnv: createEnv });
})(typeof window !== 'undefined' ? window : globalThis);
