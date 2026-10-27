'use strict';
const { test, assert, throwsWithCode } = require('../support/harness');
const { SWFReader } = require('../support/load-reader');
const { BitWriter, matrix, cxform, rect } = require('../support/swf-builder');

const { BitReader } = SWFReader;
const at = (...bytes) => new BitReader(Uint8Array.from(bytes));

// ---- Hand-computed vectors (bit layouts worked out from the SWF v19 spec, not from the test writer) ----

test('RECT: classic 550x400 stage bytes 78 00 05 5F 00 00 0F A0 00', () => {
  const r = at(0x78, 0x00, 0x05, 0x5f, 0x00, 0x00, 0x0f, 0xa0, 0x00, 0xff);
  assert.deepStrictEqual(r.readRect(), { nBits: 15, xMin: 0, xMax: 11000, yMin: 0, yMax: 8000 });
  assert.strictEqual(r.byteOffset(), 9, 'RECT ends byte-aligned after 65 bits');
});

test('RECT: Nbits = 0 is one byte and all-zero bounds', () => {
  const r = at(0x00, 0xaa);
  assert.deepStrictEqual(r.readRect(), { nBits: 0, xMin: 0, xMax: 0, yMin: 0, yMax: 0 });
  assert.strictEqual(r.byteOffset(), 1);
});

test('MATRIX: scale 1.5/-0.5, no rotate, translate -20/31 (C9 80 00 E0 00 06 B1 F0)', () => {
  const r = at(0xc9, 0x80, 0x00, 0xe0, 0x00, 0x06, 0xb1, 0xf0);
  assert.deepStrictEqual(r.readMatrix(), {
    hasScale: true, scaleX: 1.5, scaleY: -0.5, hasRotate: false, rotateSkew0: 0, rotateSkew1: 0, translateX: -20, translateY: 31
  });
  assert.strictEqual(r.byteOffset(), 8);
});

test('MATRIX: identity record is a single zero byte', () => {
  const r = at(0x00);
  assert.deepStrictEqual(r.readMatrix(), {
    hasScale: false, scaleX: 1, scaleY: 1, hasRotate: false, rotateSkew0: 0, rotateSkew1: 0, translateX: 0, translateY: 0
  });
  assert.strictEqual(r.remainingBytes(), 0);
});

test('CXFORM: mult-only 255/-1/0, Nbits 9 (65 FF FF 00 00)', () => {
  const r = at(0x65, 0xff, 0xff, 0x00, 0x00);
  assert.deepStrictEqual(r.readCxform(), {
    hasAddTerms: false, hasMultTerms: true, redMult: 255, redAdd: 0, greenMult: -1, greenAdd: 0, blueMult: 0, blueAdd: 0
  });
  assert.strictEqual(r.byteOffset(), 5);
});

test('CXFORMWITHALPHA: mult 256/128/0/-256, add -255/0/255/1, Nbits 10 (E9 00 20 00 0C 03 01 00 0F F0 04)', () => {
  const r = at(0xe9, 0x00, 0x20, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x0f, 0xf0, 0x04);
  assert.deepStrictEqual(r.readCxformWithAlpha(), {
    hasAddTerms: true, hasMultTerms: true,
    redMult: 256, redAdd: -255, greenMult: 128, greenAdd: 0, blueMult: 0, blueAdd: 255, alphaMult: -256, alphaAdd: 1
  });
  assert.strictEqual(r.byteOffset(), 11);
});

test('CXFORM: no terms gives identity and occupies one byte', () => {
  const r = at(0x00, 0x00);
  const cx = r.readCxformWithAlpha();
  assert.strictEqual(cx.alphaMult, 256);
  assert.strictEqual(cx.redAdd, 0);
  assert.strictEqual(r.byteOffset(), 1);
});

// ---- Bit-level primitives ------------------------------------------------------------------------------

