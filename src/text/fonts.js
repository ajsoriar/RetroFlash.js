/* RetroFlash.js - Fonts and static text (DefineFont 1-3, DefineText): glyph outlines and placements. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;
  var buildShapeGeometry = M.buildShapeGeometry;

  var TEXT_BLACK = { r: 0, g: 0, b: 0, a: 255 };
  var GLYPH_FILL = [{ type: 'solid', color: TEXT_BLACK }];

  // Font character: glyph outlines on an EM square of 1024 units (DefineFont3: 20480), looked up by index
  // (DefineText) or by UTF-16 code unit (text fields).
  function fontCharacter(f, tagName) {
    var font = {
      type: 'font', id: f.fontId, name: tagName, fontName: f.name || '', bold: !!f.bold, italic: !!f.italic,
      em: f.fontVersion === 3 ? 20480 : 1024, glyphs: f.glyphs, byCode: new Map(),
      hasLayout: !!f.hasLayout, ascent: f.ascent || 0, descent: f.descent || 0
    };
    f.glyphs.forEach(function (g, i) { if (g.code !== null && !font.byCode.has(g.code)) font.byCode.set(g.code, i); });
    return font;
  }
  // Fill commands of a glyph (all of its contours), cached on the glyph.
  function glyphCommands(glyph) {
    if (!glyph.commands) {
      var geometry = buildShapeGeometry({ fillStyles: GLYPH_FILL, lineStyles: [], records: glyph.records }), cmds = [];
      geometry.groups.forEach(function (g) {
        g.fills.forEach(function (fill) { for (var i = 0; i < fill.commands.length; i++) cmds.push(fill.commands[i]); });
      });
      glyph.commands = cmds;
    }
    return glyph.commands;
  }

  /* DefineText: glyph placements in the text's own space (before its matrix), each
     { glyph, x, y, scale, color }. Font, height, colour and offsets carry over between records; the glyph
     scale is height / EM. */
  function staticTextGlyphs(character, characters, report) {
    var out = [], font = null, height = 0, color = TEXT_BLACK, x = 0, y = 0, id = character.id;
    character.text.records.forEach(function (rec) {
      if (rec.fontId !== undefined) {
        font = characters[rec.fontId];
        height = rec.height;
        if (font && font.type === 'font4') {
          report('render:font4Text', 'Static text cannot use the glyphs of a DefineFont4 font; those glyphs are not drawn.', id + ' → ' + rec.fontId);
          font = null;
        } else if (!font || font.type !== 'font') {
          report('render:missingFont', 'Static text refers to a font that is not defined; those glyphs are not drawn.', id + ' → ' + rec.fontId);
          font = null;
        }
      }
      if (rec.color) color = rec.color;
      if (rec.x !== undefined) x = rec.x;
      if (rec.y !== undefined) y = rec.y;
      rec.glyphs.forEach(function (entry) {
        var glyph = font && font.glyphs[entry.index];
        if (glyph) out.push({ glyph: glyph, x: x, y: y, scale: height / font.em, color: color });
        else if (font) report('render:missingGlyph', 'Static text uses a glyph index the font does not have; not drawn.', id + ' → ' + font.id + '#' + entry.index);
        x += entry.advance;
      });
    });
    return out;
  }

  Object.assign(M, { TEXT_BLACK: TEXT_BLACK, fontCharacter: fontCharacter, glyphCommands: glyphCommands,
    staticTextGlyphs: staticTextGlyphs });
})(typeof window !== 'undefined' ? window : globalThis);
