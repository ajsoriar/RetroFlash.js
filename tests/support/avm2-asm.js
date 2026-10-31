'use strict';
// Test-only ABC (AVM2 bytecode) writer for hand-built ActionScript 3 fixtures. Independent from src/avm2/abc.js on
// purpose, so the writer and the parser cannot share a decoding bug. Layout from the AVM2 overview.

const NS = { PACKAGE: 0x16, PACKAGE_INTERNAL: 0x17, PRIVATE: 0x05, PROTECTED: 0x18 };
const TRAIT = { slot: 0, method: 1, getter: 2, setter: 3, class: 4, function: 5, const: 6 };

// Instruction name -> [opcode, operand kinds]: u u30, b u8, s s8 (pushbyte), j branch label.
const OPS = {
  throw: [0x03], nop: [0x02], label: [0x09], kill: [0x08, 'u'],
  ifnlt: [0x0c, 'j'], ifnle: [0x0d, 'j'], ifngt: [0x0e, 'j'], ifnge: [0x0f, 'j'], jump: [0x10, 'j'], iftrue: [0x11, 'j'],
  iffalse: [0x12, 'j'], ifeq: [0x13, 'j'], ifne: [0x14, 'j'], iflt: [0x15, 'j'], ifle: [0x16, 'j'], ifgt: [0x17, 'j'],
  ifge: [0x18, 'j'], ifstricteq: [0x19, 'j'], ifstrictne: [0x1a, 'j'],
  popscope: [0x1d], pushnull: [0x20], pushundefined: [0x21], pushbyte: [0x24, 's'], pushshort: [0x25, 'u'],
  pushtrue: [0x26], pushfalse: [0x27], pushnan: [0x28], pop: [0x29], dup: [0x2a], swap: [0x2b], pushstring: [0x2c, 'u'],
  pushint: [0x2d, 'u'], pushdouble: [0x2f, 'u'], pushscope: [0x30], newfunction: [0x40, 'u'], call: [0x41, 'u'],
  construct: [0x42, 'u'], callproperty: [0x46, 'uu'], returnvoid: [0x47], returnvalue: [0x48], constructsuper: [0x49, 'u'],
  constructprop: [0x4a, 'uu'], callproplex: [0x4c, 'uu'], callpropvoid: [0x4f, 'uu'], newobject: [0x55, 'u'], newarray: [0x56, 'u'],
  newclass: [0x58, 'u'], findpropstrict: [0x5d, 'u'], findproperty: [0x5e, 'u'], getlex: [0x60, 'u'], setproperty: [0x61, 'u'],
  getlocal: [0x62, 'u'], setlocal: [0x63, 'u'], getglobalscope: [0x64], getscopeobject: [0x65, 'b'], getproperty: [0x66, 'u'],
  initproperty: [0x68, 'u'], getslot: [0x6c, 'u'], setslot: [0x6d, 'u'], convert_s: [0x70], convert_i: [0x73], convert_d: [0x75],
  coerce: [0x80, 'u'], coerce_a: [0x82], coerce_s: [0x85], astypelate: [0x87], negate: [0x90], increment: [0x91],
  inclocal: [0x92, 'u'], decrement: [0x93], typeof: [0x95], not: [0x96], add: [0xa0], subtract: [0xa1], multiply: [0xa2],
  divide: [0xa3], modulo: [0xa4], equals: [0xab], strictequals: [0xac], lessthan: [0xad], greaterthan: [0xaf],
  istypelate: [0xb3], add_i: [0xc5], getlocal0: [0xd0], getlocal1: [0xd1], getlocal2: [0xd2], getlocal3: [0xd3],
  setlocal0: [0xd4], setlocal1: [0xd5], setlocal2: [0xd6], setlocal3: [0xd7], debugline: [0xf0, 'u']
};

function u30(out, v) {
  if (!Number.isInteger(v) || v < 0) throw new RangeError('u30 cannot hold ' + v);
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
}
function s24(out, v) { out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff); }

