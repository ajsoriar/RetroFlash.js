/* RetroFlash.js legacy bundle: the ES2015+ library functions the player calls that Chrome 38 lacks. Babel only
   rewrites syntax, so tools/build.js puts this file, unminified, before the legacy bundle. Each one is defined
   only when missing and covers just what the player needs. */
(function () {
  'use strict';
  function define(owner, name, fn) {
    if (owner && !owner[name]) Object.defineProperty(owner, name, { value: fn, configurable: true, writable: true });
  }
  define(Object, 'assign', function (target) {
    if (target === null || target === undefined) throw new TypeError('Cannot convert undefined or null to object');
    var output = Object(target);
    for (var i = 1; i < arguments.length; i++) {
      var source = arguments[i];
      if (source === null || source === undefined) continue;
      for (var key in source) if (Object.prototype.hasOwnProperty.call(source, key)) output[key] = source[key];
    }
    return output;
  });
  // Arrays from array-likes and from iterables (Map and Set keys/values, which Chrome 38 has).
  define(Array, 'from', function (items, map, thisArg) {
    var out = [], i = 0, step;
    if (items === null || items === undefined) throw new TypeError('Array.from needs an array-like or iterable object');
    var iterator = typeof Symbol === 'function' && Symbol.iterator && items[Symbol.iterator];
    if (typeof iterator === 'function') {
      for (var it = iterator.call(items); !(step = it.next()).done; i++) out.push(map ? map.call(thisArg, step.value, i) : step.value);
    } else {
      for (var length = items.length >>> 0; i < length; i++) out.push(map ? map.call(thisArg, items[i], i) : items[i]);
    }
    return out;
  });
  define(String, 'fromCodePoint', function () {
    var out = '';
    for (var i = 0; i < arguments.length; i++) {
      var c = Number(arguments[i]);
      if (!(c >= 0 && c <= 0x10ffff) || Math.floor(c) !== c) throw new RangeError('Invalid code point ' + arguments[i]);
      if (c < 0x10000) out += String.fromCharCode(c);
      else { c -= 0x10000; out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff)); }
    }
    return out;
  });
  // Typed arrays: a copy of a range (getTagData and the decoders copy tag bytes with it).
  if (typeof Uint8Array === 'function') {
    var typedArray = Object.getPrototypeOf(Uint8Array.prototype);
    var target = typedArray && typedArray !== Object.prototype ? [typedArray] : [Uint8Array.prototype, Int8Array.prototype, Uint16Array.prototype,
      Int16Array.prototype, Uint32Array.prototype, Int32Array.prototype, Float32Array.prototype, Float64Array.prototype, Uint8ClampedArray.prototype];
    target.forEach(function (proto) {
      define(proto, 'slice', function (begin, end) { return new this.constructor(this.subarray(begin, end)); });
    });
  }
})();