test('UB/SB/FB: widths 0, 1 and 32 and sign extension', () => {
  let r = at(0xff, 0xff, 0xff, 0xff);
  assert.strictEqual(r.readUB(0), 0);
  assert.strictEqual(r.readSB(0), 0);
  assert.strictEqual(r.readUB(32), 4294967295);
  r = at(0xff, 0xff, 0xff, 0xff);
  assert.strictEqual(r.readSB(32), -1);
  r = at(0x80);
  assert.strictEqual(r.readSB(1), -1);
  assert.strictEqual(r.readSB(1), 0);
  r = at(0x00, 0x01, 0x00, 0x00);
  assert.strictEqual(r.readFB(32), 1);
  r = at(0x80, 0x00, 0x00);
  assert.strictEqual(r.readFB(17), -1, '17-bit 1000…0 is -65536 → -1.0');
  r = at(0x7f, 0xff, 0xff, 0xff);
  assert.strictEqual(r.readSB(32), 2147483647);
});

test('UB: fields that span byte boundaries, MSB first', () => {
  let r = at(0b10110011, 0b01011100);
  assert.strictEqual(r.readUB(3), 0b101);
  assert.strictEqual(r.readUB(7), 0b1001101); // 10011 + 01
  assert.strictEqual(r.readSB(6), 28);        // 011100
  r = at(0b00000111, 0b10000000);
  assert.strictEqual(r.readUB(5), 0);
  assert.strictEqual(r.readSB(5), -2);        // 111 + 10 = 11110
});

test('align() and byte-aligned reads after a partial bit field', () => {
  const r = at(0b11100000, 0x34, 0x12, 0x78, 0x56, 0x34, 0x12, 0xff);
  assert.strictEqual(r.readUB(3), 7);
  assert.strictEqual(r.readUI16(), 0x1234, 'UI16 aligns to byte 1 first');
  assert.strictEqual(r.readUI32(), 0x12345678);
  assert.strictEqual(r.readUI8(), 0xff);
  assert.strictEqual(r.remainingBytes(), 0);
});

test('reads never cross the reader end, even if the buffer continues', () => {
  const bytes = Uint8Array.from([0xff, 0xff, 0xff]);
  const r = new BitReader(bytes, 0, 1);
  assert.strictEqual(r.readUB(8), 255);
  throwsWithCode(() => r.readUB(1), 'TRUNCATED_DATA');
  throwsWithCode(() => new BitReader(bytes, 1, 2).readUI16(), 'TRUNCATED_DATA');
  throwsWithCode(() => new BitReader(bytes, 0, 1).readUB(9), 'TRUNCATED_DATA');
});

test('truncated records report TRUNCATED_DATA with a byte offset', () => {
  // HasScale=1, NScaleBits=31 and nothing else.
  const r = at(0xff);
  assert.throws(() => r.readMatrix(), (err) => err.code === 'TRUNCATED_DATA' && /MATRIX\.ScaleX/.test(err.message) && err.offset === 0);
  throwsWithCode(() => at(0xf8).readRect(), 'TRUNCATED_DATA');
  throwsWithCode(() => at(0xff).readCxformWithAlpha(), 'TRUNCATED_DATA');
});

test('invalid widths and ranges are rejected', () => {
  throwsWithCode(() => at(0, 0, 0, 0, 0).readUB(33), 'BAD_BIT_COUNT');
  throwsWithCode(() => at(0).readUB(-1), 'BAD_BIT_COUNT');
  throwsWithCode(() => at(0).readSB(1.5), 'BAD_BIT_COUNT');
  throwsWithCode(() => new BitReader(new Uint8Array(4), 3, 2), 'INVALID_RANGE');
  throwsWithCode(() => new BitReader(new Uint8Array(4), 0, 5), 'INVALID_RANGE');
  throwsWithCode(() => new BitReader([1, 2, 3]), 'INVALID_INPUT');
});

