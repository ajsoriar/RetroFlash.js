/* RetroFlash.js - Timelines (the root and DefineSprite instances) and their display lists. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;
  var resolveLimits = M.resolveLimits, IDENTITY = M.IDENTITY, toMatrix = M.toMatrix, CX_IDENTITY = M.CX_IDENTITY,
    toColorTransform = M.toColorTransform, ActionScheduler = M.ActionScheduler, bindTextField = M.bindTextField;

  /* A Clip is a running timeline (the root or a sprite instance) with its display list keyed by depth.
     `env` is the movie's display context (createEnv). Display objects are { depth, characterId, character,
     matrix, cx, ratio, name, clipDepth, blendMode, clip }, plus `binding` for text fields bound to a variable,
     and, once a script changed them, `visible`, `transform` (avm1/properties.js), `scriptTransformed` (the
     timeline no longer moves it) and `dynamic` (created by a script at depth + SCRIPT_DEPTH; the timeline never
     removes it). `playing` is the timeline's own play state (AVM1 stop/play); `variables` holds its AVM1
     variables (avm1/variables.js). A Clip is also an AVM1 value (avm1Type 'movieclip'). */
  function Clip(env, def, level, parent) {
    this.env = env;
    this.def = def;
    this.level = level;
    this.parent = parent || null;
    this.object = null; // its display object in the parent's list (see displayObject)
    this.frame = 0;
    this.loop = true;
    this.playing = true;
    this.displayList = new Map();
    this.variables = new Map();
    if (!this.parent && env.scripts) env.scripts.root = this; // the movie's root, for paths outside scripts
  }
  Clip.prototype.avm1Type = 'movieclip';
  // Script depths (duplicateMovieClip) are offset from timeline depths, as in Flash Player.
  var SCRIPT_DEPTH = 16384;
  // The display object that places this clip; the root gets one of its own (its _x, _alpha, ... apply to the movie).
  Clip.prototype.displayObject = function () {
    return this.object || (this.object = { depth: 0, characterId: 0, character: null, matrix: IDENTITY, cx: CX_IDENTITY, name: '', clip: this });
  };
  /* The display context shared by every Clip of one movie: the dictionary, report(feature, reason, source),
     the limits (resolveLimits), `instances` (sprite and button instances created in the current step; the
     player resets it at each tick, seek and input event), `scripts`, the movie's ActionScheduler, and `loads`,
     its LoadQueue (display/loader.js), and `host`, the HostBridge to the page (avm1/external.js). options:
     { limits, actions, loader, maxFileBytes, host, dispatch } (actions: false queues no scripts; loader: the host
     page's loader function; host: the Player option `host`; dispatch: the Player's cancelable events). */
  function createEnv(movie, report, options) {
    options = options || {};
    var limits = options.limits || resolveLimits();
    var scripts = new ActionScheduler(movie.swf, report, limits, options.actions);
    scripts.host = new M.HostBridge(options.host, report, options.dispatch, options.interaction);
    return {
      characters: movie.characters, exports: movie.exports || Object.create(null), swf: movie.swf, version: movie.swf.version, url: '',
      report: report, limits: limits, instances: 0, instanceNames: 0, input: null, initActions: new Set(),
      scripts: scripts, host: scripts.host,
      loads: M.LoadQueue ? new M.LoadQueue(options.loader, report, limits, options.maxFileBytes, options.interaction) : null
    };
  }
  /* The context of a movie or image loaded into a clip: its own dictionary, exports, SWF version and URL; the
     rest (scripts, loads, limits, instance counts, input and dragging state) is the main movie's. */
  var SHARED_STATE = ['instances', 'instanceNames', 'input', 'drag', 'dropTarget'];
  function createMovieEnv(env, movie, url) {
    var main = env.main || env, child = Object.create(main);
    SHARED_STATE.forEach(function (key) {
      Object.defineProperty(child, key, { get: function () { return main[key]; }, set: function (value) { main[key] = value; } });
    });
    return Object.assign(child, {
      main: main, characters: movie.characters, exports: movie.exports, swf: movie.swf, version: movie.swf.version, url: url,
      initActions: new Set()
    });
  }
  // A movie with nothing in it (an emptied clip, or an image), standing in for a SWF file of `version`.
  function contentMovie(version, byteLength, characters) {
    return {
      characters: characters || Object.create(null), exports: Object.create(null),
      swf: { version: version, declaredLength: byteLength, width: 0, height: 0, getTagData: function () { return new Uint8Array(0); } }
    };
  }
  function emptyTimeline(name) { return { type: 'sprite', id: 0, name: name, frames: [[]], labels: Object.create(null) }; }
  // Character ids of the sprites containing this clip, up to the root of its movie (0).
  Clip.prototype.ancestry = function () {
    var ids = [];
    for (var clip = this; clip; clip = clip.content ? null : clip.parent) ids.push(clip.def.id);
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
      obj.clip.object = obj;
      obj.clip.gotoFrame(1);
    } else if (character.type === 'button') {
      obj.button = new M.ButtonInstance(this, character, level + 1, ancestry.concat(characterId));
    } else if (character.type === 'editText') {
      if (character.field.variableName) bindTextField(this, obj);
      if (!character.field.readOnly) env.report('text:input', 'Input text fields are drawn but cannot be edited yet.', characterId);
    } else if (character.type === 'font') {
      env.report('render:fontPlaced', 'A font is not a display object; the placement draws nothing.', characterId);
    } else if (character.type === 'unsupported') {
      env.report('render:' + character.name, character.name + ' characters are placed but not drawn yet.', characterId);
    }
    return obj;
  };
  // A sprite instance placed without a name is named "instanceN", N counting from 1 in the movie, as in Flash Player.
  function nameInstance(env, obj) {
    if (obj.clip && obj.name === undefined) obj.name = 'instance' + (++env.instanceNames);
  }
  /* A display object just put on the stage: a new sprite instance is named, and gets its initialize and load
     events (after its own frame-1 script, which was queued when it was made). */
  function placed(env, obj) {
    nameInstance(env, obj);
    if (obj.clip && env.scripts) {
      env.scripts.clipEvent(obj.clip, 'initialize');
      env.scripts.clipEvent(obj.clip, 'load');
    }
  }
  /* A display object leaving the stage: a sprite instance and the instances inside it are marked removed and
     get their unload events. */
  function retire(env, obj) {
    if (!obj || !obj.clip || !env.scripts) return;
    (function unload(clip) {
      clip.displayList.forEach(function (child) { if (child.clip) unload(child.clip); });
      clip.removed = true;
      clip.releaseContent();
      env.scripts.clipEvent(clip, 'unload');
    })(obj.clip);
  }
  /* The clip event actions of a placement (onClipEvent), as runnable blocks: [{ events, keyCode, block }],
     made once per tag. */
  function clipActionsOf(env, tag) {
    if (!tag.clipActionBlocks) {
      var data = env.swf.getTagData(tag);
      tag.clipActionBlocks = tag.fields.clipActions.map(function (a) {
        return {
          events: a.events, keyCode: a.keyCode,
          block: { bytes: data.subarray(a.start, a.end), offset: tag.dataOffset + a.start, label: 'onClipEvent(' + a.events.join(', ') + ')' }
        };
      });
    }
    return tag.clipActionBlocks;
  }
  /* Applies one control tag to `list` (a Map depth -> object); `make(characterId)` creates new objects. An
     object a script transformed keeps its matrix and colour transform. */
  function applyControlTag(list, tag, make, env) {
    var f = tag.fields, report = env.report;
    if (!f) return;
    var code = tag.code;
    if (code === 5 || code === 28) { retire(env, list.get(f.depth)); list.delete(f.depth); return; }
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
    if (existing && obj !== existing) retire(env, existing);
    obj.depth = f.depth;
    var keep = obj === existing && obj.scriptTransformed;
    if (f.matrix && !keep) { obj.matrix = toMatrix(f.matrix); obj.transform = null; }
    if (f.colorTransform && !keep) obj.cx = toColorTransform(f.colorTransform);
    if (f.ratio !== undefined) obj.ratio = f.ratio;
    if (f.name !== undefined) obj.name = f.name;
    if (f.clipDepth !== undefined) obj.clipDepth = f.clipDepth;
    if (f.blendMode !== undefined) obj.blendMode = f.blendMode;
    if (f.clipActions && f.clipActions.length && env.swf) obj.clipActions = clipActionsOf(env, tag);
    list.set(f.depth, obj);
    if (obj !== existing) placed(env, obj);
  }
  Clip.prototype.frameCount = function () { return this.def.frames.length; };
  Clip.prototype.gotoFrame = function (n) {
    var count = this.def.frames.length, self = this, env = this.env;
    n = Math.max(1, Math.min(count, Math.floor(n)));
    if (n === this.frame) return;
    var make = function (id) { return self.createObject(id); };
    if (n > this.frame) {
      for (var k = this.frame + 1; k <= n; k++) {
        this.def.frames[k - 1].forEach(function (tag) { applyControlTag(self.displayList, tag, make, env); });
      }
    } else {
      // Rewind: rebuild the target state from frame 1, then keep existing objects whose depth still holds
      // the same character (sprite instances keep running), replace or remove the rest. Objects created by
      // scripts stay; objects a script transformed keep their matrix and colour transform.
      var plan = new Map(), plain = function (id) { return { characterId: id, matrix: IDENTITY, cx: CX_IDENTITY }; };
      var planEnv = { report: env.report, instanceNames: 0, swf: env.swf };
      for (var j = 1; j <= n; j++) {
        this.def.frames[j - 1].forEach(function (tag) { applyControlTag(plan, tag, plain, planEnv); });
      }
      this.displayList.forEach(function (obj, depth) {
        var target = plan.get(depth);
        if (!obj.dynamic && (!target || target.characterId !== obj.characterId)) { retire(env, obj); self.displayList.delete(depth); }
      });
      plan.forEach(function (target, depth) {
        var existing = self.displayList.get(depth), obj = existing || self.createObject(target.characterId);
        ['depth', 'ratio', 'clipDepth', 'blendMode'].forEach(function (k) { obj[k] = target[k]; });
        if (!(existing && existing.scriptTransformed)) { obj.matrix = target.matrix; obj.cx = target.cx; obj.transform = null; }
        if (target.name !== undefined) obj.name = target.name;
        if (target.clipActions) obj.clipActions = target.clipActions;
        self.displayList.set(depth, obj);
        if (!existing) placed(env, obj);
      });
    }
    this.frame = n;
    this.queueFrameActions(n);
  };
  /* The scripts of the frame just entered run after the current tick, in queue order: first the DoInitAction
     scripts met for the first time in the movie (run on the root timeline, once), then the DoAction scripts. */
  Clip.prototype.queueFrameActions = function (n) {
    var env = this.env, init = [], root = this.root();
    this.def.frames[n - 1].forEach(function (tag) {
      if (tag.code !== 59 || env.initActions.has(tag) || tag.length < 2) return;
      env.initActions.add(tag);
      if (!tag.initBlock) tag.initBlock = { bytes: env.swf.getTagData(tag).subarray(2), offset: tag.dataOffset + 2, label: 'DoInitAction' };
      init.push(tag.initBlock);
    });
    if (init.length) env.scripts.enqueue(root, init);
    env.scripts.enqueue(this, this.def.frames[n - 1].filter(function (tag) { return tag.code === 12; }));
  };
  /* One tick: existing child sprites tick first; then this clip gets its enterFrame event and its timeline
     moves to its next frame (children it places now start at their frame 1), as in Flash Player. A stopped
     timeline stays put but its children keep playing. Returns true when the last frame was passed. */
  Clip.prototype.tick = function () {
    this.displayList.forEach(function (obj) {
      if (obj.clip) obj.clip.tick();
      else if (obj.button) obj.button.tick();
    });
    this.env.scripts.clipEvent(this, 'enterFrame');
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
  // Puts a display object made by a script at script depth `depth` (0 or more), replacing what was there.
  Clip.prototype.placeScripted = function (obj, name, depth) {
    obj.depth = depth + SCRIPT_DEPTH;
    obj.name = name;
    obj.dynamic = true;
    retire(this.env, this.displayList.get(obj.depth));
    this.displayList.set(obj.depth, obj);
    placed(this.env, obj);
    return obj.clip;
  };
  /* duplicateMovieClip (CloneSprite): a new instance of `source`'s sprite, named `name`, at script depth `depth`
     of this clip, with source's matrix, colour transform and clip events. It starts at its frame 1. Returns
     the new Clip, or null. */
  Clip.prototype.cloneChild = function (source, name, depth) {
    var obj = this.createObject(source.characterId);
    if (!obj.clip) return null;
    obj.matrix = source.matrix;
    obj.cx = source.cx;
    if (source.clipActions) obj.clipActions = source.clipActions;
    return this.placeScripted(obj, name, depth);
  };
  // attachMovie: a new instance of a sprite character (found by its ExportAssets name) at script depth `depth`.
  Clip.prototype.attachChild = function (characterId, name, depth) {
    var obj = this.createObject(characterId);
    return obj.clip ? this.placeScripted(obj, name, depth) : null;
  };
  // createEmptyMovieClip: an empty sprite instance with one frame at script depth `depth`.
  Clip.prototype.createEmptyChild = function (name, depth) {
    var def = { type: 'sprite', id: 0, name: 'empty', frames: [[]], labels: Object.create(null) };
    var obj = { characterId: 0, character: def, matrix: IDENTITY, cx: CX_IDENTITY, clip: null };
    obj.clip = new Clip(this.env, def, this.level + 1, this);
    obj.clip.object = obj;
    obj.clip.gotoFrame(1);
    return this.placeScripted(obj, name, depth);
  };
  /* swapDepths: moves `obj` to `depth` (an internal depth), swapping with what is there. Both objects are then
     managed by scripts: the timeline no longer removes them. */
  Clip.prototype.swapDepths = function (obj, depth) {
    if (this.displayList.get(obj.depth) !== obj || obj.depth === depth) return;
    var other = this.displayList.get(depth), from = obj.depth;
    this.displayList.delete(from);
    if (other) { other.depth = from; other.dynamic = true; this.displayList.set(from, other); }
    obj.depth = depth;
    obj.dynamic = true;
    this.displayList.set(depth, obj);
  };
  // removeMovieClip (RemoveSprite): only instances created or moved by a script can be removed. True when removed.
  Clip.prototype.removeChild = function (obj) {
    if (!obj.dynamic || this.displayList.get(obj.depth) !== obj) return false;
    this.displayList.delete(obj.depth);
    retire(this.env, obj);
    return true;
  };
  /* Loading into this clip (display/loader.js). The clip keeps its display object (name, depth, transform,
     clip events), but its content goes: its children leave with their unload events, it gets its own unload
     event, its variables and methods are cleared, and it becomes an empty one-frame timeline (0 bytes) until
     new content arrives. */
  Clip.prototype.clearContent = function () {
    var env = this.env;
    this.displayList.forEach(function (obj) { retire(env, obj); });
    if (env.scripts) env.scripts.clipEvent(this, 'unload');
    this.displayList = new Map();
    this.variables = new Map();
    this.releaseContent();
    this.env = createMovieEnv(env, contentMovie(env.version, 0), env.url);
    this.def = emptyTimeline('empty');
    this.frame = 1;
    this.playing = true;
  };
  // Frees the bitmaps of loaded content and gives their pixels back to the load budget.
  Clip.prototype.releaseContent = function () {
    var content = this.content, loads = this.env.loads;
    if (!content) return;
    this.content = null;
    var pixels = content.movie ? content.movie.release() : (M.releaseSource(content.image), content.image.reserved);
    if (loads) { loads.pixels.remaining += pixels; loads.contents.delete(this); }
  };
  // Shows a loaded movie: its root timeline from frame 1, with its own dictionary, then the clip's load event.
  Clip.prototype.showMovie = function (movie, url) {
    this.showContent(createMovieEnv(this.env, movie, url), movie.root, { movie: movie });
  };
  // Shows a loaded image ({ source, width, height, reserved }) at the clip's origin, at one twip per 1/20 pixel.
  Clip.prototype.showImage = function (image, url) {
    var bitmap = { type: 'bitmap', id: 1, name: url, source: image.source, width: image.width, height: image.height };
    var movie = contentMovie(this.env.version, 0, Object.create(null));
    movie.characters[1] = bitmap;
    this.showContent(createMovieEnv(this.env, movie, url), emptyTimeline('image'), { image: image });
    this.displayList.set(1, { depth: 1, characterId: 1, character: bitmap, matrix: IDENTITY, cx: CX_IDENTITY, clip: null });
  };
  Clip.prototype.showContent = function (env, def, content) {
    this.releaseContent();
    this.env = env;
    this.def = def;
    this.content = content;
    this.frame = 0;
    this.playing = true;
    this.gotoFrame(1);
    if (env.scripts) env.scripts.clipEvent(this, 'load');
  };
  Clip.prototype.findLabel = function (label) {
    var labels = this.def.labels;
    if (label in labels) return labels[label];
    var lower = label.toLowerCase(), names = Object.keys(labels);
    for (var i = 0; i < names.length; i++) if (names[i].toLowerCase() === lower) return labels[names[i]];
    return 0;
  };

  Object.assign(M, { Clip: Clip, createEnv: createEnv, createMovieEnv: createMovieEnv, SCRIPT_DEPTH: SCRIPT_DEPTH });
})(typeof window !== 'undefined' ? window : globalThis);
