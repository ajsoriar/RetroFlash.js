/* RetroFlash.js - Canvas 2D renderer. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;
  var toMatrix = M.toMatrix, multiply = M.multiply, invert = M.invert, transformPoint = M.transformPoint,
    CX_IDENTITY = M.CX_IDENTITY, concatColorTransform = M.concatColorTransform, cssColor = M.cssColor,
    geometryOf = M.geometryOf, TEXT_BLACK = M.TEXT_BLACK, glyphCommands = M.glyphCommands,
    staticTextGlyphs = M.staticTextGlyphs, GUTTER = M.GUTTER, DEVICE_ASCENT = M.DEVICE_ASCENT,
    DEVICE_DESCENT = M.DEVICE_DESCENT, layoutEditText = M.layoutEditText;

  var GRADIENT_HALF = 16384;      // SWF gradients are defined on a 32768-twip square centred on the origin

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
    } else if (character.type === 'text') {
      var base = multiply(world, toMatrix(character.text.matrix));
      this.textGlyphs(character).forEach(function (p) {
        maskPath.addPath(glyphPath(p.glyph), domMatrix(multiply(base, [p.scale, 0, 0, p.scale, p.x, p.y])));
      });
    } else if (character.type === 'editText') {
      this.report('render:textMask', 'Text fields used as masks do not mask anything yet.', character.id);
    } else if ((character.type === 'sprite' && obj.clip) || (character.type === 'button' && obj.button)) {
      var container = obj.clip || obj.button;
      container.depths().forEach(function (d) {
        var child = container.displayList.get(d);
        if (!child.clipDepth) self.collectMask(child, multiply(world, child.matrix), maskPath);
      });
    }
  };
  CanvasRenderer.prototype.drawObject = function (obj, world, cx) {
    var character = obj.character;
    if (!character) return;
    if (character.type === 'shape') this.drawShape(character, world, cx);
    else if (character.type === 'sprite' && obj.clip) this.drawClip(obj.clip, world, cx);
    else if (character.type === 'button' && obj.button) this.drawClip(obj.button, world, cx);
    else if (character.type === 'bitmap') this.drawBitmap(character, world, cx);
    else if (character.type === 'text') this.drawText(character, world, cx);
    else if (character.type === 'editText') this.drawEditText(character, world, cx);
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
  CanvasRenderer.prototype.drawEditText = function (character, world, cx) {
    var ctx = this.ctx, field = character.field, scale = Math.sqrt(Math.abs(world[0] * world[3] - world[1] * world[2]));
    if (!scale || !isFinite(scale)) return;
    if (!field.useOutlines && (Math.abs(world[1]) > 0.006 * scale || Math.abs(world[2]) > 0.006 * scale || world[0] <= 0 || world[3] <= 0)) {
      return this.report('render:deviceTextTransform', 'Text fields with device fonts are not drawn when rotated, skewed or mirrored (as in Flash Player).', character.id);
    }
    var layout = character.layout || (character.layout = layoutEditText(character, this.characters, this.measure, this.report));
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
  // Canvas cannot apply per-channel colour transforms to images; only the alpha multiplier is applied.
  CanvasRenderer.prototype.bitmapAlpha = function (cx, source) {
    if (cx[0] !== 1 || cx[1] !== 1 || cx[2] !== 1 || cx[4] || cx[5] || cx[6] || cx[7]) {
      this.report('render:bitmapColorTransform', 'Colour transforms on bitmaps apply only their alpha multiplier.', source);
    }
    return Math.max(0, Math.min(1, cx[3]));
  };
  // A bitmap character placed directly: one bitmap pixel = 20 twips.
  CanvasRenderer.prototype.drawBitmap = function (character, world, cx) {
    if (!character.source) return;
    var ctx = this.ctx;
    ctx.setTransform(world[0], world[1], world[2], world[3], world[4], world[5]);
    ctx.globalAlpha = this.bitmapAlpha(cx, character.id);
    ctx.drawImage(character.source, 0, 0, character.width * 20, character.height * 20);
    ctx.globalAlpha = 1;
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
      this.fillBitmap(character, style, path, rule, cx);
    } else {
      this.fillGradient(character, style, path, rule, cx);
    }
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
     shape; clipped fills draw the image once (Flash extends the edge pixels beyond it; that is not reproduced). */
  CanvasRenderer.prototype.fillBitmap = function (character, style, path, rule, cx) {
    var bitmap = this.characters && this.characters[style.bitmapId], ctx = this.ctx;
    if (!bitmap || bitmap.type !== 'bitmap') {
      // Flash uses bitmap id 65535 for "no bitmap"; anything else missing is worth reporting.
      if (style.bitmapId !== 65535) this.report('render:missingBitmap', 'A bitmap fill refers to a bitmap that is not defined; not drawn.', character.id + ' → ' + style.bitmapId);
      return;
    }
    if (!bitmap.source) return; // decode failure, already reported
    var m = toMatrix(style.matrix), inverse = invert(m);
    if (!inverse) return;
    ctx.save();
    ctx.clip(path, rule);
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.globalAlpha = this.bitmapAlpha(cx, character.id);
    ctx.imageSmoothingEnabled = style.smooth;
    if (style.repeat) {
      var area = boundsIn(inverse, character.shape.bounds);
      ctx.fillStyle = ctx.createPattern(bitmap.source, 'repeat');
      ctx.fillRect(area[0], area[1], area[2], area[3]);
    } else {
      ctx.drawImage(bitmap.source, 0, 0);
    }
    ctx.restore();
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
    var area = boundsIn(inverse, character.shape.bounds);
    ctx.save();
    ctx.clip(path, rule);
    ctx.transform(gm[0], gm[1], gm[2], gm[3], gm[4], gm[5]);
    ctx.fillStyle = this.gradient(style, cx);
    ctx.fillRect(area[0], area[1], area[2], area[3]);
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

  Object.assign(M, { CanvasRenderer: CanvasRenderer });
})(typeof window !== 'undefined' ? window : globalThis);