test('STRING: UTF-8 from SWF 6, Latin-1 before, terminator required', () => {
  const utf8 = Uint8Array.from([0x63, 0x6c, 0x69, 0x70, 0x5f, 0xc3, 0xb1, 0x00, 0x2a]);
  const r6 = new BitReader(utf8);
  assert.strictEqual(r6.readString(6), 'clip_ñ');
  assert.strictEqual(r6.readUI8(), 0x2a);
  assert.strictEqual(new BitReader(Uint8Array.from([0xe9, 0x00])).readString(5), 'é');
  assert.strictEqual(new BitReader(Uint8Array.from([0x00])).readString(10), '');
  throwsWithCode(() => new BitReader(Uint8Array.from([0x61, 0x62])).readString(10), 'TRUNCATED_DATA');
});

// ---- Round trip against the independent test writer --------------------------------------------------

function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

test('round trip: 300 random RECT/MATRIX/CXFORM/CXFORMWITHALPHA records (seeded)', () => {
  const rand = prng(20261027);
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const fixed = () => int(-0x7fffff, 0x7fffff) / 65536;
  for (let i = 0; i < 300; i++) {
    const w = new BitWriter();
    const box = { xMin: int(-(2 ** 20), 2 ** 20), xMax: int(-(2 ** 20), 2 ** 20), yMin: int(-(2 ** 20), 2 ** 20), yMax: int(-(2 ** 20), 2 ** 20) };
    const m = {};
    if (rand() < 0.6) { m.scaleX = fixed(); m.scaleY = fixed(); }
    if (rand() < 0.4) { m.rotateSkew0 = fixed(); m.rotateSkew1 = fixed(); }
    if (rand() < 0.8) { m.translateX = int(-(2 ** 24), 2 ** 24); m.translateY = int(-(2 ** 24), 2 ** 24); }
    const term = () => int(-16384, 16383); // CXFORM Nbits is UB[4]: at most SB[15]
    const cx = {}, cxa = {};
    if (rand() < 0.7) cx.mult = [term(), term(), term()];
    if (rand() < 0.7) cx.add = [term(), term(), term()];
    if (rand() < 0.7) cxa.mult = [term(), term(), term(), term()];
    if (rand() < 0.7) cxa.add = [term(), term(), term(), term()];
    w.bit(rand() < 0.5); // start unaligned: every record must re-align on its own
    rect(w, box); matrix(w, m); cxform(w, cx, false); cxform(w, cxa, true);
    const r = new BitReader(w.bytes());
    r.readUB(1);
    const gotRect = r.readRect();
    assert.deepStrictEqual([gotRect.xMin, gotRect.xMax, gotRect.yMin, gotRect.yMax], [box.xMin, box.xMax, box.yMin, box.yMax]);
    const gotM = r.readMatrix();
    assert.strictEqual(gotM.hasScale, m.scaleX !== undefined);
    assert.strictEqual(gotM.scaleX, m.scaleX === undefined ? 1 : m.scaleX);
    assert.strictEqual(gotM.scaleY, m.scaleY === undefined ? 1 : m.scaleY);
    assert.strictEqual(gotM.rotateSkew0, m.rotateSkew0 || 0);
    assert.strictEqual(gotM.rotateSkew1, m.rotateSkew1 || 0);
    assert.strictEqual(gotM.translateX, m.translateX || 0);
    assert.strictEqual(gotM.translateY, m.translateY || 0);
    const gotCx = r.readCxform(), gotCxa = r.readCxformWithAlpha();
    const channels = ['red', 'green', 'blue', 'alpha'];
    [[cx, gotCx, 3], [cxa, gotCxa, 4]].forEach(([want, got, n]) => {
      for (let c = 0; c < n; c++) {
        assert.strictEqual(got[channels[c] + 'Mult'], want.mult ? want.mult[c] : 256);
        assert.strictEqual(got[channels[c] + 'Add'], want.add ? want.add[c] : 0);
      }
      assert.strictEqual('alphaMult' in got, n === 4);
    });
    assert.strictEqual(r.remainingBytes(), 0, 'case ' + i + ' consumed every byte');
  }
});
