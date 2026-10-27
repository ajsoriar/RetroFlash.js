/* SWFReader v0.3 - dependency-free SWF structure reader (browser classic script; also loadable from Node for tests).
   API: const movie = await SWFReader.load(fileOrBuffer[, options]);
   SWFReader parses the header, the tag index (recursively inside DefineSprite) and a small set of tag bodies.
   It does NOT render and NEVER executes ActionScript. Anything it does not decode is reported in
   movie.unsupported; malformed content is reported in movie.diagnostics or rejected with a coded error.
*/
(function (global) {
  'use strict';

  var VERSION = '0.3.0';

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

  var DEFAULT_OPTIONS = Object.freeze({
    maxFileBytes: 50 * 1024 * 1024, // declared (uncompressed) SWF length
    maxTags: 500000,                // tags indexed in total, nested ones included
    maxSpriteDepth: 4,              // DefineSprite nesting levels whose contents are indexed
    strict: false                   // throw instead of recording a diagnostic for invalid tag bodies
  });

  // Control tags valid inside DefineSprite (SWF spec v19, DefineSprite). PlaceObject3 is accepted as well
  // because SWF 8+ authoring tools emit it inside sprites.
  var SPRITE_CONTROL_TAGS = { 0: 1, 1: 1, 4: 1, 5: 1, 12: 1, 15: 1, 18: 1, 19: 1, 26: 1, 28: 1, 43: 1, 45: 1, 70: 1 };

  var REASON_INDEXED = 'Indexed only: offsets and raw bytes are available through getTagData(); the body is not decoded yet.';
  var REASON_UNKNOWN = 'Unknown tag code; skipped using its declared length.';
  var REASON_AVM1 = 'AVM1 bytecode detected; it is never executed (no ActionScript VM in this phase).';
  var REASON_AVM2 = 'AVM2 (ActionScript 3) bytecode detected; it is never executed.';
  var UNPARSED_REASONS = {
    clipActions: 'AVM1 clip event actions; not parsed and never executed.',
    filterList: 'Filter list not decoded yet; the optional fields after it are left unparsed too.',
    afterFilterList: 'Not decoded because it follows an undecoded filter list.',
    controlTags: 'Sprite nesting deeper than options.maxSpriteDepth; contents not indexed.'
  };

  function SWFReaderError(code, message, offset) {
    var err = new Error('SWFReader: ' + message);
    err.name = 'SWFReaderError';
    err.code = code;
    if (offset !== undefined) err.offset = offset;
    return err;
  }
  function fail(code, message, offset) { throw SWFReaderError(code, message, offset); }
  function isReaderError(err) { return !!err && err.name === 'SWFReaderError'; }
  function plainMessage(err) { return String(err.message).replace(/^SWFReader: /, ''); }

  function readUint32(bytes, at) {
    return (bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536 + bytes[at + 3] * 16777216) >>> 0;
  }

  var utf8Decoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8') : null;
  // SWF 6+ strings are UTF-8. Older files use the author's locale encoding, which the file does not record;
  // they are decoded as Latin-1 (one byte per character), as are all strings when TextDecoder is missing.
  function decodeString(bytes, version) {
    if (version >= 6 && utf8Decoder) return utf8Decoder.decode(bytes);
    var result = '';
    for (var i = 0; i < bytes.length; i++) result += String.fromCharCode(bytes[i]);
    return result;
  }

  /* MSB-first bit reader over bytes[start, end). Bit fields (UB/SB/FB) read from the current bit position;
     byte-aligned types (UI8/UI16/UI32/STRING) and records (RECT/MATRIX/CXFORM*) align first, as the spec
     requires. Every read is bounds-checked and throws SWFReaderError TRUNCATED_DATA past `end`. */
  function BitReader(bytes, start, end) {
    if (!(bytes instanceof Uint8Array)) fail('INVALID_INPUT', 'BitReader needs a Uint8Array');
    start = start === undefined ? 0 : start;
    end = end === undefined ? bytes.length : end;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || end > bytes.length) {
      fail('INVALID_RANGE', 'BitReader range [' + start + ', ' + end + ') is outside the buffer');
    }
    this.bytes = bytes;
    this.start = start;
    this.end = end;
    this.bitPos = start * 8;
  }
  BitReader.prototype.byteOffset = function () { return Math.ceil(this.bitPos / 8); };
  BitReader.prototype.remainingBits = function () { return this.end * 8 - this.bitPos; };
  BitReader.prototype.remainingBytes = function () { return this.end - this.byteOffset(); };
  BitReader.prototype.align = function () { this.bitPos = this.byteOffset() * 8; return this; };
  BitReader.prototype.need = function (bits, what) {
    if (bits > this.remainingBits()) {
      fail('TRUNCATED_DATA', (what || 'Field') + ' needs ' + bits + ' bit(s) at byte ' + Math.floor(this.bitPos / 8) +
        ' but only ' + this.remainingBits() + ' remain', Math.floor(this.bitPos / 8));
    }
  };
  BitReader.prototype.readUB = function (count, what) {
    if (!Number.isInteger(count) || count < 0 || count > 32) {
      fail('BAD_BIT_COUNT', 'Bit field width must be an integer from 0 to 32, got ' + count);
    }
    this.need(count, what);
    var bytes = this.bytes, byteIndex = Math.floor(this.bitPos / 8), bit = this.bitPos % 8, value = 0;
    for (var i = 0; i < count; i++) {
      value = value * 2 + ((bytes[byteIndex] >> (7 - bit)) & 1);
      if (++bit === 8) { bit = 0; byteIndex++; }
    }
    this.bitPos += count;
    return value;
  };
  BitReader.prototype.readSB = function (count, what) {
    var value = this.readUB(count, what);
    if (count > 0 && value >= Math.pow(2, count - 1)) value -= Math.pow(2, count);
    return value;
  };
  // FB: signed 16.16 fixed-point bit field.
  BitReader.prototype.readFB = function (count, what) { return this.readSB(count, what) / 65536; };
  BitReader.prototype.readUI8 = function (what) {
    this.align(); this.need(8, what || 'UI8');
    var value = this.bytes[this.bitPos / 8];
    this.bitPos += 8;
    return value;
  };
  BitReader.prototype.readUI16 = function (what) {
    this.align(); this.need(16, what || 'UI16');
    var at = this.bitPos / 8;
    this.bitPos += 16;
    return this.bytes[at] | (this.bytes[at + 1] << 8);
  };
  BitReader.prototype.readUI32 = function (what) {
    this.align(); this.need(32, what || 'UI32');
    var at = this.bitPos / 8;
    this.bitPos += 32;
    return readUint32(this.bytes, at);
  };
  BitReader.prototype.readString = function (version, what) {
    this.align();
    var at = this.bitPos / 8, stop = at;
    while (stop < this.end && this.bytes[stop] !== 0) stop++;
    if (stop >= this.end) fail('TRUNCATED_DATA', (what || 'STRING') + ' at byte ' + at + ' has no null terminator', at);
    this.bitPos = (stop + 1) * 8;
    return decodeString(this.bytes.subarray(at, stop), version);
  };
  BitReader.prototype.readRGB = function (what) {
    what = what || 'RGB';
    return { r: this.readUI8(what), g: this.readUI8(what), b: this.readUI8(what) };
  };
  BitReader.prototype.readRGBA = function (what) {
    what = what || 'RGBA';
    return { r: this.readUI8(what), g: this.readUI8(what), b: this.readUI8(what), a: this.readUI8(what) };
  };
  // FIXED8: signed 8.8 fixed point stored as a little-endian 16-bit value.
  BitReader.prototype.readFixed8 = function (what) {
    var value = this.readUI16(what || 'FIXED8');
    return (value >= 0x8000 ? value - 0x10000 : value) / 256;
  };
  // RECT: coordinates in twips (1/20 px).
  BitReader.prototype.readRect = function () {
    this.align();
    var nBits = this.readUB(5, 'RECT.Nbits');
    var rect = {
      nBits: nBits,
      xMin: this.readSB(nBits, 'RECT.Xmin'), xMax: this.readSB(nBits, 'RECT.Xmax'),
      yMin: this.readSB(nBits, 'RECT.Ymin'), yMax: this.readSB(nBits, 'RECT.Ymax')
    };
    this.align();
    return rect;
  };
  // MATRIX: scale/rotate-skew as numbers (16.16 fixed), translation in twips. Absent parts get identity values.
  BitReader.prototype.readMatrix = function () {
    this.align();
    var m = { hasScale: false, scaleX: 1, scaleY: 1, hasRotate: false, rotateSkew0: 0, rotateSkew1: 0, translateX: 0, translateY: 0 };
    if (this.readUB(1, 'MATRIX.HasScale')) {
      var nScale = this.readUB(5, 'MATRIX.NScaleBits');
      m.hasScale = true;
      m.scaleX = this.readFB(nScale, 'MATRIX.ScaleX');
      m.scaleY = this.readFB(nScale, 'MATRIX.ScaleY');
    }
    if (this.readUB(1, 'MATRIX.HasRotate')) {
      var nRotate = this.readUB(5, 'MATRIX.NRotateBits');
      m.hasRotate = true;
      m.rotateSkew0 = this.readFB(nRotate, 'MATRIX.RotateSkew0');
      m.rotateSkew1 = this.readFB(nRotate, 'MATRIX.RotateSkew1');
    }
    var nTranslate = this.readUB(5, 'MATRIX.NTranslateBits');
    m.translateX = this.readSB(nTranslate, 'MATRIX.TranslateX');
    m.translateY = this.readSB(nTranslate, 'MATRIX.TranslateY');
    this.align();
    return m;
  };
  // CXFORM / CXFORMWITHALPHA: multiply terms are raw 8.8 fixed integers (256 = 1.0); add terms are raw integers.
  function readColorTransform(reader, withAlpha) {
    var label = withAlpha ? 'CXFORMWITHALPHA' : 'CXFORM';
    var channels = withAlpha ? ['red', 'green', 'blue', 'alpha'] : ['red', 'green', 'blue'];
    reader.align();
    var cx = {
      hasAddTerms: reader.readUB(1, label + '.HasAddTerms') === 1,
      hasMultTerms: reader.readUB(1, label + '.HasMultTerms') === 1
    };
    var nBits = reader.readUB(4, label + '.Nbits'), i;
    for (i = 0; i < channels.length; i++) { cx[channels[i] + 'Mult'] = 256; cx[channels[i] + 'Add'] = 0; }
    if (cx.hasMultTerms) {
      for (i = 0; i < channels.length; i++) cx[channels[i] + 'Mult'] = reader.readSB(nBits, label + '.' + channels[i] + 'Mult');
    }
    if (cx.hasAddTerms) {
      for (i = 0; i < channels.length; i++) cx[channels[i] + 'Add'] = reader.readSB(nBits, label + '.' + channels[i] + 'Add');
    }
    reader.align();
    return cx;
  }
  BitReader.prototype.readCxform = function () { return readColorTransform(this, false); };
  BitReader.prototype.readCxformWithAlpha = function () { return readColorTransform(this, true); };

  // PlaceObject2 flag byte, then the fields shared by PlaceObject2 and PlaceObject3 up to ClipDepth.
  function readPlacementFields(r, ctx, flags, f, label) {
    if (flags & 0x02) f.characterId = r.readUI16(label + '.CharacterId');
    if (flags & 0x04) f.matrix = r.readMatrix();
    if (flags & 0x08) f.colorTransform = r.readCxformWithAlpha();
    if (flags & 0x10) f.ratio = r.readUI16(label + '.Ratio');
    if (flags & 0x20) f.name = r.readString(ctx.version, label + '.Name');
    if (flags & 0x40) f.clipDepth = r.readUI16(label + '.ClipDepth');
    return f;
  }

  /* Shapes (DefineShape 1-4). `shapeVersion` selects the per-version layout: RGB colours in versions 1-2,
     RGBA from 3, extended style counts from 2, LINESTYLE2 and focal gradients in 4. Colours are always
     returned as {r, g, b, a} (a = 255 when the file stores RGB). */
  function readShapeColor(r, shapeVersion, what) {
    if (shapeVersion >= 3) return r.readRGBA(what);
    var c = r.readRGB(what);
    c.a = 255;
    return c;
  }
  function readGradient(r, shapeVersion, focal) {
    r.align();
    var g = { spreadMode: r.readUB(2, 'GRADIENT.SpreadMode'), interpolationMode: r.readUB(2, 'GRADIENT.InterpolationMode'), stops: [] };
    var count = r.readUB(4, 'GRADIENT.NumGradients');
    for (var i = 0; i < count; i++) {
      g.stops.push({ ratio: r.readUI8('GRADRECORD.Ratio'), color: readShapeColor(r, shapeVersion, 'GRADRECORD.Color') });
    }
    if (focal) g.focalPoint = r.readFixed8('FOCALGRADIENT.FocalPoint');
    return g;
  }
  function readFillStyle(r, shapeVersion) {
    var at = r.byteOffset(), type = r.readUI8('FILLSTYLE.FillStyleType');
    if (type === 0x00) return { type: 'solid', color: readShapeColor(r, shapeVersion, 'FILLSTYLE.Color') };
    if (type === 0x10 || type === 0x12 || (type === 0x13 && shapeVersion >= 4)) {
      return { type: type === 0x10 ? 'linear' : type === 0x12 ? 'radial' : 'focal', matrix: r.readMatrix(), gradient: readGradient(r, shapeVersion, type === 0x13) };
    }
    if (type >= 0x40 && type <= 0x43) {
      return { type: 'bitmap', bitmapId: r.readUI16('FILLSTYLE.BitmapId'), matrix: r.readMatrix(), repeat: type === 0x40 || type === 0x42, smooth: type <= 0x41 };
    }
    fail('INVALID_VALUE', 'Unknown FILLSTYLE type 0x' + type.toString(16) + ' for DefineShape' + (shapeVersion > 1 ? shapeVersion : '') + ' at byte ' + at, at);
  }
  function readLineStyle(r, shapeVersion) {
    if (shapeVersion < 4) return { width: r.readUI16('LINESTYLE.Width'), color: readShapeColor(r, shapeVersion, 'LINESTYLE.Color') };
    var s = { width: r.readUI16('LINESTYLE2.Width'), startCap: r.readUB(2, 'LINESTYLE2.StartCapStyle'), join: r.readUB(2, 'LINESTYLE2.JoinStyle') };
    var hasFill = r.readUB(1, 'LINESTYLE2.HasFillFlag');
    s.noHScale = r.readUB(1, 'LINESTYLE2.NoHScaleFlag') === 1;
    s.noVScale = r.readUB(1, 'LINESTYLE2.NoVScaleFlag') === 1;
    s.pixelHinting = r.readUB(1, 'LINESTYLE2.PixelHintingFlag') === 1;
    r.readUB(5, 'LINESTYLE2.Reserved');
    s.noClose = r.readUB(1, 'LINESTYLE2.NoClose') === 1;
    s.endCap = r.readUB(2, 'LINESTYLE2.EndCapStyle');
    if (s.join === 2) s.miterLimit = r.readFixed8('LINESTYLE2.MiterLimitFactor');
    if (hasFill) s.fill = readFillStyle(r, shapeVersion);
    else s.color = r.readRGBA('LINESTYLE2.Color');
    return s;
  }
  function readStyleCount(r, shapeVersion, what) {
    var count = r.readUI8(what);
    return count === 0xff && shapeVersion >= 2 ? r.readUI16(what + 'Extended') : count;
  }
  function readShapeStyles(r, shapeVersion) {
    var styles = { fillStyles: [], lineStyles: [] }, i, count;
    count = readStyleCount(r, shapeVersion, 'FILLSTYLEARRAY.FillStyleCount');
    for (i = 0; i < count; i++) styles.fillStyles.push(readFillStyle(r, shapeVersion));
    count = readStyleCount(r, shapeVersion, 'LINESTYLEARRAY.LineStyleCount');
    for (i = 0; i < count; i++) styles.lineStyles.push(readLineStyle(r, shapeVersion));
    styles.fillBits = r.readUB(4, 'SHAPE.NumFillBits');
    styles.lineBits = r.readUB(4, 'SHAPE.NumLineBits');
    return styles;
  }
  // SHAPERECORDs up to EndShapeRecord. Edges keep their deltas (twips); MoveTo is absolute, as in the spec.
  function readShapeRecords(r, shapeVersion, fillBits, lineBits) {
    var records = [], n;
    for (;;) {
      if (r.readUB(1, 'SHAPERECORD.TypeFlag')) {
        if (r.readUB(1, 'EDGERECORD.StraightFlag')) {
          n = r.readUB(4, 'STRAIGHTEDGERECORD.NumBits') + 2;
          if (r.readUB(1, 'STRAIGHTEDGERECORD.GeneralLineFlag')) {
            records.push({ type: 'line', dx: r.readSB(n, 'STRAIGHTEDGERECORD.DeltaX'), dy: r.readSB(n, 'STRAIGHTEDGERECORD.DeltaY') });
          } else if (r.readUB(1, 'STRAIGHTEDGERECORD.VertLineFlag')) {
            records.push({ type: 'line', dx: 0, dy: r.readSB(n, 'STRAIGHTEDGERECORD.DeltaY') });
          } else {
            records.push({ type: 'line', dx: r.readSB(n, 'STRAIGHTEDGERECORD.DeltaX'), dy: 0 });
          }
        } else {
          n = r.readUB(4, 'CURVEDEDGERECORD.NumBits') + 2;
          records.push({
            type: 'curve', cdx: r.readSB(n, 'CURVEDEDGERECORD.ControlDeltaX'), cdy: r.readSB(n, 'CURVEDEDGERECORD.ControlDeltaY'),
            adx: r.readSB(n, 'CURVEDEDGERECORD.AnchorDeltaX'), ady: r.readSB(n, 'CURVEDEDGERECORD.AnchorDeltaY')
          });
        }
        continue;
      }
      // StateNewStyles, StateLineStyle, StateFillStyle1, StateFillStyle0, StateMoveTo; all zero = EndShapeRecord.
      var flags = r.readUB(5, 'STYLECHANGERECORD.Flags');
      if (!flags) break;
      var rec = { type: 'style' };
      if (flags & 0x01) {
        n = r.readUB(5, 'STYLECHANGERECORD.MoveBits');
        rec.moveTo = { x: r.readSB(n, 'STYLECHANGERECORD.MoveDeltaX'), y: r.readSB(n, 'STYLECHANGERECORD.MoveDeltaY') };
      }
      if (flags & 0x02) rec.fill0 = r.readUB(fillBits, 'STYLECHANGERECORD.FillStyle0');
      if (flags & 0x04) rec.fill1 = r.readUB(fillBits, 'STYLECHANGERECORD.FillStyle1');
      if (flags & 0x08) rec.line = r.readUB(lineBits, 'STYLECHANGERECORD.LineStyle');
      if (flags & 0x10) {
        var styles = readShapeStyles(r, shapeVersion);
        rec.newStyles = { fillStyles: styles.fillStyles, lineStyles: styles.lineStyles };
        fillBits = styles.fillBits;
        lineBits = styles.lineBits;
      }
      records.push(rec);
    }
    r.align();
    return records;
  }
  function shapeDecoder(shapeVersion) {
    var label = 'DefineShape' + (shapeVersion > 1 ? shapeVersion : '');
    return function (r) {
      var f = { shapeId: r.readUI16(label + '.ShapeId'), shapeVersion: shapeVersion, bounds: r.readRect() };
      if (shapeVersion === 4) {
        f.edgeBounds = r.readRect();
        var flags = r.readUI8('DefineShape4.Flags');
        f.usesFillWindingRule = !!(flags & 0x04);
        f.usesNonScalingStrokes = !!(flags & 0x02);
        f.usesScalingStrokes = !!(flags & 0x01);
      }
      var styles = readShapeStyles(r, shapeVersion);
      f.fillStyles = styles.fillStyles;
      f.lineStyles = styles.lineStyles;
      f.records = readShapeRecords(r, shapeVersion, styles.fillBits, styles.lineBits);
      return f;
    };
  }

  // Tag body decoders: (reader, ctx, tag, level, unparsed) -> fields. Push names onto `unparsed` for
  // fields that exist in the tag but are not decoded; the tag is then reported as 'partial'.
  var DECODERS = {
    0: function () { return {}; },
    1: function () { return {}; },
    2: shapeDecoder(1),
    22: shapeDecoder(2),
    32: shapeDecoder(3),
    83: shapeDecoder(4),
    4: function (r) {
      var f = { characterId: r.readUI16('PlaceObject.CharacterId'), depth: r.readUI16('PlaceObject.Depth'), matrix: r.readMatrix() };
      f.colorTransform = r.remainingBytes() > 0 ? r.readCxform() : null;
      return f;
    },
    5: function (r) {
      return { characterId: r.readUI16('RemoveObject.CharacterId'), depth: r.readUI16('RemoveObject.Depth') };
    },
    9: function (r, ctx, tag, level) {
      var color = r.readRGB('SetBackgroundColor');
      if (level === 0) ctx.background = { r: color.r, g: color.g, b: color.b };
      return color;
    },
    26: function (r, ctx, tag, level, unparsed) {
      var flags = r.readUI8('PlaceObject2.Flags');
      var f = { move: !!(flags & 0x01), depth: r.readUI16('PlaceObject2.Depth') };
      readPlacementFields(r, ctx, flags, f, 'PlaceObject2');
      if (flags & 0x80) { f.hasClipActions = true; ctx.codeTags.clipActions++; unparsed.push('clipActions'); }
      return f;
    },
    28: function (r) { return { depth: r.readUI16('RemoveObject2.Depth') }; },
    43: function (r, ctx, tag) {
      var f = { name: r.readString(ctx.version, 'FrameLabel.Name') };
      if (ctx.version >= 6 && r.remainingBytes() > 0) f.namedAnchor = r.readUI8('FrameLabel.NamedAnchorFlag') === 1;
      tag.label = f.name;
      return f;
    },
    69: function (r, ctx, tag, level) {
      var raw = r.readUI32('FileAttributes');
      // Flag bits are MSB-first in the first byte, which is the low byte of the little-endian UI32.
      var f = {
        raw: raw, useDirectBlit: !!(raw & 0x40), useGPU: !!(raw & 0x20), hasMetadata: !!(raw & 0x10),
        actionScript3: !!(raw & 0x08), useNetwork: !!(raw & 0x01)
      };
      if (level === 0 && !ctx.fileAttributes) ctx.fileAttributes = f;
      return f;
    },
    70: function (r, ctx, tag, level, unparsed) {
      var flags = r.readUI8('PlaceObject3.Flags'), flags2 = r.readUI8('PlaceObject3.Flags2');
      var f = { move: !!(flags & 0x01), depth: r.readUI16('PlaceObject3.Depth') };
      if ((flags2 & 0x08) || ((flags2 & 0x10) && (flags & 0x02))) f.className = r.readString(ctx.version, 'PlaceObject3.ClassName');
      readPlacementFields(r, ctx, flags, f, 'PlaceObject3');
      var optional = [[0x02, 'blendMode'], [0x04, 'bitmapCache'], [0x20, 'visible'], [0x40, 'backgroundColor']];
      if (flags2 & 0x01) {
        unparsed.push('filterList');
        for (var i = 0; i < optional.length; i++) if (flags2 & optional[i][0]) unparsed.push(optional[i][1]);
      } else {
        if (flags2 & 0x02) f.blendMode = r.readUI8('PlaceObject3.BlendMode');
        if (flags2 & 0x04) f.bitmapCache = r.readUI8('PlaceObject3.BitmapCache');
        if (flags2 & 0x20) f.visible = r.readUI8('PlaceObject3.Visible');
        if (flags2 & 0x40) f.backgroundColor = r.readRGBA('PlaceObject3.BackgroundColor');
      }
      if (flags & 0x80) { f.hasClipActions = true; ctx.codeTags.clipActions++; unparsed.push('clipActions'); }
      return f;
    }
  };

  function diagnose(ctx, level, code, message, tag) {
    var entry = { level: level, code: code, message: message };
    if (tag) { entry.path = tag.path; entry.offset = tag.offset; }
    ctx.diagnostics.push(entry);
  }
  function markUnsupported(ctx, feature, reason, tag) {
    var entry = ctx.unsupported[feature];
    if (!entry) {
      entry = ctx.unsupported[feature] = { feature: feature, reason: reason, count: 0, firstPath: tag.path, firstOffset: tag.offset };
      ctx.unsupportedList.push(entry);
    }
    entry.count++;
  }
  // A tag body that does not match its declared layout: recorded as an error diagnostic, or thrown in strict mode.
  function invalidTag(ctx, tag, err) {
    if (!isReaderError(err)) throw err;
    var message = tag.name + ' at offset ' + tag.offset + ': ' + plainMessage(err);
    if (ctx.opts.strict || err.code === 'TOO_MANY_TAGS') fail(err.code, message, tag.offset);
    tag.status = 'invalid';
    diagnose(ctx, 'error', err.code, message, tag);
  }

  function decodeTag(ctx, tag, level) {
    var code = tag.code;
    if (code === 39) return decodeSprite(ctx, tag, level);
    if (code === 12 || code === 59) {
      ctx.codeTags.avm1++;
      tag.status = 'not-executed';
      return markUnsupported(ctx, 'actionscript:' + tag.name, REASON_AVM1, tag);
    }
    if (code === 82) {
      ctx.codeTags.avm2++;
      tag.status = 'not-executed';
      return markUnsupported(ctx, 'actionscript:' + tag.name, REASON_AVM2, tag);
    }
    var decoder = DECODERS[code];
    if (!decoder) {
      if (!TAG_NAMES[code]) tag.status = 'unknown';
      return markUnsupported(ctx, 'tag:' + tag.name, TAG_NAMES[code] ? REASON_INDEXED : REASON_UNKNOWN, tag);
    }
    var reader = new BitReader(ctx.bytes, tag.dataOffset, tag.dataOffset + tag.length), unparsed = [];
    try {
      tag.fields = decoder(reader, ctx, tag, level, unparsed);
    } catch (err) {
      return invalidTag(ctx, tag, err);
    }
    if (unparsed.length) {
      tag.status = 'partial';
      tag.unparsed = unparsed;
      var afterFilters = unparsed[0] === 'filterList';
      for (var i = 0; i < unparsed.length; i++) {
        var reason = UNPARSED_REASONS[unparsed[i]] || (afterFilters ? UNPARSED_REASONS.afterFilterList : 'Not decoded yet.');
        markUnsupported(ctx, tag.name + '.' + unparsed[i], reason, tag);
      }
    } else {
      tag.status = 'decoded';
      if (reader.remainingBytes() > 0) {
        diagnose(ctx, 'warning', 'TAG_EXTRA_BYTES', tag.name + ' at offset ' + tag.offset + ' has ' +
          reader.remainingBytes() + ' unread byte(s) after its fields', tag);
      }
    }
  }

  function decodeSprite(ctx, tag, level) {
    ctx.spriteCount++;
    var reader = new BitReader(ctx.bytes, tag.dataOffset, tag.dataOffset + tag.length);
    try {
      tag.spriteId = reader.readUI16('DefineSprite.SpriteID');
      tag.spriteFrames = reader.readUI16('DefineSprite.FrameCount');
    } catch (err) {
      return invalidTag(ctx, tag, err);
    }
    tag.fields = { spriteId: tag.spriteId, frameCount: tag.spriteFrames };
    var list = { tags: [], frames: [], endFound: false, trailingBytes: 0 };
    tag.children = list.tags;
    tag.frames = list.frames;
    var label = 'DefineSprite ' + tag.spriteId + ' at offset ' + tag.offset;
    if (level + 1 > ctx.opts.maxSpriteDepth) {
      tag.status = 'partial';
      tag.unparsed = ['controlTags'];
      diagnose(ctx, 'error', 'SPRITE_DEPTH_EXCEEDED', label + ' is nested ' + (level + 1) +
        ' level(s) deep; options.maxSpriteDepth is ' + ctx.opts.maxSpriteDepth, tag);
      return markUnsupported(ctx, 'DefineSprite.controlTags', UNPARSED_REASONS.controlTags, tag);
    }
    try {
      parseTagList(ctx, reader.byteOffset(), tag.dataOffset + tag.length, level + 1, tag.path, list);
    } catch (err) {
      tag.actualFrameCount = list.frames.length;
      return invalidTag(ctx, tag, err);
    }
    tag.status = 'decoded';
    tag.actualFrameCount = list.frames.length;
    tag.endFound = list.endFound;
    if (!list.endFound) diagnose(ctx, 'warning', 'SPRITE_MISSING_END', label + ' has no End tag', tag);
    if (list.trailingBytes) diagnose(ctx, 'warning', 'SPRITE_TRAILING_BYTES', label + ' has ' + list.trailingBytes + ' byte(s) after End', tag);
    if (list.frames.length !== tag.spriteFrames) {
      diagnose(ctx, 'warning', 'SPRITE_FRAME_COUNT_MISMATCH', label + ' declares ' + tag.spriteFrames +
        ' frame(s) but contains ' + list.frames.length + ' ShowFrame', tag);
    }
  }

  // Indexes the tag records in bytes[start, end) into `list`. Record-level errors (truncated header, length
  // outside the enclosing range) throw: the caller decides whether they are fatal (file) or local (sprite).
  function parseTagList(ctx, start, end, level, parentPath, list) {
    var bytes = ctx.bytes, offset = start, frame = 1, labels = [];
    var scope = level ? 'the enclosing DefineSprite' : 'the file';
    while (offset < end) {
      var headerStart = offset;
      if (end - offset < 2) {
        fail('TRUNCATED_TAG_HEADER', 'Tag header at offset ' + offset + ' is truncated (' + (end - offset) + ' byte left in ' + scope + ')', offset);
      }
      var codeAndLength = bytes[offset] | (bytes[offset + 1] << 8);
      offset += 2;
      var code = codeAndLength >>> 6, length = codeAndLength & 0x3f, longHeader = length === 0x3f;
      var name = TAG_NAMES[code] || ('Unknown_' + code);
      if (longHeader) {
        if (end - offset < 4) fail('TRUNCATED_TAG_HEADER', 'Long header of ' + name + ' at offset ' + headerStart + ' is truncated', headerStart);
        length = readUint32(bytes, offset);
        offset += 4;
        if (length > 0x7fffffff) {
          fail('BAD_TAG_LENGTH', name + ' at offset ' + headerStart + ' declares a negative SI32 length (' + (length | 0) + ')', headerStart);
        }
      }
      if (length > end - offset) {
        fail('TAG_OUT_OF_BOUNDS', name + ' at offset ' + headerStart + ' declares ' + length + ' byte(s) but only ' +
          (end - offset) + ' remain in ' + scope, headerStart);
      }
      if (++ctx.tagCount > ctx.opts.maxTags) fail('TOO_MANY_TAGS', 'More than options.maxTags (' + ctx.opts.maxTags + ') tags', headerStart);
      var tag = {
        index: list.tags.length, path: parentPath ? parentPath + '/' + list.tags.length : String(list.tags.length),
        level: level, code: code, name: name, offset: headerStart, dataOffset: offset,
        headerLength: offset - headerStart, longHeader: longHeader, length: length, frame: frame, status: 'indexed'
      };
      list.tags.push(tag);
      if (level > 0 && !SPRITE_CONTROL_TAGS[code]) {
        diagnose(ctx, 'warning', 'TAG_NOT_ALLOWED_IN_SPRITE', name + ' at offset ' + headerStart + ' is not a valid DefineSprite control tag', tag);
      }
      decodeTag(ctx, tag, level);
      offset += length;
      if (code === 43 && tag.fields) labels.push(tag.fields.name);
      if (code === 1) {
        list.frames.push({ number: frame, endTagIndex: tag.index, labels: labels });
        labels = [];
        frame++;
      }
      if (code === 0) { list.endFound = true; break; }
    }
    list.trailingBytes = end - offset;
  }

  async function inflateZlib(compressed, expectedLength) {
    var stream;
    try {
      stream = new DecompressionStream('deflate');
    } catch (err) {
      fail('CWS_UNSUPPORTED', 'CWS needs DecompressionStream("deflate"), which this environment does not provide; FWS works without it');
    }
    var writer = stream.writable.getWriter(), reader = stream.readable.getReader();
    function ignore() {}
    writer.write(compressed).catch(ignore);
    writer.close().catch(ignore);
    var out = new Uint8Array(expectedLength), size = 0;
    try {
      for (;;) {
        var step = await reader.read();
        if (step.done) break;
        var chunk = step.value;
        if (chunk.length > expectedLength - size) {
          reader.cancel().catch(ignore);
          fail('CWS_LENGTH_MISMATCH', 'Decompressed CWS data exceeds the declared length (' + (expectedLength + 8) + ' bytes)');
        }
        out.set(chunk, size);
        size += chunk.length;
      }
    } catch (err) {
      if (isReaderError(err)) throw err;
      fail('CWS_INFLATE_FAILED', 'Could not decompress CWS (zlib): ' + (err && err.message ? err.message : err));
    }
    return out.subarray(0, size);
  }

  function resolveOptions(options) {
    if (options === undefined || options === null) options = {};
    if (typeof options !== 'object') fail('INVALID_OPTION', 'options must be an object');
    var out = { strict: !!options.strict };
    ['maxFileBytes', 'maxTags', 'maxSpriteDepth'].forEach(function (key) {
      var value = options[key] === undefined ? DEFAULT_OPTIONS[key] : options[key];
      if (!Number.isInteger(value) || value < 0) fail('INVALID_OPTION', 'options.' + key + ' must be a non-negative integer');
      out[key] = value;
    });
    return out;
  }

  async function toBytes(input, opts) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (typeof Blob !== 'undefined' && input instanceof Blob) {
      if (input.size > opts.maxFileBytes) fail('FILE_TOO_LARGE', 'File is ' + input.size + ' bytes; options.maxFileBytes is ' + opts.maxFileBytes);
      return new Uint8Array(await input.arrayBuffer());
    }
    fail('INVALID_INPUT', 'Invalid input; use File, Blob, ArrayBuffer or Uint8Array');
  }

  function walk(tags, parent, callback) {
    for (var i = 0; i < tags.length; i++) {
      callback(tags[i], parent);
      if (tags[i].children) walk(tags[i].children, tags[i], callback);
    }
  }

  async function load(input, options) {
    var opts = resolveOptions(options);
    var source = await toBytes(input, opts);
    if (source.length < 8) fail('FILE_TOO_SHORT', 'File is too short (' + source.length + ' bytes) to hold an SWF header');
    var signature = String.fromCharCode(source[0], source[1], source[2]);
    if (signature !== 'FWS' && signature !== 'CWS' && signature !== 'ZWS') {
      fail('BAD_SIGNATURE', 'Unknown SWF signature: ' + JSON.stringify(signature), 0);
    }
    var version = source[3], declaredLength = readUint32(source, 4);
    if (signature === 'ZWS') fail('ZWS_UNSUPPORTED', 'ZWS uses LZMA compression, which is not implemented yet');
    // 8-byte header + 1-byte minimal RECT + FrameRate + FrameCount.
    if (declaredLength < 13) fail('BAD_LENGTH', 'Declared length ' + declaredLength + ' is smaller than the minimal SWF header (13 bytes)', 4);
    if (declaredLength > opts.maxFileBytes) {
      fail('FILE_TOO_LARGE', 'Declared length ' + declaredLength + ' exceeds options.maxFileBytes (' + opts.maxFileBytes + ')', 4);
    }

    var diagnostics = [], bytes;
    if (signature === 'CWS') {
      var payload = await inflateZlib(source.subarray(8), declaredLength - 8);
      if (payload.length !== declaredLength - 8) {
        fail('CWS_LENGTH_MISMATCH', 'Declared length is ' + declaredLength + ' bytes but the decompressed SWF has ' + (payload.length + 8));
      }
      bytes = new Uint8Array(declaredLength);
      bytes.set(source.subarray(0, 8));
      bytes.set(payload, 8);
    } else {
      if (source.length < declaredLength) {
        fail('TRUNCATED_FILE', 'File is truncated: declared ' + declaredLength + ' bytes, got ' + source.length);
      }
      bytes = source.length > declaredLength ? source.subarray(0, declaredLength) : source;
      if (source.length > declaredLength) {
        diagnostics.push({ level: 'warning', code: 'TRAILING_FILE_BYTES', message: (source.length - declaredLength) +
          ' byte(s) after the declared SWF length were ignored', offset: declaredLength });
      }
    }

    var header = new BitReader(bytes, 8, bytes.length), rect, rectEnd, fps, frameCount;
    try {
      rect = header.readRect();
      rectEnd = header.byteOffset();
      fps = header.readUI16('FrameRate') / 256;
      frameCount = header.readUI16('FrameCount');
    } catch (err) {
      if (!isReaderError(err)) throw err;
      fail('TRUNCATED_HEADER', 'SWF header is incomplete: ' + plainMessage(err), err.offset);
    }

    var ctx = {
      bytes: bytes, version: version, opts: opts, tagCount: 0, spriteCount: 0,
      diagnostics: diagnostics, unsupported: Object.create(null), unsupportedList: [],
      background: null, fileAttributes: null, codeTags: { avm1: 0, avm2: 0, clipActions: 0 }
    };
    var list = { tags: [], frames: [], endFound: false, trailingBytes: 0 };
    parseTagList(ctx, header.byteOffset(), bytes.length, 0, '', list);

    function warn(code, message) { diagnostics.push({ level: 'warning', code: code, message: message }); }
    if (signature === 'CWS' && version < 6) warn('CWS_OLD_VERSION', 'CWS compression requires SWF 6 or later; file declares SWF ' + version);
    if (rect.xMin > rect.xMax || rect.yMin > rect.yMax) warn('INVALID_STAGE_RECT', 'Stage RECT has a minimum greater than its maximum');
    if (!list.endFound) warn('MISSING_END', 'No End tag found');
    if (list.trailingBytes) warn('TRAILING_BYTES_AFTER_END', list.trailingBytes + ' byte(s) after the End tag');
    if (list.frames.length !== frameCount) {
      warn('FRAME_COUNT_MISMATCH', 'Header declares ' + frameCount + ' frame(s) but ' + list.frames.length + ' ShowFrame were found');
    }
    if (version >= 8) {
      if (!ctx.fileAttributes) warn('FILE_ATTRIBUTES_MISSING', 'SWF 8+ requires a FileAttributes tag');
      else if (list.tags[0].code !== 69) warn('FILE_ATTRIBUTES_NOT_FIRST', 'FileAttributes must be the first tag in SWF 8+');
    }
    if (ctx.fileAttributes && ctx.fileAttributes.actionScript3) warn('AVM2_DECLARED', 'The file declares ActionScript 3 (AVM2)');

    return {
      signature: signature, compression: signature === 'CWS' ? 'zlib' : 'none',
      version: version, declaredLength: declaredLength, sourceLength: source.length,
      width: (rect.xMax - rect.xMin) / 20, height: (rect.yMax - rect.yMin) / 20,
      bounds: {
        xminTwips: rect.xMin, xmaxTwips: rect.xMax, yminTwips: rect.yMin, ymaxTwips: rect.yMax, nBits: rect.nBits,
        width: (rect.xMax - rect.xMin) / 20, height: (rect.yMax - rect.yMin) / 20, nextOffset: rectEnd
      },
      fps: fps, frameCount: frameCount, actualFrameCount: list.frames.length,
      tags: list.tags, frames: list.frames, totalTagCount: ctx.tagCount, spriteCount: ctx.spriteCount,
      background: ctx.background, fileAttributes: ctx.fileAttributes, codeTags: ctx.codeTags,
      diagnostics: diagnostics, unsupported: ctx.unsupportedList,
      warnings: diagnostics.filter(function (d) { return d.level !== 'info'; }).map(function (d) { return d.message; }),
      limits: opts,
      getTagData: function (tagOrIndex) {
        var tag = typeof tagOrIndex === 'number' ? list.tags[tagOrIndex] : tagOrIndex;
        if (!tag || typeof tag !== 'object' || !Number.isInteger(tag.dataOffset) || !Number.isInteger(tag.length) ||
            tag.dataOffset < 0 || tag.length < 0 || tag.dataOffset + tag.length > bytes.length) {
          fail('INVALID_TAG', 'Tag not found or outside the file: ' + (typeof tagOrIndex === 'number' ? tagOrIndex : typeof tagOrIndex));
        }
        return bytes.slice(tag.dataOffset, tag.dataOffset + tag.length);
      },
      walkTags: function (callback) { walk(list.tags, null, callback); }
    };
  }

  global.SWFReader = Object.freeze({
    version: VERSION, load: load, BitReader: BitReader,
    defaultOptions: DEFAULT_OPTIONS, tagNames: Object.freeze(TAG_NAMES)
  });
})(typeof window !== 'undefined' ? window : globalThis);