/* Assembles [name, ...operands] instructions and { label } markers. Branch operands are label names. */
function assemble(code) {
  const out = [], labels = new Map(), fixups = [];
  for (const ins of code) {
    if (!Array.isArray(ins)) { labels.set(ins.label, out.length); continue; }
    const [name, ...args] = ins, spec = OPS[name];
    if (!spec) throw new Error('unknown instruction ' + name);
    out.push(spec[0]);
    [...(spec[1] || '')].forEach((kind, i) => {
      if (kind === 'u') u30(out, args[i]);
      else if (kind === 'b') out.push(args[i] & 0xff);
      else if (kind === 's') out.push(args[i] & 0xff);
      else if (kind === 'j') { fixups.push({ at: out.length, label: args[i] }); s24(out, 0); }
    });
  }
  for (const f of fixups) {
    if (!labels.has(f.label)) throw new Error('unknown label ' + f.label);
    const offset = labels.get(f.label) - (f.at + 3), b = [];
    s24(b, offset);
    out.splice(f.at, 3, ...b);
  }
  return out;
}

/* Builds one ABC block. Pool entries are deduplicated; methods, classes and scripts are added in order.
   Names: qname(pkg, name, kind?) for a QName, multiname(name, [namespace indices]) for a Multiname. */
class AbcBuilder {
  constructor() {
    this.strings = ['']; this.namespaces = [null]; this.nsSets = [null]; this.multinames = [null];
    this.ints = [0]; this.doubles = [0]; this.methods = []; this.bodies = []; this.instances = []; this.classes = []; this.scripts = [];
  }
  pool(list, key, value) {
    const i = list.findIndex((e, n) => n > 0 && JSON.stringify(e) === key);
    if (i > 0) return i;
    list.push(value);
    return list.length - 1;
  }
  string(s) { const i = this.strings.indexOf(s, 1); if (i > 0) return i; this.strings.push(s); return this.strings.length - 1; }
  int(v) { const i = this.ints.indexOf(v, 1); if (i > 0) return i; this.ints.push(v); return this.ints.length - 1; }
  double(v) { this.doubles.push(v); return this.doubles.length - 1; }
  ns(uri, kind = NS.PACKAGE) { const e = [kind, this.string(uri)]; return this.pool(this.namespaces, JSON.stringify(e), e); }
  nsSet(list) { return this.pool(this.nsSets, JSON.stringify(list), list); }
  qname(pkg, name, kind = NS.PACKAGE) { const e = [0x07, this.ns(pkg, kind), this.string(name)]; return this.pool(this.multinames, JSON.stringify(e), e); }
  multiname(name, namespaces) { const e = [0x09, this.string(name), this.nsSet(namespaces)]; return this.pool(this.multinames, JSON.stringify(e), e); }
  // A Multiname over the public namespace and package `pkg` (what compilers emit for unqualified names).
  name(name, pkg = '') { return this.multiname(name, [...new Set([this.ns(''), this.ns(pkg), this.ns(pkg, NS.PACKAGE_INTERNAL)])]); }
  /* A method with a body: `code` is instructions for assemble(), or raw bytes (numbers). opts: { params, flags,
     localCount, maxStack, initScope, maxScope, exceptions }. */
  method(code, opts = {}) {
    const index = this.methods.length;
    this.methods.push({ params: opts.params || 0, flags: opts.flags || 0, name: opts.name ? this.string(opts.name) : 0 });
    if (code) {
      this.bodies.push({
        method: index, maxStack: opts.maxStack || 8, localCount: opts.localCount || (opts.params || 0) + 1,
        initScope: opts.initScope || 0, maxScope: opts.maxScope || 16, code: typeof code[0] === 'number' ? code : assemble(code),
        exceptions: opts.exceptions || []
      });
    }
    return index;
  }
  // traits: [{ kind: 'slot' | 'method' | 'class' | ..., name (multiname index), type?, slotId?, method?, cls? }]
  klass({ name, superName = 0, flags = 0x08, protectedNs, iinit, cinit, itraits = [], ctraits = [] }) {
    this.instances.push({ name, superName, flags, protectedNs: protectedNs || this.ns(this.strings[this.multinames[name][2]], NS.PROTECTED), iinit, traits: itraits });
    this.classes.push({ cinit, traits: ctraits });
    return this.classes.length - 1;
  }
  script(init, traits) { this.scripts.push({ init, traits }); return this.scripts.length - 1; }
  bytes() {
    const out = [];
    out.push(16, 0, 46, 0); // minor 16, major 46
    const counted = (list, write) => { u30(out, list.length <= 1 ? 0 : list.length); list.slice(1).forEach(write); };
    counted(this.ints, (v) => u30(out, v >>> 0));
    u30(out, 0); // uints
    counted(this.doubles, (v) => { const b = Buffer.alloc(8); b.writeDoubleLE(v); out.push(...b); });
    counted(this.strings, (s) => { const b = Buffer.from(s, 'utf8'); u30(out, b.length); out.push(...b); });
    counted(this.namespaces, ([kind, name]) => { out.push(kind); u30(out, name); });
    counted(this.nsSets, (set) => { u30(out, set.length); set.forEach((n) => u30(out, n)); });
    counted(this.multinames, ([kind, a, b]) => { out.push(kind); u30(out, a); u30(out, b); });
    u30(out, this.methods.length);
    this.methods.forEach((m) => { u30(out, m.params); u30(out, 0); for (let i = 0; i < m.params; i++) u30(out, 0); u30(out, m.name); out.push(m.flags); });
    u30(out, 0); // metadata
    const traits = (list) => {
      u30(out, list.length);
      list.forEach((t) => {
        u30(out, t.name);
        out.push(TRAIT[t.kind]);
        if (t.kind === 'slot' || t.kind === 'const') { u30(out, t.slotId || 0); u30(out, t.type || 0); u30(out, 0); }
        else if (t.kind === 'class') { u30(out, t.slotId || 0); u30(out, t.cls); }
        else if (t.kind === 'function') { u30(out, t.slotId || 0); u30(out, t.method); }
        else { u30(out, t.dispId || 0); u30(out, t.method); }
      });
    };
    u30(out, this.classes.length);
    this.instances.forEach((inst) => {
      u30(out, inst.name); u30(out, inst.superName); out.push(inst.flags);
      if (inst.flags & 0x08) u30(out, inst.protectedNs);
      u30(out, 0); // interfaces
      u30(out, inst.iinit);
      traits(inst.traits);
    });
    this.classes.forEach((c) => { u30(out, c.cinit); traits(c.traits); });
    u30(out, this.scripts.length);
    this.scripts.forEach((s) => { u30(out, s.init); traits(s.traits); });
    u30(out, this.bodies.length);
    this.bodies.forEach((b) => {
      [b.method, b.maxStack, b.localCount, b.initScope, b.maxScope].forEach((v) => u30(out, v));
      u30(out, b.code.length);
      out.push(...b.code);
      u30(out, b.exceptions.length);
      b.exceptions.forEach((e) => [e.from, e.to, e.target, e.type || 0, e.name || 0].forEach((v) => u30(out, v)));
      u30(out, 0); // traits
    });
    return Uint8Array.from(out);
  }
}

