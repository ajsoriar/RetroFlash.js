/* RetroFlash.js - Bitmap decoding: lossless formats and JPEG alpha in JavaScript, JPEG/PNG/GIF through the browser decoder, and pixel budgets. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;
  var playerError = M.playerError;

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

  Object.assign(M, { losslessByteLength: losslessByteLength, decodeLossless: decodeLossless, cleanJpeg: cleanJpeg,
    mergeJpegTables: mergeJpegTables, imageSize: imageSize, reservePixels: reservePixels,
    decodeBitmap: decodeBitmap });
})(typeof window !== 'undefined' ? window : globalThis);
