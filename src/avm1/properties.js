/* RetroFlash.js - AVM1 movie clip properties (_x, _alpha, _currentframe, ...), bounds and target paths. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;
  var toNumber = M.toNumber, toAvmString = M.toAvmString, multiply = M.multiply, invert = M.invert,
    transformPoint = M.transformPoint;

  /* Properties work on a Clip (the root or a sprite instance) through its display object, clip.displayObject():
     { matrix, cx, name, visible, ... } in the parent's display list (the root gets one of its own). Properties
     that change the matrix or colour transform mark the object `scriptTransformed`, so the timeline stops
     moving it, as in Flash Player. Scale, rotation and a hidden skew are read from the matrix once and kept
     in object.transform, so setting one keeps the others exactly. */

  // In GetProperty/SetProperty index order (SWF19). Names are case-insensitive.
  var PROPERTY_NAMES = ['_x', '_y', '_xscale', '_yscale', '_currentframe', '_totalframes', '_alpha', '_visible',
    '_width', '_height', '_rotation', '_target', '_framesloaded', '_name', '_droptarget', '_url', '_highquality',
    '_focusrect', '_soundbuftime', '_quality', '_xmouse', '_ymouse'];
  var PROPERTY_INDEX = {};
  PROPERTY_NAMES.forEach(function (name, i) { PROPERTY_INDEX[name] = i; });
  function propertyIndex(name) {
    var i = PROPERTY_INDEX[String(name).toLowerCase()];
    return i === undefined ? -1 : i;
  }

  // Dot path (_level0.a.b) and slash path (/a/b) of a clip.
  function clipPath(clip) {
    return clip.parent ? clipPath(clip.parent) + '.' + (clip.displayObject().name || '') : '_level0';
  }
  function slashPath(clip) {
    if (!clip.parent) return '/';
    var parent = clip.parent.parent ? slashPath(clip.parent) : '';
    return parent + '/' + (clip.displayObject().name || '');
  }

  // Pixels to twips truncate toward zero; an infinite position becomes the lowest integer, as in Flash Player.
  function toTwips(px) {
    if (!isFinite(px)) return -2147483648;
    return Math.max(-2147483648, Math.min(2147483647, Math.trunc(px * 20)));
  }
  // A number for a numeric property, or null: undefined, null and NaN set nothing.
  function numeric(value, version) {
    if (value === undefined || value === null) return null;
    var n = toNumber(value, version);
    return n !== n ? null : n;
  }

  function transformOf(obj) {
    if (!obj.transform) {
      var m = obj.matrix, rx = Math.atan2(m[1], m[0]);
      obj.transform = {
        scaleX: Math.sqrt(m[0] * m[0] + m[1] * m[1]), scaleY: Math.sqrt(m[2] * m[2] + m[3] * m[3]),
        rotation: rx, skew: Math.atan2(-m[2], m[3]) - rx
      };
    }
    return obj.transform;
  }
  // Rebuilds the matrix's scale/rotation terms from the kept values (32-bit floats, as Flash stores them).
  function applyTransform(obj) {
    var t = obj.transform, m = obj.matrix.slice();
    var sx = t.scaleX === t.scaleX ? t.scaleX : 0, sy = t.scaleY === t.scaleY ? t.scaleY : 0;
    var rot = t.rotation === t.rotation ? t.rotation : 0;
    m[0] = Math.fround(sx * Math.cos(rot));
    m[1] = Math.fround(sx * Math.sin(rot));
    m[2] = Math.fround(-sy * Math.sin(rot + t.skew));
    m[3] = Math.fround(sy * Math.cos(rot + t.skew));
    setMatrix(obj, m);
  }
  function setMatrix(obj, m) {
    obj.matrix = m;
    obj.scriptTransformed = true;
  }

  /* Bounds in twips of a display object's content in its own space, or null when it has none: shape bounds,
     text bounds, a text field's bounds, a bitmap's size, and the union of a sprite's or button's children. */
  function contentBounds(obj) {
    var c = obj.character, container = obj.clip || obj.button, box = null;
    if (!container) {
      if (!c) return null;
      if (c.type === 'shape') return c.shape.bounds;
      if (c.type === 'morphShape') return M.morphBounds(c, obj.ratio);
      if (c.type === 'text') return c.text.bounds;
      if (c.type === 'editText') return (obj.layout || c.layout || c.field).bounds;
      if (c.type === 'bitmap') return { xMin: 0, yMin: 0, xMax: c.width * 20, yMax: c.height * 20 };
      return null;
    }
    container.displayList.forEach(function (child) {
      if (child.visible === false) return;
      var b = transformedBounds(contentBounds(child), child.matrix);
      if (b) box = box ? { xMin: Math.min(box.xMin, b.xMin), yMin: Math.min(box.yMin, b.yMin), xMax: Math.max(box.xMax, b.xMax), yMax: Math.max(box.yMax, b.yMax) } : b;
    });
    return box;
  }
  function transformedBounds(b, m) {
    if (!b) return null;
    var xs = [], ys = [];
    [[b.xMin, b.yMin], [b.xMax, b.yMin], [b.xMin, b.yMax], [b.xMax, b.yMax]].forEach(function (p) {
      var q = transformPoint(m, p[0], p[1]);
      xs.push(q[0]);
      ys.push(q[1]);
    });
    return { xMin: Math.min.apply(null, xs), yMin: Math.min.apply(null, ys), xMax: Math.max.apply(null, xs), yMax: Math.max.apply(null, ys) };
  }
  // Size in pixels of the object's bounds in its parent's space (axis 'x' or 'y').
  function size(obj, axis) {
    var b = transformedBounds(contentBounds(obj), obj.matrix);
    if (!b) return 0;
    return (axis === 'x' ? b.xMax - b.xMin : b.yMax - b.yMin) / 20;
  }
  /* _width/_height: scales the object so its bounds in the parent's space get `value` pixels on `axis`, keeping
     the other scale. Unrotated, this is the factor value / unscaled size; rotated, the axis-aligned box of the
     rotated content is matched (Flash Player uses its own empirical rule there). */
  function setSize(obj, axis, value) {
    var b = contentBounds(obj), t = transformOf(obj);
    if (!b) return;
    var w = (b.xMax - b.xMin) / 20, h = (b.yMax - b.yMin) / 20, cos = Math.abs(Math.cos(t.rotation)), sin = Math.abs(Math.sin(t.rotation));
    var scale = axis === 'x' ? (value - sin * t.scaleY * h) / (cos * w) : (value - sin * t.scaleX * w) / (cos * h);
    if (!isFinite(scale)) scale = 0;
    if (axis === 'x') t.scaleX = scale; else t.scaleY = scale;
    applyTransform(obj);
  }
  // The clip's matrix on the stage (the product of its ancestors' matrices).
  function worldMatrix(clip) {
    var m = clip.displayObject().matrix;
    for (var p = clip.parent; p; p = p.parent) m = multiply(p.displayObject().matrix, m);
    return m;
  }
  function mouse(clip, axis) {
    var input = clip.env.input, inverse = invert(worldMatrix(clip));
    if (!input || !inverse) return 0;
    var p = transformPoint(inverse, input.x, input.y);
    return (axis === 'x' ? p[0] : p[1]) / 20;
  }

  // Points between a clip's own space and the stage, in twips.
  function localToStage(clip, x, y) { return transformPoint(worldMatrix(clip), x, y); }
  function stageToLocal(clip, x, y) {
    var inverse = invert(worldMatrix(clip));
    return inverse ? transformPoint(inverse, x, y) : [NaN, NaN];
  }
  // The bounds of a clip's content on the stage (twips), or null when it has none.
  function stageBounds(clip) { return transformedBounds(contentBounds(clip.displayObject()), worldMatrix(clip)); }
  /* getBounds(space): a clip's bounds in the space of `space` (a clip), in pixels. An empty clip gives
     6710886.35 for every side, as in Flash Player. */
  function boundsIn(clip, space) {
    var b = transformedBounds(contentBounds(clip.displayObject()), worldMatrix(clip)), inverse = invert(worldMatrix(space));
    if (!b || !inverse) return { xMin: 6710886.35, xMax: 6710886.35, yMin: 6710886.35, yMax: 6710886.35 };
    b = transformedBounds(b, inverse);
    return { xMin: b.xMin / 20, xMax: b.xMax / 20, yMin: b.yMin / 20, yMax: b.yMax / 20 };
  }
  /* hitTest(x, y, shapeFlag): the point is in _root coordinates (pixels). With shapeFlag the clip's shapes are
     tested, otherwise its bounds. */
  function hitTestPoint(clip, x, y, shape) {
    var p = transformPoint(clip.root().displayObject().matrix, x * 20, y * 20);
    if (shape) return M.hitTestObject({ character: { type: 'sprite' }, clip: clip }, worldMatrix(clip), p[0], p[1], clip.env.report);
    var b = stageBounds(clip);
    return !!b && p[0] >= b.xMin && p[0] <= b.xMax && p[1] >= b.yMin && p[1] <= b.yMax;
  }
  // hitTest(target): whether the bounds of two clips overlap on the stage.
  function hitTestClip(clip, other) {
    var a = stageBounds(clip), b = stageBounds(other);
    return !!a && !!b && a.xMin <= b.xMax && b.xMin <= a.xMax && a.yMin <= b.yMax && b.yMin <= a.yMax;
  }

  /* Dragging (startDrag): the clip follows the pointer, with its origin under the pointer (lockCenter) or
     keeping its offset; `rect` ([left, top, right, bottom], pixels in the parent's space) bounds its position.
     One clip is dragged at a time (env.drag). env.dropTarget is the topmost other clip under the pointer. */
  function startDrag(clip, lockCenter, rect) {
    var env = clip.env, obj = clip.displayObject(), input = env.input;
    var p = input ? pointerIn(clip, input) : [obj.matrix[4], obj.matrix[5]];
    env.drag = { clip: clip, rect: rect, dx: lockCenter ? 0 : obj.matrix[4] - p[0], dy: lockCenter ? 0 : obj.matrix[5] - p[1] };
    updateDrag(env);
  }
  // The pointer in the space the dragged clip's position is in (its parent's), in twips.
  function pointerIn(clip, input) {
    return clip.parent ? stageToLocal(clip.parent, input.x, input.y) : [input.x, input.y];
  }
  // Moves the dragged clip to the pointer; true when a clip is being dragged.
  function updateDrag(env) {
    var drag = env.drag, input = env.input;
    if (!drag) return false;
    if (drag.clip.removed || !input) { env.drag = null; return false; }
    var p = pointerIn(drag.clip, input), x = p[0] + drag.dx, y = p[1] + drag.dy, r = drag.rect;
    if (r) {
      x = Math.max(Math.min(r[0], r[2]) * 20, Math.min(Math.max(r[0], r[2]) * 20, x));
      y = Math.max(Math.min(r[1], r[3]) * 20, Math.min(Math.max(r[1], r[3]) * 20, y));
    }
    var obj = drag.clip.displayObject(), m = obj.matrix.slice();
    m[4] = x;
    m[5] = y;
    setMatrix(obj, m);
    env.dropTarget = dropTargetOf(env, drag.clip);
    return true;
  }
  function stopDrag(env) {
    if (!env.drag) return;
    env.dropTarget = dropTargetOf(env, env.drag.clip);
    env.drag = null;
  }
  // The deepest clip under the pointer, other than `dragged`.
  function dropTargetOf(env, dragged) {
    var input = env.input, root = dragged.root();
    if (!input) return null;
    return (function clipAt(container, matrix) {
      var depths = container.depths();
      for (var i = depths.length - 1; i >= 0; i--) {
        var obj = container.displayList.get(depths[i]);
        if (!obj.clip || obj.clip === dragged || obj.visible === false || obj.clipDepth) continue;
        var world = multiply(matrix, obj.matrix);
        if (M.hitTestObject(obj, world, input.x, input.y, env.report)) return clipAt(obj.clip, world) || obj.clip;
      }
      return null;
    })(root, root.displayObject().matrix);
  }

  /* The value of property `index` (PROPERTY_NAMES order) of a clip. `version` is the SWF version. */
  function getProperty(clip, index, version) {
    var obj = clip.displayObject();
    switch (index) {
      case 0: return obj.matrix[4] / 20;
      case 1: return obj.matrix[5] / 20;
      case 2: return transformOf(obj).scaleX * 100;
      case 3: return transformOf(obj).scaleY * 100;
      case 4: return clip.frame;
      case 5: case 12: return clip.frameCount();
      case 6: return obj.cx[3] * 100;
      case 7: return obj.visible !== false;
      case 8: return size(obj, 'x');
      case 9: return size(obj, 'y');
      case 10: return transformOf(obj).rotation * 180 / Math.PI;
      case 11: return slashPath(clip);
      case 13: return obj.name || '';
      case 14: return clip.env.dropTarget && !clip.env.dropTarget.removed ? slashPath(clip.env.dropTarget) : version < 6 ? undefined : '';
      case 15: return clip.env.url || '';           // a loaded movie's URL; the player does not know the main movie's
      case 16: return 1;                            // high quality
      case 17: return version <= 5 ? 1 : true;      // the stage focus rectangle is on
      case 18: return 5;                            // sound buffer time (no sound yet)
      case 19: return 'HIGH';
      case 20: return mouse(clip, 'x');
      case 21: return mouse(clip, 'y');
      default: return undefined;
    }
  }
  /* Sets property `index` of a clip. Read-only properties, and the quality and sound settings (which have no
     effect in this player), are ignored. */
  function setProperty(clip, index, value, version) {
    var obj = clip.displayObject(), n = index === 13 ? null : numeric(value, version), t, m;
    switch (index) {
      case 0: case 1:
        if (n === null) return;
        m = obj.matrix.slice();
        m[index === 0 ? 4 : 5] = toTwips(n);
        setMatrix(obj, m);
        return;
      case 2: case 3:
        if (n === null) return;
        t = transformOf(obj);
        if (index === 2) t.scaleX = n / 100; else t.scaleY = n / 100;
        applyTransform(obj);
        return;
      case 6:
        if (n === null) return;
        var cx = obj.cx.slice();
        cx[3] = isFinite(n) ? n / 100 : 0;
        obj.cx = cx;
        obj.scriptTransformed = true;
        return;
      case 7: if (n !== null) obj.visible = n !== 0; return;
      case 8: case 9: if (n !== null) setSize(obj, index === 8 ? 'x' : 'y', n); return;
      case 10:
        if (n === null) return;
        n %= 360;
        if (n < -180) n += 360; else if (n > 180) n -= 360;
        transformOf(obj).rotation = n * Math.PI / 180;
        applyTransform(obj);
        return;
      case 13:
        obj.name = toAvmString(typeof value === 'number' && value !== value && version >= 7 ? 0 : value, version);
        return;
    }
  }

  Object.assign(M, {
    PROPERTY_NAMES: PROPERTY_NAMES, propertyIndex: propertyIndex, getProperty: getProperty, setProperty: setProperty,
    clipPath: clipPath, slashPath: slashPath, contentBounds: contentBounds, localToStage: localToStage,
    stageToLocal: stageToLocal, boundsIn: boundsIn, hitTestPoint: hitTestPoint, hitTestClip: hitTestClip,
    startDrag: startDrag, updateDrag: updateDrag, stopDrag: stopDrag
  });
})(typeof window !== 'undefined' ? window : globalThis);
