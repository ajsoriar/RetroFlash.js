'use strict';
// Catalog of the project's own SWF fixtures. `node tests/fixtures/build-fixtures.js` (re)writes the .swf
// files next to this script; tests/unit/fixtures.test.js checks every file against its `expect` entry and
// verifies the committed bytes still match this generator. Document changes in tests/COMPATIBILITY.md.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { body, tag, T, swf, matrix, cxform, rect, movieBody, STAGE_550x400 } = require('../support/swf-builder');
const { buildAnimation } = require('./animation');
const { buildBitmaps } = require('./bitmaps');
const { buildActions } = require('./actions');
const { buildButtons } = require('./buttons');
const { buildText } = require('./text');
const { buildGame } = require('./game');
const { buildBrowser } = require('./browser');
const { buildSound } = require('./sound');
const { buildMorph } = require('./morph');
const { buildPaint } = require('./paint');

const fileAttributes = (raw = 0) => tag(T.FileAttributes, body((w) => w.u32(raw)));
const background = (r, g, b) => tag(T.SetBackgroundColor, body((w) => w.rgb({ r, g, b })));
const showFrame = () => tag(T.ShowFrame);
const end = () => tag(T.End);
const frameLabel = (name, opts) => tag(T.FrameLabel, body((w) => w.string(name)), opts);
const sprite = (id, frameCount, children, opts) =>
  tag(T.DefineSprite, Buffer.concat([body((w) => w.u16(id).u16(frameCount)), ...children]), opts);
// DefineShape with an empty SHAPEWITHSTYLE: no styles, NumFillBits/NumLineBits 0, EndShapeRecord.
const emptyShape = (id) => tag(T.DefineShape, body((w) => {
  w.u16(id);
  rect(w, { xMax: 400, yMax: 400 });
  w.u8(0).u8(0).ub(4, 0).ub(4, 0).ub(6, 0);
}));
// PlaceObject2/3 flag bits.
const PO = { move: 0x01, character: 0x02, matrix: 0x04, cxform: 0x08, ratio: 0x10, name: 0x20, clipDepth: 0x40, clipActions: 0x80 };
const PO3 = { filterList: 0x01, blendMode: 0x02, cacheAsBitmap: 0x04, className: 0x08 };

const minimalTags = () => [fileAttributes(), background(0x33, 0x66, 0x99), showFrame(), end()];

const timelineTags = () => [
  fileAttributes(),
  background(0x33, 0x66, 0x99),
  emptyShape(2),
  sprite(1, 2, [
    tag(T.PlaceObject2, body((w) => { w.u8(PO.character | PO.matrix).u16(1).u16(2); matrix(w, { translateX: 100, translateY: 200 }); })),
    showFrame(),
    frameLabel('spin'),
    tag(T.PlaceObject2, body((w) => { w.u8(PO.move | PO.matrix).u16(1); matrix(w, { rotateSkew0: 0.5, rotateSkew1: -0.5, translateX: 100, translateY: 200 }); })),
    showFrame(),
    end()
  ]),
  frameLabel('intro'),
  tag(T.PlaceObject, body((w) => {
    w.u16(2).u16(1);
    matrix(w, { scaleX: 2, scaleY: 2, translateX: 400, translateY: 800 });
    cxform(w, { mult: [128, 256, 256], add: [10, -10, 0] }, false);
  })),
  tag(T.PlaceObject2, body((w) => {
    w.u8(PO.character | PO.matrix | PO.cxform | PO.name).u16(2).u16(1);
    matrix(w, { scaleX: 1.5, scaleY: -0.5, translateX: -20, translateY: 31 });
    cxform(w, { mult: [256, 128, 0, -256], add: [-255, 0, 255, 1] }, true);
    w.string('clip_ñ');
  })),
  tag(T.DoAction, Uint8Array.from([0x07, 0x00])), // ActionStop, ActionEndFlag: indexed, never executed
  showFrame(),
  tag(T.PlaceObject2, body((w) => w.u8(PO.move | PO.ratio).u16(2).u16(300))),
  tag(T.RemoveObject, body((w) => w.u16(2).u16(1))),
  frameLabel('outro', { long: true }),
  tag(T.PlaceObject3, body((w) => {
    w.u8(PO.character | PO.matrix).u8(PO3.blendMode | PO3.cacheAsBitmap).u16(3).u16(2);
    matrix(w, {});
    w.u8(3).u8(1); // BlendMode multiply, BitmapCache on
  })),
  tag(T.RemoveObject2, body((w) => w.u16(2))),
  showFrame(),
  end()
];

