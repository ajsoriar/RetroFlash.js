/* SWFReader v0.1 - dependency-free SWF structure reader (browser, classic script).
   API: const movie = await SWFReader.load(fileOrArrayBuffer);
   SWFReader parses metadata and tag boundaries; it does NOT render or execute scripts.
*/
(function (global) {
  'use strict';

  var TAG_NAMES = {
    0:'End', 1:'ShowFrame', 2:'DefineShape', 4:'PlaceObject', 5:'RemoveObject',
    6:'DefineBits', 7:'DefineButton', 8:'JPEGTables', 9:'SetBackgroundColor',
    10:'DefineFont', 11:'DefineText', 12:'DoAction', 13:'DefineFontInfo',
    14:'DefineSound', 15:'StartSound', 17:'DefineButtonSound', 18:'SoundStreamHead',
    19:'SoundStreamBlock', 20:'DefineBitsLossless', 21:'DefineBitsJPEG2',
    22:'DefineShape2', 23:'DefineButtonCxform', 24:'Protect',
    26:'PlaceObject2', 28:'RemoveObject2', 32:'DefineShape3',
    33:'DefineText2', 34:'DefineButton2', 35:'DefineBitsJPEG3',
    36:'DefineBitsLossless2', 37:'DefineEditText', 39:'DefineSprite',
    43:'FrameLabel', 45:'SoundStreamHead2', 46:'DefineMorphShape',
    48:'DefineFont2', 56:'ExportAssets', 57:'ImportAssets',
    59:'DoInitAction', 60:'DefineVideoStream', 61:'VideoFrame',
    62:'DefineFontInfo2', 69:'FileAttributes', 70:'PlaceObject3',
    71:'ImportAssets2', 73:'DefineFontAlignZones', 74:'CSMTextSettings',
    75:'DefineFont3', 76:'SymbolClass', 77:'Metadata',
    78:'DefineScalingGrid', 82:'DoABC', 83:'DefineShape4',
    84:'DefineMorphShape2', 86:'DefineSceneAndFrameLabelData',
    87:'DefineBinaryData', 88:'DefineFontName', 89:'StartSound2',
    90:'DefineBitsJPEG4', 91:'DefineFont4', 93:'EnableTelemetry'
  };

  function fail(message) { throw new Error('SWFReader: ' + message); }
  function uint16(bytes, at) {
    if (at + 2 > bytes.length) fail('Datos truncados en ' + at);
    return bytes[at] | (bytes[at + 1] << 8);
  }
  function uint32(bytes, at) {
    if (at + 4 > bytes.length) fail('Datos truncados en ' + at);
    return (bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536 + bytes[at + 3] * 16777216) >>> 0;
  }
  function getBits(bytes, bitOffset, count) {
    var out = 0;
    for (var i = 0; i < count; i++) {
      var bit = bitOffset + i;
      if ((bit >>> 3) >= bytes.length) fail('RECT truncado');
      out = out * 2 + ((bytes[bit >>> 3] >>> (7 - (bit & 7))) & 1);
    }
    return out;
  }
  function signed(value, bits) {
    if (bits === 0) return 0;
    var half = Math.pow(2, bits - 1);
    return value >= half ? value - half * 2 : value;
  }
  function parseRect(bytes, offset) {
    var bit = offset * 8;
    var width = getBits(bytes, bit, 5); bit += 5;
    if (width > 31) fail('RECT invalido');
    var values = [];
    for (var i = 0; i < 4; i++) {
      values.push(signed(getBits(bytes, bit, width), width));
      bit += width;
    }
    return {
      xminTwips: values[0], xmaxTwips: values[1],
      yminTwips: values[2], ymaxTwips: values[3],
      width: (values[1] - values[0]) / 20,
      height: (values[3] - values[2]) / 20,
      nextOffset: Math.ceil(bit / 8)
    };
  }
  async function inflateZlib(compressed) {
    if (typeof DecompressionStream !== 'function') {
      fail('CWS necesita DecompressionStream("deflate") en este navegador; FWS funciona sin ella');
    }
    try {
      var stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (err) {
      fail('No se pudo descomprimir CWS (zlib): ' + err.message);
    }
  }
  async function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (typeof Blob !== 'undefined' && input instanceof Blob) return new Uint8Array(await input.arrayBuffer());
    fail('Entrada no valida; usa File, Blob, ArrayBuffer o Uint8Array');
  }
  function readCString(bytes, start, end) {
    var stop = start;
    while (stop < end && bytes[stop] !== 0) stop++;
    // Frame labels historically use the SWF single-byte string encoding.
    var result = '';
    for (var i = start; i < stop; i++) result += String.fromCharCode(bytes[i]);
    return result;
  }
  function parseTags(bytes, start, end, baseOffset) {
    var tags = [], frames = [], currentFrame = 1, endFound = false;
    var background = null, flags = null, codeTags = { avm1: 0, avm2: 0 };
    var offset = start;
    while (offset < end) {
      var headerStart = offset;
      if (offset + 2 > end) fail('Cabecera de etiqueta truncada en ' + offset);
      var record = uint16(bytes, offset); offset += 2;
      var code = record >>> 6;
      var length = record & 63;
      if (length === 63) {
        if (offset + 4 > end) fail('Longitud extendida truncada en ' + offset);
        length = uint32(bytes, offset); offset += 4;
      }
      var dataOffset = offset;
      if (length > end - dataOffset) fail('Etiqueta ' + code + ' fuera de limites en ' + headerStart);
      var tag = {
        index: tags.length, code: code, name: TAG_NAMES[code] || ('Unknown_' + code),
        offset: headerStart + baseOffset, dataOffset: dataOffset + baseOffset,
        length: length, frame: currentFrame
      };
      if (code === 9 && length >= 3) {
        background = { r: bytes[offset], g: bytes[offset + 1], b: bytes[offset + 2] };
      }
      if (code === 69 && length >= 4) {
        var rawFlags = uint32(bytes, offset);
        flags = { raw: rawFlags, actionScript3: !!(rawFlags & 8), useNetwork: !!(rawFlags & 1) };
      }
      if (code === 43) tag.label = readCString(bytes, offset, offset + length);
      if (code === 39 && length >= 4) {
        tag.spriteId = uint16(bytes, offset);
        tag.spriteFrames = uint16(bytes, offset + 2);
      }
      if (code === 12 || code === 59) codeTags.avm1++;
      if (code === 82) codeTags.avm2++;
      tags.push(tag);
      offset += length;
      if (code === 1) {
        frames.push({ number: currentFrame, endTagIndex: tag.index });
        currentFrame++;
      }
      if (code === 0) { endFound = true; break; }
    }
    return { tags: tags, frames: frames, background: background,
      fileAttributes: flags, codeTags: codeTags, endFound: endFound,
      trailingBytes: end - offset };
  }

  async function load(input) {
    var source = await toBytes(input);
    if (source.length < 8) fail('Archivo demasiado corto');
    var signature = String.fromCharCode(source[0], source[1], source[2]);
    if (signature !== 'FWS' && signature !== 'CWS' && signature !== 'ZWS') fail('Firma SWF desconocida: ' + signature);
    var version = source[3], declaredLength = uint32(source, 4);
    if (declaredLength < 12) fail('Longitud declarada invalida');
    if (signature === 'ZWS') fail('ZWS utiliza LZMA; aun no implementado en fase 1');
    var bytes;
    if (signature === 'CWS') {
      var payload = await inflateZlib(source.subarray(8));
      bytes = new Uint8Array(8 + payload.length);
      bytes.set(source.subarray(0, 8)); bytes.set(payload, 8);
    } else { bytes = source; }
    if (bytes.length !== declaredLength) {
      fail('Tamano SWF incorrecto: declarado ' + declaredLength + ', obtenido ' + bytes.length);
    }
    var rect = parseRect(bytes, 8);
    var p = rect.nextOffset;
    if (p + 4 > bytes.length) fail('Cabecera SWF incompleta');
    var fps = uint16(bytes, p) / 256; p += 2;
    var frameCount = uint16(bytes, p); p += 2;
    var parsed = parseTags(bytes, p, bytes.length, 0);
    var warnings = [];
    if (!parsed.endFound) warnings.push('No se encontro la etiqueta End');
    if (parsed.trailingBytes) warnings.push('Hay ' + parsed.trailingBytes + ' bytes despues de End');
    if (parsed.frames.length !== frameCount) warnings.push('La cabecera declara ' + frameCount + ' fotogramas, pero se encontraron ' + parsed.frames.length + ' ShowFrame');
    if (parsed.fileAttributes && parsed.fileAttributes.actionScript3) warnings.push('El archivo declara ActionScript 3 (AVM2)');
    return {
      signature: signature, compression: signature === 'CWS' ? 'zlib' : 'none',
      version: version, declaredLength: declaredLength, sourceLength: source.length,
      width: rect.width, height: rect.height, bounds: rect,
      fps: fps, frameCount: frameCount, actualFrameCount: parsed.frames.length,
      tags: parsed.tags, frames: parsed.frames,
      background: parsed.background, fileAttributes: parsed.fileAttributes,
      codeTags: parsed.codeTags, warnings: warnings,
      getTagData: function (tagOrIndex) {
        var tag = typeof tagOrIndex === 'number' ? parsed.tags[tagOrIndex] : tagOrIndex;
        if (!tag || !Number.isInteger(tag.dataOffset) || !Number.isInteger(tag.length) ||
            tag.dataOffset < 0 || tag.length < 0 || tag.dataOffset + tag.length > bytes.length) {
          fail('Etiqueta no valida');
        }
        return bytes.slice(tag.dataOffset, tag.dataOffset + tag.length);
      }
    };
  }

  global.SWFReader = Object.freeze({ version: '0.1.0', load: load, tagNames: Object.freeze(TAG_NAMES) });
})(typeof window !== 'undefined' ? window : globalThis);
