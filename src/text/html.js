/* RetroFlash.js - The HTML subset of Flash text fields. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;

  var MAX_HTML_TAG = 4096;                              // characters; longer HTML tags are dropped

  var HTML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: '\'', nbsp: '\u00a0' };
  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{1,8});/gi, function (m, e) {
      if (e.charAt(0) === '#') {
        var n = e.charAt(1) === 'x' || e.charAt(1) === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
      }
      var v = HTML_ENTITIES[e.toLowerCase()];
      return v === undefined ? m : v;
    });
  }
  function htmlAttributes(source) {
    var attrs = Object.create(null), re = /([^\s=\/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g, m;
    while ((m = re.exec(source))) attrs[m[1].toLowerCase()] = decodeEntities(m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4]);
    return attrs;
  }
  // <font size>: absolute, or relative with + / -; digits after the first non-digit are ignored.
  function htmlFontSize(value, current, version) {
    var sign = value.charAt(0) === '+' || value.charAt(0) === '-' ? value.charAt(0) : '';
    var digits = /^\d+/.exec(sign ? value.slice(1) : value);
    if (!digits) return current;
    var n = parseInt(digits[0], 10);
    n = sign === '+' ? current + n : sign === '-' ? current - n : n;
    return version < 13 ? Math.max(1, Math.min(127, n)) : Math.max(1, n);
  }
  function htmlNumber(value, current) {
    var n = parseFloat(value);
    return isFinite(n) ? n : current;
  }
  /* The HTML subset of Flash text fields, as spans [{ text, format }] with '\n' line breaks. Supported:
     <p align>, <br>, <font face size color>, <b>, <i>, <u>, <a> (drawn as text), <li> (bullet),
     <textformat leftmargin rightmargin indent blockindent leading>. Unknown tags keep the current format;
     end tags that do not close the innermost open tag are ignored. Up to SWF 7, whitespace-only text between
     tags is dropped; up to SWF 6, fields always behave as multiline. */
  function parseHtmlText(html, base, multiline, version, report) {
    multiline = multiline || version <= 6;
    var spans = [], stack = [{ tag: '', format: base }], pOpen = false;
    function top() { return stack[stack.length - 1].format; }
    function emit(text, format) { if (text) spans.push({ text: text, format: format }); }
    function endsWithBreak() { return !spans.length || /\n$/.test(spans[spans.length - 1].text); }
    function text(raw) {
      if (!raw) return;
      var t = decodeEntities(raw);
      if (version <= 7 && !t.trim()) return;
      emit(t.replace(/\r\n|\r|\n/g, '\n'), top());
    }
    /* Linear scan (hostile text must not cause quadratic regex work): `<` starts a tag only before a name or
       `/name`; a tag without `>` ends the markup, and the rest is text. */
    var i = 0, at = 0;
    for (;;) {
      var lt = html.indexOf('<', at);
      if (lt < 0) break;
      if (html.substr(lt, 4) === '<!--') {
        var close = html.indexOf('-->', lt + 4);
        text(html.slice(i, lt));
        i = at = close < 0 ? html.length : close + 3;
        continue;
      }
      if (!/^<\/?[a-zA-Z]/.test(html.substr(lt, 3))) { at = lt + 1; continue; }
      var gt = html.indexOf('>', lt);
      if (gt < 0) break;
      text(html.slice(i, lt));
      i = at = gt + 1;
      if (gt - lt > MAX_HTML_TAG) continue; // an absurdly long tag is dropped
      var m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)([\s\S]*)>$/.exec(html.slice(lt, gt + 1));
      if (!m) continue;
      var name = m[2].toLowerCase();
      if (m[1]) {
        if (stack.length > 1 && stack[stack.length - 1].tag === name) {
          if (name === 'p' && multiline && pOpen) { pOpen = false; emit('\n', top()); }
          if (name === 'li' && multiline) emit('\n', top());
          stack.pop();
        }
        continue;
      }
      var format = Object.assign({}, top()), a = htmlAttributes(m[3]), selfClosing = /\/\s*$/.test(m[3]);
      if (name === 'br' || name === 'sbr') {
        if (multiline || name === 'sbr') emit('\n', format);
        continue;
      }
      if (name === 'img') {
        report('text:htmlImage', 'Images in HTML text fields are not drawn.');
        continue;
      }
      if (name === 'p') {
        pOpen = true;
        var align = (a.align || '').toLowerCase(), aligns = { left: 0, right: 1, center: 2, justify: 3 };
        if (align in aligns) format.align = aligns[align];
      } else if (name === 'font') {
        if (a.face) format.face = a.face;
        if (a.size) format.size = htmlFontSize(a.size, format.size, version);
        var hex = a.color && /^#\s*([0-9a-f]+)/i.exec(a.color);
        if (hex) {
          var rgb = parseInt(hex[1].slice(-6), 16);
          format.color = { r: (rgb >> 16) & 255, g: (rgb >> 8) & 255, b: rgb & 255 };
        }
      } else if (name === 'b') {
        format.bold = true;
      } else if (name === 'i') {
        format.italic = true;
      } else if (name === 'u') {
        format.underline = true;
      } else if (name === 'li') {
        if (multiline && !endsWithBreak()) emit('\n', top());
        format.bullet = true;
      } else if (name === 'textformat') {
        if (a.leftmargin !== undefined) format.leftMargin = htmlNumber(a.leftmargin, format.leftMargin);
        if (a.rightmargin !== undefined) format.rightMargin = htmlNumber(a.rightmargin, format.rightMargin);
        if (a.indent !== undefined) format.indent = htmlNumber(a.indent, format.indent);
        if (a.blockindent !== undefined) format.blockIndent = htmlNumber(a.blockindent, format.blockIndent);
        if (a.leading !== undefined) format.leading = htmlNumber(a.leading, format.leading);
      }
      if (selfClosing) { if (name === 'p') pOpen = false; continue; }
      stack.push({ tag: name, format: format });
    }
    text(html.slice(i));
    return spans;
  }

  Object.assign(M, { parseHtmlText: parseHtmlText });
})(typeof window !== 'undefined' ? window : globalThis);
