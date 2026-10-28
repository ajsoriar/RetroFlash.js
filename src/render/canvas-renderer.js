/* RetroFlash.js - Canvas 2D renderer. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;
  var toMatrix = M.toMatrix, multiply = M.multiply, invert = M.invert, transformPoint = M.transformPoint,
    CX_IDENTITY = M.CX_IDENTITY, concatColorTransform = M.concatColorTransform, cssColor = M.cssColor,
    geometryOf = M.geometryOf, shapeOf = M.shapeOf, morphFrame = M.morphFrame, TEXT_BLACK = M.TEXT_BLACK, glyphCommands = M.glyphCommands,
    staticTextGlyphs = M.staticTextGlyphs, GUTTER = M.GUTTER, DEVICE_ASCENT = M.DEVICE_ASCENT,
    DEVICE_DESCENT = M.DEVICE_DESCENT, layoutEditText = M.layoutEditText, textFieldText = M.textFieldText,
    createCanvas = M.createCanvas, contentBounds = M.contentBounds;

  var GRADIENT_HALF = 16384;      // SWF gradients are defined on a 32768-twip square centred on the origin
  var MAX_GRADIENT_PERIODS = 512; // repetitions of a reflect/repeat gradient drawn over one fill
  var MAX_TINT_PIXELS = 2048 * 2048, TINTS_PER_BITMAP = 4; // tinted bitmap copies (per-channel colour transforms)

  var CAPS = ['round', 'butt', 'square'];
  var JOINS = ['round', 'bevel', 'miter'];

  function CanvasRenderer(canvas, report) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.report = report;
    this.measure = canvasMeasure(this.ctx);
  }
  // Device-font measurement for layoutEditText. Ascent and descent come from the font's own metrics when the
  // browser reports them (fontBoundingBox*), otherwise from typical sans-serif proportions.
  function canvasMeasure(ctx) {
    var metrics = new Map();
    return {
      width: function (css, text) { ctx.font = css; return ctx.measureText(text).width; },
      metrics: function (css, size) {
        var m = metrics.get(css);
        if (!m) {
          ctx.font = css;
          var t = ctx.measureText('Mg');
          m = t.fontBoundingBoxAscent !== undefined ? { ascent: t.fontBoundingBoxAscent, descent: t.fontBoundingBoxDescent }
            : { ascent: DEVICE_ASCENT * size, descent: DEVICE_DESCENT * size };
          metrics.set(css, m);
        }
        return m;
      }
    };
  }
  function glyphPath(glyph) {
    glyphCommands(glyph);
    return pathOf(glyph);
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
    this.characters = stage.characters;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = bg ? 'rgb(' + bg.r + ',' + bg.g + ',' + bg.b + ')' : '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    var sx = canvas.width / stage.widthTwips, sy = canvas.height / stage.heightTwips;
    this.stageX = sx; // device pixels per twip at stage level (non-scaling strokes, 9-slice scaling)
    this.stageY = sy;
    // The root's own display object holds what scripts set on _root (_x, _alpha, _visible, ...).
    var top = root.displayObject();
    if (top.visible === false) return;
    this.drawClip(root, multiply([sx, 0, 0, sy, -stage.xMin * sx, -stage.yMin * sy], top.matrix), top.cx);
  };
  /* A clip or button instance. Its bitmap fills and fonts come from its own movie (one loaded into a clip has its
     own). `nine` is its 9-slice mapping (see nineSlice), or null. */
  CanvasRenderer.prototype.drawClip = function (clip, matrix, cx, nine) {
    var outer = this.characters;
    if (clip.env && clip.env.characters) this.characters = clip.env.characters;
    try {
      this.drawList(clip, matrix, cx, nine);
    } finally {
      this.characters = outer;
    }
  };
  CanvasRenderer.prototype.drawList = function (clip, matrix, cx, nine) {
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
      if (obj.visible === false) continue; // _visible = false (masks still mask)
      if (obj.blendMode > 1) this.report('render:blendMode', 'Blend modes other than normal are drawn as normal.', obj.characterId);
      this.drawObject(obj, world, concatColorTransform(cx, obj.cx), nine);
    }
    while (masks.length) { ctx.restore(); masks.pop(); }
  };
  CanvasRenderer.prototype.collectMask = function (obj, world, maskPath) {
    var character = obj.character, self = this;
    if (!character) return;
    if (character.type === 'shape' || character.type === 'morphShape') {
      var transform = domMatrix(world);
      geometryOf(shapeOf(obj, this.report), this.report).groups.forEach(function (g) {
        g.fills.forEach(function (fill) { maskPath.addPath(pathOf(fill), transform); });
      });
    } else if (character.type === 'text') {
      var base = multiply(world, toMatrix(character.text.matrix));
      this.textGlyphs(character).forEach(function (p) {
        maskPath.addPath(glyphPath(p.glyph), domMatrix(multiply(base, [p.scale, 0, 0, p.scale, p.x, p.y])));
      });
    } else if (character.type === 'editText') {
      this.report('render:textMask', 'Text fields used as masks do not mask anything yet.', character.id);
    } else if ((character.type === 'sprite' && obj.clip) || (character.type === 'button' && obj.button)) {
      var container = obj.clip || obj.button, outer = this.characters;
      if (container.env && container.env.characters) this.characters = container.env.characters;
      try {
        container.depths().forEach(function (d) {
          var child = container.displayList.get(d);
          if (!child.clipDepth) self.collectMask(child, multiply(world, child.matrix), maskPath);
        });
      } finally {
        this.characters = outer;
      }
    }
  };
  CanvasRenderer.prototype.drawObject = function (obj, world, cx, nine) {
    var character = obj.character;
    if (!character) return;
    if (character.type === 'shape' || character.type === 'morphShape') {
      var shape = character.type === 'shape' ? character : morphFrame(character, obj.ratio, this.report);
      this.drawShape(shape, world, cx, nine ? this.nineGeometry(obj, shape, nine) : null);
    }
    else if (character.type === 'sprite' && obj.clip) this.drawClip(obj.clip, world, cx, this.nineSlice(character, obj, world));
    else if (character.type === 'button' && obj.button) this.drawClip(obj.button, world, cx, this.nineSlice(character, obj, world));
    else if (character.type === 'bitmap') this.drawBitmap(character, world, cx);
    else if (character.type === 'text') this.drawText(character, world, cx);
    else if (character.type === 'editText') this.drawEditText(character, world, cx, obj);
  };
  /* The layout of a text field: shared by every instance of the character, or, for a field bound to a
     variable, the instance's own, laid out again whenever its text changes. */
  CanvasRenderer.prototype.editTextLayout = function (character, obj) {
    if (!obj || !obj.binding) return character.layout || (character.layout = layoutEditText(character, this.characters, this.measure, this.report));
    var text = textFieldText(obj);
    if (!obj.layout || obj.layoutText !== text) {
      obj.layoutText = text;
      obj.layout = layoutEditText(character, this.characters, this.measure, this.report, text);
    }
    return obj.layout;
  };
  CanvasRenderer.prototype.textGlyphs = function (character) {
    return character.glyphs || (character.glyphs = staticTextGlyphs(character, this.characters, this.report));
  };
  // DefineText: each glyph is filled with its record's colour (even-odd, like other shapes).
  CanvasRenderer.prototype.drawText = function (character, world, cx) {
    var ctx = this.ctx, base = multiply(world, toMatrix(character.text.matrix));
    this.textGlyphs(character).forEach(function (p) {
      var m = multiply(base, [p.scale, 0, 0, p.scale, p.x, p.y]);
      ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
      ctx.fillStyle = cssColor(p.color, cx);
      ctx.fill(glyphPath(p.glyph), 'evenodd');
    });
  };
  /* Text field: optional border (white background, black frame), then the text clipped to the bounds narrowed
     by the gutter horizontally. As in Flash Player, a field that uses device fonts is not drawn when it is
     rotated, skewed or mirrored. */
  CanvasRenderer.prototype.drawEditText = function (character, world, cx, obj) {
    var ctx = this.ctx, field = character.field, scale = Math.sqrt(Math.abs(world[0] * world[3] - world[1] * world[2]));
    if (!scale || !isFinite(scale)) return;
    if (!field.useOutlines && (Math.abs(world[1]) > 0.006 * scale || Math.abs(world[2]) > 0.006 * scale || world[0] <= 0 || world[3] <= 0)) {
      return this.report('render:deviceTextTransform', 'Text fields with device fonts are not drawn when rotated, skewed or mirrored (as in Flash Player).', character.id);
    }
    var layout = this.editTextLayout(character, obj);
    var b = layout.bounds, width = b.xMax - b.xMin, height = b.yMax - b.yMin;
    ctx.setTransform(world[0], world[1], world[2], world[3], world[4], world[5]);
    if (field.border) {
      ctx.fillStyle = cssColor({ r: 255, g: 255, b: 255, a: 255 }, cx);
      ctx.fillRect(b.xMin, b.yMin, width, height);
      ctx.strokeStyle = cssColor(TEXT_BLACK, cx);
      ctx.lineWidth = 1 / scale;
      ctx.strokeRect(b.xMin, b.yMin, width, height);
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(b.xMin + GUTTER, b.yMin, Math.max(0, width - 2 * GUTTER), height);
    ctx.clip();
    var self = this;
    layout.lines.forEach(function (line) {
      line.runs.forEach(function (run) { self.drawTextRun(run, world, cx, scale); });
    });
    ctx.restore();
  };
  CanvasRenderer.prototype.drawTextRun = function (run, world, cx, scale) {
    var ctx = this.ctx, face = run.face, c = run.format.color, x = run.x;
    ctx.fillStyle = cssColor({ r: c.r, g: c.g, b: c.b, a: 255 }, cx);
    if (face.font) {
      var font = face.font, k = face.scale;
      for (var i = 0; i < run.text.length; i++) {
        var index = font.byCode.get(run.text.charCodeAt(i));
        if (index === undefined) {
          if (run.text.charAt(i) !== ' ') this.report('text:missingGlyph', 'A text field uses a character its embedded font has no glyph for; not drawn.', font.id + ': ' + run.text.charAt(i));
          continue;
        }
        var glyph = font.glyphs[index], m = multiply(world, [k, 0, 0, k, x, run.baseline]);
        ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
        ctx.fill(glyphPath(glyph), 'evenodd');
        x += glyph.advance * k;
      }
    } else {
      // Device fonts are drawn in pixel units (1 px = 20 twips) so that font sizes stay ordinary.
      ctx.setTransform(world[0] * 20, world[1] * 20, world[2] * 20, world[3] * 20, world[4], world[5]);
      ctx.font = face.css;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.fillText(run.text, run.x / 20, run.baseline / 20);
    }
    if (run.format.underline && run.width) {
      ctx.setTransform(world[0], world[1], world[2], world[3], world[4], world[5]);
      var thickness = Math.max(run.format.size, 1);
      ctx.fillRect(run.x, run.baseline + thickness * 2, run.width, Math.max(thickness, 1 / scale));
    }
  };
  /* A bitmap under colour transform `cx`: { source, alpha }. A transform that only scales alpha keeps the image
     and becomes `alpha`; any other is applied to the pixels of a copy (the latest TINTS_PER_BITMAP are kept per
     bitmap). A bitmap too large for that, one whose pixels cannot be read, or no canvas at all, falls back to
     the alpha multiplier and is reported. */
  CanvasRenderer.prototype.bitmapImage = function (bitmap, cx, source) {
    var alpha = Math.max(0, Math.min(1, cx[3]));
    if (cx[0] === 1 && cx[1] === 1 && cx[2] === 1 && !cx[4] && !cx[5] && !cx[6] && !cx[7]) return { source: bitmap.source, alpha: alpha };
    var tinted = tint(bitmap, cx);
    if (tinted) return { source: tinted, alpha: cx[7] ? 1 : alpha };
    this.report('render:bitmapColorTransform', 'A bitmap could not be tinted (too large, unreadable, or no canvas); only the alpha multiplier of its colour transform is applied.', source);
    return { source: bitmap.source, alpha: alpha };
  };
  function tint(bitmap, cx) {
    var withAlpha = !!cx[7], key = (withAlpha ? cx : [cx[0], cx[1], cx[2], cx[4], cx[5], cx[6]]).join(',');
    var tints = bitmap.tints || (bitmap.tints = new Map()), found = tints.get(key);
    if (found) return found;
    var w = bitmap.width, h = bitmap.height, canvas = null;
    if (!w || !h || w * h > MAX_TINT_PIXELS) return null;
    try {
      canvas = createCanvas(w, h);
      var c = canvas.getContext('2d');
      c.drawImage(bitmap.source, 0, 0);
      var image = c.getImageData(0, 0, w, h), d = image.data;
      for (var i = 0; i < d.length; i += 4) {
        d[i] = d[i] * cx[0] + cx[4];
        d[i + 1] = d[i + 1] * cx[1] + cx[5];
        d[i + 2] = d[i + 2] * cx[2] + cx[6];
        if (withAlpha) d[i + 3] = d[i + 3] * cx[3] + cx[7];
      }
      c.putImageData(image, 0, 0);
    } catch (err) {
      return null; // no canvas here, or a cross-origin image whose pixels cannot be read
    }
    if (tints.size >= TINTS_PER_BITMAP) tints.delete(tints.keys().next().value);
    tints.set(key, canvas);
    return canvas;
  }
  // A bitmap character placed directly: one bitmap pixel = 20 twips.
  CanvasRenderer.prototype.drawBitmap = function (character, world, cx) {
    if (!character.source) return;
    var ctx = this.ctx, image = this.bitmapImage(character, cx, character.id);
    ctx.setTransform(world[0], world[1], world[2], world[3], world[4], world[5]);
    ctx.globalAlpha = image.alpha;
    ctx.drawImage(image.source, 0, 0, character.width * 20, character.height * 20);
    ctx.globalAlpha = 1;
  };
  /* 9-slice scaling (DefineScalingGrid) of a sprite or button placed with `world`: { x, y }, functions that move
     a coordinate of its own space so that, once scaled, the parts outside the grid keep their size. The corners
     keep it in both directions, the edges in one, and the centre takes the rest; a clip scaled below the size
     of its corners shrinks them evenly. Only shapes directly in the clip follow it. A rotated or skewed clip,
     or one that is not scaled, is drawn as it is (as in Flash Player). */
  CanvasRenderer.prototype.nineSlice = function (character, obj, world) {
    var grid = character.scalingGrid;
    if (!grid || world[1] || world[2] || !this.stageX) return null;
    var kx = Math.abs(world[0] / this.stageX), ky = Math.abs(world[3] / this.stageY);
    if (Math.abs(kx - 1) < 1e-9 && Math.abs(ky - 1) < 1e-9) return null;
    var b = contentBounds(obj);
    if (!b || !kx || !ky) return null;
    return { x: sliceAxis(b.xMin, b.xMax, grid.xMin, grid.xMax, kx), y: sliceAxis(b.yMin, b.yMax, grid.yMin, grid.yMax, ky) };
  };
  function sliceAxis(b0, b1, g0, g1, k) {
    g0 = Math.max(b0, Math.min(b1, g0));
    g1 = Math.max(g0, Math.min(b1, g1));
    var outer = (g0 - b0) + (b1 - g1), c = outer > 0 ? Math.min(1 / k, (b1 - b0) / outer) : 1 / k;
    var low = b0 + (g0 - b0) * c, high = b1 - (b1 - g1) * c;
    return function (v) {
      if (v <= g0) return b0 + (v - b0) * c;
      if (v >= g1) return b1 - (b1 - v) * c;
      return low + (v - g0) * (high - low) / (g1 - g0);
    };
  }
  // The geometry of a shape placed with obj.matrix inside a 9-slice clip, its points moved by `nine`.
  CanvasRenderer.prototype.nineGeometry = function (obj, shape, nine) {
    var m = obj.matrix, inverse = invert(m), geometry = geometryOf(shape, this.report);
    if (!inverse) return geometry;
    function move(c) {
      var out = c.slice();
      for (var i = 0; i < c.length;) {
        var points = c[i] === 2 ? 2 : 1;
        i++;
        for (var k = 0; k < points; k++, i += 2) {
          var p = transformPoint(m, c[i], c[i + 1]), q = transformPoint(inverse, nine.x(p[0]), nine.y(p[1]));
          out[i] = q[0];
          out[i + 1] = q[1];
        }
      }
      return out;
    }
    function moved(entry) { return { style: entry.style, commands: move(entry.commands) }; }
    return {
      fillRule: geometry.fillRule, problems: [],
      groups: geometry.groups.map(function (g) { return { fills: g.fills.map(moved), lines: g.lines.map(moved) }; })
    };
  };
  CanvasRenderer.prototype.drawShape = function (character, world, cx, moved) {
    var ctx = this.ctx, geometry = moved || geometryOf(character, this.report), self = this;
    var shape = character.shape, scale = Math.sqrt(Math.abs(world[0] * world[3] - world[1] * world[2]));
    if (!scale || !isFinite(scale)) return;
    ctx.setTransform(world[0], world[1], world[2], world[3], world[4], world[5]);
    geometry.groups.forEach(function (g) {
      g.fills.forEach(function (fill) { self.fill(character, fill, geometry.fillRule, cx); });
      g.lines.forEach(function (line) { self.stroke(character, line, cx, scale, world); });
    });
  };
  CanvasRenderer.prototype.fill = function (character, fill, rule, cx) {
    var ctx = this.ctx, style = fill.style, path = pathOf(fill);
    if (style.type === 'solid') {
      ctx.fillStyle = cssColor(style.color, cx);
      ctx.fill(path, rule);
      return;
    }
    ctx.save();
    ctx.clip(path, rule);
    this.paint(ctx, character, style, cx, character.shape.bounds);
    ctx.restore();
  };
  // Paints a gradient or bitmap fill over `bounds` (shape space) on `target`, which is already clipped.
  CanvasRenderer.prototype.paint = function (target, character, style, cx, bounds) {
    if (style.type === 'bitmap') this.paintBitmap(target, character, style, cx, bounds);
    else if (style.gradient) this.paintGradient(target, character, style, cx, bounds);
  };
  // Shape bounds mapped into the space of `inverse` (gradient or bitmap space), as [x, y, width, height].
  function boundsIn(inverse, b) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    [[b.xMin, b.yMin], [b.xMax, b.yMin], [b.xMin, b.yMax], [b.xMax, b.yMax]].forEach(function (p) {
      var q = transformPoint(inverse, p[0], p[1]);
      minX = Math.min(minX, q[0]); maxX = Math.max(maxX, q[0]);
      minY = Math.min(minY, q[1]); maxY = Math.max(maxY, q[1]);
    });
    return [minX - 1, minY - 1, maxX - minX + 2, maxY - minY + 2];
  }
  /* Bitmap fill: the fill matrix maps bitmap pixels to shape twips. Repeating fills tile a pattern over the
     shape; clipped fills draw the image once and, as Flash Player does, extend its edge pixels beyond it. */
  CanvasRenderer.prototype.paintBitmap = function (ctx, character, style, cx, bounds) {
    var bitmap = this.characters && this.characters[style.bitmapId];
    if (!bitmap || bitmap.type !== 'bitmap') {
      // Flash uses bitmap id 65535 for "no bitmap"; anything else missing is worth reporting.
      if (style.bitmapId !== 65535) this.report('render:missingBitmap', 'A bitmap fill refers to a bitmap that is not defined; not drawn.', character.id + ' → ' + style.bitmapId);
      return;
    }
    if (!bitmap.source) return; // decode failure, already reported
    var m = toMatrix(style.matrix), inverse = invert(m);
    if (!inverse) return;
    var image = this.bitmapImage(bitmap, cx, character.id), area = boundsIn(inverse, bounds);
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.globalAlpha = image.alpha;
    ctx.imageSmoothingEnabled = style.smooth;
    if (style.repeat) {
      ctx.fillStyle = ctx.createPattern(image.source, 'repeat');
      ctx.fillRect(area[0], area[1], area[2], area[3]);
    } else {
      ctx.drawImage(image.source, 0, 0);
      extendEdges(ctx, image.source, bitmap.width, bitmap.height, area);
    }
  };
  // The edge rows, columns and corner pixels of a w x h image stretched out to cover `area` (bitmap pixels).
  function extendEdges(ctx, image, w, h, area) {
    var x0 = area[0], y0 = area[1], x1 = area[0] + area[2], y1 = area[1] + area[3];
    if (x0 < 0) ctx.drawImage(image, 0, 0, 1, h, x0, 0, -x0, h);
    if (x1 > w) ctx.drawImage(image, w - 1, 0, 1, h, w, 0, x1 - w, h);
    if (y0 < 0) ctx.drawImage(image, 0, 0, w, 1, 0, y0, w, -y0);
    if (y1 > h) ctx.drawImage(image, 0, h - 1, w, 1, 0, h, w, y1 - h);
    if (x0 < 0 && y0 < 0) ctx.drawImage(image, 0, 0, 1, 1, x0, y0, -x0, -y0);
    if (x1 > w && y0 < 0) ctx.drawImage(image, w - 1, 0, 1, 1, w, y0, x1 - w, -y0);
    if (x0 < 0 && y1 > h) ctx.drawImage(image, 0, h - 1, 1, 1, x0, h, -x0, y1 - h);
    if (x1 > w && y1 > h) ctx.drawImage(image, w - 1, h - 1, 1, 1, w, h, x1 - w, y1 - h);
  }
  /* The Canvas gradient of `style` over `area` (gradient space, [x, y, width, height]). Pad (spread 0) is
     Canvas's own behaviour. Reflect (1) and repeat (2) become one gradient over every period that `area`
     reaches, each with the stops in order (or reversed, every other period, when reflecting). A focal gradient's
     periods continue its cone: the end circle moves on along the line from the focal point through the
     centre. More than MAX_GRADIENT_PERIODS periods are drawn as pad and reported. */
  CanvasRenderer.prototype.gradient = function (target, style, cx, area, source) {
    var g = style.gradient, H = GRADIENT_HALF, spread = g.spreadMode === 1 || g.spreadMode === 2 ? g.spreadMode : 0;
    var focal = style.type === 'focal' ? Math.max(-0.98, Math.min(0.98, g.focalPoint)) * H : 0, from = 0, to = 1;
    if (spread && style.type === 'linear') {
      from = Math.floor((area[0] + H) / (2 * H));
      to = Math.max(from + 1, Math.ceil((area[0] + area[2] + H) / (2 * H)));
    } else if (spread) {
      var reach = 0;
      [[area[0], area[1]], [area[0] + area[2], area[1]], [area[0], area[1] + area[3]], [area[0] + area[2], area[1] + area[3]]].forEach(function (p) {
        reach = Math.max(reach, Math.sqrt(p[0] * p[0] + p[1] * p[1]));
      });
      to = Math.max(1, Math.ceil((reach + Math.abs(focal)) / (H - Math.abs(focal))));
    }
    if (to - from > MAX_GRADIENT_PERIODS) {
      this.report('render:gradientSpread', 'A reflect/repeat gradient repeats more than ' + MAX_GRADIENT_PERIODS + ' times over its fill; it is drawn as pad.', source);
      spread = 0; from = 0; to = 1;
    }
    var grad = style.type === 'linear' ? target.createLinearGradient(-H + from * 2 * H, 0, -H + to * 2 * H, 0)
      : target.createRadialGradient(focal, 0, 0, focal * (1 - to), 0, H * to);
    addStops(grad, g.stops, spread, from, to, cx);
    return grad;
  };
  // Each period from `from` to `to` gets the stops, padded to its ends with its first and last colours.
  function addStops(grad, stops, spread, from, to, cx) {
    var span = to - from, n = stops.length;
    for (var k = from; k < to; k++) {
      var reversed = spread === 1 && k % 2 !== 0, base = (k - from) / span;
      for (var i = 0; i < n; i++) {
        var s = reversed ? stops[n - 1 - i] : stops[i], at = reversed ? 1 - s.ratio / 255 : s.ratio / 255;
        if (i === 0) grad.addColorStop(base, cssColor(s.color, cx));
        grad.addColorStop(Math.max(0, Math.min(1, base + at / span)), cssColor(s.color, cx));
        if (i === n - 1) grad.addColorStop(Math.min(1, base + 1 / span), cssColor(s.color, cx));
      }
    }
  }
  CanvasRenderer.prototype.paintGradient = function (ctx, character, style, cx, bounds) {
    var g = style.gradient, stops = g.stops;
    if (!stops.length) return;
    if (g.interpolationMode) this.report('render:gradientLinearRGB', 'Linear-RGB gradient interpolation is drawn as sRGB.', character.id);
    var gm = toMatrix(style.matrix), inverse = invert(gm);
    if (!inverse) {
      ctx.fillStyle = cssColor(stops[stops.length - 1].color, cx);
      ctx.fillRect(bounds.xMin - 1, bounds.yMin - 1, bounds.xMax - bounds.xMin + 2, bounds.yMax - bounds.yMin + 2);
      return;
    }
    // Paint the gradient in its own space over the bounds (mapped there).
    var area = boundsIn(inverse, bounds);
    ctx.transform(gm[0], gm[1], gm[2], gm[3], gm[4], gm[5]);
    ctx.fillStyle = this.gradient(ctx, style, cx, area, character.id);
    ctx.fillRect(area[0], area[1], area[2], area[3]);
  };
  CanvasRenderer.prototype.stroke = function (character, line, cx, scale, world) {
    var ctx = this.ctx, style = line.style, version = character.shape.shapeVersion;
    ctx.lineWidth = this.strokeWidth(style, version, scale, world);
    ctx.lineCap = version === 4 ? CAPS[style.startCap] || 'round' : 'round';
    ctx.lineJoin = version === 4 ? JOINS[style.join] || 'round' : 'round';
    ctx.miterLimit = style.miterLimit || 3;
    if (style.color || (style.fill && style.fill.type === 'solid')) {
      ctx.strokeStyle = cssColor(style.color || style.fill.color, cx);
      ctx.stroke(pathOf(line));
    } else if (style.fill) {
      this.strokeFill(character, line, cx);
    }
  };
  /* Stroke width in shape units. It is in twips and scales with the object; LINESTYLE2 NoHScale/NoVScale keep it
     from scaling with the object horizontally/vertically (both: the width it has on the stage, whatever the
     object's scale; one: scaled by the object's scale on the other axis). Hairlines (and thinner) are at least
     one device pixel. */
  CanvasRenderer.prototype.strokeWidth = function (style, version, scale, world) {
    var width = style.width;
    if (version === 4 && (style.noHScale || style.noVScale) && world && this.stageX) {
      var sx = Math.sqrt(world[0] * world[0] + world[1] * world[1]) / Math.abs(this.stageX);
      var sy = Math.sqrt(world[2] * world[2] + world[3] * world[3]) / Math.abs(this.stageY);
      var k = style.noHScale && style.noVScale ? 1 : style.noHScale ? sy : sx;
      width = style.width * k * Math.sqrt(Math.abs(this.stageX * this.stageY)) / scale;
    }
    return Math.max(width, 1 / scale);
  };
  /* A gradient or bitmap line fill (LINESTYLE2 HasFill): the stroke is drawn on a layer the size of the canvas,
     the fill is painted over it where the stroke is ('source-in'), and the layer is drawn on the canvas. Without
     a canvas for the layer, the stroke takes the fill's first colour and is reported. */
  CanvasRenderer.prototype.strokeFill = function (character, line, cx) {
    var ctx = this.ctx, fill = line.style.fill, layer = this.layer();
    if (!layer) {
      this.report('render:lineFill', 'Gradient and bitmap line fills need a canvas for a layer; drawn with their first colour.', character.id);
      if (!fill.gradient || !fill.gradient.stops.length) return;
      ctx.strokeStyle = cssColor(fill.gradient.stops[0].color, cx);
      return ctx.stroke(pathOf(line));
    }
    var l = layer.getContext('2d'), b = character.shape.bounds, pad = ctx.lineWidth + 20;
    l.save();
    l.setTransform(1, 0, 0, 1, 0, 0);
    l.clearRect(0, 0, layer.width, layer.height);
    l.setTransform(ctx.getTransform());
    ['lineWidth', 'lineCap', 'lineJoin', 'miterLimit'].forEach(function (k) { l[k] = ctx[k]; });
    l.strokeStyle = '#000';
    l.stroke(pathOf(line));
    l.globalCompositeOperation = 'source-in';
    this.paint(l, character, fill, cx, { xMin: b.xMin - pad, yMin: b.yMin - pad, xMax: b.xMax + pad, yMax: b.yMax + pad });
    l.restore();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
  };
  // The canvas-sized layer for line fills, or null where no canvas can be made.
  CanvasRenderer.prototype.layer = function () {
    var w = this.canvas.width, h = this.canvas.height;
    if (this.layerCanvas && this.layerCanvas.width === w && this.layerCanvas.height === h) return this.layerCanvas;
    try { this.layerCanvas = createCanvas(w, h); } catch (err) { this.layerCanvas = null; }
    return this.layerCanvas;
  };

  Object.assign(M, { CanvasRenderer: CanvasRenderer });
})(typeof window !== 'undefined' ? window : globalThis);
