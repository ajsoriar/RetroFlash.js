/* RetroFlash.js v0.4 - SWF player prototype (browser classic script). Load swf-reader.js first.
   API: const player = new RetroFlash.Player({ canvas }); await player.load(file); player.play();
   Character dictionary, display list and timelines (root and DefineSprite), DefineShape 1-4 and bitmaps
   (JPEG/PNG/GIF via the browser decoder, lossless and JPEG alpha in JS) drawn with Canvas 2D, clipDepth masks,
   text (DefineText with embedded glyphs; DefineEditText with embedded or device fonts, word wrap, alignment
   and an HTML subset), AVM1 buttons (DefineButton/DefineButton2: states, hit areas, pointer and keyboard
   events), and a controlled AVM1 subset for timeline control (stop/play/goto/setTarget) in frame scripts and
   button actions. It never evaluates JavaScript or navigates. Sound, video and morph shapes are not drawn yet;
   see getDiagnostics().unsupported.
*/
(function (global) {
  'use strict';

  var VERSION = '0.4.0';
  var MAX_NESTING = 32;           // nested sprite/button instances
  var MAX_INSTANCES = 100000;     // sprite/button instances created in one step (tick, seek, input event); hostile-file budget
  var GRADIENT_HALF = 16384;      // SWF gradients are defined on a 32768-twip square centred on the origin
  var SHAPE_CODES = { 2: 1, 22: 1, 32: 1, 83: 1 };
  var BITMAP_CODES = { 6: 1, 20: 1, 21: 1, 35: 1, 36: 1, 90: 1 };
  var FONT_CODES = { 10: 1, 48: 1, 75: 1 };
  // Other definition tags whose body starts with the new character id (UI16); placed but not drawn yet.
  var CHARACTER_TAGS = { 14: 1, 46: 1, 60: 1, 84: 1, 87: 1, 91: 1 };
  // BUTTONCONDACTION condition bits (little-endian UI16; bits 9-15 hold a key code).
  var BUTTON = {
    IDLE_TO_OVER_UP: 1 << 0, OVER_UP_TO_IDLE: 1 << 1, OVER_UP_TO_OVER_DOWN: 1 << 2, OVER_DOWN_TO_OVER_UP: 1 << 3,
    OVER_DOWN_TO_OUT_DOWN: 1 << 4, OUT_DOWN_TO_OVER_DOWN: 1 << 5, OUT_DOWN_TO_IDLE: 1 << 6
  };
  var CAPS = ['round', 'butt', 'square'];
  var JOINS = ['round', 'bevel', 'miter'];
  var DEFAULT_MAX_BITMAP_PIXELS = 4096 * 4096;
  var DEFAULT_MAX_TOTAL_BITMAP_PIXELS = 4 * DEFAULT_MAX_BITMAP_PIXELS; // about 256 MB of RGBA for all bitmaps of a movie
  // AVM1 budgets per tick: action blocks run and actions executed.
  var MAX_ACTION_BLOCKS = 10000;
  var MAX_ACTION_STEPS = 100000;

  function playerError(code, message) {
    var err = new Error('RetroFlash: ' + message);
    err.name = 'RetroFlashError';
    err.code = code;
    return err;
  }

  // ---- Matrices [a, b, c, d, tx, ty] (Canvas order) and colour transforms ----------------------------------
  var IDENTITY = [1, 0, 0, 1, 0, 0];
  // SWF MATRIX: x' = x*ScaleX + y*RotateSkew1 + TranslateX; y' = x*RotateSkew0 + y*ScaleY + TranslateY.
  function toMatrix(m) { return m ? [m.scaleX, m.rotateSkew0, m.rotateSkew1, m.scaleY, m.translateX, m.translateY] : IDENTITY; }
  function multiply(p, c) {
    return [
      p[0] * c[0] + p[2] * c[1], p[1] * c[0] + p[3] * c[1],
      p[0] * c[2] + p[2] * c[3], p[1] * c[2] + p[3] * c[3],
      p[0] * c[4] + p[2] * c[5] + p[4], p[1] * c[4] + p[3] * c[5] + p[5]
    ];
  }
  function invert(m) {
    var det = m[0] * m[3] - m[1] * m[2];
    if (!det || !isFinite(det)) return null;
    return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
      (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
  }
  function transformPoint(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }

  // Colour transform [rMul, gMul, bMul, aMul, rAdd, gAdd, bAdd, aAdd]; multipliers as factors (SWF 256 = 1.0).
  var CX_IDENTITY = [1, 1, 1, 1, 0, 0, 0, 0];
  function toColorTransform(c) {
    if (!c) return CX_IDENTITY;
    return [c.redMult / 256, c.greenMult / 256, c.blueMult / 256, c.alphaMult === undefined ? 1 : c.alphaMult / 256,
      c.redAdd, c.greenAdd, c.blueAdd, c.alphaAdd || 0];
  }
  // Child transform applied first, then the parent's.
  function concatColorTransform(p, c) {
    return [p[0] * c[0], p[1] * c[1], p[2] * c[2], p[3] * c[3],
      p[0] * c[4] + p[4], p[1] * c[5] + p[5], p[2] * c[6] + p[6], p[3] * c[7] + p[7]];
  }
  function channel(v) { return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v); }
  function cssColor(color, cx) {
    return 'rgba(' + channel(color.r * cx[0] + cx[4]) + ',' + channel(color.g * cx[1] + cx[5]) + ',' +
      channel(color.b * cx[2] + cx[6]) + ',' + channel(color.a * cx[3] + cx[7]) / 255 + ')';
  }

  // ---- Shape geometry ---------------------------------------------------------------------------------------
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

  // ---- Bitmaps ------------------------------------------------------------------------------------------------
  // Writes straight (non-premultiplied) RGBA from premultiplied components.
  function unpremultiply(out, o, r, g, b, a) {
    if (a === 0) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; return; }
    if (a === 255) { out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255; return; }
    out[o] = Math.min(255, Math.round((r * 255) / a));
    out[o + 1] = Math.min(255, Math.round((g * 255) / a));
    out[o + 2] = Math.min(255, Math.round((b * 255) / a));
    out[o + 3] = a;
  }
  // Size of the inflated ZlibBitmapData: colour table + rows padded to 32 bits (formats 3 and 4).
  function losslessByteLength(f) {
    var w = f.width, h = f.height;
    if (f.bitmapFormat === 3) return f.colorTableSize * (f.losslessVersion === 2 ? 4 : 3) + ((w + 3) & ~3) * h;
    if (f.bitmapFormat === 4) return ((w * 2 + 3) & ~3) * h;
    return w * h * 4;
  }
  /* DefineBitsLossless(2) inflated data -> { width, height, rgba } with straight alpha. Format 3: colour-mapped
     (RGB table, or premultiplied RGBA in version 2); format 4: PIX15 big-endian; format 5: PIX24 (version 1)
     or premultiplied ARGB (version 2). Indices outside the colour table give transparent pixels. */
  function decodeLossless(f, data) {
    var w = f.width, h = f.height, v2 = f.losslessVersion === 2, out = new Uint8ClampedArray(w * h * 4), x, y, o = 0, p;
    if (data.length < losslessByteLength(f)) throw playerError('BITMAP_TRUNCATED', 'Bitmap data has ' + data.length + ' bytes, expected ' + losslessByteLength(f));
    if (f.bitmapFormat === 3) {
      var entry = v2 ? 4 : 3, count = f.colorTableSize, stride = (w + 3) & ~3, base = count * entry;
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++, o += 4) {
          var index = data[base + y * stride + x];
          if (index >= count) continue;
          p = index * entry;
          if (v2) unpremultiply(out, o, data[p], data[p + 1], data[p + 2], data[p + 3]);
          else { out[o] = data[p]; out[o + 1] = data[p + 1]; out[o + 2] = data[p + 2]; out[o + 3] = 255; }
        }
      }
    } else if (f.bitmapFormat === 4) {
      var rowBytes = (w * 2 + 3) & ~3, expand = function (c) { return (c << 3) | (c >> 2); };
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++, o += 4) {
          p = y * rowBytes + x * 2;
          var v = (data[p] << 8) | data[p + 1];
          out[o] = expand((v >> 10) & 31); out[o + 1] = expand((v >> 5) & 31); out[o + 2] = expand(v & 31); out[o + 3] = 255;
        }
      }
    } else {
      for (p = 0; p < w * h * 4; p += 4, o += 4) {
        if (v2) unpremultiply(out, o, data[p + 1], data[p + 2], data[p + 3], data[p]);
        else { out[o] = data[p + 1]; out[o + 1] = data[p + 2]; out[o + 2] = data[p + 3]; out[o + 3] = 255; }
      }
    }
    return { width: w, height: h, rgba: out };
  }
  function concatBytes(parts) {
    var length = 0, at = 0, i;
    for (i = 0; i < parts.length; i++) length += parts[i].length;
    var out = new Uint8Array(length);
    for (i = 0; i < parts.length; i++) { out.set(parts[i], at); at += parts[i].length; }
    return out;
  }
  // Removes every FF D9 FF D8 (EOI + SOI) sequence: SWF < 8 tools prepend one ("erroneous header") and some
  // files join two JPEG streams with it. Browsers need one continuous stream.
  function cleanJpeg(bytes) {
    var parts = [], start = 0;
    for (var i = 0; i + 3 < bytes.length; i++) {
      if (bytes[i] === 0xff && bytes[i + 1] === 0xd9 && bytes[i + 2] === 0xff && bytes[i + 3] === 0xd8) {
        parts.push(bytes.subarray(start, i));
        start = i + 4;
        i += 3;
      }
    }
    if (!parts.length) return bytes;
    parts.push(bytes.subarray(start));
    return concatBytes(parts);
  }
  // DefineBits: JPEGTables (SOI, DQT/DHT, EOI) + image (SOI, frame and scan) -> one JPEG stream.
  function mergeJpegTables(tables, image) {
    tables = cleanJpeg(tables);
    image = cleanJpeg(image);
    if (tables.length < 4) return image;
    var tablesEnd = tables[tables.length - 2] === 0xff && tables[tables.length - 1] === 0xd9 ? tables.length - 2 : tables.length;
    var imageStart = image[0] === 0xff && image[1] === 0xd8 ? 2 : 0;
    return concatBytes([tables.subarray(0, tablesEnd), image.subarray(imageStart)]);
  }
  function createCanvas(width, height) {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
    var c = global.document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }
  var IMAGE_TYPES = { jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif' };
  // Pixel size declared in the header of encoded image data (JPEG frame header SOFn, PNG IHDR, GIF logical
  // screen), read before decoding so that oversized images are refused before any memory is allocated.
  // Returns null when no usable size is found.
  function imageSize(bytes, format) {
    var b = bytes, n = b.length, size = null;
    if (format === 'png') {
      if (n >= 24 && b[12] === 0x49 && b[13] === 0x48 && b[14] === 0x44 && b[15] === 0x52) {
        size = { width: ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0, height: ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0 };
      }
    } else if (format === 'gif') {
      if (n >= 10) size = { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
    } else if (format === 'jpeg') {
      // Marker segments up to the first frame header; a scan (SOS) before it means there is no usable size.
      for (var i = 0; i + 3 < n && !size;) {
        if (b[i] !== 0xff) break;
        var m = b[i + 1];
        if (m === 0xff) { i++; continue; } // fill byte
        if (m === 0xd8 || m === 0xd9 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; } // no length field
        if (m === 0xda) break;
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { // SOF0-SOF15, not DHT, JPG, DAC
          if (i + 8 < n) size = { width: (b[i + 7] << 8) | b[i + 8], height: (b[i + 5] << 8) | b[i + 6] };
          break;
        }
        var length = (b[i + 2] << 8) | b[i + 3];
        if (length < 2) break;
        i += 2 + length;
      }
    }
    return size && size.width && size.height ? size : null;
  }
  // Takes width × height pixels from the movie's bitmap budget: limits = { maxPixels (per bitmap), remaining (all bitmaps) }.
  function reservePixels(limits, width, height) {
    var pixels = width * height;
    if (pixels > limits.maxPixels) throw playerError('BITMAP_TOO_LARGE', width + '×' + height + ' exceeds options.maxBitmapPixels');
    if (pixels > limits.remaining) throw playerError('BITMAP_BUDGET', width + '×' + height + ' would exceed options.maxTotalBitmapPixels for this movie');
    limits.remaining -= pixels;
    return pixels;
  }
  // Browser only: returns a drawable (ImageBitmap or canvas) for a bitmap character. Pixels are reserved
  // from `limits` before decoding, using the size declared by the SWF tag or the image header.
  async function decodeBitmap(swf, character, jpegTables, limits) {
    var f = character.fields, data = swf.getTagData(character.tag), code = character.tag.code;
    if (code === 20 || code === 36) {
      if (!f.width || !f.height) throw playerError('BITMAP_EMPTY', 'Bitmap has no pixels');
      reservePixels(limits, f.width, f.height);
      var pixels = decodeLossless(f, await global.SWFReader.inflate(data.subarray(f.dataStart), losslessByteLength(f), { truncate: true }));
      var canvas = createCanvas(pixels.width, pixels.height);
      canvas.getContext('2d').putImageData(new ImageData(pixels.rgba, pixels.width, pixels.height), 0, 0);
      return canvas;
    }
    var bytes = data.subarray(f.imageStart, f.imageEnd);
    if (code === 6) bytes = jpegTables ? mergeJpegTables(jpegTables, bytes) : cleanJpeg(bytes);
    else if (f.imageFormat === 'jpeg') bytes = cleanJpeg(bytes);
    if (!IMAGE_TYPES[f.imageFormat]) throw playerError('BITMAP_FORMAT', 'Unrecognised image data in ' + character.name);
    var declared = imageSize(bytes, f.imageFormat);
    if (!declared) throw playerError('BITMAP_FORMAT', 'No image size found in the ' + f.imageFormat + ' header of ' + character.name);
    var reserved = reservePixels(limits, declared.width, declared.height);
    var image = await createImageBitmap(new Blob([bytes], { type: IMAGE_TYPES[f.imageFormat] }));
    var w = image.width, h = image.height;
    // The decoder's result must not be larger than what the header declared (and was reserved).
    if (w * h > reserved) { image.close(); throw playerError('BITMAP_TOO_LARGE', w + '×' + h + ' is larger than the ' + declared.width + '×' + declared.height + ' declared in its header'); }
    if (f.alphaStart === undefined || f.imageFormat !== 'jpeg') return image;
    // DefineBitsJPEG3/4: separate zlib alpha plane, one byte per pixel; colour data is treated as premultiplied.
    var alpha = await global.SWFReader.inflate(data.subarray(f.alphaStart), w * h, { truncate: true });
    if (alpha.length !== w * h) { image.close(); throw playerError('BITMAP_ALPHA', 'Alpha plane has ' + alpha.length + ' bytes, expected ' + w * h); }
    var target = createCanvas(w, h), ctx = target.getContext('2d');
    ctx.drawImage(image, 0, 0);
    image.close();
    var frame = ctx.getImageData(0, 0, w, h), d = frame.data;
    for (var i = 0, o = 0; i < alpha.length; i++, o += 4) unpremultiply(d, o, d[o], d[o + 1], d[o + 2], alpha[i]);
    ctx.putImageData(frame, 0, 0);
    return target;
  }

  // ---- Movie definition: dictionary and frame lists ---------------------------------------------------------
  // Frame k (1-based) = the control tags between ShowFrame k-1 and ShowFrame k. Tags after the last ShowFrame are ignored.
  function buildTimeline(tags) {
    var frames = [], current = [], labels = Object.create(null);
    for (var i = 0; i < tags.length; i++) {
      var tag = tags[i];
      if (tag.code === 0) break;
      if (tag.code === 1) { frames.push(current); current = []; continue; }
      if (tag.code === 43 && tag.fields && !(tag.fields.name in labels)) labels[tag.fields.name] = frames.length + 1;
      current.push(tag);
    }
    if (!frames.length) frames.push(current);
    return { frames: frames, labels: labels };
  }

  // Button character: records with Canvas matrices/colour transforms, and action lists as runnable blocks.
  function buttonCharacter(swf, tag) {
    var f = tag.fields, data = swf.getTagData(tag);
    return {
      type: 'button', id: f.buttonId, name: tag.name, trackAsMenu: f.trackAsMenu,
      records: f.records.map(function (r) {
        return {
          up: r.up, over: r.over, down: r.down, hitTest: r.hitTest, characterId: r.characterId, depth: r.depth,
          matrix: toMatrix(r.matrix), cx: toColorTransform(r.colorTransform), blendMode: r.blendMode, filters: r.filters
        };
      }),
      actions: f.actions.map(function (a) {
        return { conditions: a.conditions, offset: tag.dataOffset + a.start, bytes: data.subarray(a.start, a.end), label: tag.name + ' ' + f.buttonId + ' action' };
      })
    };
  }

  function Movie(swf) {
    var characters = Object.create(null), jpegTables = null, buttonColors = Object.create(null), buttonSounds = [], fontInfos = [];
    // A definition whose body could not be decoded still defines its id (first UI16), so placements report
    // it as an invalid character rather than a missing one.
    function invalidCharacter(tag) {
      if (tag.length < 2) return;
      var data = swf.getTagData(tag), id = data[0] | (data[1] << 8);
      characters[id] = { type: 'unsupported', id: id, name: tag.name + ' (invalid)' };
    }
    swf.tags.forEach(function (tag) {
      var f = tag.fields, decoded = f && tag.status === 'decoded';
      if (SHAPE_CODES[tag.code]) {
        if (decoded) characters[f.shapeId] = { type: 'shape', id: f.shapeId, name: tag.name, shape: f, geometry: null };
        else invalidCharacter(tag);
      } else if (BITMAP_CODES[tag.code]) {
        if (decoded) characters[f.characterId] = { type: 'bitmap', id: f.characterId, name: tag.name, tag: tag, fields: f, source: null, width: 0, height: 0 };
        else invalidCharacter(tag);
      } else if (tag.code === 7 || tag.code === 34) {
        if (decoded) characters[f.buttonId] = buttonCharacter(swf, tag);
        else invalidCharacter(tag);
      } else if (FONT_CODES[tag.code]) {
        if (decoded) characters[f.fontId] = fontCharacter(f, tag.name);
        else invalidCharacter(tag);
      } else if (tag.code === 13 || tag.code === 62) {
        if (f) fontInfos.push(f);
      } else if (tag.code === 11 || tag.code === 33) {
        if (decoded) characters[f.characterId] = { type: 'text', id: f.characterId, name: tag.name, text: f, glyphs: null };
        else invalidCharacter(tag);
      } else if (tag.code === 37) {
        if (decoded) characters[f.characterId] = { type: 'editText', id: f.characterId, name: tag.name, field: f, version: swf.version, layout: null };
        else invalidCharacter(tag);
      } else if (tag.code === 23) {
        if (f) buttonColors[f.buttonId] = f.colorTransforms;
      } else if (tag.code === 17) {
        if (f) buttonSounds.push(f.buttonId);
      } else if (tag.code === 8) {
        if (!jpegTables && tag.length) jpegTables = swf.getTagData(tag);
      } else if (tag.code === 39 && tag.children && tag.status !== 'invalid') {
        var timeline = buildTimeline(tag.children);
        characters[tag.spriteId] = { type: 'sprite', id: tag.spriteId, name: tag.name, frames: timeline.frames, labels: timeline.labels };
      } else if (CHARACTER_TAGS[tag.code] && tag.length >= 2) {
        var data = swf.getTagData(tag), id = data[0] | (data[1] << 8);
        characters[id] = { type: 'unsupported', id: id, name: tag.name };
      }
    });
    // DefineButtonCxform colours apply to a DefineButton's records in order.
    Object.keys(buttonColors).forEach(function (id) {
      var button = characters[id];
      if (!button || button.type !== 'button') return;
      buttonColors[id].forEach(function (cx, i) { if (button.records[i]) button.records[i].cx = toColorTransform(cx); });
    });
    // DefineFontInfo gives a DefineFont its name, style and the character code of each glyph.
    fontInfos.forEach(function (info) {
      var font = characters[info.fontId];
      if (!font || font.type !== 'font') return;
      font.fontName = info.name;
      font.bold = info.bold;
      font.italic = info.italic;
      font.byCode = new Map();
      info.codes.forEach(function (code, i) { if (i < font.glyphs.length && !font.byCode.has(code)) font.byCode.set(code, i); });
    });
    var root = buildTimeline(swf.tags);
    this.swf = swf;
    this.characters = characters;
    this.jpegTables = jpegTables;
    this.buttonSounds = buttonSounds;
    this.root = { type: 'sprite', id: 0, name: 'root', frames: root.frames, labels: root.labels };
  }
  // Browser only. Decodes every bitmap character, at most BITMAP_DECODE_CONCURRENCY at a time to bound the
  // memory held by inflated buffers; failures are reported and leave the bitmap undrawn. Bitmaps are taken in
  // character id order from one pixel budget (maxTotalPixels), so a movie cannot exhaust memory with many images.
  var BITMAP_DECODE_CONCURRENCY = 4;
  Movie.prototype.decodeBitmaps = function (maxPixels, maxTotalPixels, report) {
    var self = this, limits = { maxPixels: maxPixels, remaining: maxTotalPixels };
    var pending = Object.keys(this.characters).map(function (id) { return self.characters[id]; })
      .filter(function (c) { return c.type === 'bitmap'; });
    function worker() {
      var character = pending.shift();
      if (!character) return Promise.resolve();
      return decodeBitmap(self.swf, character, self.jpegTables, limits).then(function (source) {
        character.source = source;
        character.width = source.width;
        character.height = source.height;
      }, function (err) {
        report('render:bitmapDecodeFailed', 'A bitmap could not be decoded and is not drawn.', character.id + ' (' + character.name + '): ' + err.message);
      }).then(worker);
    }
    var workers = [];
    for (var i = 0; i < BITMAP_DECODE_CONCURRENCY; i++) workers.push(worker());
    return Promise.all(workers);
  };
  // Frees decoded bitmap memory when the movie is discarded (ImageBitmap.close, or an empty canvas).
  Movie.prototype.release = function () {
    var characters = this.characters;
    Object.keys(characters).forEach(function (id) {
      var source = characters[id].source;
      if (!source) return;
      if (typeof source.close === 'function') source.close();
      else { source.width = 0; source.height = 0; }
      characters[id].source = null;
    });
  };

  // ---- Fonts and text -----------------------------------------------------------------------------------------
  var GUTTER = 40;                                      // twips between a text field's bounds and its text (2 px)
  var BULLET_INDENT = 720;                              // twips: text of an HTML <li> starts 36 px further right
  var DEFAULT_FONT_SIZE = 12;                           // px, for text fields without a font height
  var DEVICE_ASCENT = 0.905, DEVICE_DESCENT = 0.212;    // device-font metrics per px of size when the browser gives none
  var MAX_HTML_TAG = 4096;                              // characters; longer HTML tags are dropped
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
        if (!font || font.type !== 'font') {
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

  /* Text field formats, as in Flash's TextFormat: { face, size (px), color {r, g, b}, bold, italic, underline,
     align (0 left, 1 right, 2 center, 3 justify), leftMargin, rightMargin, indent, blockIndent, leading (px),
     bullet }. The field's default format comes from DefineEditText. */
  function fieldFormat(field, characters, version) {
    var font = field.fontId !== undefined ? characters[field.fontId] : null, html = field.html;
    if (font && font.type !== 'font') font = null;
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

  /* Lays out a DefineEditText in its own space (twips). Text breaks at '\n' and, with WordWrap, between words
     (a word longer than the line is split between characters). Each line's height is its largest ascent and
     descent plus the leading; text starts 2 px (GUTTER) inside the bounds. Alignment uses the width between
     the margins and never moves text left of the margin. AutoSize grows the field from its left edge.
     measure = { width(css, text) -> px, metrics(css, sizePx) -> { ascent, descent } in px } for device fonts.
     Returns { bounds, lines: [{ runs: [{ text, x, baseline, face, format }], bullet }], width, height }, where
     face is { font, scale } for embedded glyphs or { css } for a device font. */
  function layoutEditText(character, characters, measure, report) {
    var field = character.field, version = character.version, id = character.id;
    var base = fieldFormat(field, characters, version), source = field.initialText || '', faces = new Map();
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
        if (field.useOutlines) report('text:deviceFallback', 'A text field set to embedded fonts has no font with glyphs for its face; a device font is used.', id + ': ' + format.face);
        var css = (format.italic ? 'italic ' : '') + (format.bold ? 'bold ' : '') + format.size + 'px ' + cssFontFamily(format.face);
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

  // ---- Timelines and display list ---------------------------------------------------------------------------
  /* A Clip is a running timeline (the root or a sprite instance) with its display list keyed by depth.
     env = { characters, report(feature, reason, source) } plus, for ActionScript, the fields created by
     createEnv(). Display objects are { depth, characterId, character, matrix, cx, ratio, name, clipDepth,
     blendMode, clip }. `playing` is the timeline's own play state (AVM1 stop/play). */
  function Clip(env, def, level, parent) {
    this.env = env;
    this.def = def;
    this.level = level;
    this.parent = parent || null;
    this.frame = 0;
    this.loop = true;
    this.playing = true;
    this.displayList = new Map();
  }
  // Shared state for every Clip of one movie. options.actions: run frame scripts (default true).
  function createEnv(movie, report, options) {
    return {
      characters: movie.characters, swf: movie.swf, version: movie.swf.version, report: report,
      actions: !options || options.actions !== false, quiet: false, queue: [], actionCache: new Map(), steps: 0, instances: 0
    };
  }
  // Character ids of the sprites containing this clip (the root is 0).
  Clip.prototype.ancestry = function () {
    var ids = [];
    for (var clip = this; clip; clip = clip.parent) ids.push(clip.def.id);
    return ids;
  };
  /* `level` and `ancestry` describe the container: they default to this clip's; button children pass the
     button's, so content nested through buttons is bounded too. Hostile files can make sprites or buttons
     contain themselves (possibly several times per level, which grows exponentially), so containers are
     refused when they would contain themselves, nest deeper than MAX_NESTING, or exceed MAX_INSTANCES in one step (env.instances, reset by the player). */
  Clip.prototype.createObject = function (characterId, level, ancestry) {
    var env = this.env, character = env.characters[characterId];
    var obj = { characterId: characterId, character: character || null, matrix: IDENTITY, cx: CX_IDENTITY, clip: null };
    var container = character && (character.type === 'sprite' || character.type === 'button');
    level = level === undefined ? this.level : level;
    if (container) ancestry = ancestry || this.ancestry();
    if (!character) {
      env.report('render:missingCharacter', 'A placement refers to a character id that is not defined; nothing is drawn.', characterId);
    } else if (container && ancestry.indexOf(characterId) >= 0) {
      env.report('render:recursiveCharacter', 'A sprite or button that contains itself is not instantiated again.', characterId);
    } else if (container && level + 1 > MAX_NESTING) {
      env.report('render:nestingLimit', 'Sprite and button instances nested deeper than ' + MAX_NESTING + ' levels are not created.', characterId);
    } else if (container && (env.instances = (env.instances || 0) + 1) > MAX_INSTANCES) {
      env.report('render:instanceLimit', 'More than ' + MAX_INSTANCES + ' sprite and button instances in one step; further ones are not created.', characterId);
    } else if (character.type === 'sprite') {
      obj.clip = new Clip(env, character, level + 1, this);
      obj.clip.gotoFrame(1);
    } else if (character.type === 'button') {
      obj.button = new ButtonInstance(this, character, level + 1, ancestry.concat(characterId));
    } else if (character.type === 'editText') {
      if (character.field.variableName) env.report('text:variable', 'Text fields bound to a variable show their initial text; ActionScript variables are not implemented yet.', characterId);
      if (!character.field.readOnly) env.report('text:input', 'Input text fields are drawn but cannot be edited yet.', characterId);
    } else if (character.type === 'font') {
      env.report('render:fontPlaced', 'A font is not a display object; the placement draws nothing.', characterId);
    } else if (character.type === 'unsupported') {
      env.report('render:' + character.name, character.name + ' characters are placed but not drawn yet.', characterId);
    }
    return obj;
  };
  // Applies one control tag to `list` (a Map depth -> object); `make(characterId)` creates new objects.
  function applyControlTag(list, tag, make, report) {
    var f = tag.fields;
    if (!f) return;
    var code = tag.code;
    if (code === 5 || code === 28) { list.delete(f.depth); return; }
    if (code !== 4 && code !== 26 && code !== 70) return;
    var existing = list.get(f.depth), hasCharacter = f.characterId !== undefined, obj;
    if (code === 4) {
      obj = make(f.characterId);
    } else if (f.move) {
      if (existing && hasCharacter && f.characterId !== existing.characterId) {
        obj = make(f.characterId);
        ['matrix', 'cx', 'ratio', 'name', 'clipDepth', 'blendMode'].forEach(function (k) { if (existing[k] !== undefined) obj[k] = existing[k]; });
      } else if (existing) {
        obj = existing;
      } else if (hasCharacter) {
        obj = make(f.characterId);
      } else {
        return report('timeline:moveWithoutObject', 'PlaceObject2/3 moves a depth that is empty; ignored.', f.depth);
      }
    } else if (hasCharacter) {
      obj = make(f.characterId);
    } else {
      return report('timeline:placeWithoutCharacter', 'PlaceObject2/3 without Move or CharacterId; ignored.', f.depth);
    }
    obj.depth = f.depth;
    if (f.matrix) obj.matrix = toMatrix(f.matrix);
    if (f.colorTransform) obj.cx = toColorTransform(f.colorTransform);
    if (f.ratio !== undefined) obj.ratio = f.ratio;
    if (f.name !== undefined) obj.name = f.name;
    if (f.clipDepth !== undefined) obj.clipDepth = f.clipDepth;
    if (f.blendMode !== undefined) obj.blendMode = f.blendMode;
    list.set(f.depth, obj);
  }
  Clip.prototype.frameCount = function () { return this.def.frames.length; };
  Clip.prototype.gotoFrame = function (n) {
    var count = this.def.frames.length, self = this, report = this.env.report;
    n = Math.max(1, Math.min(count, Math.floor(n)));
    if (n === this.frame) return;
    var make = function (id) { return self.createObject(id); };
    if (n > this.frame) {
      for (var k = this.frame + 1; k <= n; k++) {
        this.def.frames[k - 1].forEach(function (tag) { applyControlTag(self.displayList, tag, make, report); });
      }
    } else {
      // Rewind: rebuild the target state from frame 1, then keep existing objects whose depth still holds
      // the same character (sprite instances keep running), replace or remove the rest.
      var plan = new Map(), plain = function (id) { return { characterId: id, matrix: IDENTITY, cx: CX_IDENTITY }; };
      for (var j = 1; j <= n; j++) {
        this.def.frames[j - 1].forEach(function (tag) { applyControlTag(plan, tag, plain, report); });
      }
      this.displayList.forEach(function (obj, depth) {
        var target = plan.get(depth);
        if (!target || target.characterId !== obj.characterId) self.displayList.delete(depth);
      });
      plan.forEach(function (target, depth) {
        var obj = self.displayList.get(depth) || self.createObject(target.characterId);
        ['depth', 'matrix', 'cx', 'ratio', 'name', 'clipDepth', 'blendMode'].forEach(function (k) { obj[k] = target[k]; });
        self.displayList.set(depth, obj);
      });
    }
    this.frame = n;
    this.queueFrameActions(n);
  };
  // Frame scripts (DoAction) of the frame just entered run after the current tick, in queue order.
  Clip.prototype.queueFrameActions = function (n) {
    var env = this.env;
    if (!env.queue || env.quiet || !env.actions) return;
    var tags = this.def.frames[n - 1].filter(function (tag) { return tag.code === 12; });
    if (tags.length) env.queue.push({ clip: this, tags: tags });
  };
  // One tick: existing child sprites advance first; then this timeline moves to its next frame (children it
  // places now start at their frame 1). A stopped timeline stays put but its children keep playing.
  // Returns true when the last frame was passed (looped or stopped there).
  Clip.prototype.tick = function () {
    this.displayList.forEach(function (obj) {
      if (obj.clip) obj.clip.tick();
      else if (obj.button) obj.button.tick();
    });
    var count = this.def.frames.length;
    if (!this.playing || count < 2) return false;
    if (this.frame < count) { this.gotoFrame(this.frame + 1); return false; }
    if (this.loop) this.gotoFrame(1);
    return true;
  };
  Clip.prototype.depths = function () {
    return Array.from(this.displayList.keys()).sort(function (a, b) { return a - b; });
  };
  Clip.prototype.root = function () {
    var clip = this;
    while (clip.parent) clip = clip.parent;
    return clip;
  };
  // Child sprite instance by instance name (case-insensitive before SWF 7, as in Flash Player).
  Clip.prototype.childByName = function (name) {
    var found = null, insensitive = this.env.version < 7, wanted = insensitive ? name.toLowerCase() : name;
    this.displayList.forEach(function (obj) {
      if (found || !obj.clip || obj.name === undefined) return;
      if ((insensitive ? obj.name.toLowerCase() : obj.name) === wanted) found = obj.clip;
    });
    return found;
  };
  Clip.prototype.findLabel = function (label) {
    var labels = this.def.labels;
    if (label in labels) return labels[label];
    var lower = label.toLowerCase(), names = Object.keys(labels);
    for (var i = 0; i < names.length; i++) if (names[i].toLowerCase() === lower) return labels[names[i]];
    return 0;
  };

  // ---- Buttons ----------------------------------------------------------------------------------------------
  /* An AVM1 button instance placed in `parentClip`. Its display list holds the children of the current state
     (up/over/down); children that stay at the same depth with the same character persist across state changes.
     The hit area (HIT_TEST records) is a separate list that is never drawn. Button actions run in the
     context of the parent timeline. */
  function ButtonInstance(parentClip, character, level, ancestry) {
    this.parentClip = parentClip;
    this.character = character;
    this.env = parentClip.env;
    this.level = level === undefined ? parentClip.level + 1 : level;
    this.ancestry = ancestry || parentClip.ancestry().concat(character.id);
    this.state = null;
    this.displayList = new Map();
    this.hitList = new Map();
    var self = this, env = this.env, wasQuiet = env.quiet;
    // Hit-area children are never drawn or ticked, so sprites in it must not run frame scripts either.
    env.quiet = true;
    try {
      character.records.forEach(function (r) { if (r.hitTest) self.hitList.set(r.depth, self.child(r, null)); });
    } finally {
      env.quiet = wasQuiet;
    }
    this.setState('up');
  }
  ButtonInstance.prototype.child = function (record, existing) {
    var obj = existing && existing.characterId === record.characterId ? existing : this.parentClip.createObject(record.characterId, this.level, this.ancestry);
    obj.depth = record.depth;
    obj.matrix = record.matrix;
    obj.cx = record.cx;
    obj.blendMode = record.blendMode;
    if (record.filters) this.env.report('render:filters', 'Filters are not drawn yet.', this.character.id);
    return obj;
  };
  ButtonInstance.prototype.setState = function (state) {
    if (state === this.state) return;
    var next = new Map(), self = this;
    this.character.records.forEach(function (r) {
      if (r[state]) next.set(r.depth, self.child(r, self.displayList.get(r.depth)));
    });
    this.displayList = next;
    this.state = state;
  };
  ButtonInstance.prototype.depths = Clip.prototype.depths;
  ButtonInstance.prototype.tick = function () {
    this.displayList.forEach(function (obj) {
      if (obj.clip) obj.clip.tick();
      else if (obj.button) obj.button.tick();
    });
  };
  // Queues the actions whose conditions match: a transition bit, or a key code (bits 9-15).
  ButtonInstance.prototype.runActions = function (condition, keyCode) {
    var env = this.env, clip = this.parentClip, matched = false;
    this.character.actions.forEach(function (a) {
      var match = keyCode ? ((a.conditions >> 9) & 0x7f) === keyCode : (a.conditions & condition) !== 0;
      if (!match) return;
      matched = true;
      if (env.actions && env.queue) env.queue.push({ clip: clip, tags: [a] });
    });
    return matched;
  };

  // ---- AVM1: timeline-control subset --------------------------------------------------------------------------
  /* A controlled interpreter for frame scripts. It never evaluates JavaScript, never navigates and never touches
     the page. It runs the actions that only steer timelines (Flash 3/4 style) and reports everything else:
     plain actions without timeline effect are skipped; control flow and calls end the script, because their
     outcome cannot be known without the full VM (phase 5). */
  var ACTION_NAMES = {
    0x04: 'NextFrame', 0x05: 'PreviousFrame', 0x06: 'Play', 0x07: 'Stop', 0x08: 'ToggleQuality', 0x09: 'StopSounds',
    0x0a: 'Add', 0x0b: 'Subtract', 0x0c: 'Multiply', 0x0d: 'Divide', 0x0e: 'Equals', 0x0f: 'Less', 0x10: 'And', 0x11: 'Or',
    0x12: 'Not', 0x13: 'StringEquals', 0x14: 'StringLength', 0x15: 'StringExtract', 0x17: 'Pop', 0x18: 'ToInteger',
    0x1c: 'GetVariable', 0x1d: 'SetVariable', 0x20: 'SetTarget2', 0x21: 'StringAdd', 0x22: 'GetProperty', 0x23: 'SetProperty',
    0x24: 'CloneSprite', 0x25: 'RemoveSprite', 0x26: 'Trace', 0x27: 'StartDrag', 0x28: 'EndDrag', 0x29: 'StringLess',
    0x2a: 'Throw', 0x2b: 'CastOp', 0x2c: 'ImplementsOp', 0x30: 'RandomNumber', 0x31: 'MBStringLength', 0x32: 'CharToAscii',
    0x33: 'AsciiToChar', 0x34: 'GetTime', 0x35: 'MBStringExtract', 0x36: 'MBCharToAscii', 0x37: 'MBAsciiToChar',
    0x3a: 'Delete', 0x3b: 'Delete2', 0x3c: 'DefineLocal', 0x3d: 'CallFunction', 0x3e: 'Return', 0x3f: 'Modulo',
    0x40: 'NewObject', 0x41: 'DefineLocal2', 0x42: 'InitArray', 0x43: 'InitObject', 0x44: 'TypeOf', 0x45: 'TargetPath',
    0x46: 'Enumerate', 0x47: 'Add2', 0x48: 'Less2', 0x49: 'Equals2', 0x4a: 'ToNumber', 0x4b: 'ToString', 0x4c: 'PushDuplicate',
    0x4d: 'StackSwap', 0x4e: 'GetMember', 0x4f: 'SetMember', 0x50: 'Increment', 0x51: 'Decrement', 0x52: 'CallMethod',
    0x53: 'NewMethod', 0x54: 'InstanceOf', 0x55: 'Enumerate2', 0x60: 'BitAnd', 0x61: 'BitOr', 0x62: 'BitXor', 0x63: 'BitLShift',
    0x64: 'BitRShift', 0x65: 'BitURShift', 0x66: 'StrictEquals', 0x67: 'Greater', 0x68: 'StringGreater', 0x69: 'Extends',
    0x81: 'GotoFrame', 0x83: 'GetURL', 0x87: 'StoreRegister', 0x88: 'ConstantPool', 0x8a: 'WaitForFrame', 0x8b: 'SetTarget',
    0x8c: 'GotoLabel', 0x8d: 'WaitForFrame2', 0x8e: 'DefineFunction2', 0x8f: 'Try', 0x94: 'With', 0x96: 'Push', 0x99: 'Jump',
    0x9a: 'GetURL2', 0x9b: 'DefineFunction', 0x9d: 'If', 0x9e: 'Call', 0x9f: 'GotoFrame2'
  };
  // Actions whose effect on what runs next is unknown without the full VM: the script stops there.
  var STOP_ACTIONS = { 0x20: 1, 0x2a: 1, 0x3d: 1, 0x3e: 1, 0x52: 1, 0x8d: 1, 0x8f: 1, 0x94: 1, 0x99: 1, 0x9d: 1, 0x9e: 1, 0x9f: 1 };

  // Action records up to ActionEndFlag: [{ code, offset, data, next }]. `truncated` marks a record cut short.
  function parseActions(bytes) {
    var list = [], i = 0;
    list.truncated = false;
    while (i < bytes.length) {
      var code = bytes[i], start = i, length = 0;
      i++;
      if (code === 0) break;
      if (code >= 0x80) {
        if (i + 2 > bytes.length) { list.truncated = true; break; }
        length = bytes[i] | (bytes[i + 1] << 8);
        i += 2;
        if (i + length > bytes.length) { list.truncated = true; break; }
      }
      list.push({ code: code, offset: start, data: bytes.subarray(i, i + length), next: i + length });
      i += length;
    }
    return list;
  }
  function actionString(action, version) { return new global.SWFReader.BitReader(action.data).readString(version, 'action string'); }
  function actionUI16(action) { return action.data[0] | (action.data[1] << 8); }
  // DefineFunction/DefineFunction2: byte length of the body that follows the record (skipped, not run).
  function functionCodeSize(action, version) {
    var r = new global.SWFReader.BitReader(action.data);
    r.readString(version);
    var count = r.readUI16();
    if (action.code === 0x9b) {
      for (var i = 0; i < count; i++) r.readString(version);
    } else {
      r.readUI8();
      r.readUI16();
      for (var j = 0; j < count; j++) { r.readUI8(); r.readString(version); }
    }
    return r.readUI16();
  }
  /* Target paths for SetTarget: slash syntax ("/a/b", "../a", "a/b") or dot syntax ("_root.a", "_parent.b", "this").
     Returns the sprite instance's Clip or null. */
  function resolveTarget(clip, path) {
    var current = clip, root = clip.root();
    if (path.charAt(0) === '/') { current = root; path = path.slice(1); }
    var slashSyntax = path.indexOf('/') >= 0 || path.slice(0, 2) === '..';
    var parts = slashSyntax ? path.split('/') : path.split('.');
    for (var i = 0; i < parts.length && current; i++) {
      var part = parts[i], lower = part.toLowerCase();
      if (!part || lower === 'this') continue;
      if (part === '..' || lower === '_parent') current = current.parent;
      else if (lower === '_root' || lower === '_level0') current = root;
      else current = current.childByName(part);
    }
    return current || null;
  }
  // block: a DoAction tag, or a button action { bytes, offset, label }.
  function runActionBlock(env, clip, block) {
    var actions = env.actionCache.get(block), source = (block.label || 'DoAction') + ' at offset ' + block.offset;
    if (!actions) {
      actions = parseActions(block.bytes || env.swf.getTagData(block));
      env.actionCache.set(block, actions);
    }
    if (actions.truncated) env.report('avm1:malformedAction', 'An action record runs past the end of its DoAction; the rest is ignored.', source);
    var target = clip, skipUntil = -1, version = env.version;
    for (var i = 0; i < actions.length; i++) {
      var a = actions[i], n;
      if (a.offset < skipUntil) continue;
      if (++env.steps > MAX_ACTION_STEPS) return env.report('avm1:budget', 'More than ' + MAX_ACTION_STEPS + ' actions in one frame; the rest were not run.', source);
      try {
        switch (a.code) {
          case 0x04: if (target) { target.gotoFrame(target.frame + 1); target.playing = false; } break;
          case 0x05: if (target) { target.gotoFrame(target.frame - 1); target.playing = false; } break;
          case 0x06: if (target) target.playing = true; break;
          case 0x07: if (target) target.playing = false; break;
          case 0x08: case 0x09: case 0x8a: break; // ToggleQuality, StopSounds: no effect yet; WaitForFrame: every frame is loaded
          case 0x81: if (target) target.gotoFrame(actionUI16(a) + 1); break;
          case 0x8c:
            if (!target) break;
            n = target.findLabel(actionString(a, version));
            if (n) target.gotoFrame(n);
            else env.report('avm1:labelNotFound', 'GotoLabel names a frame label that does not exist; ignored.', source);
            break;
          case 0x8b:
            var path = actionString(a, version);
            target = path === '' ? clip : resolveTarget(clip, path);
            if (!target) env.report('avm1:targetNotFound', 'SetTarget names a sprite instance that does not exist; actions are ignored until the next SetTarget.', source + ': ' + path);
            break;
          case 0x83:
            env.report('avm1:GetURL', 'GetURL is ignored: the player never navigates, opens windows or loads URLs.', source);
            break;
          case 0x9b: case 0x8e:
            skipUntil = a.next + functionCodeSize(a, version);
            env.report('avm1:' + ACTION_NAMES[a.code], 'Function definitions are skipped; functions cannot be called yet.', source);
            break;
          default:
            var name = ACTION_NAMES[a.code] || 'Unknown_0x' + a.code.toString(16);
            if (STOP_ACTIONS[a.code]) {
              return env.report('avm1:' + name, 'Control flow and calls are not interpreted yet; the rest of this script was not run.', source);
            }
            env.report('avm1:' + name, 'Not interpreted yet (no timeline effect in this subset); skipped.', source);
        }
      } catch (err) {
        if (err.name !== 'SWFReaderError') throw err;
        return env.report('avm1:malformedAction', 'An action has malformed data; the rest of this script was not run.', source);
      }
    }
  }
  // Runs queued frame scripts, including the ones queued while running (gotos). Bounded per tick.
  function runActionQueue(env) {
    var blocks = 0;
    env.steps = 0;
    while (env.queue.length) {
      if (++blocks > MAX_ACTION_BLOCKS) {
        env.queue.length = 0;
        return env.report('avm1:budget', 'More than ' + MAX_ACTION_BLOCKS + ' frame scripts in one frame; the rest were dropped.', 'queue');
      }
      var item = env.queue.shift();
      for (var i = 0; i < item.tags.length; i++) runActionBlock(env, item.clip, item.tags[i]);
    }
  }

  // ---- Hit testing --------------------------------------------------------------------------------------------
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
    if (c.type === 'shape' || c.type === 'bitmap' || c.type === 'text' || c.type === 'editText') {
      var inverse = invert(world);
      if (!inverse) return false;
      local = transformPoint(inverse, x, y);
    }
    if (c.type === 'shape') return pointInShape(geometryOf(c, report), local[0], local[1]);
    if (c.type === 'bitmap') return local[0] >= 0 && local[1] >= 0 && local[0] < c.width * 20 && local[1] < c.height * 20;
    if (c.type === 'text') return inRect(c.text.bounds, local);
    if (c.type === 'editText') return inRect(c.layout ? c.layout.bounds : c.field.bounds, local);
    if (c.type === 'sprite' && obj.clip) return hitTestList(obj.clip.displayList, world, x, y, report);
    if (c.type === 'button' && obj.button) return hitTestList(obj.button.hitList, world, x, y, report);
    return false;
  }
  function hitTestList(list, matrix, x, y, report) {
    var hit = false;
    list.forEach(function (obj) { if (!hit && !obj.clipDepth) hit = hitTestObject(obj, multiply(matrix, obj.matrix), x, y, report); });
    return hit;
  }
  /* Topmost button whose hit area contains the point, searching from the highest depth down through sprites.
     As in AVM1, non-interactive content (shapes, bitmaps) never blocks a button underneath it. Masks are not
     taken into account yet. Returns the button's display object or null. */
  function pickButton(container, matrix, x, y, report) {
    var depths = container.depths();
    for (var i = depths.length - 1; i >= 0; i--) {
      var obj = container.displayList.get(depths[i]);
      if (obj.clipDepth) continue;
      var world = multiply(matrix, obj.matrix);
      if (obj.button) {
        if (hitTestList(obj.button.hitList, world, x, y, report)) return obj;
      } else if (obj.clip) {
        var found = pickButton(obj.clip, world, x, y, report);
        if (found) return found;
      }
    }
    return null;
  }
  function collectButtons(container, set) {
    container.displayList.forEach(function (obj) {
      if (obj.button) { set.add(obj); collectButtons(obj.button, set); }
      else if (obj.clip) collectButtons(obj.clip, set);
    });
    return set;
  }

  // ---- Input: pointer and keyboard -> button events --------------------------------------------------------
  /* Tracks the hovered and pressed button for one movie and turns pointer changes into AVM1 button events
     (Push tracking, as in Flash Player). Coordinates are stage twips. Each method
     returns true when something changed (state or queued actions); the caller then runs the action queue
     and redraws. trackAsMenu buttons are handled as push buttons. */
  function InputController(env, getRoot) {
    this.env = env;
    this.getRoot = getRoot;
    this.hovered = null;
    this.pressed = null;
    this.mouseDown = false;
    this.inside = false;
    this.x = 0;
    this.y = 0;
  }
  InputController.prototype.fire = function (target, state, condition) {
    target.button.runActions(condition);
    target.button.setState(state);
    if (target.button.character.trackAsMenu) this.env.report('input:trackAsMenu', 'Menu-tracking buttons are handled as push buttons.', target.characterId);
  };
  // Buttons that left the stage are forgotten without events, as Flash does. The display list only changes
  // in ticks, frame scripts and seeks, so this runs after those (afterTick, Player.seek), not on every move.
  InputController.prototype.pruneRemoved = function () {
    var root = this.getRoot();
    if (!root || (!this.hovered && !this.pressed)) return;
    var live = collectButtons(root, new Set());
    if (this.hovered && !live.has(this.hovered)) this.hovered = null;
    if (this.pressed && !live.has(this.pressed)) this.pressed = null;
  };
  InputController.prototype.update = function (moved) {
    var root = this.getRoot();
    if (!root) return false;
    if (!moved && this.hovered) return false;
    var over = this.inside ? pickButton(root, IDENTITY, this.x, this.y, this.env.report) : null;
    if (over === this.hovered) return false;
    var previous = this.hovered;
    this.hovered = over;
    if (this.mouseDown) {
      // While the button is held only the pressed button gets drag events; no roll events in AVM1.
      if (this.pressed && previous === this.pressed) this.fire(this.pressed, 'over', BUTTON.OVER_DOWN_TO_OUT_DOWN);
      else if (this.pressed && over === this.pressed) this.fire(this.pressed, 'down', BUTTON.OUT_DOWN_TO_OVER_DOWN);
    } else {
      if (previous) this.fire(previous, 'up', BUTTON.OVER_UP_TO_IDLE);
      if (over) this.fire(over, 'over', BUTTON.IDLE_TO_OVER_UP);
    }
    return true;
  };
  InputController.prototype.move = function (x, y) {
    this.inside = true;
    this.x = x;
    this.y = y;
    return this.update(true);
  };
  InputController.prototype.leave = function () {
    this.inside = false;
    return this.update(true);
  };
  InputController.prototype.down = function () {
    if (this.mouseDown) return false;
    this.mouseDown = true;
    this.update(true);
    if (!this.hovered) return false;
    this.pressed = this.hovered;
    this.fire(this.pressed, 'down', BUTTON.OVER_UP_TO_OVER_DOWN);
    return true;
  };
  InputController.prototype.up = function () {
    if (!this.mouseDown) return false;
    this.mouseDown = false;
    var pressed = this.pressed;
    this.pressed = null;
    if (!pressed) {
      // Pressed outside every button: the button now under the pointer (entered silently while the mouse
      // was down) gets its roll over on release.
      if (this.hovered) { this.fire(this.hovered, 'over', BUTTON.IDLE_TO_OVER_UP); return true; }
      return this.update(true);
    }
    if (this.hovered === pressed) {
      this.fire(pressed, 'over', BUTTON.OVER_DOWN_TO_OVER_UP);
    } else {
      this.fire(pressed, 'up', BUTTON.OUT_DOWN_TO_IDLE);
      if (this.hovered) this.fire(this.hovered, 'over', BUTTON.IDLE_TO_OVER_UP);
    }
    return true;
  };
  // SWF key code (1-127): every button on stage with a matching KeyPress condition runs its actions.
  InputController.prototype.key = function (code) {
    var root = this.getRoot(), matched = false;
    if (!root || !code) return false;
    collectButtons(root, new Set()).forEach(function (obj) { if (obj.button.runActions(0, code)) matched = true; });
    return matched;
  };
  // After a frame or a script run: forget removed buttons, then re-pick only if nothing is hovered (a button
  // may have appeared under a still pointer).
  InputController.prototype.afterTick = function () {
    this.pruneRemoved();
    return this.update(false);
  };
  InputController.prototype.cursor = function () { return this.hovered || this.pressed ? 'pointer' : ''; };
  // Browser KeyboardEvent.key -> SWF key code (SWF19 KeyPress codes; printable ASCII otherwise).
  var SWF_KEYS = { ArrowLeft: 1, ArrowRight: 2, Home: 3, End: 4, Insert: 5, Delete: 6, Backspace: 8, Enter: 13, ArrowUp: 14,
    ArrowDown: 15, PageUp: 16, PageDown: 17, Tab: 18, Escape: 19 };
  function swfKeyCode(key) {
    if (SWF_KEYS[key]) return SWF_KEYS[key];
    if (typeof key === 'string' && key.length === 1) {
      var c = key.charCodeAt(0);
      if (c >= 32 && c <= 126) return c;
    }
    return 0;
  }

  // ---- Canvas 2D renderer -----------------------------------------------------------------------------------
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
  function geometryOf(character, report) {
    if (!character.geometry) {
      character.geometry = buildShapeGeometry(character.shape);
      character.geometry.problems.forEach(function (p) {
        report('render:invalidStyleIndex', 'A shape refers to a style that does not exist; those edges are skipped.', character.id + ': ' + p);
      });
    }
    return character.geometry;
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

  // ---- Player -------------------------------------------------------------------------------------------------
  var EVENTS = { load: 1, frame: 1, warning: 1, error: 1, end: 1 };

  function Player(options) {
    options = options || {};
    if (!options.canvas || typeof options.canvas.getContext !== 'function') throw playerError('INVALID_OPTION', 'options.canvas must be a <canvas> element');
    this.canvas = options.canvas;
    this.options = {
      autoplay: !!options.autoplay,
      loop: options.loop !== false,
      maxFileBytes: options.maxFileBytes,
      maxBitmapPixels: options.maxBitmapPixels || DEFAULT_MAX_BITMAP_PIXELS,
      maxTotalBitmapPixels: options.maxTotalBitmapPixels || DEFAULT_MAX_TOTAL_BITMAP_PIXELS,
      actions: options.actions !== false,
      input: options.input !== false,
      pixelRatio: options.pixelRatio || global.devicePixelRatio || 1,
      maxCatchUpFrames: options.maxCatchUpFrames || 4
    };
    this.state = 'idle';
    this.listeners = {};
    this.movie = null;
    this.root = null;
    this.unsupported = [];
    this.unsupportedByFeature = Object.create(null);
    this.rafId = 0;
    this.loadSerial = 0;
    var self = this;
    this.report = function (feature, reason, source) { self.recordUnsupported(feature, reason, source); };
    this.renderer = new CanvasRenderer(this.canvas, this.report);
    this.input = null;
    this.domHandlers = [];
    if (this.options.input && typeof this.canvas.addEventListener === 'function') this.attachInput();
  }
  // Pointer and keyboard on the canvas drive the movie's buttons. The canvas gets focus when pressed.
  Player.prototype.attachInput = function () {
    var self = this, canvas = this.canvas;
    if (canvas.tabIndex < 0) canvas.tabIndex = 0;
    function on(type, fn) { canvas.addEventListener(type, fn); self.domHandlers.push([type, fn]); }
    function point(e) {
      var rect = canvas.getBoundingClientRect(), b = self.movie.swf.bounds;
      return [b.xminTwips + ((e.clientX - rect.left) / rect.width) * (b.xmaxTwips - b.xminTwips),
        b.yminTwips + ((e.clientY - rect.top) / rect.height) * (b.ymaxTwips - b.yminTwips)];
    }
    function ready() {
      if (!self.input || !self.root || self.state === 'loading' || self.state === 'destroyed') return false;
      self.env.instances = 0;
      return true;
    }
    on('pointermove', function (e) { if (ready()) { var p = point(e); if (self.input.move(p[0], p[1])) self.afterInput(); } });
    on('pointerleave', function () { if (ready() && !self.input.mouseDown && self.input.leave()) self.afterInput(); });
    on('pointerdown', function (e) {
      if (!ready() || e.button !== 0) return;
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* capture is optional */ }
      if (canvas.focus) canvas.focus({ preventScroll: true });
      var p = point(e);
      var changed = self.input.move(p[0], p[1]);
      if (self.input.down() || changed) self.afterInput();
    });
    on('pointerup', function (e) {
      if (!ready() || e.button !== 0) return;
      var p = point(e), inside = p[0] >= self.movie.swf.bounds.xminTwips && p[0] <= self.movie.swf.bounds.xmaxTwips &&
        p[1] >= self.movie.swf.bounds.yminTwips && p[1] <= self.movie.swf.bounds.ymaxTwips;
      if (inside) self.input.move(p[0], p[1]); else self.input.leave();
      if (self.input.up()) self.afterInput();
    });
    on('pointercancel', function () { if (ready() && self.input.up()) self.afterInput(); });
    on('keydown', function (e) {
      if (!ready()) return;
      if (self.input.key(swfKeyCode(e.key))) { e.preventDefault(); self.afterInput(); }
    });
  };
  // Runs the actions queued by a button event, re-checks the hovered button, redraws.
  Player.prototype.afterInput = function () {
    runActionQueue(this.env);
    if (this.input.afterTick()) runActionQueue(this.env);
    this.render();
    this.canvas.style.cursor = this.input.cursor();
    this.emit('frame', this.root.frame);
  };
  Player.prototype.on = function (type, fn) {
    if (!EVENTS[type]) throw playerError('INVALID_EVENT', 'Unknown event ' + type);
    (this.listeners[type] || (this.listeners[type] = [])).push(fn);
    return this;
  };
  Player.prototype.off = function (type, fn) {
    var list = this.listeners[type];
    if (list) this.listeners[type] = list.filter(function (f) { return f !== fn; });
    return this;
  };
  Player.prototype.emit = function (type, detail) {
    (this.listeners[type] || []).slice().forEach(function (fn) {
      try { fn(detail); } catch (err) { if (global.console) console.error(err); }
    });
  };
  // Aggregated per feature; `count` is the number of distinct sources (character ids, depths).
  Player.prototype.recordUnsupported = function (feature, reason, source) {
    var entry = this.unsupportedByFeature[feature];
    if (!entry) {
      entry = this.unsupportedByFeature[feature] = { feature: feature, reason: reason, count: 0, sources: [] };
      this.unsupported.push(entry);
    }
    var key = String(source);
    if (entry.sources.indexOf(key) === -1) {
      entry.sources.push(key);
      entry.count++;
      if (entry.count === 1) this.emit('warning', entry);
    }
  };
  Player.prototype.assertUsable = function () {
    if (this.state === 'destroyed') throw playerError('DESTROYED', 'The player has been destroyed');
  };
  // Only the latest call wins: a load that is superseded by another load(), or by destroy(), resolves to null
  // without changing the player, even if it fails. Its diagnostics are dropped from that moment on.
  Player.prototype.load = async function (input) {
    this.assertUsable();
    if (!global.SWFReader) throw playerError('MISSING_READER', 'Load swf-reader.js before retroflash.js');
    var serial = ++this.loadSerial, self = this;
    function superseded() { return self.state === 'destroyed' || serial !== self.loadSerial; }
    function report(feature, reason, source) { if (!superseded()) self.report(feature, reason, source); }
    this.pause();
    if (this.movie) this.movie.release();
    this.state = 'loading';
    this.movie = this.root = null;
    this.unsupported = [];
    this.unsupportedByFeature = Object.create(null);
    var swf, movie = null;
    try {
      swf = await global.SWFReader.load(input, this.options.maxFileBytes ? { maxFileBytes: this.options.maxFileBytes } : undefined);
    } catch (err) {
      if (superseded()) return null;
      this.state = 'error';
      this.emit('error', err);
      throw err;
    }
    if (superseded()) return null;
    try {
      movie = new Movie(swf);
      await movie.decodeBitmaps(this.options.maxBitmapPixels, this.options.maxTotalBitmapPixels, report);
      if (superseded()) { movie.release(); return null; }
      this.movie = movie;
      this.fps = swf.fps > 0 ? swf.fps : 12;
      if (!(swf.fps > 0)) this.recordUnsupported('timeline:zeroFps', 'The file declares 0 fps; playing at 12 fps.', 'header');
      this.restart();
      this.resize();
      this.render();
    } catch (err) {
      if (movie) movie.release();
      if (superseded()) return null;
      // Never leave the player stuck in 'loading' (for example a runtime error on a hostile file).
      this.movie = this.root = null;
      this.state = 'error';
      this.emit('error', err);
      throw err;
    }
    this.state = 'ready';
    this.emit('load', this.getInfo());
    if (this.options.autoplay) this.play();
    return this.getInfo();
  };
  Player.prototype.resize = function () {
    var swf = this.movie.swf, ratio = this.options.pixelRatio;
    var width = Math.max(1, swf.width), height = Math.max(1, swf.height);
    this.canvas.width = Math.max(1, Math.min(8192, Math.round(width * ratio)));
    this.canvas.height = Math.max(1, Math.min(8192, Math.round(height * ratio)));
    if (this.canvas.style) { this.canvas.style.width = width + 'px'; this.canvas.style.height = 'auto'; }
  };
  // Fresh root timeline at frame 1, with its frame scripts run (as when the movie starts).
  Player.prototype.restart = function () {
    this.env = createEnv(this.movie, this.report, { actions: this.options.actions });
    this.root = new Clip(this.env, this.movie.root, 0, null);
    this.root.loop = this.options.loop;
    this.root.gotoFrame(1);
    runActionQueue(this.env);
    var self = this, previous = this.input;
    this.input = new InputController(this.env, function () { return self.root; });
    if (previous && previous.inside) { this.input.inside = true; this.input.x = previous.x; this.input.y = previous.y; }
    if (this.input.afterTick()) runActionQueue(this.env);
    if (this.movie.buttonSounds.length) this.recordUnsupported('sound:DefineButtonSound', 'Button sounds are not played (no audio yet).', this.movie.buttonSounds.join(','));
  };
  Player.prototype.render = function () {
    var swf = this.movie.swf, b = swf.bounds;
    this.renderer.render({
      background: swf.background, xMin: b.xminTwips, yMin: b.yminTwips, characters: this.movie.characters,
      widthTwips: Math.max(1, b.xmaxTwips - b.xminTwips), heightTwips: Math.max(1, b.ymaxTwips - b.yminTwips)
    }, this.root);
  };
  Player.prototype.play = function () {
    this.assertUsable();
    if (!this.root || this.state === 'playing') return;
    // A finished non-looping movie restarts like stop(): timelines rebuilt and frame-1 scripts run again.
    if (!this.options.loop && this.root.frame === this.root.frameCount()) { this.restart(); this.render(); }
    this.state = 'playing';
    this.lastTime = null;
    this.accumulator = 0;
    var self = this;
    this.rafId = global.requestAnimationFrame(function (t) { self.loop(t); });
  };
  Player.prototype.pause = function () {
    if (this.rafId) global.cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    if (this.state === 'playing') this.state = 'paused';
  };
  // Rewinds to the start: every timeline is rebuilt at frame 1 and frame-1 scripts run again; stays paused.
  Player.prototype.stop = function () {
    this.assertUsable();
    this.pause();
    if (!this.root) return;
    this.restart();
    this.render();
    this.emit('frame', this.root.frame);
  };
  // Advances exactly one frame (root and every sprite instance), then renders.
  Player.prototype.step = function () {
    this.assertUsable();
    if (!this.root) return;
    this.advance();
    this.render();
    this.emit('frame', this.root.frame);
  };
  // frame: 1-based number or frame label. A debugging/scrubbing jump: frame scripts are NOT run, and sprite
  // instances that persist keep their own playhead.
  Player.prototype.seek = function (frame) {
    this.assertUsable();
    if (!this.root) throw playerError('NOT_LOADED', 'No movie loaded');
    var n = typeof frame === 'string' ? this.movie.root.labels[frame] : frame;
    if (!Number.isFinite(n)) throw playerError('INVALID_FRAME', 'Unknown frame ' + JSON.stringify(frame));
    this.env.instances = 0;
    this.env.quiet = true;
    try { this.root.gotoFrame(n); } finally { this.env.quiet = false; }
    if (this.input) this.input.pruneRemoved();
    this.render();
    this.emit('frame', this.root.frame);
  };
  Player.prototype.advance = function () {
    this.env.instances = 0;
    var ended = this.root.tick();
    runActionQueue(this.env);
    if (this.input && this.input.afterTick()) {
      runActionQueue(this.env);
      this.canvas.style.cursor = this.input.cursor();
    }
    if (ended) {
      this.emit('end', this.root.frame);
      if (!this.options.loop) this.pause();
    }
  };
  Player.prototype.loop = function (time) {
    if (this.state !== 'playing') return;
    var self = this, duration = 1000 / this.fps, steps = 0;
    if (this.lastTime !== null) this.accumulator += time - this.lastTime;
    this.lastTime = time;
    while (this.accumulator >= duration && steps < this.options.maxCatchUpFrames && this.state === 'playing') {
      this.advance();
      this.accumulator -= duration;
      steps++;
    }
    if (steps === this.options.maxCatchUpFrames) this.accumulator = Math.min(this.accumulator, duration); // drop frames, don't spiral
    if (steps) { this.render(); this.emit('frame', this.root.frame); }
    if (this.state === 'playing') this.rafId = global.requestAnimationFrame(function (t) { self.loop(t); });
  };
  Player.prototype.getInfo = function () {
    var swf = this.movie && this.movie.swf;
    return {
      state: this.state, playerVersion: VERSION,
      signature: swf ? swf.signature : null, version: swf ? swf.version : null,
      width: swf ? swf.width : 0, height: swf ? swf.height : 0, fps: swf ? this.fps : 0,
      frameCount: this.root ? this.root.frameCount() : 0, currentFrame: this.root ? this.root.frame : 0,
      rootPlaying: this.root ? this.root.playing : false,
      labels: this.movie ? Object.assign({}, this.movie.root.labels) : {}
    };
  };
  Player.prototype.getDiagnostics = function () {
    var swf = this.movie && this.movie.swf;
    return {
      diagnostics: swf ? swf.diagnostics.slice() : [],
      unsupported: (swf ? swf.unsupported : []).concat(this.unsupported.map(function (u) {
        return { feature: u.feature, reason: u.reason, count: u.count, sources: u.sources.slice() };
      }))
    };
  };
  Player.prototype.destroy = function () {
    var canvas = this.canvas;
    this.pause();
    this.domHandlers.forEach(function (h) { canvas.removeEventListener(h[0], h[1]); });
    this.domHandlers = [];
    this.state = 'destroyed';
    this.listeners = {};
    if (this.movie) this.movie.release();
    this.movie = this.root = this.input = null;
  };

  global.RetroFlash = Object.freeze({
    version: VERSION,
    Player: Player,
    // Building blocks exposed for tests and tooling; not a stable API.
    internals: Object.freeze({
      buildShapeGeometry: buildShapeGeometry, buildTimeline: buildTimeline, Movie: Movie, Clip: Clip, createEnv: createEnv,
      multiply: multiply, invert: invert, toMatrix: toMatrix, toColorTransform: toColorTransform,
      concatColorTransform: concatColorTransform, cssColor: cssColor,
      decodeLossless: decodeLossless, losslessByteLength: losslessByteLength, cleanJpeg: cleanJpeg, mergeJpegTables: mergeJpegTables,
      imageSize: imageSize, reservePixels: reservePixels,
      glyphCommands: glyphCommands, staticTextGlyphs: staticTextGlyphs, fieldFormat: fieldFormat, parseHtmlText: parseHtmlText,
      cssFontFamily: cssFontFamily, layoutEditText: layoutEditText, hitTestObject: hitTestObject,
      parseActions: parseActions, resolveTarget: resolveTarget, runActionQueue: runActionQueue,
      ButtonInstance: ButtonInstance, InputController: InputController, pickButton: pickButton, pointInShape: pointInShape,
      swfKeyCode: swfKeyCode, BUTTON: BUTTON
    })
  });
})(typeof window !== 'undefined' ? window : globalThis);
