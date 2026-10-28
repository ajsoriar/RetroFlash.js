/* RetroFlash.js - Movie definition: the character dictionary and frame lists. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;
  var toMatrix = M.toMatrix, toColorTransform = M.toColorTransform, decodeBitmap = M.decodeBitmap,
    fontCharacter = M.fontCharacter;

  var SHAPE_CODES = { 2: 1, 22: 1, 32: 1, 83: 1 };
  var BITMAP_CODES = { 6: 1, 20: 1, 21: 1, 35: 1, 36: 1, 90: 1 };
  var FONT_CODES = { 10: 1, 48: 1, 75: 1 };
  // Other definition tags whose body starts with the new character id (UI16); placed but not drawn yet.
  var CHARACTER_TAGS = { 60: 1, 87: 1 };

  /* Frame k (1-based) = the control tags between ShowFrame k-1 and ShowFrame k. Tags after the last ShowFrame are
     ignored. A timeline with a stream sound also gets `stream`: { head (the first SoundStreamHead's fields),
     blocks: [{ frame, tag }] (SoundStreamBlock tags), name }; the Movie adds the SWF its blocks come from. */
  function buildTimeline(tags, name) {
    var frames = [], current = [], labels = Object.create(null), stream = null;
    for (var i = 0; i < tags.length; i++) {
      var tag = tags[i];
      if (tag.code === 0) break;
      if (tag.code === 1) { frames.push(current); current = []; continue; }
      if (tag.code === 43 && tag.fields && !(tag.fields.name in labels)) labels[tag.fields.name] = frames.length + 1;
      if (tag.code === 18 || tag.code === 45 || tag.code === 19) {
        stream = stream || { head: null, blocks: [], name: name || 'root', swf: null };
        if (tag.code === 19) stream.blocks.push({ frame: frames.length + 1, tag: tag });
        else if (!stream.head && tag.fields) stream.head = tag.fields;
      }
      current.push(tag);
    }
    if (!frames.length) frames.push(current);
    return { frames: frames, labels: labels, stream: stream && stream.blocks.length ? stream : null };
  }
  // Sound character (DefineSound): its format, and where its samples are (sound data starts at dataStart).
  function soundCharacter(swf, tag) {
    var f = tag.fields;
    return {
      type: 'sound', id: f.soundId, name: tag.name, format: f.format, rate: f.rate, is16Bit: f.is16Bit, stereo: f.stereo,
      sampleCount: f.sampleCount, seekSamples: f.seekSamples || 0, swf: swf, tag: tag, dataStart: f.dataStart
    };
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
    var characters = Object.create(null), exports = Object.create(null), jpegTables = null, buttonColors = Object.create(null), buttonSounds = Object.create(null), fontInfos = [], grids = [];
    // A definition whose body could not be decoded still defines its id (first UI16), so placements report
    // it as an invalid character rather than a missing one.
    function invalidCharacter(tag) {
      if (tag.length < 2) return;
      var data = swf.getTagData(tag), id = data[0] | (data[1] << 8);
      characters[id] = { type: 'unsupported', id: id, name: tag.name + ' (invalid)' };
    }
    // Stream blocks are read from this movie's SWF.
    function withSwf(stream) { if (stream) stream.swf = swf; return stream; }
    swf.tags.forEach(function (tag) {
      var f = tag.fields, decoded = f && tag.status === 'decoded';
      if (SHAPE_CODES[tag.code]) {
        if (decoded) characters[f.shapeId] = { type: 'shape', id: f.shapeId, name: tag.name, shape: f, geometry: null };
        else invalidCharacter(tag);
      } else if (tag.code === 46 || tag.code === 84) {
        // Morph shape: drawn at each placement's ratio (render/morph.js); `frames` caches those shapes.
        if (decoded) characters[f.characterId] = { type: 'morphShape', id: f.characterId, name: tag.name, morph: f, frames: new Map() };
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
      } else if (tag.code === 91) {
        // DefineFont4: an OpenType font, loaded into the browser by loadFonts; `family` is its CSS name then.
        if (decoded) {
          characters[f.fontId] = {
            type: 'font4', id: f.fontId, name: tag.name, fontName: f.name, bold: f.bold, italic: f.italic,
            data: f.hasFontData ? swf.getTagData(tag).subarray(f.dataStart) : null, family: null, face: null
          };
        } else invalidCharacter(tag);
      } else if (tag.code === 78) {
        if (decoded) grids.push(f);
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
        if (decoded) buttonSounds[f.buttonId] = f.sounds;
      } else if (tag.code === 14) {
        if (decoded) characters[f.soundId] = soundCharacter(swf, tag);
        else invalidCharacter(tag);
      } else if (tag.code === 56) {
        if (f) f.assets.forEach(function (a) { if (!(a.name in exports)) exports[a.name] = a.characterId; });
      } else if (tag.code === 8) {
        if (!jpegTables && tag.length) jpegTables = swf.getTagData(tag);
      } else if (tag.code === 39 && tag.children && tag.status !== 'invalid') {
        var timeline = buildTimeline(tag.children, 'sprite ' + tag.spriteId);
        characters[tag.spriteId] = { type: 'sprite', id: tag.spriteId, name: tag.name, frames: timeline.frames, labels: timeline.labels, stream: withSwf(timeline.stream) };
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
    // DefineScalingGrid gives a sprite or button its 9-slice grid.
    grids.forEach(function (g) {
      var c = characters[g.characterId];
      if (c && (c.type === 'sprite' || c.type === 'button')) c.scalingGrid = g.splitter;
    });
    // DefineButtonSound gives a button the sounds of its state changes.
    Object.keys(buttonSounds).forEach(function (id) {
      var button = characters[id];
      if (button && button.type === 'button') button.sounds = buttonSounds[id];
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
    this.exports = exports; // ExportAssets: linkage name -> character id (attachMovie)
    this.jpegTables = jpegTables;
    this.root = { type: 'sprite', id: 0, name: 'root', frames: root.frames, labels: root.labels, stream: withSwf(root.stream) };
  }
  /* Browser only. Decodes every bitmap character, at most BITMAP_DECODE_CONCURRENCY at a time to bound the
     memory held by inflated buffers; failures are reported and leave the bitmap undrawn. Bitmaps are taken in
     character id order from one pixel budget, limits = { maxPixels (per bitmap), remaining (all of them) }, so
     a movie cannot exhaust memory with many images. Movies loaded into clips share one budget. */
  var BITMAP_DECODE_CONCURRENCY = 4;
  Movie.prototype.decodeBitmaps = function (limits, report) {
    var self = this;
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
        limits.remaining += character.reserved || 0;
        character.reserved = 0;
        report('render:bitmapDecodeFailed', 'A bitmap could not be decoded and is not drawn.', character.id + ' (' + character.name + '): ' + err.message);
      }).then(worker);
    }
    var workers = [];
    for (var i = 0; i < BITMAP_DECODE_CONCURRENCY; i++) workers.push(worker());
    return Promise.all(workers);
  };
  /* Browser only. Loads the font files of DefineFont4 characters into the page (FontFace, document.fonts), each
     under a family name of its own, so text fields that name the font draw with it. Without the FontFace API,
     or when a file cannot be loaded, the text uses a device font and that is reported. */
  var fontSerial = 0;
  Movie.prototype.loadFonts = function (report) {
    var characters = this.characters, fonts = global.document && global.document.fonts;
    var list = Object.keys(characters).map(function (id) { return characters[id]; }).filter(function (c) { return c.type === 'font4' && c.data; });
    if (!list.length) return Promise.resolve();
    if (typeof global.FontFace !== 'function' || !fonts) {
      report('text:font4', 'DefineFont4 fonts need the browser\'s FontFace API; text that names them uses a device font.', list.map(function (c) { return c.id; }).join(','));
      return Promise.resolve();
    }
    return Promise.all(list.map(function (c) {
      var family = 'RetroFlash Font4 ' + (++fontSerial), face;
      try {
        face = new global.FontFace(family, c.data, { weight: c.bold ? 'bold' : 'normal', style: c.italic ? 'italic' : 'normal' });
      } catch (err) {
        return report('text:font4', 'A DefineFont4 font could not be loaded; text that names it uses a device font.', c.id + ': ' + err.message);
      }
      return face.load().then(function () {
        fonts.add(face);
        c.family = family;
        c.face = face;
      }, function (err) {
        report('text:font4', 'A DefineFont4 font could not be loaded; text that names it uses a device font.', c.id + ': ' + (err && err.message));
      });
    }));
  };
  // Frees decoded bitmap memory and loaded fonts when the movie is discarded. Returns the pixels its bitmaps had reserved.
  Movie.prototype.release = function () {
    var characters = this.characters, pixels = 0, fonts = global.document && global.document.fonts;
    Object.keys(characters).forEach(function (id) {
      var c = characters[id];
      pixels += c.reserved || 0;
      c.reserved = 0;
      releaseSource(c);
      if (c.type !== 'font4') return;
      if (c.face && fonts) fonts.delete(c.face);
      c.face = c.family = null;
    });
    return pixels;
  };
  // Frees a decoded image (ImageBitmap.close, or an empty canvas).
  function releaseSource(holder) {
    var source = holder.source;
    if (!source) return;
    if (typeof source.close === 'function') source.close();
    else { source.width = 0; source.height = 0; }
    holder.source = null;
    holder.tints = null; // tinted copies made by the renderer
  }

  Object.assign(M, { buildTimeline: buildTimeline, Movie: Movie, releaseSource: releaseSource });
})(typeof window !== 'undefined' ? window : globalThis);
