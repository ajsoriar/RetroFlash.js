'use strict';
// Test-only SWF writer used to generate the project's own fixtures. Independent from the reader on purpose:
// it writes bits with a separate implementation so reader and writer cannot share a decoding bug.
const zlib = require('zlib');

class BitWriter {
  constructor() { this.out = []; this.cur = 0; this.nbits = 0; }
  bit(b) {
    this.cur = (this.cur << 1) | (b ? 1 : 0);
    if (++this.nbits === 8) { this.out.push(this.cur); this.cur = 0; this.nbits = 0; }
    return this;
  }
  ub(count, value) {
    if (!Number.isInteger(value) || value < 0 || value >= 2 ** count) throw new RangeError(`UB[${count}] cannot hold ${value}`);
    for (let i = count - 1; i >= 0; i--) this.bit(Math.floor(value / 2 ** i) % 2);
    return this;
  }
  sb(count, value) {
    if (count === 0) {
      if (value !== 0) throw new RangeError(`SB[0] cannot hold ${value}`);
      return this;
    }
    if (!Number.isInteger(value) || value < -(2 ** (count - 1)) || value >= 2 ** (count - 1)) throw new RangeError(`SB[${count}] cannot hold ${value}`);
    return this.ub(count, value < 0 ? value + 2 ** count : value);
  }
  fb(count, value) { return this.sb(count, Math.round(value * 65536)); }
  align() { while (this.nbits) this.bit(0); return this; }
  u8(v) { this.align(); this.out.push(v & 0xff); return this; }
  u16(v) { return this.u8(v).u8(v >>> 8); }
  u32(v) { return this.u16(v & 0xffff).u16(Math.floor(v / 65536)); }
  raw(bytes) { this.align(); for (const b of bytes) this.out.push(b); return this; }
  string(text) { return this.raw(Buffer.from(text, 'utf8')).u8(0); }
  rgb({ r, g, b }) { return this.u8(r).u8(g).u8(b); }
  bytes() { this.align(); return Uint8Array.from(this.out); }
}

// Smallest SB width that holds every value (0 when all are zero).
function signedBits(...values) {
  if (values.every((v) => v === 0)) return 0;
  let n = 1;
  while (values.some((v) => v < -(2 ** (n - 1)) || v >= 2 ** (n - 1))) n++;
  return n;
}

function rect(w, { xMin = 0, xMax, yMin = 0, yMax, nBits }) {
  const n = nBits === undefined ? signedBits(xMin, xMax, yMin, yMax) : nBits;
  w.align().ub(5, n).sb(n, xMin).sb(n, xMax).sb(n, yMin).sb(n, yMax);
  return w.align();
}

function matrix(w, m = {}) {
  w.align();
  if (m.scaleX !== undefined) {
    const n = signedBits(Math.round(m.scaleX * 65536), Math.round(m.scaleY * 65536));
    w.bit(1).ub(5, n).fb(n, m.scaleX).fb(n, m.scaleY);
  } else w.bit(0);
  if (m.rotateSkew0 !== undefined) {
    const n = signedBits(Math.round(m.rotateSkew0 * 65536), Math.round(m.rotateSkew1 * 65536));
    w.bit(1).ub(5, n).fb(n, m.rotateSkew0).fb(n, m.rotateSkew1);
  } else w.bit(0);
  const tx = m.translateX || 0, ty = m.translateY || 0, n = signedBits(tx, ty);
  w.ub(5, n).sb(n, tx).sb(n, ty);
  return w.align();
}

// c: { mult: [r, g, b(, a)], add: [r, g, b(, a)] } raw integers (mult 256 = 1.0).
function cxform(w, c, withAlpha) {
  const count = withAlpha ? 4 : 3;
  const terms = [...(c.mult || []), ...(c.add || [])];
  const n = signedBits(...terms);
  w.align().bit(c.add ? 1 : 0).bit(c.mult ? 1 : 0).ub(4, n);
  for (const list of [c.mult, c.add]) {
    if (!list) continue;
    if (list.length !== count) throw new RangeError('wrong number of colour terms');
    for (const v of list) w.sb(n, v);
  }
  return w.align();
}

function body(fn) { const w = new BitWriter(); fn(w); return w.bytes(); }

// RECORDHEADER + body. `long` forces the 6-byte form; `length` overrides the declared length.
function tag(code, data = new Uint8Array(0), { long = false, length } = {}) {
  const declared = length === undefined ? data.length : length;
  const w = new BitWriter();
  if (long || declared >= 0x3f) w.u16((code << 6) | 0x3f).u32(declared);
  else w.u16((code << 6) | declared);
  return Buffer.concat([w.bytes(), Buffer.from(data)]);
}

const T = {
  End: 0, ShowFrame: 1, DefineShape: 2, PlaceObject: 4, RemoveObject: 5, SetBackgroundColor: 9, DoAction: 12,
  PlaceObject2: 26, RemoveObject2: 28, DefineSprite: 39, FrameLabel: 43, DoInitAction: 59,
  FileAttributes: 69, PlaceObject3: 70, DoABC: 82
};

const STAGE_550x400 = { xMax: 11000, yMax: 8000 };

// Header body after the 8-byte prefix: RECT, FrameRate (8.8), FrameCount, tags.
function movieBody({ stage = STAGE_550x400, fps = 24, frameCount = 1, tags = [] }) {
  const w = new BitWriter();
  rect(w, stage);
  w.u16(Math.round(fps * 256)).u16(frameCount);
  return Buffer.concat([Buffer.from(w.bytes()), ...tags.map((t) => Buffer.from(t))]);
}

// Full file. declaredLength defaults to the real uncompressed length; `append` adds bytes after the result.
function swf({ signature = 'FWS', version = 10, declaredLength, append, ...rest }) {
  const content = movieBody(rest);
  const prefix = new BitWriter().raw(Buffer.from(signature, 'latin1')).u8(version)
    .u32(declaredLength === undefined ? 8 + content.length : declaredLength).bytes();
  const payload = signature === 'CWS' ? zlib.deflateSync(content) : content;
  return new Uint8Array(Buffer.concat([Buffer.from(prefix), payload, Buffer.from(append || [])]));
}

module.exports = { BitWriter, signedBits, rect, matrix, cxform, body, tag, T, swf, movieBody, STAGE_550x400 };
