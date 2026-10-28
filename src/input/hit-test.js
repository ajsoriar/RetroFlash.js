/* RetroFlash.js - Hit testing against the display list. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;
  var multiply = M.multiply, invert = M.invert, transformPoint = M.transformPoint, geometryOf = M.geometryOf, shapeOf = M.shapeOf;

  // Calls fn(x0, y0, x1, y1) for every segment of flat path commands; curves are split into 8 segments.
  // With `close`, each contour also gets its closing segment (as Canvas fill does).
  function forEachSegment(cmds, close, fn) {
    var x = 0, y = 0, sx = 0, sy = 0;
    for (var i = 0; i < cmds.length;) {
      var op = cmds[i];
      if (op === 0) {
        if (close && (x !== sx || y !== sy)) fn(x, y, sx, sy);
        x = sx = cmds[i + 1]; y = sy = cmds[i + 2]; i += 3;
      } else if (op === 1) {
        fn(x, y, cmds[i + 1], cmds[i + 2]);
        x = cmds[i + 1]; y = cmds[i + 2]; i += 3;
      } else {
        var cx = cmds[i + 1], cy = cmds[i + 2], ex = cmds[i + 3], ey = cmds[i + 4], px = x, py = y;
        for (var k = 1; k <= 8; k++) {
          var t = k / 8, u = 1 - t;
          var qx = u * u * x + 2 * u * t * cx + t * t * ex, qy = u * u * y + 2 * u * t * cy + t * t * ey;
          fn(px, py, qx, qy);
          px = qx; py = qy;
        }
        x = ex; y = ey; i += 5;
      }
    }
    if (close && (x !== sx || y !== sy)) fn(x, y, sx, sy);
  }
  function pointInFill(cmds, x, y, rule) {
    var crossings = 0, winding = 0;
    forEachSegment(cmds, true, function (x0, y0, x1, y1) {
      if ((y0 > y) === (y1 > y)) return;
      if (x < x0 + ((y - y0) * (x1 - x0)) / (y1 - y0)) { crossings++; winding += y1 > y0 ? 1 : -1; }
    });
    return rule === 'nonzero' ? winding !== 0 : crossings % 2 === 1;
  }
  function pointNearStroke(cmds, x, y, radius) {
    var near = false;
    forEachSegment(cmds, false, function (x0, y0, x1, y1) {
      if (near) return;
      var dx = x1 - x0, dy = y1 - y0, len = dx * dx + dy * dy;
      var t = len ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / len)) : 0;
      var ex = x0 + t * dx - x, ey = y0 + t * dy - y;
      near = ex * ex + ey * ey <= radius * radius;
    });
    return near;
  }
  // Point (shape-local twips) inside any fill, or within half a line width (at least 1 px) of any stroke.
  function pointInShape(geometry, x, y) {
    for (var g = 0; g < geometry.groups.length; g++) {
      var group = geometry.groups[g], i;
      for (i = 0; i < group.fills.length; i++) if (pointInFill(group.fills[i].commands, x, y, geometry.fillRule)) return true;
      for (i = 0; i < group.lines.length; i++) if (pointNearStroke(group.lines[i].commands, x, y, Math.max(group.lines[i].style.width, 20) / 2)) return true;
    }
    return false;
  }
  function inRect(r, p) { return p[0] >= r.xMin && p[0] <= r.xMax && p[1] >= r.yMin && p[1] <= r.yMax; }
  /* Point in stage twips against a display object whose world matrix is `world`. Text is hit-tested by its
     bounds (DefineText TextBounds, or the text field's bounds), in the character's own space. */
  function hitTestObject(obj, world, x, y, report) {
    var c = obj.character, local;
    if (!c) return false;
    if (c.type === 'shape' || c.type === 'morphShape' || c.type === 'bitmap' || c.type === 'text' || c.type === 'editText') {
      var inverse = invert(world);
      if (!inverse) return false;
      local = transformPoint(inverse, x, y);
    }
    if (c.type === 'shape' || c.type === 'morphShape') return pointInShape(geometryOf(shapeOf(obj, report), report), local[0], local[1]);
    if (c.type === 'bitmap') return local[0] >= 0 && local[1] >= 0 && local[0] < c.width * 20 && local[1] < c.height * 20;
    if (c.type === 'text') return inRect(c.text.bounds, local);
    if (c.type === 'editText') {
      var layout = obj.layout || c.layout; // a bound field's own layout, else the character's (after drawing)
      return inRect(layout ? layout.bounds : c.field.bounds, local);
    }
    if (c.type === 'sprite' && obj.clip) return hitTestList(obj.clip.displayList, world, x, y, report);
    if (c.type === 'button' && obj.button) return hitTestList(obj.button.hitList, world, x, y, report);
    return false;
  }
  function hitTestList(list, matrix, x, y, report) {
    var hit = false;
    list.forEach(function (obj) {
      if (!hit && !obj.clipDepth && obj.visible !== false) hit = hitTestObject(obj, multiply(matrix, obj.matrix), x, y, report);
    });
    return hit;
  }
  /* Topmost button whose hit area contains the point, searching from the highest depth down through sprites.
     As in AVM1, non-interactive content (shapes, bitmaps) never blocks a button underneath it. Masks are not
     taken into account yet. Returns the button's display object or null. */
  function pickButton(container, matrix, x, y, report) {
    var depths = container.depths();
    for (var i = depths.length - 1; i >= 0; i--) {
      var obj = container.displayList.get(depths[i]);
      if (obj.clipDepth || obj.visible === false) continue; // invisible buttons, and their contents, are not hit
      var world = multiply(matrix, obj.matrix);
      if (obj.button) {
        if (hitTestList(obj.button.hitList, world, x, y, report)) return obj;
      } else if (obj.clip) {
        // A clip with button handlers (onPress, ...) takes the pointer for everything inside it, as in Flash Player.
        if (isButtonClip(obj.clip)) {
          if (hitTestList(obj.clip.displayList, world, x, y, report)) return obj;
          continue;
        }
        var found = pickButton(obj.clip, world, x, y, report);
        if (found) return found;
      }
    }
    return null;
  }
  function isButtonClip(clip) { return !!(clip.env.scripts && clip.env.scripts.isButtonClip(clip)); }
  // Every button instance and clip with button handlers on stage.
  function collectButtons(container, set) {
    container.displayList.forEach(function (obj) {
      if (obj.button) { set.add(obj); collectButtons(obj.button, set); }
      else if (obj.clip) { if (isButtonClip(obj.clip)) set.add(obj); collectButtons(obj.clip, set); }
    });
    return set;
  }

  Object.assign(M, { pointInShape: pointInShape, hitTestObject: hitTestObject, pickButton: pickButton,
    collectButtons: collectButtons });
})(typeof window !== 'undefined' ? window : globalThis);
