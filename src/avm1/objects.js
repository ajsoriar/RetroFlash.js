/* RetroFlash.js - AVM1 objects: plain objects, arrays and functions, and member access on every value. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;
  var UNKNOWN_VALUE = M.UNKNOWN_VALUE, isClip = M.isClip, propertyIndex = M.propertyIndex, getProperty = M.getProperty,
    setProperty = M.setProperty;

  /* Objects are AvmObject instances: a prototype (`proto`, another object or null) and their own properties,
     `props`, a Map from the key (lowercased before SWF 7, when names are case-insensitive) to { name, value,
     hidden }. Hidden properties (the built-in ones) are not enumerated. AvmArray keeps its elements in `items`;
     AvmFunction is a native function (`native(rt, thisValue, args, fn)`) or bytecode (`def`, see the
     interpreter). Movie clips (Clip) are objects too: their properties are the clip properties, _root and
     _parent, their variables, their child instances, and MovieClip.prototype.

     `rt` is the movie's AVM1 runtime (globals.js): { version, global, protos, call, construct, ... }. */

  var MAX_PROTO_DEPTH = 256;         // prototype chains longer than this are cut (hostile files can make loops)
  var MAX_ARRAY_INDEX = 1 << 24;     // indexes from here on are plain properties: an array never grows past it
  var MAX_STRING_LENGTH = 1 << 24;   // strings built by scripts (concatenation, join) stop at 16 M characters

  function AvmObject(proto) {
    this.proto = proto || null;
    this.props = new Map();
  }
  AvmObject.prototype.avm1Type = 'object';
  function AvmArray(proto, items) {
    AvmObject.call(this, proto);
    this.items = items || [];
  }
  AvmArray.prototype = Object.create(AvmObject.prototype);
  AvmArray.prototype.constructor = AvmArray;
  function AvmFunction(proto, native, def) {
    AvmObject.call(this, proto);
    this.native = native || null;
    this.def = def || null;
  }
  AvmFunction.prototype = Object.create(AvmObject.prototype);
  AvmFunction.prototype.constructor = AvmFunction;
  AvmFunction.prototype.avm1Type = 'function';

  // Thrown when a script goes past a runtime limit; the interpreter ends the whole block and reports it.
  function LimitError(message) { this.message = message; }

  function isObject(v) { return v instanceof AvmObject; }
  function isFunction(v) { return v instanceof AvmFunction; }
  function keyOf(name, version) { return version < 7 ? name.toLowerCase() : name; }
  function arrayIndex(name) {
    if (!/^(0|[1-9]\d{0,7})$/.test(name)) return -1;
    var i = Number(name);
    return i < MAX_ARRAY_INDEX ? i : -1;
  }
  function checkString(s) {
    if (s.length > MAX_STRING_LENGTH) throw new LimitError('A string grew past ' + MAX_STRING_LENGTH + ' characters.');
    return s;
  }
  function clipRef(clip, version) { return version < 5 ? undefined : clip; }

  // Own property entry, or undefined.
  function ownEntry(obj, name, version) { return obj.props.get(keyOf(name, version)); }
  function setOwn(obj, name, value, version, hidden) {
    var key = keyOf(name, version), entry = obj.props.get(key);
    if (entry) entry.value = value;
    else obj.props.set(key, { name: name, value: value, hidden: !!hidden });
  }
  // The prototype a primitive's members come from.
  function protoOf(rt, v) {
    if (isObject(v)) return v;
    switch (typeof v) {
      case 'string': return rt.protos.String;
      case 'number': return rt.protos.Number;
      case 'boolean': return rt.protos.Boolean;
      default: return null;
    }
  }
  // Looks `name` up along a prototype chain starting at `obj`; { found, value }.
  function lookup(obj, name, version) {
    for (var depth = 0; obj && depth < MAX_PROTO_DEPTH; depth++, obj = obj.proto) {
      if (obj instanceof AvmArray) {
        var i = arrayIndex(name);
        if (i >= 0 && i in obj.items) return { found: true, value: obj.items[i] };
        if (keyOf(name, version) === 'length') return { found: true, value: obj.items.length };
      }
      var entry = ownEntry(obj, name, version);
      if (entry) return { found: true, value: entry.value };
      if (keyOf(name, version) === '__proto__') return { found: true, value: obj.proto };
    }
    return { found: false, value: undefined };
  }

  /* Members of a movie clip, in Flash Player's order: properties (_x, ...), _root and _parent, variables, child
     instances; then MovieClip.prototype. */
  function clipMember(rt, clip, name) {
    var version = rt.version, lower = name.toLowerCase(), index = propertyIndex(name), key = keyOf(name, clip.env.version);
    if (index >= 0) return { found: true, value: getProperty(clip, index, version) };
    if (lower === '_root') return { found: true, value: clipRef(clip.root(), version) };
    if (lower === '_parent') return { found: !!clip.parent, value: clip.parent ? clipRef(clip.parent, version) : undefined };
    if (clip.variables.has(key)) return { found: true, value: clip.variables.get(key) };
    var child = clip.childByName(name);
    if (child) return { found: true, value: clipRef(child, version) };
    return lookup(rt.protos.MovieClip, name, version);
  }
  function member(rt, obj, name) {
    if (obj === UNKNOWN_VALUE) return { found: true, value: UNKNOWN_VALUE };
    if (isClip(obj)) return clipMember(rt, obj, name);
    if (typeof obj === 'string' && keyOf(name, rt.version) === 'length') return { found: true, value: obj.length };
    var proto = protoOf(rt, obj);
    return proto ? lookup(proto, name, rt.version) : { found: false, value: undefined };
  }
  // The value of obj[name] (undefined when missing); `obj` can be any value.
  function getMember(rt, obj, name) { return member(rt, obj, name).value; }
  function hasMember(rt, obj, name) { return member(rt, obj, name).found; }

  /* obj[name] = value. Movie clip properties set the property; arrays keep their length in step; __proto__
     replaces the prototype. Returns false when nothing could be set (_root, _parent, a primitive). */
  function setMember(rt, obj, name, value) {
    var version = rt.version;
    if (isClip(obj)) {
      var index = propertyIndex(name), lower = name.toLowerCase();
      if (index >= 0) { setProperty(obj, index, value, version); return true; }
      if (lower === '_root' || lower === '_parent') return false;
      obj.variables.set(keyOf(name, obj.env.version), value);
      return true;
    }
    if (!isObject(obj)) return false;
    var key = keyOf(name, version);
    if (key === '__proto__') { obj.proto = isObject(value) ? value : null; return true; }
    if (obj instanceof AvmArray) {
      var i = arrayIndex(name);
      if (i >= 0) { obj.items[i] = value; return true; }
      if (key === 'length') { setLength(obj, M.toNumber(value, version)); return true; }
    }
    setOwn(obj, name, value, version);
    return true;
  }
  function setLength(array, n) {
    if (!(n >= 0)) return;
    n = Math.min(Math.floor(n), MAX_ARRAY_INDEX);
    array.items.length = n;
  }
  // delete obj[name]: own properties only; true when something was deleted.
  function deleteMember(rt, obj, name) {
    var key = keyOf(name, rt.version);
    if (isClip(obj)) return obj.variables.delete(keyOf(name, obj.env.version));
    if (!isObject(obj)) return false;
    if (obj instanceof AvmArray) {
      var i = arrayIndex(name);
      if (i >= 0 && i in obj.items) { delete obj.items[i]; return true; }
    }
    var entry = obj.props.get(key);
    if (!entry || entry.hidden) return false;
    return obj.props.delete(key);
  }
  /* Enumerable names for for..in: own properties first, most recently added first (as Flash Player lists
     them), then the prototype chain's, skipping names already listed. A clip lists its variables and its
     child instances. */
  function keysOf(rt, obj) {
    var names = [], seen = new Set(), version = rt.version;
    function add(name, key) { if (!seen.has(key)) { seen.add(key); names.push(name); } }
    if (isClip(obj)) {
      Array.from(obj.variables.keys()).reverse().forEach(function (k) { add(k, k); });
      obj.displayList.forEach(function (child) { if (child.clip && child.name) add(child.name, keyOf(child.name, version)); });
      return names;
    }
    for (var depth = 0; isObject(obj) && depth < MAX_PROTO_DEPTH; depth++, obj = obj.proto) {
      if (obj instanceof AvmArray) {
        for (var i = obj.items.length - 1; i >= 0; i--) if (i in obj.items) add(String(i), String(i));
      }
      Array.from(obj.props.values()).reverse().forEach(function (e) {
        var key = keyOf(e.name, version);
        if (e.hidden) seen.add(key); else add(e.name, key);
      });
    }
    return names;
  }
  // value instanceof constructor: the constructor's prototype is on the value's prototype chain.
  function instanceOf(rt, value, constructor) {
    if (!isObject(value) && !isClip(value)) return false;
    var proto = getMember(rt, constructor, 'prototype');
    if (!isObject(proto)) return false;
    var obj = isClip(value) ? rt.protos.MovieClip : value.proto;
    for (var depth = 0; obj && depth < MAX_PROTO_DEPTH; depth++, obj = obj.proto) if (obj === proto) return true;
    return false;
  }

  /* Conversions of objects (used by values.js through M.objectToPrimitive): valueOf() for numbers, toString()
     for strings, called on the movie's runtime that is running (M.currentRuntime). Without one, or when the
     call gives no primitive, an object is NaN and "[object Object]" ("[type Function]" for functions). */
  function objectToPrimitive(obj, hint) {
    var rt = M.currentRuntime, method = hint === 'string' ? 'toString' : 'valueOf';
    if (rt) {
      var fn = getMember(rt, obj, method);
      if (isFunction(fn)) {
        var v = rt.call(fn, obj, []);
        if (hint === 'string' ? typeof v === 'string' : !isObject(v) && !isClip(v) && v !== UNKNOWN_VALUE) return v;
      }
    }
    if (hint === 'string') return isFunction(obj) ? '[type Function]' : '[type Object]';
    return hint === 'default' ? obj : NaN;
  }
  // ToPrimitive without a hint (Add2): an object's valueOf() when it is a primitive, else the object itself.
  function toPrimitive(v) { return isObject(v) ? objectToPrimitive(v, 'default') : v; }

  Object.assign(M, {
    AvmObject: AvmObject, AvmArray: AvmArray, AvmFunction: AvmFunction, LimitError: LimitError, isObject: isObject,
    isFunction: isFunction, getMember: getMember, hasMember: hasMember, setMember: setMember, setOwn: setOwn,
    deleteMember: deleteMember, keysOf: keysOf, instanceOf: instanceOf, objectToPrimitive: objectToPrimitive, toPrimitive: toPrimitive,
    checkString: checkString, MAX_ARRAY_INDEX: MAX_ARRAY_INDEX, MAX_STRING_LENGTH: MAX_STRING_LENGTH
  });
})(typeof window !== 'undefined' ? window : globalThis);
