/* RetroFlash.js - ABC (ActionScript Byte Code) files: the AVM2 code of DoABC tags, parsed and checked before
   anything runs. Layout from the AVM2 overview (abcFile, cpool_info, method_info, instance_info, ...). */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;

  function abcError(message, offset) {
    var err = new Error('ABC: ' + message + (offset !== undefined ? ' (byte ' + offset + ')' : ''));
    err.name = 'AbcError';
    err.code = 'AVM2_ABC_INVALID';
    return err;
  }

  // Namespace kinds and multiname kinds of the constant pool.
  var NS = { NAMESPACE: 0x08, PACKAGE: 0x16, PACKAGE_INTERNAL: 0x17, PROTECTED: 0x18, EXPLICIT: 0x19, STATIC_PROTECTED: 0x1a, PRIVATE: 0x05 };
  var MN = {
    QNAME: 0x07, QNAME_A: 0x0d, RTQNAME: 0x0f, RTQNAME_A: 0x10, RTQNAME_L: 0x11, RTQNAME_LA: 0x12,
    MULTINAME: 0x09, MULTINAME_A: 0x0e, MULTINAME_L: 0x1b, MULTINAME_LA: 0x1c, TYPENAME: 0x1d
  };
  var TRAIT = { SLOT: 0, METHOD: 1, GETTER: 2, SETTER: 3, CLASS: 4, FUNCTION: 5, CONST: 6 };
  var METHOD_FLAGS = { NEED_ARGUMENTS: 0x01, NEED_ACTIVATION: 0x02, NEED_REST: 0x04, HAS_OPTIONAL: 0x08, SET_DXNS: 0x40, HAS_PARAM_NAMES: 0x80 };
  var CLASS_FLAGS = { SEALED: 0x01, FINAL: 0x02, INTERFACE: 0x04, PROTECTED_NS: 0x08 };

  // Reads the variable-length integers and strings of an ABC block, never past `end`.
  function AbcReader(bytes, start, end) {
    this.bytes = bytes;
    this.pos = start || 0;
    this.end = end === undefined ? bytes.length : end;
  }
  AbcReader.prototype.need = function (n, what) {
    if (this.pos + n > this.end) throw abcError('truncated ' + what, this.pos);
  };
  AbcReader.prototype.u8 = function (what) {
    this.need(1, what);
    return this.bytes[this.pos++];
  };
  AbcReader.prototype.u16 = function (what) {
    this.need(2, what);
    var v = this.bytes[this.pos] | (this.bytes[this.pos + 1] << 8);
    this.pos += 2;
    return v;
  };
  AbcReader.prototype.s24 = function (what) {
    this.need(3, what);
    var b = this.bytes, v = b[this.pos] | (b[this.pos + 1] << 8) | (b[this.pos + 2] << 16);
    this.pos += 3;
    return (v << 8) >> 8;
  };
  // u32 in 1-5 bytes, 7 bits each, low bits first.
  AbcReader.prototype.u32 = function (what) {
    var result = 0, shift = 0;
    for (var i = 0; i < 5; i++) {
      var b = this.u8(what);
      result += (b & 0x7f) * Math.pow(2, shift);
      if (!(b & 0x80)) break;
      shift += 7;
    }
    return result % 4294967296;
  };
  AbcReader.prototype.u30 = function (what) {
    var v = this.u32(what);
    if (v > 0x3fffffff) throw abcError(what + ' does not fit in 30 bits', this.pos);
    return v;
  };
  AbcReader.prototype.s32 = function (what) { return this.u32(what) | 0; };
  AbcReader.prototype.d64 = function (what) {
    this.need(8, what);
    var view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 8);
    this.pos += 8;
    return view.getFloat64(0, true);
  };
  AbcReader.prototype.utf8 = function (length, what) {
    this.need(length, what);
    var bytes = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return decodeUtf8(bytes);
  };
  // A count of entries that each take at least `min` bytes: larger than what is left means a hostile length.
  AbcReader.prototype.count = function (what, min) {
    var n = this.u30(what);
    if (n * (min || 1) > this.end - this.pos) throw abcError(what + ' (' + n + ') exceeds the bytes left', this.pos);
    return n;
  };

  function decodeUtf8(bytes) {
    if (typeof TextDecoder === 'function') return new TextDecoder('utf-8').decode(bytes);
    var out = '';
    for (var i = 0; i < bytes.length;) {
      var c = bytes[i++];
      if (c >= 0xc0 && c < 0xe0 && i < bytes.length) c = ((c & 0x1f) << 6) | (bytes[i++] & 0x3f);
      else if (c >= 0xe0 && c < 0xf0 && i + 1 < bytes.length) { c = ((c & 0x0f) << 12) | ((bytes[i] & 0x3f) << 6) | (bytes[i + 1] & 0x3f); i += 2; }
      else if (c >= 0xf0 && i + 2 < bytes.length) { c = ((c & 0x07) << 18) | ((bytes[i] & 0x3f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f); i += 3; }
      out += String.fromCodePoint(c);
    }
    return out;
  }

  // ---- Constant pool ----
  function readConstantPool(r) {
    var pool = { ints: [0], uints: [0], doubles: [NaN], strings: [null], namespaces: [null], nsSets: [null], multinames: [null] };
    var i, n;
    n = r.count('int count');
    for (i = 1; i < n; i++) pool.ints.push(r.s32('int constant'));
    n = r.count('uint count');
    for (i = 1; i < n; i++) pool.uints.push(r.u32('uint constant'));
    n = r.count('double count', 8);
    for (i = 1; i < n; i++) pool.doubles.push(r.d64('double constant'));
    n = r.count('string count');
    for (i = 1; i < n; i++) pool.strings.push(r.utf8(r.u30('string length'), 'string'));
    n = r.count('namespace count', 2);
    for (i = 1; i < n; i++) {
      var kind = r.u8('namespace kind'), name = r.u30('namespace name');
      pool.namespaces.push({ kind: kind, nameIndex: name, uri: null });
    }
    n = r.count('namespace set count');
    for (i = 1; i < n; i++) {
      var size = r.count('namespace set size'), set = [];
      for (var k = 0; k < size; k++) set.push(r.u30('namespace set entry'));
      pool.nsSets.push(set);
    }
    n = r.count('multiname count');
    for (i = 1; i < n; i++) pool.multinames.push(readMultiname(r));
    return pool;
  }
  function readMultiname(r) {
    var kind = r.u8('multiname kind'), mn = { kind: kind, ns: 0, name: 0, nsSet: 0, attribute: false };
    switch (kind) {
      case MN.QNAME_A: mn.attribute = true; /* falls through */
      case MN.QNAME: mn.ns = r.u30('QName namespace'); mn.name = r.u30('QName name'); break;
      case MN.RTQNAME_A: mn.attribute = true; /* falls through */
      case MN.RTQNAME: mn.name = r.u30('RTQName name'); mn.runtimeNs = true; break;
      case MN.RTQNAME_LA: mn.attribute = true; /* falls through */
      case MN.RTQNAME_L: mn.runtimeNs = true; mn.runtimeName = true; break;
      case MN.MULTINAME_A: mn.attribute = true; /* falls through */
      case MN.MULTINAME: mn.name = r.u30('Multiname name'); mn.nsSet = r.u30('Multiname namespace set'); break;
      case MN.MULTINAME_LA: mn.attribute = true; /* falls through */
      case MN.MULTINAME_L: mn.runtimeName = true; mn.nsSet = r.u30('MultinameL namespace set'); break;
      case MN.TYPENAME:
        mn.qname = r.u30('TypeName name');
        var count = r.count('TypeName parameter count');
        mn.params = [];
        for (var i = 0; i < count; i++) mn.params.push(r.u30('TypeName parameter'));
        break;
      default: throw abcError('unknown multiname kind 0x' + kind.toString(16), r.pos - 1);
    }
    return mn;
  }
  // Index checks, then the pool's indices are replaced by the objects they name.
  function resolveConstantPool(pool) {
    function index(list, i, what) {
      if (!(i >= 0 && i < list.length)) throw abcError(what + ' index ' + i + ' is outside its pool (' + list.length + ')');
      return list[i];
    }
    pool.namespaces.forEach(function (ns, i) {
      if (!ns) return;
      var name = index(pool.strings, ns.nameIndex, 'namespace name');
      ns.uri = name === null ? '' : name;
      ns.id = i;
    });
    pool.nsSets = pool.nsSets.map(function (set) {
      return set && set.map(function (i) {
        var ns = index(pool.namespaces, i, 'namespace set entry');
        if (!ns) throw abcError('a namespace set holds namespace 0');
        return ns;
      });
    });
    pool.multinames.forEach(function (mn) {
      if (!mn) return;
      if (mn.kind === MN.TYPENAME) {
        mn.qname = index(pool.multinames, mn.qname, 'TypeName name');
        mn.params = mn.params.map(function (p) { return index(pool.multinames, p, 'TypeName parameter'); });
        mn.name = mn.qname ? mn.qname.name : null;
        mn.namespaces = mn.qname ? mn.qname.namespaces : [];
        return;
      }
      mn.name = mn.runtimeName ? null : index(pool.strings, mn.name, 'multiname name'); // null: any name (*)
      if (mn.kind === MN.QNAME || mn.kind === MN.QNAME_A) {
        var ns = index(pool.namespaces, mn.ns, 'QName namespace');
        mn.namespaces = ns ? [ns] : null; // null: any namespace (*)
      } else if (mn.nsSet) {
        mn.namespaces = index(pool.nsSets, mn.nsSet, 'multiname namespace set');
        if (!mn.namespaces) throw abcError('a multiname uses namespace set 0');
      } else if (!mn.runtimeNs) {
        throw abcError('a multiname uses namespace set 0');
      }
      delete mn.ns;
      delete mn.nsSet;
    });
  }

  // ---- Methods, metadata, traits, classes, scripts and bodies ----
  function readMethod(r, pool) {
    var paramCount = r.count('parameter count'), m = { returnType: r.u30('return type'), paramTypes: [], optional: [], paramNames: null, body: null };
    for (var i = 0; i < paramCount; i++) m.paramTypes.push(r.u30('parameter type'));
    m.nameIndex = r.u30('method name');
    m.flags = r.u8('method flags');
    if (m.flags & METHOD_FLAGS.HAS_OPTIONAL) {
      var optionCount = r.count('option count', 2);
      if (optionCount > paramCount) throw abcError('a method has more optional values than parameters', r.pos);
      for (i = 0; i < optionCount; i++) m.optional.push({ index: r.u30('option value'), kind: r.u8('option kind') });
    }
    if (m.flags & METHOD_FLAGS.HAS_PARAM_NAMES) {
      m.paramNames = [];
      for (i = 0; i < paramCount; i++) m.paramNames.push(r.u30('parameter name'));
    }
    m.paramCount = paramCount;
    return m;
  }
  function readTraits(r) {
    var count = r.count('trait count', 3), traits = [];
    for (var i = 0; i < count; i++) {
      var t = { name: r.u30('trait name') }, tag = r.u8('trait kind');
      t.kind = tag & 0x0f;
      t.attributes = tag >> 4;
      switch (t.kind) {
        case TRAIT.SLOT: case TRAIT.CONST:
          t.slotId = r.u30('slot id');
          t.typeName = r.u30('slot type');
          t.valueIndex = r.u30('slot value');
          if (t.valueIndex) t.valueKind = r.u8('slot value kind');
          break;
        case TRAIT.CLASS: t.slotId = r.u30('slot id'); t.classIndex = r.u30('trait class'); break;
        case TRAIT.FUNCTION: t.slotId = r.u30('slot id'); t.methodIndex = r.u30('trait function'); break;
        case TRAIT.METHOD: case TRAIT.GETTER: case TRAIT.SETTER:
          t.dispId = r.u30('disp id');
          t.methodIndex = r.u30('trait method');
          break;
        default: throw abcError('unknown trait kind ' + t.kind, r.pos - 1);
      }
      if (t.attributes & 0x04) {
        var metadataCount = r.count('trait metadata count');
        t.metadata = [];
        for (var k = 0; k < metadataCount; k++) t.metadata.push(r.u30('trait metadata'));
      }
      traits.push(t);
    }
    return traits;
  }

  /* Parses one ABC block (the bytecode of a DoABC tag) into { major, minor, pool, methods, metadata,
     instances, classes, scripts, bodies }. Every index is checked here, and every method body's code is
     decoded and checked by decodeCode, so a malformed block fails before anything runs. Sizes are bounded by
     the input: a count larger than the bytes left is refused. */
  function parseAbc(bytes, options) {
    options = options || {};
    var maxBytes = options.maxAbcBytes || 16 * 1024 * 1024;
    if (bytes.length > maxBytes) throw abcError('the block is ' + bytes.length + ' bytes; the limit is ' + maxBytes);
    var r = new AbcReader(bytes, 0, bytes.length), abc = {};
    abc.minor = r.u16('minor version');
    abc.major = r.u16('major version');
    if (abc.major !== 46) throw abcError('version ' + abc.major + '.' + abc.minor + ' is not supported (46.x is)');
    var pool = abc.pool = readConstantPool(r);
    var i, n;
    n = r.count('method count', 4);
    abc.methods = [];
    for (i = 0; i < n; i++) abc.methods.push(readMethod(r, pool));
    n = r.count('metadata count', 2);
    abc.metadata = [];
    for (i = 0; i < n; i++) {
      var md = { name: r.u30('metadata name'), items: [] }, itemCount = r.count('metadata item count', 2);
      for (var k = 0; k < itemCount; k++) md.items.push({ key: r.u30('metadata key'), value: r.u30('metadata value') });
      abc.metadata.push(md);
    }
    var classCount = r.count('class count', 6);
    abc.instances = [];
    for (i = 0; i < classCount; i++) {
      var inst = { name: r.u30('instance name'), superName: r.u30('super name'), flags: r.u8('instance flags'), interfaces: [] };
      if (inst.flags & CLASS_FLAGS.PROTECTED_NS) inst.protectedNs = r.u30('protected namespace');
      var interfaceCount = r.count('interface count');
      for (k = 0; k < interfaceCount; k++) inst.interfaces.push(r.u30('interface'));
      inst.init = r.u30('instance initializer');
      inst.traits = readTraits(r);
      abc.instances.push(inst);
    }
    abc.classes = [];
    for (i = 0; i < classCount; i++) abc.classes.push({ init: r.u30('class initializer'), traits: readTraits(r) });
    n = r.count('script count', 2);
    abc.scripts = [];
    for (i = 0; i < n; i++) abc.scripts.push({ init: r.u30('script initializer'), traits: readTraits(r) });
    n = r.count('method body count', 7);
    abc.bodies = [];
    for (i = 0; i < n; i++) {
      var body = {
        method: r.u30('body method'), maxStack: r.u30('max stack'), localCount: r.u30('local count'),
        initScopeDepth: r.u30('init scope depth'), maxScopeDepth: r.u30('max scope depth')
      };
      var codeLength = r.u30('code length');
      r.need(codeLength, 'method code');
      body.codeOffset = r.pos;
      body.code = bytes.subarray(r.pos, r.pos + codeLength);
      r.pos += codeLength;
      var exceptionCount = r.count('exception count', 5);
      body.exceptions = [];
      for (k = 0; k < exceptionCount; k++) {
        body.exceptions.push({ from: r.u30('exception from'), to: r.u30('exception to'), target: r.u30('exception target'), type: r.u30('exception type'), varName: r.u30('exception name') });
      }
      body.traits = readTraits(r);
      abc.bodies.push(body);
    }
    if (r.pos !== r.end) throw abcError((r.end - r.pos) + ' byte(s) after the last method body', r.pos);
    resolve(abc);
    return abc;
  }

  // Index checks across the whole block; indices become the objects they name.
  function resolve(abc) {
    var pool = abc.pool;
    resolveConstantPool(pool);
    function at(list, i, what) {
      if (!(i >= 0 && i < list.length)) throw abcError(what + ' index ' + i + ' is outside its table (' + list.length + ')');
      return list[i];
    }
    function multiname(i, what, allowZero) {
      var mn = at(pool.multinames, i, what);
      if (!mn && !allowZero) throw abcError(what + ' is multiname 0');
      return mn;
    }
    function qname(i, what) {
      var mn = multiname(i, what);
      if (mn.kind !== MN.QNAME && mn.kind !== MN.QNAME_A) throw abcError(what + ' is not a QName');
      return mn;
    }
    function constant(kind, index, what) {
      switch (kind) {
        case 0x03: return { value: at(pool.ints, index, what) };
        case 0x04: return { value: at(pool.uints, index, what) };
        case 0x06: return { value: at(pool.doubles, index, what) };
        case 0x01: return { value: at(pool.strings, index, what) };
        case 0x0b: return { value: true };
        case 0x0a: return { value: false };
        case 0x0c: return { value: null };
        case 0x00: return { value: undefined };
        case 0x08: case 0x16: case 0x17: case 0x18: case 0x19: case 0x1a: case 0x05:
          return { value: at(pool.namespaces, index, what), namespace: true };
        default: throw abcError(what + ' has unknown constant kind 0x' + kind.toString(16));
      }
    }
    abc.methods.forEach(function (m, i) {
      m.index = i;
      m.name = at(pool.strings, m.nameIndex, 'method name') || '';
      m.returnType = multiname(m.returnType, 'method return type', true);
      m.paramTypes = m.paramTypes.map(function (t) { return multiname(t, 'parameter type', true); });
      m.optional = m.optional.map(function (o) { return constant(o.kind, o.index, 'optional parameter'); });
      if (m.paramNames) m.paramNames = m.paramNames.map(function (p) { return at(pool.strings, p, 'parameter name'); });
    });
    function method(i, what) { return at(abc.methods, i, what); }
    function traits(list) {
      var slots = Object.create(null);
      list.forEach(function (t) {
        t.name = qname(t.name, 'trait name');
        if (t.kind === TRAIT.SLOT || t.kind === TRAIT.CONST) {
          t.typeName = multiname(t.typeName, 'slot type', true);
          t.value = t.valueIndex ? constant(t.valueKind, t.valueIndex, 'slot value').value : undefined;
          t.hasValue = !!t.valueIndex;
        } else if (t.kind === TRAIT.CLASS) {
          t.classInfo = at(abc.classes, t.classIndex, 'trait class');
        } else {
          t.method = method(t.methodIndex, 'trait method');
        }
        if (t.slotId !== undefined && t.slotId) {
          if (slots[t.slotId]) throw abcError('two traits use slot ' + t.slotId);
          slots[t.slotId] = true;
        }
        if (t.metadata) t.metadata = t.metadata.map(function (k) { return at(abc.metadata, k, 'trait metadata'); });
      });
      return list;
    }
    abc.metadata.forEach(function (md) {
      md.name = at(pool.strings, md.name, 'metadata name');
      md.items = md.items.map(function (item) { return { key: at(pool.strings, item.key, 'metadata key'), value: at(pool.strings, item.value, 'metadata value') }; });
    });
    abc.instances.forEach(function (inst, i) {
      inst.index = i;
      inst.name = qname(inst.name, 'class name');
      inst.superName = multiname(inst.superName, 'super class', true);
      if (inst.protectedNs !== undefined) inst.protectedNs = at(pool.namespaces, inst.protectedNs, 'protected namespace');
      inst.interfaces = inst.interfaces.map(function (k) { return multiname(k, 'interface'); });
      inst.init = method(inst.init, 'instance initializer');
      inst.traits = traits(inst.traits);
    });
    abc.classes.forEach(function (cls, i) {
      cls.index = i;
      cls.instance = abc.instances[i];
      cls.init = method(cls.init, 'class initializer');
      cls.traits = traits(cls.traits);
    });
    abc.scripts.forEach(function (s, i) {
      s.index = i;
      s.init = method(s.init, 'script initializer');
      s.traits = traits(s.traits);
    });
    abc.bodies.forEach(function (body) {
      var m = method(body.method, 'body method');
      if (m.body) throw abcError('method ' + m.index + ' has two bodies');
      m.body = body;
      body.method = m;
      body.traits = traits(body.traits);
      body.exceptions.forEach(function (e) {
        e.type = multiname(e.type, 'exception type', true);
        e.varName = multiname(e.varName, 'exception variable', true);
      });
      body.instructions = decodeCode(abc, body);
      body.exceptions.forEach(function (e) {
        e.fromIndex = indexAtOrAfter(body, e.from);
        e.toIndex = indexAtOrAfter(body, e.to);
        if (!body.byOffset.has(e.target)) throw abcError('an exception handler starts inside an instruction');
        e.targetIndex = body.byOffset.get(e.target);
      });
    });
  }
  function indexAtOrAfter(body, offset) {
    if (offset > body.code.length) throw abcError('an exception range is outside its method');
    for (var i = 0; i < body.instructions.length; i++) if (body.instructions[i].offset >= offset) return i;
    return body.instructions.length;
  }

  /* Instruction operand layouts. Operand codes: m multiname, s string, i int, u uint, d double, n namespace,
     M method, C class, x u30, b u8, B s8, j s24 branch, a u30 argument count. */
  var OPCODES = {
    0x01: ['bkpt', ''], 0x02: ['nop', ''], 0x03: ['throw', ''], 0x04: ['getsuper', 'm'], 0x05: ['setsuper', 'm'],
    0x06: ['dxns', 's'], 0x07: ['dxnslate', ''], 0x08: ['kill', 'x'], 0x09: ['label', ''],
    0x0c: ['ifnlt', 'j'], 0x0d: ['ifnle', 'j'], 0x0e: ['ifngt', 'j'], 0x0f: ['ifnge', 'j'], 0x10: ['jump', 'j'],
    0x11: ['iftrue', 'j'], 0x12: ['iffalse', 'j'], 0x13: ['ifeq', 'j'], 0x14: ['ifne', 'j'], 0x15: ['iflt', 'j'],
    0x16: ['ifle', 'j'], 0x17: ['ifgt', 'j'], 0x18: ['ifge', 'j'], 0x19: ['ifstricteq', 'j'], 0x1a: ['ifstrictne', 'j'],
    0x1b: ['lookupswitch', '*'], 0x1c: ['pushwith', ''], 0x1d: ['popscope', ''], 0x1e: ['nextname', ''],
    0x1f: ['hasnext', ''], 0x20: ['pushnull', ''], 0x21: ['pushundefined', ''], 0x23: ['nextvalue', ''],
    0x24: ['pushbyte', 'B'], 0x25: ['pushshort', 'x'], 0x26: ['pushtrue', ''], 0x27: ['pushfalse', ''],
    0x28: ['pushnan', ''], 0x29: ['pop', ''], 0x2a: ['dup', ''], 0x2b: ['swap', ''], 0x2c: ['pushstring', 's'],
    0x2d: ['pushint', 'i'], 0x2e: ['pushuint', 'u'], 0x2f: ['pushdouble', 'd'], 0x30: ['pushscope', ''],
    0x31: ['pushnamespace', 'n'], 0x32: ['hasnext2', 'xx'], 0x40: ['newfunction', 'M'], 0x41: ['call', 'a'],
    0x42: ['construct', 'a'], 0x43: ['callmethod', 'xa'], 0x44: ['callstatic', 'Ma'], 0x45: ['callsuper', 'ma'],
    0x46: ['callproperty', 'ma'], 0x47: ['returnvoid', ''], 0x48: ['returnvalue', ''], 0x49: ['constructsuper', 'a'],
    0x4a: ['constructprop', 'ma'], 0x4c: ['callproplex', 'ma'], 0x4e: ['callsupervoid', 'ma'], 0x4f: ['callpropvoid', 'ma'],
    0x53: ['applytype', 'a'], 0x55: ['newobject', 'a'], 0x56: ['newarray', 'a'], 0x57: ['newactivation', ''],
    0x58: ['newclass', 'C'], 0x59: ['getdescendants', 'm'], 0x5a: ['newcatch', 'x'], 0x5d: ['findpropstrict', 'm'],
    0x5e: ['findproperty', 'm'], 0x5f: ['finddef', 'm'], 0x60: ['getlex', 'm'], 0x61: ['setproperty', 'm'],
    0x62: ['getlocal', 'x'], 0x63: ['setlocal', 'x'], 0x64: ['getglobalscope', ''], 0x65: ['getscopeobject', 'b'],
    0x66: ['getproperty', 'm'], 0x68: ['initproperty', 'm'], 0x6a: ['deleteproperty', 'm'], 0x6c: ['getslot', 'x'],
    0x6d: ['setslot', 'x'], 0x6e: ['getglobalslot', 'x'], 0x6f: ['setglobalslot', 'x'], 0x70: ['convert_s', ''],
    0x71: ['esc_xelem', ''], 0x72: ['esc_xattr', ''], 0x73: ['convert_i', ''], 0x74: ['convert_u', ''],
    0x75: ['convert_d', ''], 0x76: ['convert_b', ''], 0x77: ['convert_o', ''], 0x78: ['checkfilter', ''],
    0x80: ['coerce', 'm'], 0x81: ['coerce_b', ''], 0x82: ['coerce_a', ''], 0x83: ['coerce_i', ''], 0x84: ['coerce_d', ''],
    0x85: ['coerce_s', ''], 0x86: ['astype', 'm'], 0x87: ['astypelate', ''], 0x88: ['coerce_u', ''], 0x89: ['coerce_o', ''],
    0x90: ['negate', ''], 0x91: ['increment', ''], 0x92: ['inclocal', 'x'], 0x93: ['decrement', ''], 0x94: ['declocal', 'x'],
    0x95: ['typeof', ''], 0x96: ['not', ''], 0x97: ['bitnot', ''], 0xa0: ['add', ''], 0xa1: ['subtract', ''],
    0xa2: ['multiply', ''], 0xa3: ['divide', ''], 0xa4: ['modulo', ''], 0xa5: ['lshift', ''], 0xa6: ['rshift', ''],
    0xa7: ['urshift', ''], 0xa8: ['bitand', ''], 0xa9: ['bitor', ''], 0xaa: ['bitxor', ''], 0xab: ['equals', ''],
    0xac: ['strictequals', ''], 0xad: ['lessthan', ''], 0xae: ['lessequals', ''], 0xaf: ['greaterthan', ''],
    0xb0: ['greaterequals', ''], 0xb1: ['instanceof', ''], 0xb2: ['istype', 'm'], 0xb3: ['istypelate', ''], 0xb4: ['in', ''],
    0xc0: ['increment_i', ''], 0xc1: ['decrement_i', ''], 0xc2: ['inclocal_i', 'x'], 0xc3: ['declocal_i', 'x'],
    0xc4: ['negate_i', ''], 0xc5: ['add_i', ''], 0xc6: ['subtract_i', ''], 0xc7: ['multiply_i', ''],
    0xd0: ['getlocal_0', ''], 0xd1: ['getlocal_1', ''], 0xd2: ['getlocal_2', ''], 0xd3: ['getlocal_3', ''],
    0xd4: ['setlocal_0', ''], 0xd5: ['setlocal_1', ''], 0xd6: ['setlocal_2', ''], 0xd7: ['setlocal_3', ''],
    0xef: ['debug', 'bxbx'], 0xf0: ['debugline', 'x'], 0xf1: ['debugfile', 's']
  };

  /* Decodes a method body into [{ offset, op, name, args, target? }]. Pool and table operands are resolved
     and checked; branch targets must land on an instruction start (`target` is then that instruction's index).
     Register operands must be below the body's local count. `byOffset` maps instruction offsets to indices. */
  function decodeCode(abc, body) {
    var pool = abc.pool, code = body.code, r = new AbcReader(code, 0, code.length), list = [], byOffset = new Map();
    function at(table, i, what) {
      if (!(i >= 0 && i < table.length)) throw abcError(what + ' operand ' + i + ' is outside its pool in method ' + body.method.index, body.codeOffset + r.pos);
      return table[i];
    }
    while (r.pos < r.end) {
      var offset = r.pos, op = r.u8('opcode'), spec = OPCODES[op];
      if (!spec) throw abcError('unknown opcode 0x' + op.toString(16) + ' at offset ' + offset + ' of method ' + body.method.index, body.codeOffset + offset);
      var ins = { offset: offset, op: op, name: spec[0], args: [] }, layout = spec[1];
      if (layout === '*') {
        var base = offset, cases = [r.s24('lookupswitch default')], caseCount = r.u30('lookupswitch case count');
        if (caseCount + 1 > (r.end - r.pos) / 3) throw abcError('lookupswitch case count is too large', body.codeOffset + r.pos);
        for (var c = 0; c <= caseCount; c++) cases.push(r.s24('lookupswitch case'));
        ins.branches = cases.map(function (d) { return base + d; });
      }
      for (var k = 0; k < layout.length && layout !== '*'; k++) {
        var t = layout[k], v;
        switch (t) {
          case 'm': v = at(pool.multinames, r.u30('multiname'), 'multiname'); if (!v) throw abcError('an instruction uses multiname 0', body.codeOffset + offset); break;
          case 's': v = at(pool.strings, r.u30('string'), 'string'); break;
          case 'i': v = at(pool.ints, r.u30('int'), 'int'); break;
          case 'u': v = at(pool.uints, r.u30('uint'), 'uint'); break;
          case 'd': v = at(pool.doubles, r.u30('double'), 'double'); break;
          case 'n': v = at(pool.namespaces, r.u30('namespace'), 'namespace'); break;
          case 'M': v = at(abc.methods, r.u30('method'), 'method'); break;
          case 'C': v = at(abc.classes, r.u30('class'), 'class'); break;
          case 'x': v = r.u30('operand'); break;
          case 'a': v = r.u30('argument count'); break;
          case 'b': v = r.u8('operand'); break;
          case 'B': v = (r.u8('operand') << 24) >> 24; break;
          case 'j': v = r.s24('branch'); ins.branches = [r.pos + v]; break;
        }
        ins.args.push(v);
      }
      if (op === 0x25) ins.args[0] = (ins.args[0] << 16) >> 16; // pushshort: a signed 16-bit value
      byOffset.set(offset, list.length);
      list.push(ins);
    }
    var regs = body.localCount;
    list.forEach(function (ins) {
      if (ins.branches) {
        ins.targets = ins.branches.map(function (target) {
          if (!byOffset.has(target)) throw abcError(ins.name + ' at offset ' + ins.offset + ' of method ' + body.method.index + ' jumps to ' + target + ', which is not an instruction', body.codeOffset + ins.offset);
          return byOffset.get(target);
        });
      }
      var reg = ins.op >= 0xd0 && ins.op <= 0xd7 ? (ins.op - 0xd0) & 3 : (ins.op === 0x62 || ins.op === 0x63 || ins.op === 0x08 || ins.op === 0x92 || ins.op === 0x94 || ins.op === 0xc2 || ins.op === 0xc3) ? ins.args[0] : -1;
      if (reg >= regs) throw abcError(ins.name + ' at offset ' + ins.offset + ' of method ' + body.method.index + ' uses register ' + reg + ' of ' + regs, body.codeOffset + ins.offset);
      if (ins.op === 0x32 && (ins.args[0] >= regs || ins.args[1] >= regs)) throw abcError('hasnext2 uses a register outside the method', body.codeOffset + ins.offset);
    });
    body.byOffset = byOffset;
    return list;
  }

  // "package::name" style text for diagnostics.
  function multinameText(mn) {
    if (!mn) return '*';
    if (mn.kind === MN.TYPENAME) return multinameText(mn.qname) + '.<' + mn.params.map(multinameText).join(',') + '>';
    var name = mn.name === null ? (mn.runtimeName ? '[runtime]' : '*') : mn.name;
    if (mn.kind === MN.QNAME || mn.kind === MN.QNAME_A) {
      var ns = mn.namespaces ? mn.namespaces[0].uri : '*';
      return (ns ? ns + '::' : '') + name;
    }
    return name;
  }

  Object.assign(M, {
    AbcReader: AbcReader, parseAbc: parseAbc, abcMultinameText: multinameText,
    AVM2_OPCODES: OPCODES, AVM2_NS: NS, AVM2_MN: MN, AVM2_TRAIT: TRAIT, AVM2_METHOD_FLAGS: METHOD_FLAGS, AVM2_CLASS_FLAGS: CLASS_FLAGS
  });
})(typeof window !== 'undefined' ? window : globalThis);
