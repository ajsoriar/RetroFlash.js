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
  var CHARACTER_TAGS = { 14: 1, 46: 1, 60: 1, 84: 1, 87: 1, 91: 1 };

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
    var characters = Object.create(null), exports = Object.create(null), jpegTables = null, buttonColors = Object.create(null), buttonSounds = [], fontInfos = [];
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
      } else if (tag.code === 56) {
        if (f) f.assets.forEach(function (a) { if (!(a.name in exports)) exports[a.name] = a.characterId; });
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
    this.exports = exports; // ExportAssets: linkage name -> character id (attachMovie)
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

  Object.assign(M, { buildTimeline: buildTimeline, Movie: Movie });
})(typeof window !== 'undefined' ? window : globalThis);
