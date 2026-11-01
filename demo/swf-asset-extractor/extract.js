/* SWF Asset Extractor - finds the resources of a SWF file and converts the ones it can: bitmaps to PNG, shapes
   to SVG, sounds to MP3 or WAV, fonts, texts, binary data and bytecode to files. It uses swf-extractor-core.js
   (the project's reader and decoders) and never runs ActionScript: bytecode is only copied out. Everything
   read from the file is data; the page (app.js) puts it into the document with textContent only.
   API: SWFAssetExtractor.analyze(bytes, fileName, onProgress) -> Promise<{ movie, assets, skipped }>. */
(function (global) {
  'use strict';

  var core = global.SWFExtractorCore, SWFReader = core.SWFReader, M = core.modules;

  // Output limits. Bitmaps keep the player's pixel budgets; the rest bound what one file can make us build.
  var LIMITS = {
    maxAssets: 2000,                        // rows: resources past this are counted but not converted
    maxBitmapPixels: 4096 * 4096,           // pixels of one bitmap
    maxTotalBitmapPixels: 4 * 4096 * 4096,  // pixels of all bitmaps of the file together
    maxAudioFrames: 48000 * 60 * 10,        // decoded sample frames of one sound (10 minutes at 48 kHz)
    maxSvgNumbers: 2000000,                 // coordinates written into one SVG
    maxGlyphs: 512,                         // glyphs drawn in a font's outline sheet
    maxJsonChars: 2 * 1024 * 1024,          // characters of one JSON file
    maxTextChars: 200000                    // characters of one extracted text
  };

  var KINDS = {
    image: 'Image', shape: 'Vector shape', morph: 'Morph shape', sound: 'Sound', stream: 'Stream sound', video: 'Video',
    font: 'Font', text: 'Text', binary: 'Binary data', code: 'ActionScript', other: 'Other tag'
  };
  // Tags that build the movie's structure (placements, frames, labels, settings) rather than holding a resource,
  // and tags whose content is shown with another resource (font info with its font, JPEGTables with DefineBits).
  var STRUCTURAL = {};
  [0, 1, 4, 5, 7, 8, 9, 13, 15, 17, 23, 24, 26, 28, 34, 39, 43, 56, 57, 58, 62, 64, 65, 66, 69, 70, 71, 73, 74, 76, 78, 86, 88, 89, 93]
    .forEach(function (code) { STRUCTURAL[code] = true; });
  var STATUS_TEXT = { indexed: 'not decoded by the reader', partial: 'partly decoded', unknown: 'unknown tag', invalid: 'malformed', 'not-executed': 'bytecode, never run', decoded: 'decoded' };

  function LimitError(message) { this.message = message; }

  // ---- Small helpers ----

  function safeName(text) {
    var s = String(text || '').replace(/\.swf$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
    return (s || 'movie').slice(0, 60);
  }
  function blob(parts, type) { return new Blob(Array.isArray(parts) ? parts : [parts], { type: type }); }
  function u16(b, at) { return b[at] | (b[at + 1] << 8); }
  function hex(n) { return '0x' + n.toString(16); }
  function rgb(c) { return 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')'; }
  function px(twips) { return +(twips / 20).toFixed(2); }
  function seconds(frames, rate) { return rate ? (frames / rate).toFixed(2) + ' s' : 'unknown'; }
  function escapeXml(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]; })
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');
  }
  function concat(chunks) {
    var size = 0, at = 0;
    chunks.forEach(function (c) { size += c.length; });
    var out = new Uint8Array(size);
    chunks.forEach(function (c) { out.set(c, at); at += c.length; });
    return out;
  }
  // JSON of decoded fields: byte arrays are summarized, and a result past the limit is replaced by a note.
  function jsonBlob(value) {
    var text = JSON.stringify(value, function (key, v) {
      if (v instanceof Uint8Array || v instanceof ArrayBuffer) return '[' + v.byteLength + ' bytes]';
      return v;
    }, 2);
    var truncated = text.length > LIMITS.maxJsonChars;
    if (truncated) text = JSON.stringify({ truncated: true, note: 'The decoded data is larger than ' + LIMITS.maxJsonChars + ' characters; only its beginning is included.', beginning: text.slice(0, LIMITS.maxJsonChars) });
    return { blob: blob(text, 'application/json'), truncated: truncated };
  }

  function newAsset(ctx, tag, kind) {
    return {
      kind: kind, tag: tag, tagName: tag.name, path: tag.path, offset: tag.offset, encodedBytes: tag.length,
      characterId: null, title: '', format: '', status: 'converted', explanation: '', metadata: [], limitations: [],
      outputs: [], preview: null, error: null, ctx: ctx
    };
  }
  function meta(a, label, value) { if (value !== undefined && value !== null && value !== '') a.metadata.push([label, String(value)]); }
  // A file for download; the first output of an asset is its main result.
  function output(a, label, suffix, ext, mime, data) {
    var name = a.ctx.base + '-' + a.kind + (a.characterId !== null ? '-' + a.characterId : '') + '-tag' + a.path.replace(/\//g, '-') + (suffix ? '-' + suffix : '') + '.' + ext;
    var file = { label: label, filename: name, mime: mime, blob: data instanceof Blob ? data : blob(data, mime) };
    a.outputs.push(file);
    return file;
  }
  function rawOutput(a, label) {
    return output(a, label || 'Raw tag body', 'raw', 'bin', 'application/octet-stream', a.ctx.swf.getTagData(a.tag));
  }
  function jsonOutput(a, label, value) {
    var r = jsonBlob(value);
    output(a, label || 'Decoded data (JSON)', 'decoded', 'json', 'application/json', r.blob);
    if (r.truncated) a.limitations.push('The decoded data was too large; the JSON file holds only its beginning.');
  }
  // The reader's explanation for a tag it did not fully decode.
  function readerReason(ctx, tag) {
    for (var i = 0; i < ctx.swf.diagnostics.length; i++) {
      var d = ctx.swf.diagnostics[i];
      if (d.offset === tag.offset && (d.level === 'error' || d.level === 'warning')) return d.message;
    }
    for (i = 0; i < ctx.swf.unsupported.length; i++) {
      var u = ctx.swf.unsupported[i];
      if (u.feature === 'tag:' + tag.name || u.feature.indexOf(tag.name + '.') === 0) return u.reason;
    }
    return '';
  }
  function requireDecoded(ctx, tag) {
    if (tag.status === 'decoded' || tag.status === 'partial') return;
    throw new Error('The reader could not decode this tag (' + (STATUS_TEXT[tag.status] || tag.status) + ')' + (readerReason(ctx, tag) ? ': ' + readerReason(ctx, tag) : '.'));
  }

  // ---- Images ----

  function canvasOf(width, height) {
    var c = global.document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }
  function pngOf(source) {
    var canvas = source;
    if (!(source instanceof global.HTMLCanvasElement)) {
      canvas = canvasOf(source.width, source.height);
      canvas.getContext('2d').drawImage(source, 0, 0);
    }
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) { if (b) resolve(b); else reject(new Error('The browser could not encode the PNG.')); }, 'image/png');
    });
  }
  function release(source) {
    if (typeof source.close === 'function') source.close();
    else { source.width = 0; source.height = 0; }
  }
  var LOSSLESS_FORMATS = { 3: '8-bit colour-mapped', 4: '15-bit RGB', 5: '24-bit RGB' };
  var IMAGE_FILES = { jpeg: ['jpg', 'image/jpeg', 'JPEG'], png: ['png', 'image/png', 'PNG'], gif: ['gif', 'image/gif', 'GIF'] };

  async function bitmapAsset(ctx, a, tag) {
    requireDecoded(ctx, tag);
    var f = tag.fields, lossless = tag.code === 20 || tag.code === 36, alpha = tag.code === 36 || f.alphaStart !== undefined;
    a.characterId = f.characterId;
    a.title = 'Bitmap ' + f.characterId;
    // The original encoded image, when it is a file of its own (JPEG, PNG or GIF data).
    if (!lossless) {
      var data = ctx.swf.getTagData(tag), bytes = data.subarray(f.imageStart, f.imageEnd), kind = IMAGE_FILES[f.imageFormat];
      if (tag.code === 6) {
        bytes = ctx.jpegTables ? M.mergeJpegTables(ctx.jpegTables, bytes) : M.cleanJpeg(bytes);
        if (!ctx.jpegTables) a.limitations.push('The movie has no JPEGTables tag; the image was decoded on its own, which works only when it carries its own tables.');
        else a.metadata.push(['JPEG tables', 'merged from the movie\'s JPEGTables tag']);
      } else if (f.imageFormat === 'jpeg') {
        bytes = M.cleanJpeg(bytes);
      }
      meta(a, 'Encoding', kind ? kind[2] : 'unknown');
      if (tag.code === 90) meta(a, 'Deblocking filter', f.deblockParam);
      if (alpha) meta(a, 'Alpha', 'separate zlib alpha plane, combined into the PNG');
      a.format = (kind ? kind[2] : 'image') + (alpha ? ' + alpha' : '');
      var original = { bytes: bytes, kind: kind };
    } else {
      meta(a, 'Encoding', 'SWF lossless (zlib), ' + (f.bitmapFormat === 5 && tag.code === 36 ? '32-bit ARGB' : LOSSLESS_FORMATS[f.bitmapFormat] || 'format ' + f.bitmapFormat));
      if (f.bitmapFormat === 3) meta(a, 'Colour table', f.colorTableSize + ' colours');
      a.format = 'Lossless' + (alpha ? ' + alpha' : '');
    }
    var source = await M.decodeBitmap(ctx.swf, { fields: f, tag: tag, name: tag.name + ' ' + f.characterId }, ctx.jpegTables, ctx.bitmapLimits);
    var width = source.width, height = source.height, png;
    try {
      png = await pngOf(source);
    } finally {
      release(source);
    }
    a.format += ', ' + width + ' × ' + height;
    meta(a, 'Size', width + ' × ' + height + ' pixels');
    output(a, 'PNG image', '', 'png', 'image/png', png);
    a.preview = { type: 'image', blob: png, alt: 'Bitmap ' + f.characterId };
    if (original && original.kind && original.bytes.length) {
      output(a, 'Original ' + original.kind[2] + (alpha ? ' (colour only, no alpha)' : ''), 'original', original.kind[0], original.kind[1], original.bytes);
      if (alpha) a.limitations.push('The original JPEG has no transparency; the SWF stores it separately. Use the PNG for the image with its alpha channel.');
    }
    a.explanation = lossless
      ? 'A bitmap stored in the SWF\'s own compressed pixel format, converted to PNG' + (alpha ? ' with its transparency.' : '.')
      : 'A ' + (original && original.kind ? original.kind[2] : 'compressed') + ' image, converted to PNG' + (alpha ? ' with its separate alpha channel applied' : '') + '. The original encoded file is offered as well.';
  }

  // ---- Vector shapes (SVG) ----

  var SPREAD = ['pad', 'reflect', 'repeat'], CAPS = ['round', 'butt', 'square'], JOINS = ['round', 'bevel', 'miter'];
  /* An SVG document for a decoded shape ({ bounds, fillStyles, lineStyles, records, usesFillWindingRule }).
     Coordinates are pixels (twips / 20). Returns { svg, notes }: notes say what is approximated. */
  function shapeSvg(shape) {
    var geometry = M.buildShapeGeometry(shape), b = shape.bounds, defs = [], body = [], notes = {}, numbers = 0, ids = 0;
    function path(cmds) {
      var d = [];
      numbers += cmds.length;
      if (numbers > LIMITS.maxSvgNumbers) throw new LimitError('The shape has too many points for SVG output (more than ' + LIMITS.maxSvgNumbers + ' coordinates).');
      for (var i = 0; i < cmds.length;) {
        if (cmds[i] === 0) { d.push('M' + px(cmds[i + 1]) + ' ' + px(cmds[i + 2])); i += 3; }
        else if (cmds[i] === 1) { d.push('L' + px(cmds[i + 1]) + ' ' + px(cmds[i + 2])); i += 3; }
        else { d.push('Q' + px(cmds[i + 1]) + ' ' + px(cmds[i + 2]) + ' ' + px(cmds[i + 3]) + ' ' + px(cmds[i + 4])); i += 5; }
      }
      return d.join('');
    }
    // A paint server for a fill style: a colour, a gradient, or a placeholder pattern for bitmap fills.
    function paint(style) {
      if (!style) return { value: 'none' };
      if (style.type === 'solid') return { value: rgb(style.color), opacity: style.color.a / 255 };
      if (style.type === 'linear' || style.type === 'radial' || style.type === 'focal') {
        var id = 'g' + (++ids), g = style.gradient, m = M.toMatrix(style.matrix), common = ' id="' + id + '" gradientUnits="userSpaceOnUse" spreadMethod="' + (SPREAD[g.spreadMode] || 'pad') + '"' +
          (g.interpolationMode === 1 ? ' color-interpolation="linearRGB"' : '') +
          ' gradientTransform="matrix(' + [m[0], m[1], m[2], m[3], px(m[4]), px(m[5])].map(function (n) { return +n.toFixed(6); }).join(' ') + ')"';
        var stops = g.stops.map(function (s) { return '<stop offset="' + +(s.ratio / 255).toFixed(4) + '" stop-color="' + rgb(s.color) + '" stop-opacity="' + +(s.color.a / 255).toFixed(4) + '"/>'; }).join('');
        if (style.type === 'linear') defs.push('<linearGradient' + common + ' x1="-819.2" y1="0" x2="819.2" y2="0">' + stops + '</linearGradient>');
        else defs.push('<radialGradient' + common + ' cx="0" cy="0" r="819.2" fx="' + (style.type === 'focal' ? +(g.focalPoint * 819.2).toFixed(2) : 0) + '" fy="0">' + stops + '</radialGradient>');
        notes.gradient = 'Gradients are converted to SVG gradients; ' + (g.interpolationMode === 1 ? 'linear-RGB colour blending and ' : '') + 'colour stops may look slightly different from Flash Player.';
        return { value: 'url(#' + id + ')' };
      }
      if (style.type === 'bitmap') {
        notes.bitmap = 'Bitmap fills are drawn as a grey hatched placeholder; the bitmap itself is listed as image ' + style.bitmapId + ' when the file defines it.';
        if (!notes.hatch) {
          notes.hatch = true;
          defs.push('<pattern id="bitmapfill" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#cbd5e1"/><path d="M0 8L8 0" stroke="#64748b" stroke-width="1"/></pattern>');
        }
        return { value: 'url(#bitmapfill)' };
      }
      return { value: 'none' };
    }
    geometry.groups.forEach(function (group) {
      group.fills.forEach(function (fill) {
        var p = paint(fill.style);
        body.push('<path d="' + path(fill.commands) + '" fill="' + p.value + '"' + (p.opacity !== undefined && p.opacity < 1 ? ' fill-opacity="' + +p.opacity.toFixed(4) + '"' : '') + ' fill-rule="' + geometry.fillRule + '"/>');
      });
      group.lines.forEach(function (line) {
        var s = line.style || {}, p = s.fill ? paint(s.fill) : s.color ? paint({ type: 'solid', color: s.color }) : { value: 'none' };
        var width = s.width ? px(s.width) : 1, attrs = ' stroke="' + p.value + '" stroke-width="' + width + '"';
        if (p.opacity !== undefined && p.opacity < 1) attrs += ' stroke-opacity="' + +p.opacity.toFixed(4) + '"';
        attrs += ' stroke-linecap="' + (CAPS[s.startCap] || 'round') + '" stroke-linejoin="' + (JOINS[s.join] || 'round') + '"';
        if (s.join === 2 && s.miterLimit) attrs += ' stroke-miterlimit="' + s.miterLimit + '"';
        if (!s.width || s.noHScale || s.noVScale) attrs += ' vector-effect="non-scaling-stroke"';
        if (!s.width) notes.hairline = 'Hairlines (width 0) are drawn 1 pixel wide.';
        if (s.startCap !== undefined && s.endCap !== undefined && s.startCap !== s.endCap) notes.caps = 'Lines with different start and end caps use the start cap at both ends.';
        if (s.noHScale !== s.noVScale) notes.scale = 'Strokes that keep their width in only one direction are drawn as non-scaling in both.';
        body.push('<path d="' + path(line.commands) + '" fill="none"' + attrs + '/>');
      });
    });
    if (geometry.problems.length) notes.problems = 'Some edges refer to styles that do not exist; they are left out, as in Flash Player.';
    var x = px(b.xMin), y = px(b.yMin), w = Math.max(1, px(b.xMax - b.xMin)), h = Math.max(1, px(b.yMax - b.yMin));
    var svg = '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + [x, y, w, h].join(' ') + '" width="' + w + '" height="' + h + '">' +
      (defs.length ? '<defs>' + defs.join('') + '</defs>' : '') + body.join('') + '</svg>\n';
    return { svg: svg, notes: Object.keys(notes).filter(function (k) { return typeof notes[k] === 'string'; }).map(function (k) { return notes[k]; }), empty: !body.length, width: w, height: h };
  }
  function addSvg(a, label, suffix, result) {
    var file = output(a, label, suffix, 'svg', 'image/svg+xml', result.svg);
    result.notes.forEach(function (n) { if (a.limitations.indexOf(n) < 0) a.limitations.push(n); });
    return file;
  }

  function shapeAsset(ctx, a, tag) {
    requireDecoded(ctx, tag);
    var f = tag.fields, result = shapeSvg(f);
    a.characterId = f.shapeId;
    a.title = 'Shape ' + f.shapeId;
    a.format = 'SVG, ' + result.width + ' × ' + result.height + ' px';
    meta(a, 'Tag version', 'DefineShape' + (f.shapeVersion > 1 ? f.shapeVersion : ''));
    meta(a, 'Bounds', result.width + ' × ' + result.height + ' px');
    meta(a, 'Styles', f.fillStyles.length + ' fill, ' + f.lineStyles.length + ' line (first style set)');
    meta(a, 'Fill rule', f.usesFillWindingRule ? 'non-zero' : 'even-odd');
    var file = addSvg(a, 'SVG drawing', '', result);
    a.preview = { type: 'image', blob: file.blob, alt: 'Shape ' + f.shapeId };
    if (result.empty) a.limitations.push('The shape has no visible fills or strokes.');
    a.explanation = 'A vector shape converted from its edge records to an SVG drawing, with its solid fills, gradients and strokes.';
  }

  function morphAsset(ctx, a, tag) {
    requireDecoded(ctx, tag);
    var f = tag.fields, character = { type: 'morphShape', id: f.characterId, name: tag.name, morph: f, frames: new Map() };
    var problems = [];
    a.characterId = f.characterId;
    a.title = 'Morph shape ' + f.characterId;
    var start = shapeSvg(M.morphFrame(character, 0, function (feature, reason) { problems.push(reason); }).shape);
    var end = shapeSvg(M.morphFrame(character, 65535).shape);
    a.format = 'Start/end SVG + JSON';
    meta(a, 'Tag version', tag.name);
    meta(a, 'Start bounds', start.width + ' × ' + start.height + ' px');
    meta(a, 'End bounds', end.width + ' × ' + end.height + ' px');
    meta(a, 'Styles', f.fillStyles.length + ' fill, ' + f.lineStyles.length + ' line');
    var s = addSvg(a, 'Start state SVG (ratio 0)', 'start', start), e = addSvg(a, 'End state SVG (ratio 65535)', 'end', end);
    jsonOutput(a, 'Decoded morph data (JSON)', f);
    rawOutput(a);
    a.preview = { type: 'images', items: [{ blob: s.blob, caption: 'Start' }, { blob: e.blob, caption: 'End' }] };
    problems.forEach(function (p) { a.limitations.push(p); });
    a.limitations.unshift('An SVG file holds one still drawing: these are the two end states, not the transition between them.');
    a.explanation = 'A morph shape changes from a start shape to an end shape as the timeline sets its ratio. Its two end states are drawn as SVG; the decoded data describes both.';
  }

  // ---- Sound ----

  // 16-bit PCM WAV from planar Float32 channels.
  function wavBlob(rate, channels) {
    var frames = channels[0].length, count = channels.length, buffer = new ArrayBuffer(44 + frames * count * 2), v = new DataView(buffer);
    function text(at, s) { for (var i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); }
    text(0, 'RIFF'); v.setUint32(4, 36 + frames * count * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, count, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * count * 2, true); v.setUint16(32, count * 2, true); v.setUint16(34, 16, true);
    text(36, 'data'); v.setUint32(40, frames * count * 2, true);
    for (var i = 0, at = 44; i < frames; i++) {
      for (var c = 0; c < count; c++, at += 2) v.setInt16(at, Math.max(-32768, Math.min(32767, Math.round(channels[c][i] * 32768))), true);
    }
    return blob(buffer, 'audio/wav');
  }
  function soundMeta(a, f, rate) {
    meta(a, 'Codec', M.soundFormatName(f.format) + (f.format === 0 ? ' (platform byte order)' : ''));
    meta(a, 'Sample rate', rate + ' Hz');
    meta(a, 'Channels', f.stereo ? 'stereo' : 'mono');
    if (f.format === 0 || f.format === 3) meta(a, 'Sample size', f.is16Bit ? '16-bit' : '8-bit');
  }
  // Decoded PCM/ADPCM as WAV: { blob, frames, partial }.
  function decodeToWav(a, format, rate, is16Bit, stereo, blocks, expected) {
    var decoded = M.decodeSoundBlocks(format, rate, is16Bit, stereo, blocks, LIMITS.maxAudioFrames);
    var frames = decoded.channels[0].length, partial = frames >= LIMITS.maxAudioFrames && (expected === undefined || expected > frames);
    if (partial) a.limitations.push('The sound is longer than ' + LIMITS.maxAudioFrames + ' sample frames; the WAV file holds only its beginning.');
    if (format === 0) a.limitations.push('This PCM sound uses the byte order of the computer that made the movie; it is read as little-endian, as Flash Player on Windows did.');
    return { blob: wavBlob(Math.round(rate), decoded.channels), frames: frames, partial: partial };
  }

  function soundAsset(ctx, a, tag) {
    requireDecoded(ctx, tag);
    var f = tag.fields, data = ctx.swf.getTagData(tag).subarray(f.dataStart);
    a.characterId = f.soundId;
    a.title = 'Sound ' + f.soundId;
    soundMeta(a, f, f.rate);
    meta(a, 'Samples', f.sampleCount + ' (' + seconds(f.sampleCount, f.rate) + ')');
    var name = M.soundFormatName(f.format);
    if (f.format === 2) {
      var mp3 = M.parseMp3(data);
      if (f.seekSamples) meta(a, 'Decoder delay', f.seekSamples + ' samples (skipped by Flash Player when playing)');
      if (!mp3) throw new Error('No valid MP3 frames were found in the sound data.');
      var file = output(a, 'MP3 audio', '', 'mp3', 'audio/mpeg', data);
      a.preview = { type: 'audio', blob: file.blob };
      a.format = 'MP3, ' + mp3.rate + ' Hz, ' + (mp3.stereo ? 'stereo' : 'mono');
      a.explanation = 'An MP3 sound. The SWF stores ordinary MP3 frames, saved here as an .mp3 file.';
    } else if (M.decodesItself(f.format)) {
      var wav = decodeToWav(a, f.format, f.rate, f.is16Bit, f.stereo, [data], f.sampleCount);
      file = output(a, 'WAV audio', '', 'wav', 'audio/wav', wav.blob);
      a.preview = { type: 'audio', blob: file.blob };
      if (wav.partial) a.status = 'partial';
      a.format = 'WAV from ' + name + ', ' + f.rate + ' Hz';
      a.explanation = 'A ' + name + ' sound, decoded and saved as a 16-bit WAV file.';
    } else {
      a.status = 'unsupported';
      a.format = name + ' (encoded)';
      a.explanation = 'A ' + name + ' sound. This tool cannot decode ' + name + ', so it offers the encoded data as it is in the SWF.';
      a.limitations.push('The encoded ' + name + ' data is not a standard audio file; it needs a ' + name + ' decoder.');
    }
    output(a, 'Encoded sound data', 'encoded', 'bin', 'application/octet-stream', data);
  }

  function streamAsset(ctx, a, stream) {
    var head = stream.head && stream.head.fields, blocks = stream.blocks;
    a.title = 'Stream sound of ' + stream.timeline;
    a.encodedBytes = blocks.reduce(function (n, t) { return n + t.length; }, 0);
    meta(a, 'Timeline', stream.timeline);
    meta(a, 'Blocks', blocks.length + ' (frames ' + blocks[0].frame + '–' + blocks[blocks.length - 1].frame + ')');
    var datas = blocks.map(function (t) { return ctx.swf.getTagData(t); });
    var raw = concat(datas);
    if (!head) {
      a.status = 'partial';
      a.format = 'Raw blocks';
      a.explanation = 'Sound blocks of a timeline without a SoundStreamHead tag, so their format is unknown. The blocks are offered as they are, in order.';
      output(a, 'Raw stream blocks (concatenated)', 'blocks', 'bin', 'application/octet-stream', raw);
      return;
    }
    soundMeta(a, head, head.rate);
    meta(a, 'Samples per frame', head.sampleCount);
    var name = M.soundFormatName(head.format);
    if (head.format === 2) {
      // Each MP3 block starts with SampleCount (UI16) and SeekSamples (SI16), then whole MP3 frames.
      var frames = concat(datas.filter(function (d) { return d.length > 4; }).map(function (d) { return d.subarray(4); }));
      var mp3 = M.parseMp3(frames);
      if (!mp3) throw new Error('No valid MP3 frames were found in the stream blocks.');
      var file = output(a, 'MP3 audio (all blocks)', '', 'mp3', 'audio/mpeg', frames);
      a.preview = { type: 'audio', blob: file.blob };
      a.format = 'MP3, ' + mp3.rate + ' Hz';
      a.explanation = 'Sound streamed along a timeline in ' + blocks.length + ' blocks. The MP3 frames of all blocks are joined, in order, into one .mp3 file.';
    } else if (M.decodesItself(head.format)) {
      var wav = decodeToWav(a, head.format, head.rate, head.is16Bit, head.stereo, datas);
      file = output(a, 'WAV audio (all blocks)', '', 'wav', 'audio/wav', wav.blob);
      a.preview = { type: 'audio', blob: file.blob };
      if (wav.partial) a.status = 'partial';
      a.format = 'WAV from ' + name + ', ' + head.rate + ' Hz';
      a.explanation = 'Sound streamed along a timeline in ' + blocks.length + ' blocks, decoded in order and saved as one 16-bit WAV file.';
    } else {
      a.status = 'unsupported';
      a.format = name + ' (encoded)';
      a.explanation = 'Sound streamed along a timeline in ' + name + ', which this tool cannot decode. The blocks are offered as they are, in order.';
    }
    output(a, 'Raw stream blocks (concatenated)', 'blocks', 'bin', 'application/octet-stream', raw);
    a.limitations.push('Stream blocks belong to their timeline frames; a single block is not a complete sound, so they are only offered together.');
  }

  // ---- Video ----

  var VIDEO_CODECS = { 2: 'Sorenson H.263', 3: 'Screen video', 4: 'On2 VP6', 5: 'On2 VP6 with alpha', 6: 'Screen video v2', 7: 'AVC (H.264)' };
  function videoAsset(ctx, a, tag) {
    var data = ctx.swf.getTagData(tag);
    if (data.length < 10) throw new Error('The DefineVideoStream tag is too short.');
    var id = u16(data, 0), frames = ctx.videoFrames[id] || [];
    a.characterId = id;
    a.title = 'Video stream ' + id;
    a.status = 'raw';
    a.format = (VIDEO_CODECS[data[9]] || 'codec ' + data[9]) + ', ' + u16(data, 4) + ' × ' + u16(data, 6);
    meta(a, 'Codec', VIDEO_CODECS[data[9]] || 'unknown (' + data[9] + ')');
    meta(a, 'Frames', u16(data, 2) + ' declared, ' + frames.length + ' VideoFrame tags');
    meta(a, 'Size', u16(data, 4) + ' × ' + u16(data, 6));
    a.explanation = 'An embedded video stream. Its frames are compressed video data that needs a decoder for this codec; they are offered as they are.';
    if (frames.length) output(a, 'Video frame data (' + frames.length + ' frames, concatenated)', 'frames', 'bin', 'application/octet-stream', concat(frames.map(function (t) { return ctx.swf.getTagData(t).subarray(4); })));
    rawOutput(a, 'Raw DefineVideoStream body');
    a.limitations.push('The frames are not converted to a video file.');
  }

  // ---- Fonts and text ----

  function fontCodes(ctx, f) {
    var info = f.fontVersion === 1 ? ctx.fontInfos[f.fontId] : null;
    return f.glyphs.map(function (g, i) { return info ? (i < info.codes.length ? info.codes[i] : null) : g.code; });
  }
  function charOf(code) {
    if (code === null || code === undefined) return null;
    if (code >= 0xd800 && code <= 0xdfff) return null;
    return String.fromCharCode(code);
  }
  function fontSheet(f, codes) {
    var em = f.fontVersion === 3 ? 20480 : 1024, cols = 16, count = Math.min(f.glyphs.length, LIMITS.maxGlyphs), numbers = 0;
    var cell = 1000, scale = cell / em, rowH = cell * 1.35, body = [];
    for (var i = 0; i < count; i++) {
      var cmds = M.glyphCommands(f.glyphs[i]), d = [], x0 = (i % cols) * cell, y0 = Math.floor(i / cols) * rowH + cell * 0.85;
      numbers += cmds.length;
      if (numbers > LIMITS.maxSvgNumbers) throw new LimitError('The font has too many outline points for SVG output.');
      for (var k = 0; k < cmds.length;) {
        var n = cmds[k] === 2 ? 4 : 2, pts = [];
        for (var j = 0; j < n; j += 2) pts.push(+(x0 + cmds[k + 1 + j] * scale).toFixed(1) + ' ' + +(y0 + cmds[k + 2 + j] * scale).toFixed(1));
        d.push((cmds[k] === 0 ? 'M' : cmds[k] === 1 ? 'L' : 'Q') + pts.join(' '));
        k += 1 + n;
      }
      var ch = charOf(codes[i]), label = ch !== null ? ch + ' U+' + ('000' + codes[i].toString(16).toUpperCase()).slice(-4) : '#' + i;
      body.push('<path d="' + d.join('') + '" fill="#111827" fill-rule="nonzero"/><text x="' + (x0 + cell / 2) + '" y="' + (y0 + cell * 0.42) + '" font-size="110" text-anchor="middle" fill="#6b7280" font-family="sans-serif">' + escapeXml(label) + '</text>');
    }
    var w = cols * cell, h = Math.max(1, Math.ceil(count / cols)) * rowH;
    return '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" width="' + w / 10 + '" height="' + h / 10 + '"><rect width="100%" height="100%" fill="#ffffff"/>' + body.join('') + '</svg>\n';
  }

  function fontAsset(ctx, a, tag) {
    requireDecoded(ctx, tag);
    var f = tag.fields, codes = fontCodes(ctx, f), mapped = codes.filter(function (c) { return c !== null && c !== undefined; }).length;
    var info = f.fontVersion === 1 ? ctx.fontInfos[f.fontId] : null, name = (info && info.name) || f.name || '';
    a.characterId = f.fontId;
    a.title = 'Font ' + f.fontId + (name ? ' “' + name + '”' : '');
    meta(a, 'Name', name || '(none)');
    meta(a, 'Style', [f.bold || (info && info.bold) ? 'bold' : '', f.italic || (info && info.italic) ? 'italic' : ''].filter(Boolean).join(', ') || 'regular');
    meta(a, 'Glyphs', f.glyphs.length + (mapped < f.glyphs.length ? ' (' + mapped + ' with a character code)' : ''));
    if (f.hasLayout) meta(a, 'Metrics', 'ascent ' + f.ascent + ', descent ' + f.descent + ', leading ' + f.leading + (f.kerning ? ', ' + f.kerning.length + ' kerning pairs' : ''));
    if (ctx.fontNames[f.fontId]) meta(a, 'Copyright', ctx.fontNames[f.fontId]);
    var summary = {
      fontId: f.fontId, tag: tag.name, name: name, bold: !!f.bold, italic: !!f.italic, emSquare: f.fontVersion === 3 ? 20480 : 1024,
      ascent: f.ascent, descent: f.descent, leading: f.leading, kerning: f.kerning,
      glyphs: f.glyphs.map(function (g, i) { return { index: i, code: codes[i], character: charOf(codes[i]), advance: g.advance, bounds: g.bounds }; })
    };
    if (!f.glyphs.length) {
      a.status = 'raw';
      a.format = 'Device font reference';
      a.explanation = 'A device font: the movie names a font installed on the viewer\'s computer and embeds no outlines.';
      jsonOutput(a, 'Font information (JSON)', summary);
      return;
    }
    var sheet = output(a, 'Glyph outlines (SVG sheet)', 'glyphs', 'svg', 'image/svg+xml', fontSheet(f, codes));
    a.preview = { type: 'image', blob: sheet.blob, alt: 'Glyphs of font ' + f.fontId };
    jsonOutput(a, 'Glyph table (JSON)', summary);
    a.format = f.glyphs.length + ' glyph outlines';
    if (f.glyphs.length > LIMITS.maxGlyphs) a.limitations.push('Only the first ' + LIMITS.maxGlyphs + ' glyphs are drawn in the SVG sheet; the JSON lists all of them.');
    if (mapped < f.glyphs.length) a.limitations.push(mapped ? 'Some glyphs have no character code in the SWF; they are labelled by index.' : 'The SWF gives no character codes for these glyphs; they are labelled by index.');
    a.limitations.push('These are the glyph outlines the movie uses, not an installable TTF or OTF font file.');
    a.explanation = 'An embedded font as SWF glyph outlines. The SVG sheet shows each glyph with its character; the JSON lists codes, advances and metrics.';
  }

  async function font4Asset(ctx, a, tag) {
    requireDecoded(ctx, tag);
    var f = tag.fields;
    a.characterId = f.fontId;
    a.title = 'Font ' + f.fontId + (f.name ? ' “' + f.name + '”' : '');
    meta(a, 'Name', f.name || '(none)');
    meta(a, 'Style', [f.bold ? 'bold' : '', f.italic ? 'italic' : ''].filter(Boolean).join(', ') || 'regular');
    if (!f.hasFontData) {
      a.status = 'raw';
      a.format = 'Font name only';
      a.explanation = 'A DefineFont4 tag without a font program: it only names a font.';
      rawOutput(a);
      return;
    }
    var data = ctx.swf.getTagData(tag).subarray(f.dataStart), file = output(a, 'OpenType (CFF) font program', '', 'otf', 'font/otf', data);
    a.format = 'OpenType/CFF, ' + data.length + ' bytes';
    a.preview = { type: 'font', blob: file.blob, family: f.name };
    a.explanation = 'An embedded OpenType font program with CFF outlines, saved as it is stored in the SWF.';
    a.limitations.push('It is a CFF-based OpenType font program (as used by Flash text engines), not a TrueType font.');
  }

  function textAsset(ctx, a, tag) {
    requireDecoded(ctx, tag);
    var f = tag.fields, lines = [''], fontId = null, y = null, unmapped = 0, glyphs = 0, fonts = {};
    a.characterId = f.characterId;
    a.title = 'Static text ' + f.characterId;
    f.records.forEach(function (r, i) {
      if (r.fontId !== undefined) fontId = r.fontId;
      if (r.y !== undefined && y !== null && r.y !== y) lines.push('');
      if (r.y !== undefined) y = r.y;
      var font = ctx.fonts[fontId];
      if (fontId !== null) fonts[fontId] = true;
      r.glyphs.forEach(function (g) {
        glyphs++;
        var ch = font ? charOf(font.codes[g.index]) : null;
        if (ch === null) unmapped++;
        lines[lines.length - 1] += ch === null ? '�' : ch;
      });
    });
    var text = lines.join('\n').slice(0, LIMITS.maxTextChars);
    meta(a, 'Fonts', Object.keys(fonts).join(', ') || 'none');
    meta(a, 'Glyphs', glyphs + ' in ' + f.records.length + ' records');
    if (glyphs && unmapped === glyphs) {
      a.status = 'partial';
      a.format = 'Glyph indices only';
      a.explanation = 'Static text whose font gives no character codes, so only its glyph indices are known (see the JSON).';
    } else {
      a.format = 'Text, ' + text.length + ' characters';
      a.explanation = 'Static text, read through its font\'s character codes.';
      if (unmapped) { a.status = 'partial'; a.limitations.push(unmapped + ' glyph(s) have no character code and are shown as �.'); }
      output(a, 'Text', '', 'txt', 'text/plain;charset=utf-8', text);
      a.preview = { type: 'text', text: text };
    }
    jsonOutput(a, 'Decoded text records (JSON)', f);
    a.limitations.push('Position, size and colour of the text are in the JSON; the text file holds only the characters.');
  }

  function editTextAsset(ctx, a, tag) {
    requireDecoded(ctx, tag);
    var f = tag.fields, text = f.initialText || '';
    a.characterId = f.characterId;
    a.title = 'Text field ' + f.characterId;
    meta(a, 'Variable', f.variableName);
    meta(a, 'Font', f.fontId !== undefined ? 'font ' + f.fontId + (f.fontHeight ? ', ' + px(f.fontHeight) + ' px' : '') : f.fontClass);
    meta(a, 'Options', ['html', 'multiline', 'wordWrap', 'password', 'readOnly', 'border', 'useOutlines'].filter(function (k) { return f[k]; }).join(', ') || 'none');
    if (f.html) a.limitations.push('The text is HTML in the SWF; it is shown and saved as its source, without formatting.');
    if (!text) {
      a.status = 'raw';
      a.format = 'Empty field (settings only)';
      a.explanation = 'A text field that starts empty; scripts or the user may fill it while the movie plays. Its settings are in the JSON.';
    } else {
      text = text.slice(0, LIMITS.maxTextChars);
      a.format = (f.html ? 'HTML text' : 'Text') + ', ' + text.length + ' characters';
      a.explanation = 'A text field with its initial text' + (f.html ? ' (HTML source)' : '') + '.';
      output(a, f.html ? 'Text (HTML source)' : 'Text', '', 'txt', 'text/plain;charset=utf-8', text);
      a.preview = { type: 'text', text: text };
    }
    jsonOutput(a, 'Field settings (JSON)', f);
  }

  // ---- Binary data, bytecode, metadata ----

  function sniff(b) {
    function starts(s) { for (var i = 0; i < s.length; i++) if (b[i] !== s.charCodeAt(i)) return false; return b.length >= s.length; }
    if (starts('FWS') || starts('CWS') || starts('ZWS')) return ['swf', 'application/x-shockwave-flash', 'a SWF movie'];
    if (b[0] === 0x89 && starts('\x89PNG')) return ['png', 'image/png', 'a PNG image'];
    if (b[0] === 0xff && b[1] === 0xd8) return ['jpg', 'image/jpeg', 'a JPEG image'];
    if (starts('GIF8')) return ['gif', 'image/gif', 'a GIF image'];
    if (starts('PK\x03\x04')) return ['zip', 'application/zip', 'a ZIP archive'];
    if (starts('<?xml') || starts('\xef\xbb\xbf<?xml')) return ['xml', 'application/xml', 'an XML document'];
    if (starts('ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return ['mp3', 'audio/mpeg', 'MP3 audio'];
    return ['bin', 'application/octet-stream', null];
  }
  function binaryAsset(ctx, a, tag) {
    var data = ctx.swf.getTagData(tag);
    if (data.length < 6) throw new Error('The DefineBinaryData tag is too short for its header.');
    var payload = data.subarray(6), type = sniff(payload);
    a.characterId = u16(data, 0);
    a.title = 'Binary data ' + a.characterId;
    a.status = 'raw';
    a.format = (type[2] ? type[0].toUpperCase() + ' (detected)' : 'Unknown format') + ', ' + payload.length + ' bytes';
    meta(a, 'Detected content', type[2] || 'unknown; the format is specific to the movie');
    output(a, 'Payload', '', type[0], type[1], payload);
    a.explanation = 'Raw data embedded by the author (DefineBinaryData), without the tag\'s character id and reserved header.' + (type[2] ? ' Its first bytes look like ' + type[2] + '.' : '');
  }
  // Counts AVM1 action records (without running them): codes from 0x80 carry a UI16 length.
  function countActions(b) {
    var count = 0, i = 0;
    while (i < b.length && count < 1000000) {
      var code = b[i];
      if (code === 0) return { count: count, ended: true };
      count++;
      i += code >= 0x80 ? 3 + (i + 2 < b.length ? u16(b, i + 1) : 0) : 1;
    }
    return { count: count, ended: false };
  }
  function codeAsset(ctx, a, tag) {
    var data = ctx.swf.getTagData(tag), bytes = data, where = tag.path.indexOf('/') > 0 ? 'a sprite timeline' : 'the main timeline';
    a.status = 'raw';
    if (tag.code === 82) {
      var f = tag.fields;
      if (!f) throw new Error('The DoABC header could not be read.');
      bytes = data.subarray(f.abcStart);
      a.title = 'ActionScript 3 bytecode' + (f.name ? ' “' + f.name + '”' : '');
      a.format = 'AVM2 (ABC ' + (bytes.length >= 4 ? u16(bytes, 2) + '.' + u16(bytes, 0) : '?') + ')';
      meta(a, 'Virtual machine', 'AVM2 (ActionScript 3)');
      meta(a, 'ABC version', bytes.length >= 4 ? u16(bytes, 2) + '.' + u16(bytes, 0) : 'unknown');
      meta(a, 'Lazy initialization', f.lazyInitialize ? 'yes' : 'no');
      output(a, 'ABC bytecode', '', 'abc', 'application/octet-stream', bytes);
    } else {
      if (tag.code === 59) {
        if (data.length < 2) throw new Error('The DoInitAction tag is too short.');
        a.characterId = u16(data, 0);
        bytes = data.subarray(2);
        meta(a, 'Runs for sprite', a.characterId);
      }
      var actions = countActions(bytes);
      a.title = tag.code === 59 ? 'Initialization actions for sprite ' + a.characterId : 'Frame actions (frame ' + tag.frame + ' of ' + where + ')';
      a.format = 'AVM1, ' + actions.count + ' actions';
      meta(a, 'Virtual machine', 'AVM1 (ActionScript 1 and 2)');
      meta(a, 'Actions', actions.count + (actions.ended ? '' : ' (no end marker found)'));
      output(a, 'AVM1 bytecode', '', 'avm1', 'application/octet-stream', bytes);
    }
    meta(a, 'Frame', tag.frame);
    a.explanation = 'ActionScript bytecode, extracted as it is. It is never run or evaluated by this tool.';
    a.limitations.push('Bytecode is not decompiled; use an ActionScript decompiler to read it.');
  }
  function metadataAsset(ctx, a, tag) {
    var data = ctx.swf.getTagData(tag), end = data.indexOf(0);
    var text = new TextDecoder('utf-8').decode(end >= 0 ? data.subarray(0, end) : data).slice(0, LIMITS.maxTextChars);
    a.title = 'Metadata';
    a.status = 'raw';
    a.format = 'XML text, ' + text.length + ' characters';
    output(a, 'Metadata (XML)', '', 'xml', 'application/xml', text);
    a.preview = { type: 'text', text: text };
    a.explanation = 'Descriptive metadata (usually XMP/RDF XML) written by the authoring tool.';
  }
  function otherAsset(ctx, a, tag) {
    a.status = tag.status === 'invalid' ? 'error' : tag.status === 'partial' ? 'partial' : 'raw';
    a.title = tag.name;
    a.format = 'Tag body, ' + tag.length + ' bytes';
    var reason = readerReason(ctx, tag);
    meta(a, 'Reader status', STATUS_TEXT[tag.status] || tag.status);
    if (reason) a.limitations.push(reason);
    if (tag.status === 'invalid') a.error = reason || 'The reader could not decode this tag.';
    rawOutput(a);
    if (tag.fields) jsonOutput(a, 'Decoded fields (JSON)', tag.fields);
    a.explanation = 'A tag this tool does not convert. Its body is offered as it is' + (tag.fields ? ', with the fields the reader decoded.' : '.');
  }

  var HANDLERS = {
    6: ['image', bitmapAsset], 21: ['image', bitmapAsset], 35: ['image', bitmapAsset], 90: ['image', bitmapAsset], 20: ['image', bitmapAsset], 36: ['image', bitmapAsset],
    2: ['shape', shapeAsset], 22: ['shape', shapeAsset], 32: ['shape', shapeAsset], 83: ['shape', shapeAsset],
    46: ['morph', morphAsset], 84: ['morph', morphAsset], 14: ['sound', soundAsset], 60: ['video', videoAsset],
    10: ['font', fontAsset], 48: ['font', fontAsset], 75: ['font', fontAsset], 91: ['font', font4Asset],
    11: ['text', textAsset], 33: ['text', textAsset], 37: ['text', editTextAsset], 87: ['binary', binaryAsset],
    12: ['code', codeAsset], 59: ['code', codeAsset], 82: ['code', codeAsset], 77: ['other', metadataAsset]
  };

  // A failed conversion keeps the row: its error, and the raw tag body when the tag has one.
  function failed(a, err) {
    a.status = 'error';
    a.error = err instanceof LimitError ? err.message : (err && err.message ? err.message.replace(/^(SWFReader|RetroFlash): /, '') : String(err));
    a.preview = null;
    a.outputs = a.outputs.filter(function (o) { return o.label.indexOf('Raw') === 0; });
    if (a.tag && !a.outputs.length && a.tag.length) {
      try { rawOutput(a); } catch (e) { /* nothing to offer */ }
    }
  }

  function headerOf(swf, fileName, fileSize) {
    return {
      name: fileName, signature: swf.signature, compression: swf.compression === 'zlib' ? 'zlib (CWS)' : 'none (FWS)', version: swf.version,
      width: swf.width, height: swf.height, fps: swf.fps, frames: swf.frameCount, actualFrames: swf.actualFrameCount, fileSize: fileSize,
      declaredLength: swf.declaredLength, tags: swf.totalTagCount, background: swf.background,
      actionScript: swf.fileAttributes && swf.fileAttributes.actionScript3 ? 'ActionScript 3 (AVM2)' : (swf.codeTags.avm1 || swf.codeTags.buttonActions || swf.codeTags.clipActions) ? 'ActionScript 1/2 (AVM1)' : 'none found',
      diagnostics: swf.diagnostics.slice(), unsupported: swf.unsupported.slice()
    };
  }

  /* Reads the SWF in `bytes` and converts its resources, one at a time; onProgress(done, total) follows the
     work. A file the reader rejects makes the promise fail with the reader's error. */
  async function analyze(bytes, fileName, onProgress) {
    var swf = await SWFReader.load(bytes);
    var ctx = {
      swf: swf, base: safeName(fileName), jpegTables: null, fontInfos: {}, fontNames: {}, fonts: {}, videoFrames: {},
      bitmapLimits: { maxPixels: LIMITS.maxBitmapPixels, remaining: LIMITS.maxTotalBitmapPixels }
    };
    var entries = [];
    swf.walkTags(function (tag, parent) { entries.push({ tag: tag, parent: parent }); });
    // What other resources need: JPEG tables, font names and codes, and video frames by stream.
    entries.forEach(function (e) {
      var tag = e.tag, f = tag.fields;
      if (tag.code === 8 && !ctx.jpegTables && tag.length) ctx.jpegTables = swf.getTagData(tag);
      else if ((tag.code === 13 || tag.code === 62) && f) ctx.fontInfos[f.fontId] = f;
      else if (tag.code === 88 && f && f.copyright) ctx.fontNames[f.fontId] = f.copyright;
      else if (tag.code === 61 && tag.length >= 4) {
        var id = u16(swf.getTagData(tag), 0);
        (ctx.videoFrames[id] || (ctx.videoFrames[id] = [])).push(tag);
      }
    });
    entries.forEach(function (e) {
      var f = e.tag.fields;
      if ((e.tag.code === 10 || e.tag.code === 48 || e.tag.code === 75) && f && f.glyphs) ctx.fonts[f.fontId] = { codes: fontCodes(ctx, f) };
    });
    // The work list: resource tags in file order, one stream sound per timeline (at its first stream tag).
    var jobs = [], streams = {}, skipped = 0;
    entries.forEach(function (e) {
      var tag = e.tag, code = tag.code;
      if (code === 18 || code === 45 || code === 19) {
        var key = e.parent ? 'sprite ' + e.parent.spriteId : 'the main timeline', s = streams[key];
        if (!s) { s = streams[key] = { timeline: key, head: null, blocks: [], tag: tag }; jobs.push({ stream: s }); }
        if (code === 19) s.blocks.push(tag);
        else if (!s.head && tag.fields) s.head = tag;
        return;
      }
      if (code === 61 || (STRUCTURAL[code] && tag.status !== 'unknown')) return;
      var handler = HANDLERS[code];
      if (handler) jobs.push({ tag: tag, kind: handler[0], run: handler[1] });
      else if (tag.status !== 'decoded') jobs.push({ tag: tag, kind: 'other', run: otherAsset });
    });
    // A stream without blocks (a header only) has no sound to offer.
    jobs = jobs.filter(function (j) { return !j.stream || j.stream.blocks.length; });
    var assets = [];
    for (var i = 0; i < jobs.length; i++) {
      if (assets.length >= LIMITS.maxAssets) { skipped = jobs.length - i; break; }
      var job = jobs[i], a;
      if (job.stream) {
        a = newAsset(ctx, job.stream.head || job.stream.blocks[0], 'stream');
        try { streamAsset(ctx, a, job.stream); } catch (err) { failed(a, err); }
      } else {
        a = newAsset(ctx, job.tag, job.kind);
        try { await job.run(ctx, a, job.tag); } catch (err) { failed(a, err); }
      }
      if (!a.title) a.title = job.tag ? job.tag.name : 'Stream sound';
      delete a.ctx;
      assets.push(a);
      if (onProgress) onProgress(i + 1, jobs.length);
      if (i % 8 === 7) await new Promise(function (resolve) { setTimeout(resolve, 0); });
    }
    return { movie: headerOf(swf, fileName, bytes.byteLength), assets: assets, skipped: skipped, kinds: KINDS };
  }

  global.SWFAssetExtractor = Object.freeze({ analyze: analyze, limits: Object.freeze(LIMITS), kinds: Object.freeze(KINDS) });
})(typeof window !== 'undefined' ? window : globalThis);
