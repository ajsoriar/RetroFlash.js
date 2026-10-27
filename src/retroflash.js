/* RetroFlash.js v0.1 - SWF player prototype (browser classic script). Load swf-reader.js first.
   API: const player = new RetroFlash.Player({ canvas }); await player.load(file); player.play();
   Milestone 1: character dictionary, display list and timelines (root and DefineSprite), DefineShape 1-4
   drawn with Canvas 2D, clipDepth masks. ActionScript is NEVER executed; bitmaps, text, buttons and morph
   shapes are not drawn yet and are reported through getDiagnostics().unsupported.
*/
(function (global) {
  'use strict';

  var VERSION = '0.1.0';
  var MAX_NESTING = 32;           // nested sprite instances; guards against sprites that place themselves
  var GRADIENT_HALF = 16384;      // SWF gradients are defined on a 32768-twip square centred on the origin
  var SHAPE_CODES = { 2: 1, 22: 1, 32: 1, 83: 1 };
  // Definition tags whose body starts with the new character id (UI16).
  var CHARACTER_TAGS = { 6: 1, 7: 1, 10: 1, 11: 1, 14: 1, 20: 1, 21: 1, 33: 1, 34: 1, 35: 1, 36: 1, 37: 1, 46: 1, 48: 1,
    60: 1, 75: 1, 84: 1, 87: 1, 90: 1, 91: 1 };
  var CAPS = ['round', 'butt', 'square'];
  var JOINS = ['round', 'bevel', 'miter'];

  function playerError(code, message) {
    var err = new Error('RetroFlash: ' + message);
    err.name = 'RetroFlashError';
    err.code = code;
    return err;
  }

  // ---- Matrices [a, b, c, d, tx, ty] (Canvas order) and colour transforms ----------------------------------
  var IDENTITY = [1, 0, 0, 1, 0, 0];
  // SWF MATRIX: x' = x*ScaleX + y*RotateSkew1 + TranslateX; y' = x*RotateSkew0 + y*ScaleY + TranslateY.
  function toMatrix(m) { return m ? [m.scaleX, m.rotateSkew0, m.rotateSkew1, m.scaleY, m.translateX, m.translateY] : IDENTITY; }
  function multiply(p, c) {
    return [
      p[0] * c[0] + p[2] * c[1], p[1] * c[0] + p[3] * c[1],
      p[0] * c[2] + p[2] * c[3], p[1] * c[2] + p[3] * c[3],
      p[0] * c[4] + p[2] * c[5] + p[4], p[1] * c[4] + p[3] * c[5] + p[5]
    ];
  }
  function invert(m) {
    var det = m[0] * m[3] - m[1] * m[2];
    if (!det || !isFinite(det)) return null;
    return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
      (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
  }
  function transformPoint(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }

  // Colour transform [rMul, gMul, bMul, aMul, rAdd, gAdd, bAdd, aAdd]; multipliers as factors (SWF 256 = 1.0).
  var CX_IDENTITY = [1, 1, 1, 1, 0, 0, 0, 0];
  function toColorTransform(c) {
    if (!c) return CX_IDENTITY;
    return [c.redMult / 256, c.greenMult / 256, c.blueMult / 256, c.alphaMult === undefined ? 1 : c.alphaMult / 256,
      c.redAdd, c.greenAdd, c.blueAdd, c.alphaAdd || 0];
  }
  // Child transform applied first, then the parent's.
  function concatColorTransform(p, c) {
    return [p[0] * c[0], p[1] * c[1], p[2] * c[2], p[3] * c[3],
      p[0] * c[4] + p[4], p[1] * c[5] + p[5], p[2] * c[6] + p[6], p[3] * c[7] + p[7]];
  }
  function channel(v) { return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v); }
  function cssColor(color, cx) {
    return 'rgba(' + channel(color.r * cx[0] + cx[4]) + ',' + channel(color.g * cx[1] + cx[5]) + ',' +
      channel(color.b * cx[2] + cx[6]) + ',' + channel(color.a * cx[3] + cx[7]) / 255 + ')';
  }

  // ---- Shape geometry ---------------------------------------------------------------------------------------
  /* Turns decoded SHAPERECORDs into drawable groups; a StateNewStyles record starts a new group. Each fill
     style collects the edges that border it: kept as-is on the edge's FillStyle1 side, reversed on its
     FillStyle0 side, then linked end-to-start into closed contours. Line styles keep edges in record order.
     Commands are flat arrays: 0 x y (moveTo), 1 x y (lineTo), 2 cx cy x y (quadraticCurveTo), in twips. */
  function buildShapeGeometry(shape) {
    var groups = [], problems = [], group, x = 0, y = 0, fill0 = 0, fill1 = 0, line = 0;
    function startGroup(fillStyles, lineStyles) {
      group = { fillStyles: fillStyles, lineStyles: lineStyles, fillEdges: [], lineEdges: [] };
      groups.push(group);
    }
    function add(list, index, edge) { (list[index] || (list[index] = [])).push(edge); }
    startGroup(shape.fillStyles, shape.lineStyles);
    var records = shape.records;
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r.type === 'style') {
        if (r.newStyles) { startGroup(r.newStyles.fillStyles, r.newStyles.lineStyles); fill0 = fill1 = line = 0; }
        if (r.moveTo) { x = r.moveTo.x; y = r.moveTo.y; }
        if (r.fill0 !== undefined) fill0 = r.fill0;
        if (r.fill1 !== undefined) fill1 = r.fill1;
        if (r.line !== undefined) line = r.line;
        continue;
      }
      var edge = r.type === 'curve'
        ? { x0: x, y0: y, cx: x + r.cdx, cy: y + r.cdy, x1: x + r.cdx + r.adx, y1: y + r.cdy + r.ady, curve: true }
        : { x0: x, y0: y, x1: x + r.dx, y1: y + r.dy, curve: false };
      if (fill0) add(group.fillEdges, fill0, { x0: edge.x1, y0: edge.y1, cx: edge.cx, cy: edge.cy, x1: edge.x0, y1: edge.y0, curve: edge.curve });
      if (fill1) add(group.fillEdges, fill1, edge);
      if (line) add(group.lineEdges, line, edge);
      x = edge.x1;
      y = edge.y1;
    }
    var out = [];
    groups.forEach(function (g, groupIndex) {
      var result = { fills: [], lines: [] };
      g.fillEdges.forEach(function (edges, index) {
        if (index > g.fillStyles.length) return problems.push('fill style ' + index + ' does not exist (group ' + groupIndex + ')');
        result.fills.push({ style: g.fillStyles[index - 1], commands: linkContours(edges) });
      });
      g.lineEdges.forEach(function (edges, index) {
        if (index > g.lineStyles.length) return problems.push('line style ' + index + ' does not exist (group ' + groupIndex + ')');
        result.lines.push({ style: g.lineStyles[index - 1], commands: strokeCommands(edges) });
      });
      if (result.fills.length || result.lines.length) out.push(result);
    });
    return { groups: out, problems: problems, fillRule: shape.usesFillWindingRule ? 'nonzero' : 'evenodd' };
  }
  function pushEdge(cmds, e) {
    if (e.curve) cmds.push(2, e.cx, e.cy, e.x1, e.y1);
    else cmds.push(1, e.x1, e.y1);
  }
  function linkContours(edges) {
    var byStart = Object.create(null), used = [], cmds = [], i;
    for (i = 0; i < edges.length; i++) {
      var key = edges[i].x0 + ',' + edges[i].y0;
      (byStart[key] || (byStart[key] = [])).push(i);
    }
    for (i = 0; i < edges.length; i++) {
      if (used[i]) continue;
      var index = i, e = edges[i];
      cmds.push(0, e.x0, e.y0);
      while (e) {
        used[index] = true;
        pushEdge(cmds, e);
        var next = byStart[e.x1 + ',' + e.y1];
        e = null;
        while (next && next.length) {
          index = next.pop();
          if (!used[index]) { e = edges[index]; break; }
        }
      }
    }
    return cmds;
  }
  function strokeCommands(edges) {
    var cmds = [], lastX = NaN, lastY = NaN;
    for (var i = 0; i < edges.length; i++) {
      var e = edges[i];
      if (e.x0 !== lastX || e.y0 !== lastY) cmds.push(0, e.x0, e.y0);
      pushEdge(cmds, e);
      lastX = e.x1;
      lastY = e.y1;
    }
    return cmds;
  }

  // ---- Movie definition: dictionary and frame lists ---------------------------------------------------------
  // Frame k (1-based) = the control tags between ShowFrame k-1 and ShowFrame k. Tags after the last ShowFrame are ignored.
  function buildTimeline(tags) {
    var frames = [], current = [], labels = Object.create(null);
    for (var i = 0; i < tags.length; i++) {
      var tag = tags[i];
      if (tag.code === 0) break;
      if (tag.code === 1) { frames.push(current); current = []; continue; }
      if (tag.code === 43 && tag.fields && !(tag.fields.name in labels)) labels[tag.fields.name] = frames.length + 1;
      current.push(tag);
    }
    if (!frames.length) frames.push(current);
    return { frames: frames, labels: labels };
  }

  function Movie(swf) {
    var characters = Object.create(null);
    swf.tags.forEach(function (tag) {
      var f = tag.fields;
      if (SHAPE_CODES[tag.code]) {
        if (f && tag.status === 'decoded') characters[f.shapeId] = { type: 'shape', id: f.shapeId, name: tag.name, shape: f, geometry: null };
      } else if (tag.code === 39 && tag.children && tag.status !== 'invalid') {
        var timeline = buildTimeline(tag.children);
        characters[tag.spriteId] = { type: 'sprite', id: tag.spriteId, name: tag.name, frames: timeline.frames, labels: timeline.labels };
      } else if (CHARACTER_TAGS[tag.code] && tag.length >= 2) {
        var data = swf.getTagData(tag), id = data[0] | (data[1] << 8);
        characters[id] = { type: 'unsupported', id: id, name: tag.name };
      }
    });
    var root = buildTimeline(swf.tags);
    this.swf = swf;
    this.characters = characters;
    this.root = { type: 'sprite', id: 0, name: 'root', frames: root.frames, labels: root.labels };
  }

  // ---- Timelines and display list ---------------------------------------------------------------------------
  /* A Clip is a running timeline (the root or a sprite instance) with its display list keyed by depth.
     env = { characters, report(feature, reason, source) }. Display objects are
     { depth, characterId, character, matrix, cx, ratio, name, clipDepth, blendMode, clip }. */
  function Clip(env, def, level) {
    this.env = env;
    this.def = def;
    this.level = level;
    this.frame = 0;
    this.loop = true;
    this.displayList = new Map();
  }
  Clip.prototype.createObject = function (characterId) {
    var env = this.env, character = env.characters[characterId];
    var obj = { characterId: characterId, character: character || null, matrix: IDENTITY, cx: CX_IDENTITY, clip: null };
    if (!character) {
      env.report('render:missingCharacter', 'A placement refers to a character id that is not defined; nothing is drawn.', characterId);
    } else if (character.type === 'sprite') {
      if (this.level + 1 > MAX_NESTING) {
        env.report('render:nestingLimit', 'Sprite instances nested deeper than ' + MAX_NESTING + ' levels are not created.', characterId);
      } else {
        obj.clip = new Clip(env, character, this.level + 1);
        obj.clip.gotoFrame(1);
      }
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
  };
  // One tick: existing child sprites advance first; then this timeline moves to its next frame (children it
  // places now start at their frame 1). Returns true when the last frame was passed (looped or stopped).
  Clip.prototype.tick = function () {
    this.displayList.forEach(function (obj) { if (obj.clip) obj.clip.tick(); });
    var count = this.def.frames.length;
    if (count < 2) return false;
    if (this.frame < count) { this.gotoFrame(this.frame + 1); return false; }
    if (this.loop) this.gotoFrame(1);
    return true;
  };
  Clip.prototype.depths = function () {
    return Array.from(this.displayList.keys()).sort(function (a, b) { return a - b; });
  };

  // ---- Canvas 2D renderer -----------------------------------------------------------------------------------
  function CanvasRenderer(canvas, report) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.report = report;
  }
  function geometryOf(character, report) {
    if (!character.geometry) {
      character.geometry = buildShapeGeometry(character.shape);
      character.geometry.problems.forEach(function (p) {
        report('render:invalidStyleIndex', 'A shape refers to a style that does not exist; those edges are skipped.', character.id + ': ' + p);
      });
    }
    return character.geometry;
  }
  function pathOf(entry) {
    if (!entry.path) {
      var p = new Path2D(), c = entry.commands;
      for (var i = 0; i < c.length;) {
        if (c[i] === 0) { p.moveTo(c[i + 1], c[i + 2]); i += 3; }
        else if (c[i] === 1) { p.lineTo(c[i + 1], c[i + 2]); i += 3; }
        else { p.quadraticCurveTo(c[i + 1], c[i + 2], c[i + 3], c[i + 4]); i += 5; }
      }
      entry.path = p;
    }
    return entry.path;
  }
  function domMatrix(m) { return new DOMMatrix([m[0], m[1], m[2], m[3], m[4], m[5]]); }

  CanvasRenderer.prototype.render = function (stage, root) {
    var ctx = this.ctx, canvas = this.canvas, bg = stage.background;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = bg ? 'rgb(' + bg.r + ',' + bg.g + ',' + bg.b + ')' : '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    var sx = canvas.width / stage.widthTwips, sy = canvas.height / stage.heightTwips;
    this.drawClip(root, [sx, 0, 0, sy, -stage.xMin * sx, -stage.yMin * sy], CX_IDENTITY);
  };
  CanvasRenderer.prototype.drawClip = function (clip, matrix, cx) {
    var ctx = this.ctx, depths = clip.depths(), masks = [];
    for (var i = 0; i < depths.length; i++) {
      var depth = depths[i], obj = clip.displayList.get(depth);
      while (masks.length && depth > masks[masks.length - 1]) { ctx.restore(); masks.pop(); }
      var world = multiply(matrix, obj.matrix);
      if (obj.clipDepth) {
        // Mask: everything up to clipDepth is clipped to the union of the mask's fills; the mask is not drawn.
        var maskPath = new Path2D();
        this.collectMask(obj, world, maskPath);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clip(maskPath, 'nonzero');
        masks.push(obj.clipDepth);
        continue;
      }
      if (obj.blendMode > 1) this.report('render:blendMode', 'Blend modes other than normal are drawn as normal.', obj.characterId);
      this.drawObject(obj, world, concatColorTransform(cx, obj.cx));
    }
    while (masks.length) { ctx.restore(); masks.pop(); }
  };
  CanvasRenderer.prototype.collectMask = function (obj, world, maskPath) {
    var character = obj.character, self = this;
    if (!character) return;
    if (character.type === 'shape') {
      var transform = domMatrix(world);
      geometryOf(character, this.report).groups.forEach(function (g) {
        g.fills.forEach(function (fill) { maskPath.addPath(pathOf(fill), transform); });
      });
    } else if (character.type === 'sprite' && obj.clip) {
      obj.clip.depths().forEach(function (d) {
        var child = obj.clip.displayList.get(d);
        if (!child.clipDepth) self.collectMask(child, multiply(world, child.matrix), maskPath);
      });
    }
  };
  CanvasRenderer.prototype.drawObject = function (obj, world, cx) {
    var character = obj.character;
    if (!character) return;
    if (character.type === 'shape') this.drawShape(character, world, cx);
    else if (character.type === 'sprite' && obj.clip) this.drawClip(obj.clip, world, cx);
  };
  CanvasRenderer.prototype.drawShape = function (character, world, cx) {
    var ctx = this.ctx, geometry = geometryOf(character, this.report), self = this;
    var shape = character.shape, scale = Math.sqrt(Math.abs(world[0] * world[3] - world[1] * world[2]));
    if (!scale || !isFinite(scale)) return;
    ctx.setTransform(world[0], world[1], world[2], world[3], world[4], world[5]);
    geometry.groups.forEach(function (g) {
      g.fills.forEach(function (fill) { self.fill(character, fill, geometry.fillRule, cx); });
      g.lines.forEach(function (line) { self.stroke(character, line, cx, scale); });
    });
  };
  CanvasRenderer.prototype.fill = function (character, fill, rule, cx) {
    var ctx = this.ctx, style = fill.style, path = pathOf(fill);
    if (style.type === 'solid') {
      ctx.fillStyle = cssColor(style.color, cx);
      ctx.fill(path, rule);
    } else if (style.type === 'bitmap') {
      this.report('render:bitmapFill', 'Bitmap fills are not drawn yet.', character.id);
    } else {
      this.fillGradient(character, style, path, rule, cx);
    }
  };
  CanvasRenderer.prototype.gradient = function (style, cx) {
    var g = style.gradient, grad;
    if (style.type === 'linear') {
      grad = this.ctx.createLinearGradient(-GRADIENT_HALF, 0, GRADIENT_HALF, 0);
    } else {
      var focal = style.type === 'focal' ? Math.max(-0.98, Math.min(0.98, g.focalPoint)) * GRADIENT_HALF : 0;
      grad = this.ctx.createRadialGradient(focal, 0, 0, 0, 0, GRADIENT_HALF);
    }
    g.stops.forEach(function (s) { grad.addColorStop(s.ratio / 255, cssColor(s.color, cx)); });
    return grad;
  };
  CanvasRenderer.prototype.fillGradient = function (character, style, path, rule, cx) {
    var ctx = this.ctx, g = style.gradient, stops = g.stops;
    if (!stops.length) return;
    if (g.spreadMode) this.report('render:gradientSpread', 'Reflect/repeat gradient spread is drawn as pad.', character.id);
    if (g.interpolationMode) this.report('render:gradientLinearRGB', 'Linear-RGB gradient interpolation is drawn as sRGB.', character.id);
    var gm = toMatrix(style.matrix), inverse = invert(gm);
    if (!inverse) {
      ctx.fillStyle = cssColor(stops[stops.length - 1].color, cx);
      ctx.fill(path, rule);
      return;
    }
    // Paint the gradient in its own space over the shape bounds (mapped there), clipped to the fill path.
    var b = character.shape.bounds, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    [[b.xMin, b.yMin], [b.xMax, b.yMin], [b.xMin, b.yMax], [b.xMax, b.yMax]].forEach(function (p) {
      var q = transformPoint(inverse, p[0], p[1]);
      minX = Math.min(minX, q[0]); maxX = Math.max(maxX, q[0]);
      minY = Math.min(minY, q[1]); maxY = Math.max(maxY, q[1]);
    });
    ctx.save();
    ctx.clip(path, rule);
    ctx.transform(gm[0], gm[1], gm[2], gm[3], gm[4], gm[5]);
    ctx.fillStyle = this.gradient(style, cx);
    ctx.fillRect(minX - 1, minY - 1, maxX - minX + 2, maxY - minY + 2);
    ctx.restore();
  };
  CanvasRenderer.prototype.stroke = function (character, line, cx, scale) {
    var ctx = this.ctx, style = line.style, version = character.shape.shapeVersion;
    if (style.color) {
      ctx.strokeStyle = cssColor(style.color, cx);
    } else if (style.fill && style.fill.type === 'solid') {
      ctx.strokeStyle = cssColor(style.fill.color, cx);
    } else if (style.fill && style.fill.gradient && style.fill.gradient.stops.length) {
      this.report('render:lineFill', 'Gradient/bitmap line fills are drawn with their first colour.', character.id);
      ctx.strokeStyle = cssColor(style.fill.gradient.stops[0].color, cx);
    } else {
      return this.report('render:lineFill', 'Gradient/bitmap line fills are drawn with their first colour.', character.id);
    }
    // Width is in twips and scales with the object; hairlines (and thinner) are at least one device pixel.
    ctx.lineWidth = Math.max(style.width, 1 / scale);
    ctx.lineCap = version === 4 ? CAPS[style.startCap] || 'round' : 'round';
    ctx.lineJoin = version === 4 ? JOINS[style.join] || 'round' : 'round';
    if (style.miterLimit) ctx.miterLimit = style.miterLimit;
    ctx.stroke(pathOf(line));
  };

  // ---- Player -------------------------------------------------------------------------------------------------
  var EVENTS = { load: 1, frame: 1, warning: 1, error: 1, end: 1 };

  function Player(options) {
    options = options || {};
    if (!options.canvas || typeof options.canvas.getContext !== 'function') throw playerError('INVALID_OPTION', 'options.canvas must be a <canvas> element');
    this.canvas = options.canvas;
    this.options = {
      autoplay: !!options.autoplay,
      loop: options.loop !== false,
      maxFileBytes: options.maxFileBytes,
      pixelRatio: options.pixelRatio || global.devicePixelRatio || 1,
      maxCatchUpFrames: options.maxCatchUpFrames || 4
    };
    this.state = 'idle';
    this.listeners = {};
    this.movie = null;
    this.root = null;
    this.unsupported = [];
    this.unsupportedByFeature = Object.create(null);
    this.rafId = 0;
    var self = this;
    this.report = function (feature, reason, source) { self.recordUnsupported(feature, reason, source); };
    this.renderer = new CanvasRenderer(this.canvas, this.report);
  }
  Player.prototype.on = function (type, fn) {
    if (!EVENTS[type]) throw playerError('INVALID_EVENT', 'Unknown event ' + type);
    (this.listeners[type] || (this.listeners[type] = [])).push(fn);
    return this;
  };
  Player.prototype.off = function (type, fn) {
    var list = this.listeners[type];
    if (list) this.listeners[type] = list.filter(function (f) { return f !== fn; });
    return this;
  };
  Player.prototype.emit = function (type, detail) {
    (this.listeners[type] || []).slice().forEach(function (fn) {
      try { fn(detail); } catch (err) { if (global.console) console.error(err); }
    });
  };
  // Aggregated per feature; `count` is the number of distinct sources (character ids, depths).
  Player.prototype.recordUnsupported = function (feature, reason, source) {
    var entry = this.unsupportedByFeature[feature];
    if (!entry) {
      entry = this.unsupportedByFeature[feature] = { feature: feature, reason: reason, count: 0, sources: [] };
      this.unsupported.push(entry);
    }
    var key = String(source);
    if (entry.sources.indexOf(key) === -1) {
      entry.sources.push(key);
      entry.count++;
      if (entry.count === 1) this.emit('warning', entry);
    }
  };
  Player.prototype.assertUsable = function () {
    if (this.state === 'destroyed') throw playerError('DESTROYED', 'The player has been destroyed');
  };
  Player.prototype.load = async function (input) {
    this.assertUsable();
    if (!global.SWFReader) throw playerError('MISSING_READER', 'Load swf-reader.js before retroflash.js');
    this.pause();
    this.state = 'loading';
    this.movie = this.root = null;
    this.unsupported = [];
    this.unsupportedByFeature = Object.create(null);
    var swf;
    try {
      swf = await global.SWFReader.load(input, this.options.maxFileBytes ? { maxFileBytes: this.options.maxFileBytes } : undefined);
    } catch (err) {
      this.state = 'error';
      this.emit('error', err);
      throw err;
    }
    if (this.state === 'destroyed') return null;
    this.movie = new Movie(swf);
    this.fps = swf.fps > 0 ? swf.fps : 12;
    if (!(swf.fps > 0)) this.recordUnsupported('timeline:zeroFps', 'The file declares 0 fps; playing at 12 fps.', 'header');
    this.root = new Clip({ characters: this.movie.characters, report: this.report }, this.movie.root, 0);
    this.root.loop = this.options.loop;
    this.root.gotoFrame(1);
    this.resize();
    this.render();
    this.state = 'ready';
    this.emit('load', this.getInfo());
    if (this.options.autoplay) this.play();
    return this.getInfo();
  };
  Player.prototype.resize = function () {
    var swf = this.movie.swf, ratio = this.options.pixelRatio;
    var width = Math.max(1, swf.width), height = Math.max(1, swf.height);
    this.canvas.width = Math.max(1, Math.min(8192, Math.round(width * ratio)));
    this.canvas.height = Math.max(1, Math.min(8192, Math.round(height * ratio)));
    if (this.canvas.style) { this.canvas.style.width = width + 'px'; this.canvas.style.height = 'auto'; }
  };
  Player.prototype.render = function () {
    var swf = this.movie.swf, b = swf.bounds;
    this.renderer.render({
      background: swf.background, xMin: b.xminTwips, yMin: b.yminTwips,
      widthTwips: Math.max(1, b.xmaxTwips - b.xminTwips), heightTwips: Math.max(1, b.ymaxTwips - b.yminTwips)
    }, this.root);
  };
  Player.prototype.play = function () {
    this.assertUsable();
    if (!this.root || this.state === 'playing') return;
    if (!this.options.loop && this.root.frame === this.root.frameCount()) this.seek(1);
    this.state = 'playing';
    this.lastTime = null;
    this.accumulator = 0;
    var self = this;
    this.rafId = global.requestAnimationFrame(function (t) { self.loop(t); });
  };
  Player.prototype.pause = function () {
    if (this.rafId) global.cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    if (this.state === 'playing') this.state = 'paused';
  };
  Player.prototype.stop = function () {
    this.pause();
    if (this.root) this.seek(1);
  };
  // Advances exactly one frame (root and every sprite instance), then renders.
  Player.prototype.step = function () {
    this.assertUsable();
    if (!this.root) return;
    this.advance();
    this.render();
    this.emit('frame', this.root.frame);
  };
  // frame: 1-based number or frame label. Sprite instances that persist keep their own playhead.
  Player.prototype.seek = function (frame) {
    this.assertUsable();
    if (!this.root) throw playerError('NOT_LOADED', 'No movie loaded');
    var n = typeof frame === 'string' ? this.movie.root.labels[frame] : frame;
    if (!Number.isFinite(n)) throw playerError('INVALID_FRAME', 'Unknown frame ' + JSON.stringify(frame));
    this.root.gotoFrame(n);
    this.render();
    this.emit('frame', this.root.frame);
  };
  Player.prototype.advance = function () {
    if (this.root.tick()) {
      this.emit('end', this.root.frame);
      if (!this.options.loop) this.pause();
    }
  };
  Player.prototype.loop = function (time) {
    if (this.state !== 'playing') return;
    var self = this, duration = 1000 / this.fps, steps = 0;
    if (this.lastTime !== null) this.accumulator += time - this.lastTime;
    this.lastTime = time;
    while (this.accumulator >= duration && steps < this.options.maxCatchUpFrames && this.state === 'playing') {
      this.advance();
      this.accumulator -= duration;
      steps++;
    }
    if (steps === this.options.maxCatchUpFrames) this.accumulator = Math.min(this.accumulator, duration); // drop frames, don't spiral
    if (steps) { this.render(); this.emit('frame', this.root.frame); }
    if (this.state === 'playing') this.rafId = global.requestAnimationFrame(function (t) { self.loop(t); });
  };
  Player.prototype.getInfo = function () {
    var swf = this.movie && this.movie.swf;
    return {
      state: this.state, playerVersion: VERSION,
      signature: swf ? swf.signature : null, version: swf ? swf.version : null,
      width: swf ? swf.width : 0, height: swf ? swf.height : 0, fps: swf ? this.fps : 0,
      frameCount: this.root ? this.root.frameCount() : 0, currentFrame: this.root ? this.root.frame : 0,
      labels: this.movie ? Object.assign({}, this.movie.root.labels) : {}
    };
  };
  Player.prototype.getDiagnostics = function () {
    var swf = this.movie && this.movie.swf;
    return {
      diagnostics: swf ? swf.diagnostics.slice() : [],
      unsupported: (swf ? swf.unsupported : []).concat(this.unsupported.map(function (u) {
        return { feature: u.feature, reason: u.reason, count: u.count, sources: u.sources.slice() };
      }))
    };
  };
  Player.prototype.destroy = function () {
    this.pause();
    this.state = 'destroyed';
    this.listeners = {};
    this.movie = this.root = null;
  };

  global.RetroFlash = Object.freeze({
    version: VERSION,
    Player: Player,
    // Building blocks exposed for tests and tooling; not a stable API.
    internals: Object.freeze({
      buildShapeGeometry: buildShapeGeometry, buildTimeline: buildTimeline, Movie: Movie, Clip: Clip,
      multiply: multiply, invert: invert, toMatrix: toMatrix, toColorTransform: toColorTransform,
      concatColorTransform: concatColorTransform, cssColor: cssColor
    })
  });
})(typeof window !== 'undefined' ? window : globalThis);
