/* RetroFlash.js - Shape geometry: SHAPERECORDs to fill and stroke commands, shared by the renderer and hit testing. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;

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

  function geometryOf(character, report) {
    if (!character.geometry) {
      character.geometry = buildShapeGeometry(character.shape);
      character.geometry.problems.forEach(function (p) {
        report('render:invalidStyleIndex', 'A shape refers to a style that does not exist; those edges are skipped.', character.id + ': ' + p);
      });
    }
    return character.geometry;
  }

  Object.assign(M, { buildShapeGeometry: buildShapeGeometry, geometryOf: geometryOf });
})(typeof window !== 'undefined' ? window : globalThis);
