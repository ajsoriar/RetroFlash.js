/* RetroFlash.js - The XML the Flash Player plugin exchanged with the page for ExternalInterface (the plugin's
   CallFunction and SetReturnValue methods, and the page glue __flash__toXML / __flash__argumentsToXML):

     <invoke name="setMessage" returntype="xml"><arguments><string>Hello</string></arguments></invoke>

   Values: <string>text</string>, <number>5</number> (also NaN, Infinity and -Infinity), <true/>, <false/>,
   <null/>, <undefined/>, <date>milliseconds</date>, <array><property id="0">value</property>...</array> and
   <object><property id="name">value</property>...</object>. The answer to a returntype="xml" invoke is one value
   in XML; to returntype="javascript", the value as a JavaScript literal (the text the plugin's page glue ran).
   The XML is read by a small strict parser of its own (elements, attributes, text, the five named entities,
   numeric character references, CDATA, comments and the XML declaration), bounded in size, depth and nodes.
   It never uses the browser's parser or evaluates anything, so it works the same under a Content Security
   Policy, in old browsers and in Node. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;

  var MAX_XML_LENGTH = 1024 * 1024;  // characters of one invoke or value
  var MAX_XML_DEPTH = 64;            // nesting of elements
  var MAX_XML_NODES = 100000;        // elements and text nodes of one document
  var NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

  function xmlError(message) {
    var err = new Error('RetroFlash: ' + message);
    err.name = 'RetroFlashError';
    err.code = 'INVALID_XML';
    return err;
  }
  function isNameStart(c) { return /[A-Za-z_:]/.test(c) || c > '\u007f'; }
  function isNameChar(c) { return /[\w.:-]/.test(c) || c > '\u007f'; }
  function isSpace(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r'; }

  /* Parses `text` into its root element: { name, attributes (an object without a prototype), children (elements
     and strings, in order) }. Throws INVALID_XML for anything malformed or past the limits. */
  function parseXML(text) {
    text = String(text);
    if (text.length > MAX_XML_LENGTH) throw xmlError('the XML is longer than ' + MAX_XML_LENGTH + ' characters');
    var i = 0, nodes = 0;
    function fail(message) { throw xmlError(message + ' at offset ' + i); }
    function startsWith(s) { return text.substr(i, s.length) === s; }
    function skipSpace() { while (i < text.length && isSpace(text.charAt(i))) i++; }
    function name() {
      var start = i;
      if (!isNameStart(text.charAt(i))) fail('a name was expected');
      while (i < text.length && isNameChar(text.charAt(i))) i++;
      return text.slice(start, i);
    }
    function decode(raw) {
      var out = '', at = 0;
      for (;;) {
        var amp = raw.indexOf('&', at);
        if (amp < 0) return out + raw.slice(at);
        var semi = raw.indexOf(';', amp);
        if (semi < 0 || semi - amp > 12) fail('an entity is not closed');
        var entity = raw.slice(amp + 1, semi), code;
        out += raw.slice(at, amp);
        if (entity.charAt(0) === '#') {
          code = entity.charAt(1) === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
          if (!(code >= 0 && code <= 0x10ffff) || !/^#(x[0-9a-fA-F]+|[0-9]+)$/.test(entity)) fail('a character reference is not valid');
          out += code > 0xffff ? String.fromCharCode(0xd800 + ((code - 0x10000) >> 10), 0xdc00 + ((code - 0x10000) & 0x3ff)) : String.fromCharCode(code);
        } else if (NAMED.hasOwnProperty(entity)) {
          out += NAMED[entity];
        } else {
          fail('unknown entity &' + entity + ';');
        }
        at = semi + 1;
      }
    }
    // Comments, processing instructions (the XML declaration) and white space between elements.
    function skipMisc() {
      for (;;) {
        skipSpace();
        if (startsWith('<!--')) {
          var end = text.indexOf('-->', i + 4);
          if (end < 0) fail('a comment is not closed');
          i = end + 3;
        } else if (startsWith('<?')) {
          var close = text.indexOf('?>', i + 2);
          if (close < 0) fail('a processing instruction is not closed');
          i = close + 2;
        } else {
          return;
        }
      }
    }
    function element(depth) {
      if (depth > MAX_XML_DEPTH) fail('elements are nested more than ' + MAX_XML_DEPTH + ' deep');
      if (++nodes > MAX_XML_NODES) fail('more than ' + MAX_XML_NODES + ' nodes');
      if (text.charAt(i) !== '<') fail('an element was expected');
      i++;
      var node = { name: name(), attributes: Object.create(null), children: [] };
      for (;;) {
        var before = i;
        skipSpace();
        var c = text.charAt(i);
        if (c === '/' && text.charAt(i + 1) === '>') { i += 2; return node; }
        if (c === '>') { i++; break; }
        if (i === before) fail('a space was expected before an attribute');
        var key = name();
        skipSpace();
        if (text.charAt(i) !== '=') fail('"=" was expected after attribute ' + key);
        i++;
        skipSpace();
        var quote = text.charAt(i);
        if (quote !== '"' && quote !== "'") fail('a quoted attribute value was expected');
        var end = text.indexOf(quote, i + 1);
        if (end < 0) fail('an attribute value is not closed');
        var raw = text.slice(i + 1, end);
        if (raw.indexOf('<') >= 0) fail('"<" in an attribute value');
        if (key in node.attributes) fail('attribute ' + key + ' is repeated');
        node.attributes[key] = decode(raw);
        i = end + 1;
      }
      for (;;) {
        if (i >= text.length) fail('element <' + node.name + '> is not closed');
        if (startsWith('</')) {
          i += 2;
          if (name() !== node.name) fail('the end tag does not match <' + node.name + '>');
          skipSpace();
          if (text.charAt(i) !== '>') fail('">" was expected');
          i++;
          return node;
        }
        if (startsWith('<![CDATA[')) {
          var cdataEnd = text.indexOf(']]>', i + 9);
          if (cdataEnd < 0) fail('a CDATA section is not closed');
          addText(node, text.slice(i + 9, cdataEnd));
          i = cdataEnd + 3;
        } else if (startsWith('<!--') || startsWith('<?')) {
          skipMisc();
        } else if (text.charAt(i) === '<') {
          node.children.push(element(depth + 1));
        } else {
          var next = text.indexOf('<', i);
          if (next < 0) next = text.length;
          addText(node, decode(text.slice(i, next)));
          i = next;
        }
      }
    }
    function addText(node, s) {
      if (!s) return;
      var last = node.children.length - 1;
      if (last >= 0 && typeof node.children[last] === 'string') { node.children[last] += s; return; }
      if (++nodes > MAX_XML_NODES) fail('more than ' + MAX_XML_NODES + ' nodes');
      node.children.push(s);
    }
    skipMisc();
    var root = element(1);
    skipMisc();
    if (i < text.length) fail('text after the root element');
    return root;
  }

  function escapeXML(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
  function elementsOf(node) {
    return node.children.filter(function (c) {
      if (typeof c === 'string') {
        if (/\S/.test(c)) throw xmlError('unexpected text in <' + node.name + '>');
        return false;
      }
      return true;
    });
  }
  function textOf(node) {
    return node.children.map(function (c) {
      if (typeof c !== 'string') throw xmlError('<' + node.name + '> holds an element');
      return c;
    }).join('');
  }

  /* A page value in the plugin's XML. Getters are never called: objects give their own enumerable data
     properties; functions and symbols are <undefined/> (as the plugin's glue had no XML for them), cycles and
     values past the depth are <null/>. */
  function toXMLValue(value, depth, seen) {
    depth = depth || 0;
    seen = seen || [];
    switch (typeof value) {
      case 'string': return '<string>' + escapeXML(value) + '</string>';
      case 'number': return '<number>' + String(value) + '</number>';
      case 'bigint': return '<number>' + String(Number(value)) + '</number>';
      case 'boolean': return value ? '<true/>' : '<false/>';
      case 'object': break;
      default: return '<undefined/>';
    }
    if (value === null || depth >= MAX_XML_DEPTH || seen.indexOf(value) >= 0) return '<null/>';
    if (value instanceof Date) return '<date>' + value.getTime() + '</date>';
    seen.push(value);
    try {
      var out, keys, i;
      if (Array.isArray(value)) {
        out = '<array>';
        for (i = 0; i < value.length; i++) out += '<property id="' + i + '">' + toXMLValue(i in value ? dataValue(value, i) : undefined, depth + 1, seen) + '</property>';
        return out + '</array>';
      }
      out = '<object>';
      keys = Object.keys(value);
      for (i = 0; i < keys.length; i++) out += '<property id="' + escapeXML(keys[i]) + '">' + toXMLValue(dataValue(value, keys[i]), depth + 1, seen) + '</property>';
      return out + '</object>';
    } finally {
      seen.pop();
    }
  }
  function dataValue(obj, key) {
    var d = Object.getOwnPropertyDescriptor(obj, key);
    return d && 'value' in d ? d.value : null;
  }
  // The arguments of an invoke: <arguments>value...</arguments>.
  function argumentsToXML(args) {
    return '<arguments>' + (args || []).map(function (a) { return toXMLValue(a); }).join('') + '</arguments>';
  }
  // A whole invoke, as the plugin sent it to the page or the page to the plugin.
  function invokeToXML(name, args, returnType) {
    return '<invoke name="' + escapeXML(name) + '" returntype="' + escapeXML(returnType || 'xml') + '">' + argumentsToXML(args) + '</invoke>';
  }

  /* An XML value element as a page value. An <array> is an array of its properties by numeric id; an <object>
     an object without a prototype chain to reach (its own properties are plain data, even "__proto__"). */
  function fromXMLNode(node) {
    var kids;
    switch (node.name) {
      case 'string': return textOf(node);
      case 'number': {
        var s = textOf(node).trim(), n = Number(s);
        if (s === '' || (n !== n && s !== 'NaN')) throw xmlError('"' + s + '" is not a number');
        return n;
      }
      case 'true': case 'false': case 'null': case 'undefined':
        if (elementsOf(node).length) throw xmlError('<' + node.name + '> holds an element');
        return { 'true': true, 'false': false, 'null': null, 'undefined': undefined }[node.name];
      case 'date': {
        var ms = Number(textOf(node).trim());
        if (ms !== ms) throw xmlError('a <date> holds no time');
        return new Date(ms);
      }
      case 'array': case 'object': {
        var isArray = node.name === 'array', out = isArray ? [] : {};
        kids = elementsOf(node);
        kids.forEach(function (p) {
          if (p.name !== 'property' || !('id' in p.attributes)) throw xmlError('<' + node.name + '> holds something other than <property id>');
          var values = elementsOf(p);
          if (values.length !== 1) throw xmlError('a <property> holds ' + values.length + ' values');
          var id = p.attributes.id, value = fromXMLNode(values[0]);
          if (isArray) {
            if (!/^(0|[1-9]\d{0,6})$/.test(id)) throw xmlError('array property id "' + id + '" is not an index');
            out[Number(id)] = value;
          } else {
            Object.defineProperty(out, id, { value: value, enumerable: true, writable: true, configurable: true });
          }
        });
        return out;
      }
      default:
        throw xmlError('<' + node.name + '> is not a value the plugin exchanged');
    }
  }
  function fromXMLValue(xml) { return fromXMLNode(parseXML(xml)); }

  // An invoke from the page (CallFunction): { name, returnType ('xml' or 'javascript'), args }.
  function parseInvoke(xml) {
    var root = parseXML(xml);
    if (root.name !== 'invoke' || !root.attributes.name) throw xmlError('an <invoke name="..."> was expected');
    var returnType = String(root.attributes.returntype || 'xml').toLowerCase();
    if (returnType !== 'xml' && returnType !== 'javascript') throw xmlError('returntype must be "xml" or "javascript"');
    var kids = elementsOf(root), args = [];
    if (kids.length > 1 || (kids.length && kids[0].name !== 'arguments')) throw xmlError('an <invoke> holds only <arguments>');
    if (kids.length) args = elementsOf(kids[0]).map(fromXMLNode);
    return { name: root.attributes.name, returnType: returnType, args: args };
  }

  /* A value as a JavaScript literal (the answer to a returntype="javascript" invoke): JSON for strings, numbers
     with NaN and Infinity, new Date(ms), arrays and objects. Never evaluated by the player. */
  function toJSLiteral(value, depth, seen) {
    depth = depth || 0;
    seen = seen || [];
    switch (typeof value) {
      case 'string': return JSON.stringify(value).split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029');
      case 'number': return value !== value ? 'NaN' : value === Infinity ? 'Infinity' : value === -Infinity ? '-Infinity' : String(value);
      case 'boolean': return String(value);
      case 'object': break;
      default: return 'undefined';
    }
    if (value === null || depth >= MAX_XML_DEPTH || seen.indexOf(value) >= 0) return 'null';
    if (value instanceof Date) return 'new Date(' + value.getTime() + ')';
    seen.push(value);
    try {
      if (Array.isArray(value)) {
        var items = [];
        for (var i = 0; i < value.length; i++) items.push(toJSLiteral(i in value ? dataValue(value, i) : undefined, depth + 1, seen));
        return '[' + items.join(',') + ']';
      }
      return '({' + Object.keys(value).map(function (k) { return JSON.stringify(k) + ':' + toJSLiteral(dataValue(value, k), depth + 1, seen); }).join(',') + '})';
    } finally {
      seen.pop();
    }
  }

  Object.assign(M, {
    parseXML: parseXML, escapeXML: escapeXML, toXMLValue: toXMLValue, fromXMLValue: fromXMLValue,
    argumentsToXML: argumentsToXML, invokeToXML: invokeToXML, parseInvoke: parseInvoke, toJSLiteral: toJSLiteral,
    MAX_XML_LENGTH: MAX_XML_LENGTH
  });
})(typeof window !== 'undefined' ? window : globalThis);
