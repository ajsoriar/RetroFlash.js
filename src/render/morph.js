/* RetroFlash.js - Morph shapes (DefineMorphShape, DefineMorphShape2): the shape a placement's ratio selects,
   from 0 (the start shape) to 65535 (the end shape), drawn, masked and hit-tested like a DefineShape. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;

  var MAX_FRAMES = 32; // interpolated shapes kept per morph character (one per ratio in use)

  function lerp(a, b, t) { return a + (b - a) * t; }
  // Coordinates are interpolated as absolute positions and rounded to whole twips, so a point shared by two
  // edges lands on the same spot in both and contours still close.
  function twips(a, b, t) { return Math.round(lerp(a, b, t)); }
  function channel(a, b, t) { return Math.max(0, Math.min(255, Math.round(lerp(a, b, t)))); }
  function color(a, b, t) { return { r: channel(a.r, b.r, t), g: channel(a.g, b.g, t), b: channel(a.b, b.b, t), a: channel(a.a, b.a, t) }; }
  function rect(a, b, t) { return { xMin: twips(a.xMin, b.xMin, t), xMax: twips(a.xMax, b.xMax, t), yMin: twips(a.yMin, b.yMin, t), yMax: twips(a.yMax, b.yMax, t) }; }
  function matrix(a, b, t) {
    return {
      hasScale: a.hasScale || b.hasScale, scaleX: lerp(a.scaleX, b.scaleX, t), scaleY: lerp(a.scaleY, b.scaleY, t),
      hasRotate: a.hasRotate || b.hasRotate, rotateSkew0: lerp(a.rotateSkew0, b.rotateSkew0, t), rotateSkew1: lerp(a.rotateSkew1, b.rotateSkew1, t),
      translateX: lerp(a.translateX, b.translateX, t), translateY: lerp(a.translateY, b.translateY, t)
    };
  }
  // Both ends of a morph fill have the same type (the authoring tool converts them); the start wins otherwise.
  function fill(a, b, t) {
    if (a.type !== b.type) return a;
    if (a.type === 'solid') return { type: 'solid', color: color(a.color, b.color, t) };
    if (a.type === 'bitmap') return { type: 'bitmap', bitmapId: a.bitmapId, matrix: matrix(a.matrix, b.matrix, t), repeat: a.repeat, smooth: a.smooth };
    var ga = a.gradient, gb = b.gradient, g = { spreadMode: ga.spreadMode, interpolationMode: ga.interpolationMode, stops: [] };
    ga.stops.forEach(function (s, i) {
      var e = gb.stops[i] || s;
      g.stops.push({ ratio: channel(s.ratio, e.ratio, t), color: color(s.color, e.color, t) });
    });
    if (ga.focalPoint !== undefined) g.focalPoint = lerp(ga.focalPoint, gb.focalPoint, t);
    return { type: a.type, matrix: matrix(a.matrix, b.matrix, t), gradient: g };
  }
  function line(a, b, t) {
    var s = Object.assign({}, a, { width: twips(a.width, b.width, t) });
    if (a.color) s.color = color(a.color, b.color || a.color, t);
    if (a.fill) s.fill = fill(a.fill, b.fill || a.fill, t);
    return s;
  }

  /* The edges at `t`. Start and end records are walked side by side: a style change (only the start shape's
     sets styles) or a move in either list is taken on its own, and each other start edge pairs with the next
     end edge. Each list keeps its own pen. A straight edge paired with a curve is a curve whose control point
     is its midpoint. Returns { records, unpaired } (edges left over in one list, not drawn). */
  function morphRecords(start, end, t) {
    var out = [], i = 0, j = 0, sx = 0, sy = 0, ex = 0, ey = 0, px = 0, py = 0;
    function at(ax, ay, bx, by) { return [twips(ax, bx, t), twips(ay, by, t)]; }
    while (i < start.length && j < end.length) {
      var s = start[i], e = end[j];
      if (s.type === 'style' || e.type === 'style') {
        var rec = { type: 'style' }, moved = false;
        if (s.type === 'style') {
          if (s.fill0 !== undefined) rec.fill0 = s.fill0;
          if (s.fill1 !== undefined) rec.fill1 = s.fill1;
          if (s.line !== undefined) rec.line = s.line;
          if (s.moveTo) { sx = s.moveTo.x; sy = s.moveTo.y; moved = true; }
          i++;
        }
        if (e.type === 'style') {
          if (e.moveTo) { ex = e.moveTo.x; ey = e.moveTo.y; moved = true; }
          j++;
        }
        if (moved) {
          var p = at(sx, sy, ex, ey);
          rec.moveTo = { x: p[0], y: p[1] };
          px = p[0];
          py = p[1];
        }
        out.push(rec);
        continue;
      }
      var s1 = edgeEnd(s, sx, sy), e1 = edgeEnd(e, ex, ey), anchor = at(s1[0], s1[1], e1[0], e1[1]);
      if (s.type === 'line' && e.type === 'line') {
        out.push({ type: 'line', dx: anchor[0] - px, dy: anchor[1] - py });
      } else {
        var sc = control(s, sx, sy, s1), ec = control(e, ex, ey, e1), c = at(sc[0], sc[1], ec[0], ec[1]);
        out.push({ type: 'curve', cdx: c[0] - px, cdy: c[1] - py, adx: anchor[0] - c[0], ady: anchor[1] - c[1] });
      }
      px = anchor[0]; py = anchor[1];
      sx = s1[0]; sy = s1[1];
      ex = e1[0]; ey = e1[1];
      i++; j++;
    }
    return { records: out, unpaired: countEdges(start, i) + countEdges(end, j) };
  }
  function edgeEnd(r, x, y) { return r.type === 'curve' ? [x + r.cdx + r.adx, y + r.cdy + r.ady] : [x + r.dx, y + r.dy]; }
  function control(r, x, y, end) { return r.type === 'curve' ? [x + r.cdx, y + r.cdy] : [(x + end[0]) / 2, (y + end[1]) / 2]; }
  function countEdges(records, from) {
    var n = 0;
    for (var k = from; k < records.length; k++) if (records[k].type !== 'style') n++;
    return n;
  }

  function ratioOf(ratio) { return ratio > 0 ? Math.min(65535, Math.floor(ratio)) : 0; }
  /* The shape of `character` (a morph shape) at placement ratio `ratio`, as a shape character, so geometryOf,
     the renderer and hit testing take it as they are. The latest MAX_FRAMES ratios are kept. */
  function morphFrame(character, ratio, report) {
    ratio = ratioOf(ratio);
    var frames = character.frames, frame = frames.get(ratio);
    if (frame) return frame;
    var m = character.morph, t = ratio / 65535, edges = morphRecords(m.startRecords, m.endRecords, t);
    if (edges.unpaired && !character.unpairedReported && report) {
      character.unpairedReported = true;
      report('render:morphEdges', 'The start and end edges of a morph shape do not pair up; the extra edges are not drawn.', character.id + ': ' + edges.unpaired + ' edge(s)');
    }
    frame = {
      type: 'shape', id: character.id, name: character.name, geometry: null,
      shape: {
        shapeId: character.id, shapeVersion: m.morphVersion === 2 ? 4 : 3, bounds: rect(m.startBounds, m.endBounds, t),
        fillStyles: m.fillStyles.map(function (p) { return fill(p.start, p.end, t); }),
        lineStyles: m.lineStyles.map(function (p) { return line(p.start, p.end, t); }),
        records: edges.records
      }
    };
    if (frames.size >= MAX_FRAMES) frames.delete(frames.keys().next().value);
    frames.set(ratio, frame);
    return frame;
  }
  // The bounds of a morph shape at `ratio`, between its start and end bounds.
  function morphBounds(character, ratio) { return rect(character.morph.startBounds, character.morph.endBounds, ratioOf(ratio) / 65535); }
  // The shape character a display object draws: its shape, or its morph shape's shape at its ratio; else null.
  function shapeOf(obj, report) {
    var c = obj.character;
    if (!c) return null;
    if (c.type === 'shape') return c;
    return c.type === 'morphShape' ? morphFrame(c, obj.ratio, report) : null;
  }

  Object.assign(M, { morphFrame: morphFrame, morphBounds: morphBounds, morphRecords: morphRecords, shapeOf: shapeOf });
})(typeof window !== 'undefined' ? window : globalThis);
