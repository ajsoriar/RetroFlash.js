/* RetroFlash.js - Text field (DefineEditText) formats, fonts and layout. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;
  var parseHtmlText = M.parseHtmlText;

  var GUTTER = 40;                                      // twips between a text field's bounds and its text (2 px)
  var BULLET_INDENT = 720;                              // twips: text of an HTML <li> starts 36 px further right
  var DEFAULT_FONT_SIZE = 12;                           // px, for text fields without a font height
  var DEVICE_ASCENT = 0.905, DEVICE_DESCENT = 0.212;    // device-font metrics per px of size when the browser gives none

  /* Text field formats, as in Flash's TextFormat: { face, size (px), color {r, g, b}, bold, italic, underline,
     align (0 left, 1 right, 2 center, 3 justify), leftMargin, rightMargin, indent, blockIndent, leading (px),
     bullet }. The field's default format comes from DefineEditText. */
  function fieldFormat(field, characters, version) {
    var font = field.fontId !== undefined ? characters[field.fontId] : null, html = field.html;
    if (font && font.type !== 'font' && font.type !== 'font4') font = null;
    function px(v) { return (v || 0) / 20; }
    return {
      face: field.fontClass || (font && font.fontName) || 'Times New Roman',
      size: field.fontHeight !== undefined ? field.fontHeight / 20 : DEFAULT_FONT_SIZE,
      // Text colour alpha is ignored.
      color: field.color ? { r: field.color.r, g: field.color.g, b: field.color.b } : { r: 0, g: 0, b: 0 },
      // HTML fields do not inherit bold or italic from the font, and start left-aligned unless the SWF is
      // version 8 or later and the field has initial text.
      bold: !html && !!(font && font.bold), italic: !html && !!(font && font.italic), underline: false,
      align: html && (version < 8 || field.initialText === undefined) ? 0 : field.align || 0,
      leftMargin: px(field.leftMargin), rightMargin: px(field.rightMargin), indent: px(field.indent),
      blockIndent: 0, leading: px(field.leading), bullet: false
    };
  }

  // CSS font-family for a device font name (a comma-separated list is allowed); unknown names fall back to a
  // generic family: serif for Times New Roman, monospace for Courier-like names, sans-serif otherwise.
  var GENERIC_FONTS = { _sans: 'sans-serif', _serif: 'serif', _typewriter: 'monospace' };
  function cssFontFamily(face) {
    var names = face.split(','), families = [], first = names[0].trim().toLowerCase();
    names.forEach(function (name) {
      name = name.trim();
      var generic = GENERIC_FONTS[name.toLowerCase()];
      if (generic) families.push(generic);
      else if (name) families.push('"' + name.replace(/["\\;{}<>\r\n]/g, '') + '"');
    });
    families.push(first === 'times new roman' ? 'serif' : /^(courier|courier new|consolas|nsimsun)$/.test(first) ? 'monospace' : 'sans-serif');
    return families.join(', ');
  }
  function trailingSpaces(s) {
    var end = s.length;
    while (end && s.charCodeAt(end - 1) === 32) end--;
    return s.length - end;
  }
  // Embedded font for a format: same name and style first, then same name. Only fonts with glyphs qualify.
  function findEmbeddedFont(characters, format) {
    var name = format.face.toLowerCase(), byName = null, found = null;
    Object.keys(characters).some(function (id) {
      var c = characters[id];
      if (c.type !== 'font' || !c.glyphs.length || c.fontName.toLowerCase() !== name) return false;
      if (c.bold === !!format.bold && c.italic === !!format.italic) { found = c; return true; }
      if (!byName) byName = c;
      return false;
    });
    return found || byName;
  }

  // The CSS family of a loaded DefineFont4 for a format: same name and style first, then same name; or null.
  function font4Family(characters, format) {
    var name = format.face.toLowerCase(), byName = null, found = null;
    Object.keys(characters).some(function (id) {
      var c = characters[id];
      if (c.type !== 'font4' || !c.family || c.fontName.toLowerCase() !== name) return false;
      if (c.bold === !!format.bold && c.italic === !!format.italic) { found = c; return true; }
      if (!byName) byName = c;
      return false;
    });
    return (found || byName) ? (found || byName).family : null;
  }

  /* Lays out a DefineEditText in its own space (twips). Text breaks at '\n' and, with WordWrap, between words
     (a word longer than the line is split between characters). Each line's height is its largest ascent and
     descent plus the leading; text starts 2 px (GUTTER) inside the bounds. Alignment uses the width between
     the margins and never moves text left of the margin. AutoSize grows the field from its left edge.
     measure = { width(css, text) -> px, metrics(css, sizePx) -> { ascent, descent } in px } for device fonts.
     Returns { bounds, lines: [{ runs: [{ text, x, baseline, face, format }], bullet }], width, height }, where
     face is { font, scale } for embedded glyphs or { css } for a device font. `text` replaces the field's
     initial text (a field bound to a variable); for HTML fields it is HTML. */
  function layoutEditText(character, characters, measure, report, text) {
    var field = character.field, version = character.version, id = character.id;
    var base = fieldFormat(field, characters, version), source = text === undefined ? field.initialText || '' : text, faces = new Map();
    var spans = field.html ? parseHtmlText(source, base, field.multiline, version, function (f, r) { report(f, r, id); })
      : source ? [{ text: source.replace(/\r\n|\r|\n/g, '\n'), format: base }] : [];
    if (field.password) spans = spans.map(function (s) { return { text: s.text.replace(/[^\n]/g, '*'), format: s.format }; });

    // Font, metrics and width function for a format, cached by face, style and size.
    function faceOf(format) {
      var key = format.face + '|' + !!format.bold + '|' + !!format.italic + '|' + format.size, face = faces.get(key);
      if (face) return face;
      var size = format.size * 20, font = field.useOutlines ? findEmbeddedFont(characters, format) : null;
      if (font) {
        var k = size / font.em;
        face = {
          font: font, scale: k,
          ascent: font.hasLayout ? font.ascent * k : DEVICE_ASCENT * size, descent: font.hasLayout ? font.descent * k : DEVICE_DESCENT * size,
          width: function (s) {
            var w = 0;
            for (var i = 0; i < s.length; i++) {
              var index = font.byCode.get(s.charCodeAt(i));
              if (index !== undefined) w += font.glyphs[index].advance * k;
            }
            return w;
          }
        };
      } else {
        // A DefineFont4 of that name, once loaded, is drawn like a device font.
        var family = font4Family(characters, format);
        if (field.useOutlines && !family) report('text:deviceFallback', 'A text field set to embedded fonts has no font with glyphs for its face; a device font is used.', id + ': ' + format.face);
        var css = (format.italic ? 'italic ' : '') + (format.bold ? 'bold ' : '') + format.size + 'px ' + (family ? '"' + family + '", ' : '') + cssFontFamily(format.face);
        var mt = measure.metrics(css, format.size);
        face = { css: css, ascent: mt.ascent * 20, descent: mt.descent * 20, width: function (s) { return measure.width(css, s) * 20; } };
      }
      faces.set(key, face);
      return face;
    }

    // Paragraphs: lists of { text, format } pieces split at '\n'; an empty paragraph keeps its format.
    var paragraphs = [{ pieces: [], format: base }];
    spans.forEach(function (span) {
      span.text.split('\n').forEach(function (part, i) {
        if (i > 0) paragraphs.push({ pieces: [], format: span.format });
        var p = paragraphs[paragraphs.length - 1];
        if (!p.pieces.length) p.format = span.format;
        if (part) p.pieces.push({ text: part, format: span.format });
      });
    });
    // HTML ends its last paragraph with a break that does not start a new line.
    if (field.html && paragraphs.length > 1 && !paragraphs[paragraphs.length - 1].pieces.length) paragraphs.pop();

    var b = field.bounds, fieldWidth = b.xMax - b.xMin, wrap = field.wordWrap, lines = [];
    function leftOf(pf, first) { return (pf.leftMargin + pf.blockIndent + (first ? pf.indent : 0)) * 20 + (pf.bullet ? BULLET_INDENT : 0); }
    function room(pf, first) { return fieldWidth - 2 * GUTTER - leftOf(pf, first) - pf.rightMargin * 20; }
    paragraphs.forEach(function (p) {
      var pf = p.format, line = { tokens: [], width: 0, format: pf, first: true };
      function newLine() { lines.push(line); line = { tokens: [], width: 0, format: pf, first: false }; }
      function add(text, format, face, width) { line.tokens.push({ text: text, format: format, face: face, width: width }); line.width += width; }
      p.pieces.forEach(function (piece) {
        var face = faceOf(piece.format), words = wrap ? piece.text.match(/[^ ]+ *| +/g) : [piece.text];
        words.forEach(function (word) {
          var width = face.width(word), visible = word.slice(0, word.length - trailingSpaces(word));
          if (wrap && line.tokens.length && line.width + face.width(visible) > room(pf, line.first)) {
            newLine();
            if (!visible) return; // spaces at a wrap point are dropped
          }
          if (wrap && face.width(visible) > room(pf, line.first)) {
            // A word wider than the line: split it between characters.
            var chunk = '', chunkWidth = 0;
            for (var c = 0; c < word.length; c++) {
              var w = face.width(word.charAt(c));
              if (chunk && line.width + chunkWidth + w > room(pf, line.first)) { add(chunk, piece.format, face, chunkWidth); newLine(); chunk = ''; chunkWidth = 0; }
              chunk += word.charAt(c);
              chunkWidth += w;
            }
            if (chunk) add(chunk, piece.format, face, chunkWidth);
            return;
          }
          add(word, piece.format, face, width);
        });
      });
      line.last = true;
      lines.push(line);
    });

    // Vertical metrics, then the bounds (AutoSize), then horizontal positions.
    var y = GUTTER, textWidth = 0;
    lines.forEach(function (line) {
      var ascent = 0, descent = 0, leading = line.format.leading * 20;
      if (!line.tokens.length) { var face = faceOf(line.format); ascent = face.ascent; descent = face.descent; }
      line.tokens.forEach(function (t) {
        ascent = Math.max(ascent, t.face.ascent);
        descent = Math.max(descent, t.face.descent);
        leading = Math.max(leading, t.format.leading * 20);
      });
      line.baseline = y + ascent;
      y = line.baseline + descent + leading;
      textWidth = Math.max(textWidth, leftOf(line.format, line.first) + line.width + line.format.rightMargin * 20);
    });
    var bounds = { xMin: b.xMin, xMax: b.xMax, yMin: b.yMin, yMax: b.yMax };
    if (field.autoSize) {
      if (!wrap) { bounds.xMax = b.xMin + textWidth + 2 * GUTTER + (field.readOnly ? 0 : 50); fieldWidth = bounds.xMax - bounds.xMin; }
      bounds.yMax = b.yMin + (y - GUTTER) + 2 * GUTTER;
    }
    var out = lines.map(function (line) {
      var pf = line.format, tokens = line.tokens, align = pf.align, x = bounds.xMin + GUTTER + leftOf(pf, line.first), contentWidth = line.width;
      // SWF 8+ ignores trailing spaces when aligning.
      if (version >= 8 && align !== 0 && tokens.length) {
        var lastToken = tokens[tokens.length - 1], trailing = trailingSpaces(lastToken.text);
        if (trailing) contentWidth -= lastToken.face.width(lastToken.text.slice(-trailing));
      }
      var spare = room(pf, line.first) - contentWidth, gap = 0;
      if (align === 1) x += Math.max(0, spare);
      else if (align === 2) x += Math.max(0, spare / 2);
      else if (align === 3 && !line.last && tokens.length > 1) gap = Math.max(0, spare / (tokens.length - 1));
      var runs = [];
      tokens.forEach(function (t) {
        var prev = runs[runs.length - 1];
        if (prev && !gap && prev.face === t.face && prev.format === t.format) prev.text += t.text;
        else runs.push({ text: t.text, x: x, baseline: bounds.yMin + line.baseline, face: t.face, format: t.format, width: 0 });
        runs[runs.length - 1].width += t.width;
        x += t.width + gap;
      });
      var bullet = pf.bullet && line.first && tokens.length
        ? { text: '\u2022', x: bounds.xMin + GUTTER + (pf.leftMargin + pf.blockIndent) * 20, baseline: bounds.yMin + line.baseline, face: tokens[0].face, format: tokens[0].format, width: 0 }
        : null;
      return { runs: bullet ? [bullet].concat(runs) : runs };
    });
    return { bounds: bounds, lines: out, width: textWidth, height: y - GUTTER };
  }

  Object.assign(M, { GUTTER: GUTTER, DEVICE_ASCENT: DEVICE_ASCENT, DEVICE_DESCENT: DEVICE_DESCENT,
    fieldFormat: fieldFormat, cssFontFamily: cssFontFamily, layoutEditText: layoutEditText });
})(typeof window !== 'undefined' ? window : globalThis);