/* A timeline class as Flash authoring tools write it: `pkg.name extends flash.display.MovieClip`, its slots
   (stage instances), its methods ({ name: code }), and a constructor that calls super() then addFrameScript for
   `frames` ({ 0-based frame index: method name }). Its script defines the class. Returns the class's QName index. */
function timelineClass(abc, { pkg = '', name, slots = [], methods = {}, frames = {}, superClass = ['flash.display', 'MovieClip'] }) {
  const className = abc.qname(pkg, name);
  const methodName = (n) => abc.qname(pkg, n, NS.PACKAGE_INTERNAL);
  const itraits = slots.map(([slot, typePkg, type]) => ({ kind: 'slot', name: abc.qname('', slot), type: abc.qname(typePkg, type) }));
  for (const [n, code] of Object.entries(methods)) {
    itraits.push({ kind: 'method', name: methodName(n), method: abc.method([['getlocal0'], ['pushscope'], ...code], { params: n.startsWith('on') ? 1 : 0, name: n }) });
  }
  const frameCode = [];
  for (const [index, n] of Object.entries(frames)) frameCode.push(['pushbyte', Number(index)], ['getlex', methodName(n)]);
  const iinit = abc.method([
    ['getlocal0'], ['pushscope'], ['getlocal0'], ['constructsuper', 0],
    ...(frameCode.length ? [['findpropstrict', abc.name('addFrameScript', pkg)], ...frameCode, ['callpropvoid', abc.name('addFrameScript', pkg), frameCode.length]] : []),
    ['returnvoid']
  ], { name: name });
  const cinit = abc.method([['getlocal0'], ['pushscope'], ['returnvoid']]);
  const base = abc.qname(superClass[0], superClass[1]);
  const cls = abc.klass({ name: className, superName: base, iinit, cinit, itraits });
  const init = abc.method([
    ['getlocal0'], ['pushscope'], ['getscopeobject', 0], ['getlex', base], ['pushscope'], ['getlex', base], ['newclass', cls], ['popscope'],
    ['initproperty', className], ['returnvoid']
  ]);
  abc.script(init, [{ kind: 'class', name: className, cls, slotId: 1 }]);
  return className;
}

module.exports = { AbcBuilder, assemble, timelineClass, NS, OPS, u30 };