const unsupportedTags = () => [
  fileAttributes(),
  tag(1000, Uint8Array.from([1, 2, 3])),
  tag(T.DoABC, body((w) => w.u32(1).string('fake').raw([0x10, 0x00, 0x2e, 0x00]))),
  tag(T.PlaceObject2, body((w) => w.u8(PO.character | PO.clipActions).u16(1).u16(2).u16(0).u32(0).u32(0))),
  tag(T.PlaceObject3, body((w) => w.u8(PO.character).u8(PO3.filterList | PO3.blendMode).u16(2).u16(2).raw([1, 1, 0, 0, 4, 0, 0, 0, 4, 0, 1]).u8(3))),
  showFrame(),
  end()
];

const nestedSpriteTags = () => [
  fileAttributes(),
  sprite(1, 1, [
    sprite(2, 1, [showFrame(), end()]),
    tag(T.DoInitAction, body((w) => w.u16(2).raw([0x07, 0x00]))),
    showFrame(),
    end()
  ]),
  sprite(3, 3, [showFrame()]),
  showFrame(),
  end()
];

const truncatedZlib = () => {
  const full = zlib.deflateSync(movieBody({ tags: minimalTags() }));
  return full.subarray(0, Math.floor(full.length / 2));
};

const fixtures = [
  // ---- valid -------------------------------------------------------------------------------------------
  {
    file: 'valid/fws-minimal.swf',
    description: 'Uncompressed SWF 10, 550x400 at 24 fps, FileAttributes + SetBackgroundColor + ShowFrame + End.',
    build: () => swf({ tags: minimalTags() }),
    expect: { signature: 'FWS', version: 10, width: 550, height: 400, fps: 24, frameCount: 1, actualFrameCount: 1, tags: 4, diagnostics: [], unsupported: [] }
  },
  {
    file: 'valid/cws-minimal.swf',
    description: 'Same movie as fws-minimal, zlib-compressed (CWS).',
    build: () => swf({ signature: 'CWS', tags: minimalTags() }),
    expect: { signature: 'CWS', version: 10, width: 550, height: 400, fps: 24, frameCount: 1, actualFrameCount: 1, tags: 4, diagnostics: [], unsupported: [] }
  },
  {
    file: 'valid/fws-timeline.swf',
    description: 'Two frames with frame labels (one in a long tag header), a two-frame DefineSprite, PlaceObject (MATRIX + CXFORM), ' +
      'PlaceObject2 (scale/translate MATRIX, CXFORMWITHALPHA, UTF-8 name), PlaceObject2 move/rotate/ratio, PlaceObject3 with blend mode, ' +
      'RemoveObject/RemoveObject2, an empty DefineShape and a DoAction.',
    build: () => swf({ fps: 12.5, frameCount: 2, tags: timelineTags() }),
    expect: {
      signature: 'FWS', version: 10, width: 550, height: 400, fps: 12.5, frameCount: 2, actualFrameCount: 2, tags: 16,
      diagnostics: [], unsupported: ['actionscript:DoAction']
    }
  },
  {
    file: 'valid/fws-unsupported.swf',
    description: 'Content the reader must report rather than decode: unknown tag code 1000, DoABC, PlaceObject2 clip actions. ' +
      'Also a PlaceObject3 whose blur filter list is skipped by size so its blend mode is still decoded.',
    build: () => swf({ tags: unsupportedTags() }),
    expect: {
      signature: 'FWS', version: 10, width: 550, height: 400, fps: 24, frameCount: 1, actualFrameCount: 1, tags: 7, diagnostics: [],
      unsupported: ['actionscript:DoABC', 'tag:Unknown_1000']
    }
  },
  {
    file: 'valid/fws-nested-sprite.swf',
    description: 'DefineSprite containing another DefineSprite and a DoInitAction (both invalid inside sprites, still indexed ' +
      'recursively), plus a sprite that declares 3 frames, has 1 and lacks End.',
    build: () => swf({ tags: nestedSpriteTags() }),
    expect: {
      signature: 'FWS', version: 10, width: 550, height: 400, fps: 24, frameCount: 1, actualFrameCount: 1, tags: 5,
      diagnostics: ['SPRITE_FRAME_COUNT_MISMATCH', 'SPRITE_MISSING_END', 'TAG_NOT_ALLOWED_IN_SPRITE', 'TAG_NOT_ALLOWED_IN_SPRITE'],
      unsupported: ['actionscript:DoInitAction']
    }
  },
  {
    file: 'valid/fws-animation.swf',
    description: 'Player fixture (tests/fixtures/animation.js): 48-frame vector animation with DefineShape 1-4 (solid, linear, ' +
      'radial, shared-edge fills, LINESTYLE2), a clipDepth mask, a removal at frame 40 and nested DefineSprite timelines.',
    build: buildAnimation,
    expect: {
      signature: 'FWS', version: 8, width: 480, height: 320, fps: 24, frameCount: 48, actualFrameCount: 48, tags: 164,
      diagnostics: [], unsupported: []
    }
  },
  {
    file: 'valid/fws-bitmaps.swf',
    description: 'Bitmap fixture (tests/fixtures/bitmaps.js): DefineBitsJPEG2 (JPEG and PNG), DefineBitsJPEG3 with alpha, ' +
      'DefineBits + JPEGTables, DefineBitsLossless formats 3/4/5, DefineBitsLossless2 formats 3/5, drawn through clipped, ' +
      'non-smoothed and repeating bitmap fills, one rotated at half alpha.',
    build: buildBitmaps,
    expect: {
      signature: 'FWS', version: 8, width: 480, height: 320, fps: 12, frameCount: 1, actualFrameCount: 1, tags: 35,
      diagnostics: [], unsupported: []
    }
  },
  {
    file: 'valid/fws-game.swf',
    description: 'Mini game (tests/fixtures/game.js): a hero moved with the arrow keys by onClipEvent(enterFrame) and Key.isDown, ' +
      'a coin whose onEnterFrame method uses hitTest to raise _root.score, and a text field bound to score.',
    build: buildGame,
    expect: {
      signature: 'FWS', version: 6, width: 400, height: 200, fps: 12, frameCount: 1, actualFrameCount: 1, tags: 12,
      diagnostics: [], unsupported: ['actionscript:DoAction']
    }
  },
  {
    file: 'valid/fws-actions.swf',
    description: 'AVM1 timeline-control fixture (tests/fixtures/actions.js): stop/play/gotoLabel/gotoFrame/setTarget in root ' +
      'and sprite frames, a variable, a Jump, and a GetURL that must never navigate.',
    build: buildActions,
    expect: {
      signature: 'FWS', version: 6, width: 200, height: 200, fps: 12, frameCount: 6, actualFrameCount: 6, tags: 19,
      diagnostics: [], unsupported: ['actionscript:DoAction']
    }
  },
  {
    file: 'valid/fws-browser.swf',
    description: 'Browser-interaction fixture (tests/fixtures/browser.js): getURL to the current window, _blank and a named ' +
      'window, javascript:panorama(2) and (3), an FSCommand, GET and POST forms sending the variables of a sprite, ' +
      'loadMovie into "contenedor", and a gallery whose buttons change num_img to load "vv/imagenes/img" + num_img + ".jpg" into "square".',
    build: buildBrowser,
    expect: {
      signature: 'FWS', version: 7, width: 400, height: 200, fps: 12, frameCount: 3, actualFrameCount: 3, tags: 33,
      diagnostics: [], unsupported: ['actionscript:DoAction']
    }
  },
  {
    file: 'valid/fws-buttons.swf',
    description: 'Button fixture (tests/fixtures/buttons.js): DefineButton2 with up/over/down states, a larger hit area, ' +
      'roll over/roll out/release actions and an Enter key press; DefineButton (v1) tinted by DefineButtonCxform; ' +
      'a "lamp" sprite driven through setTarget.',
    build: buildButtons,
    expect: {
      signature: 'FWS', version: 6, width: 320, height: 200, fps: 12, frameCount: 2, actualFrameCount: 2, tags: 23,
      diagnostics: [], unsupported: ['actionscript:DoAction']
    }
  },
  {
    file: 'valid/fws-text.swf',
    description: 'Text fixture (tests/fixtures/text.js): DefineFont2 and DefineFont3 with project-drawn glyphs and layout, ' +
      'device fonts (DefineFont2 without glyphs, with and without CodeTableOffset), DefineText and DefineText2, and ' +
      'DefineEditText fields: device font centered, embedded font with word wrap, HTML, border with AutoSize, and a ' +
      'password input field bound to a variable.',
    build: buildText,
    expect: {
      signature: 'FWS', version: 10, width: 400, height: 300, fps: 12, frameCount: 1, actualFrameCount: 1, tags: 22,
      diagnostics: [], unsupported: []
    }
  },
  {
    file: 'valid/fws-sound.swf',
    description: 'Sound fixture (tests/fixtures/sound.js): DefineSound in PCM 16-bit, PCM 8-bit stereo, ADPCM and MP3; ' +
      'StartSound with loops, an envelope and SyncStop; a DefineButtonSound; an ADPCM stream (SoundStreamHead2 and one ' +
      'SoundStreamBlock per frame); and a button whose release plays an exported sound through the AVM1 Sound object.',
    build: buildSound,
    expect: {
      signature: 'FWS', version: 6, width: 320, height: 200, fps: 12, frameCount: 12, actualFrameCount: 12, tags: 39,
      diagnostics: [], unsupported: []
    }
  },
  {
    file: 'valid/fws-morph.swf',
    description: 'Morph shape fixture (tests/fixtures/morph.js): a DefineMorphShape from a square of straight edges to a circle ' +
      'of curves, with solid fill and outline changes, and a DefineMorphShape2 whose rectangle, linear gradient (matrix, ' +
      'colours and stop positions) and round-capped outline change; both placed at a new ratio on each of 11 frames.',
    build: buildMorph,
    expect: {
      signature: 'FWS', version: 8, width: 320, height: 200, fps: 12, frameCount: 11, actualFrameCount: 11, tags: 38,
      diagnostics: [], unsupported: []
    }
  },
  {
    file: 'valid/fws-paint.swf',
    description: 'Paint fixture (tests/fixtures/paint.js): a clipped bitmap fill reaching past its bitmap, a tinted bitmap, ' +
      'repeating and reflecting linear, radial and focal gradients, a gradient line fill, a non-scaling stroke in a scaled ' +
      'sprite, a sprite with a DefineScalingGrid, and a text field using a DefineFont4 without a font file.',
    build: buildPaint,
    expect: {
      signature: 'FWS', version: 8, width: 480, height: 320, fps: 12, frameCount: 1, actualFrameCount: 1, tags: 24,
      diagnostics: [], unsupported: []
    }
  },
  // ---- loads with diagnostics --------------------------------------------------------------------------
  {
    file: 'warn/fws-missing-end.swf',
    description: 'Tag list ends without an End tag.',
    build: () => swf({ tags: [fileAttributes(), showFrame()] }),
    expect: { signature: 'FWS', frameCount: 1, actualFrameCount: 1, tags: 2, diagnostics: ['MISSING_END'], unsupported: [] }
  },
  {
    file: 'warn/fws-bytes-after-end.swf',
    description: 'Three bytes after End, inside the declared length.',
    build: () => swf({ tags: [fileAttributes(), showFrame(), end(), Uint8Array.from([0xde, 0xad, 0x00])] }),
    expect: { signature: 'FWS', frameCount: 1, actualFrameCount: 1, tags: 3, diagnostics: ['TRAILING_BYTES_AFTER_END'], unsupported: [] }
  },
  {
    file: 'warn/fws-frame-count-mismatch.swf',
    description: 'Header declares 3 frames; the file has 1 ShowFrame.',
    build: () => swf({ frameCount: 3, tags: minimalTags() }),
    expect: { signature: 'FWS', frameCount: 3, actualFrameCount: 1, tags: 4, diagnostics: ['FRAME_COUNT_MISMATCH'], unsupported: [] }
  },
  {
    file: 'warn/fws-extra-file-bytes.swf',
    description: 'Four bytes after the declared file length (ignored).',
    build: () => swf({ tags: minimalTags(), append: [1, 2, 3, 4] }),
    expect: { signature: 'FWS', frameCount: 1, actualFrameCount: 1, tags: 4, diagnostics: ['TRAILING_FILE_BYTES'], unsupported: [] }
  },
  {
    file: 'warn/fws-invalid-bodies.swf',
    description: 'Valid tag records whose bodies are malformed: PlaceObject2 announcing a MATRIX that is cut short, ' +
      'a FrameLabel without null terminator, a 2-byte SetBackgroundColor, and an End with a 1-byte body.',
    build: () => swf({
      tags: [
        fileAttributes(),
        tag(T.PlaceObject2, Uint8Array.from([PO.character | PO.matrix, 1, 0, 2, 0, 0x88])),
        tag(T.FrameLabel, Uint8Array.from([0x61, 0x62])),
        tag(T.SetBackgroundColor, Uint8Array.from([1, 2])),
        showFrame(),
        tag(T.End, Uint8Array.from([0]))
      ]
    }),
    expect: {
      signature: 'FWS', frameCount: 1, actualFrameCount: 1, tags: 6,
      diagnostics: ['TAG_EXTRA_BYTES', 'TRUNCATED_DATA', 'TRUNCATED_DATA', 'TRUNCATED_DATA'], unsupported: []
    }
  },
  {
    file: 'warn/fws-sprite-overflow.swf',
    description: 'DefineSprite whose second child declares 20 bytes with only 2 left in the sprite: the sprite is marked invalid, ' +
      'the rest of the file is still indexed.',
    build: () => swf({
      tags: [fileAttributes(), sprite(1, 1, [showFrame(), tag(T.PlaceObject2, Uint8Array.from([0, 1]), { length: 20 })]), showFrame(), end()]
    }),
    expect: { signature: 'FWS', frameCount: 1, actualFrameCount: 1, tags: 4, diagnostics: ['TAG_OUT_OF_BOUNDS'], unsupported: [] }
  },
  // ---- rejected ----------------------------------------------------------------------------------------
  { file: 'bad/empty.swf', description: 'Zero-byte file.', build: () => new Uint8Array(0), expect: { error: 'FILE_TOO_SHORT' } },
  {
    file: 'bad/bad-signature.swf', description: 'Signature "XWS".',
    build: () => { const b = swf({ tags: minimalTags() }); b[0] = 0x58; return b; }, expect: { error: 'BAD_SIGNATURE' }
  },
  {
    file: 'bad/zws.swf', description: 'ZWS (LZMA) signature: not implemented, rejected explicitly.',
    build: () => swf({ signature: 'ZWS', version: 13, tags: minimalTags() }), expect: { error: 'ZWS_UNSUPPORTED' }
  },
  {
    file: 'bad/declared-length-too-small.swf', description: 'Declared length 10, below the 13-byte minimum header.',
    build: () => swf({ tags: minimalTags(), declaredLength: 10 }), expect: { error: 'BAD_LENGTH' }
  },
  {
    file: 'bad/declared-length-huge.swf', description: 'Declared length 0xFFFFFFFF, above the default maxFileBytes (50 MiB).',
    build: () => swf({ tags: minimalTags(), declaredLength: 0xffffffff }), expect: { error: 'FILE_TOO_LARGE' }
  },
  {
    file: 'bad/fws-truncated-file.swf', description: 'fws-minimal cut to 20 bytes; header still declares the full length.',
    build: () => swf({ tags: minimalTags() }).subarray(0, 20), expect: { error: 'TRUNCATED_FILE' }
  },
  {
    file: 'bad/fws-truncated-rect.swf', description: 'RECT with Nbits = 31 (17 bytes) inside a 13-byte file.',
    build: () => swf({ stage: { xMax: 11000, yMax: 8000, nBits: 31 }, tags: [] }).subarray(0, 13),
    patch: (b) => { b[4] = 13; b[5] = b[6] = b[7] = 0; }, expect: { error: 'TRUNCATED_HEADER' }
  },
  {
    file: 'bad/fws-truncated-tag-header.swf', description: 'A single byte where a tag header should be.',
    build: () => swf({ tags: [showFrame(), Uint8Array.from([0x40])] }), expect: { error: 'TRUNCATED_TAG_HEADER' }
  },
  {
    file: 'bad/fws-tag-out-of-bounds.swf', description: 'Short header declares 10 bytes; 2 remain.',
    build: () => swf({ tags: [tag(T.SetBackgroundColor, Uint8Array.from([1, 2]), { length: 10 })] }), expect: { error: 'TAG_OUT_OF_BOUNDS' }
  },
  {
    file: 'bad/fws-long-header-truncated.swf', description: 'Long header (0x3F) with only 2 of its 4 length bytes.',
    build: () => swf({ tags: [showFrame(), Uint8Array.from([0x3f, 0x02, 0x10, 0x00])] }), expect: { error: 'TRUNCATED_TAG_HEADER' }
  },
  {
    file: 'bad/fws-long-tag-out-of-bounds.swf', description: 'Long header declares 0x7FFFFFFF bytes.',
    build: () => swf({ tags: [tag(T.DoAction, Uint8Array.from([0]), { length: 0x7fffffff })] }), expect: { error: 'TAG_OUT_OF_BOUNDS' }
  },
  {
    file: 'bad/fws-long-tag-negative.swf', description: 'Long header length 0xFFFFFFFF (negative as SI32).',
    build: () => swf({ tags: [tag(T.DoAction, Uint8Array.from([0]), { length: 0xffffffff })] }), expect: { error: 'BAD_TAG_LENGTH' }
  },
  {
    file: 'bad/cws-corrupt.swf', description: 'CWS header followed by bytes that are not a zlib stream.',
    build: () => {
      const b = swf({ tags: minimalTags() });
      b.set(Buffer.from('CWS', 'latin1'), 0);
      b.set(Buffer.from('not a zlib stream', 'latin1'), 8);
      return b;
    },
    expect: { error: 'CWS_INFLATE_FAILED' }
  },
  {
    file: 'bad/cws-truncated.swf', description: 'zlib stream cut in half.',
    build: () => {
      const full = swf({ tags: minimalTags() });
      return new Uint8Array(Buffer.concat([Buffer.from('CWS', 'latin1'), Buffer.from(full.subarray(3, 8)), truncatedZlib()]));
    },
    expect: { error: 'CWS_INFLATE_FAILED' }
  },
  {
    file: 'bad/cws-declared-too-short.swf', description: 'CWS whose declared length is 4 bytes shorter than the inflated movie.',
    build: () => swf({ signature: 'CWS', tags: minimalTags(), declaredLength: 8 + movieBody({ tags: minimalTags() }).length - 4 }),
    expect: { error: 'CWS_LENGTH_MISMATCH' }
  },
  {
    file: 'bad/cws-declared-too-long.swf', description: 'CWS whose declared length is 4 bytes longer than the inflated movie.',
    build: () => swf({ signature: 'CWS', tags: minimalTags(), declaredLength: 8 + movieBody({ tags: minimalTags() }).length + 4 }),
    expect: { error: 'CWS_LENGTH_MISMATCH' }
  }
];

function buildFixture(fixture) {
  const bytes = new Uint8Array(fixture.build());
  if (fixture.patch) fixture.patch(bytes);
  return bytes;
}

module.exports = { fixtures, buildFixture, FIXTURE_DIR: __dirname, STAGE_550x400 };

if (require.main === module) {
  for (const fixture of fixtures) {
    const target = path.join(__dirname, fixture.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buildFixture(fixture));
    console.log('wrote ' + fixture.file);
  }
}
