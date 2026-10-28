/* RetroFlash.js - AVM1 values: conversions and comparisons, which change with the SWF version as in Flash Player. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;

  /* AVM1 values are JavaScript primitives (undefined, null, booleans, numbers and strings), movie clips (a Clip,
     avm1Type 'movieclip') and objects (avm1/objects.js: avm1Type 'object' or 'function'). UNKNOWN_VALUE stands
     for a value the player cannot compute yet (the result of an action that is not interpreted), so that no
     later action takes it for a real value. Callers deal with UNKNOWN_VALUE first. Objects convert through
     their valueOf() and toString() methods (M.objectToPrimitive, avm1/objects.js). */
  var UNKNOWN_VALUE = Object.freeze({ unknown: true });
  function isClip(v) { return v !== null && typeof v === 'object' && v.avm1Type === 'movieclip'; }
  function isObjectValue(v) { return v !== null && typeof v === 'object' && (v.avm1Type === 'object' || v.avm1Type === 'function'); }

  var WHITESPACE = /^[ \t\n\r\f\v]*/;
  // Optional sign, digits with an optional point (a lone point counts), optional exponent with optional digits.
  var DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d*))?/;

  /* String to number. From SWF 5 the whole string must be a number (leading whitespace allowed), otherwise
     NaN; in SWF 4 trailing text is ignored and a string that is not a number gives 0. From SWF 6, "0x" starts
     a hexadecimal integer and a leading 0 followed only by octal digits an octal one (both 32-bit, wrapping);
     a sign before "0x" gives NaN, as in Flash Player. */
  function stringToNumber(s, version) {
    if (version >= 6) {
      var unsigned = s.charAt(0) === '+' || s.charAt(0) === '-' ? s.slice(1) : s;
      if (/^0[xX]/.test(unsigned)) return unsigned === s ? parseInteger(s.slice(2), 16) : NaN;
      if (/^0[0-7]*$/.test(unsigned)) return parseInteger(s, 8);
    }
    var body = s.slice(WHITESPACE.exec(s)[0].length), m = DECIMAL.exec(body);
    var valid = m[2] !== '' || m[3] !== undefined;
    if (valid && (version < 5 || m[0].length === body.length)) {
      var exponent = m[4] && m[4] !== '+' && m[4] !== '-' ? m[4] : '0';
      return Number(m[1] + (m[2] || '0') + '.' + (m[3] || '0') + 'e' + exponent);
    }
    return version < 5 ? 0 : NaN;
  }
  // A signed integer in `radix`, wrapped to 32 bits; NaN when it has no digits or an invalid one.
  function parseInteger(s, radix) {
    var negative = s.charAt(0) === '-', digits = /^[+-]/.test(s) ? s.slice(1) : s, value = 0;
    if (!digits) return NaN;
    for (var i = 0; i < digits.length; i++) {
      var d = parseInt(digits.charAt(i), radix);
      if (isNaN(d)) return NaN;
      value = (value * radix + d) % 4294967296;
    }
    return (negative ? -value : value) | 0;
  }

  /* Number to string, as Flash Player prints it: integers in the 32-bit range as they are; other numbers with
     15 significant digits (rounded, trailing zeros removed), in exponent form ("1.5e+20", "2e-7") from 1e15
     up and below 1e-5. */
  function numberToString(n) {
    if (n !== n) return 'NaN';
    if (n === Infinity) return 'Infinity';
    if (n === -Infinity) return '-Infinity';
    if (n === 0) return '0';
    if (n === Math.floor(n) && n >= -2147483648 && n <= 2147483647) return String(n);
    var parts = Math.abs(n).toExponential(14).split('e');
    var digits = parts[0].replace('.', '').replace(/0+$/, ''), exponent = Number(parts[1]);
    var sign = n < 0 ? '-' : '', text;
    if (exponent >= 15 || exponent < -5) {
      text = digits.charAt(0) + (digits.length > 1 ? '.' + digits.slice(1) : '') + 'e' + (exponent < 0 ? '-' : '+') + Math.abs(exponent);
    } else if (exponent >= 0) {
      while (digits.length <= exponent) digits += '0';
      text = digits.slice(0, exponent + 1) + (digits.length > exponent + 1 ? '.' + digits.slice(exponent + 1) : '');
    } else {
      text = '0.' + new Array(-exponent).join('0') + digits;
    }
    return sign + text;
  }

  // ToNumber: undefined and null are 0 before SWF 7, NaN from SWF 7; a movie clip is NaN.
  function toNumber(v, version) {
    switch (typeof v) {
      case 'number': return v;
      case 'boolean': return v ? 1 : 0;
      case 'string': return stringToNumber(v, version);
      default:
        if (isObjectValue(v)) return toNumber(M.objectToPrimitive(v, 'number'), version);
        return isClip(v) || version >= 7 ? NaN : 0;
    }
  }
  // ToString: undefined is "" before SWF 7; booleans are "1" and "0" before SWF 5; a movie clip is its dot path.
  function toAvmString(v, version) {
    switch (typeof v) {
      case 'string': return v;
      case 'number': return numberToString(v);
      case 'boolean': return version < 5 ? (v ? '1' : '0') : (v ? 'true' : 'false');
      default:
        if (isClip(v)) return M.clipPath(v); // avm1/properties.js, loaded later
        if (isObjectValue(v)) return M.objectToPrimitive(v, 'string');
        return v === null ? 'null' : version < 7 ? '' : 'undefined';
    }
  }
  // ToBoolean: before SWF 7 a string is true when it converts to a number other than 0; from SWF 7 when not empty.
  function toBoolean(v, version) {
    switch (typeof v) {
      case 'boolean': return v;
      case 'number': return v === v && v !== 0;
      case 'string':
        if (version >= 7) return v !== '';
        var n = stringToNumber(v, version);
        return n === n && n !== 0;
      default: return isClip(v) || isObjectValue(v);
    }
  }
  // ECMAScript ToInt32 (wrapping), as the bitwise actions and ToInteger use it.
  function toInt32(v, version) { return toNumber(v, version) | 0; }

  /* Equals2: undefined and null equal each other; NaN equals NaN; a boolean compares as 1 or 0; a number and a
     string compare as numbers; two movie clips are equal when they have the same path; other mixed types are
     different. */
  function looseEquals(a, b, version) {
    if (a === undefined || a === null) return b === undefined || b === null;
    if (b === undefined || b === null) return false;
    if (isClip(a) || isClip(b)) return isClip(a) && isClip(b) && M.clipPath(a) === M.clipPath(b);
    // An object equals itself; against a primitive, it compares through valueOf().
    if (isObjectValue(a) || isObjectValue(b)) {
      if (isObjectValue(a) && isObjectValue(b)) return a === b;
      var p = M.objectToPrimitive(isObjectValue(a) ? a : b, 'number');
      return looseEquals(p, isObjectValue(a) ? b : a, version);
    }
    if (typeof a === typeof b) return a === b || (a !== a && b !== b);
    if (typeof a === 'boolean') return looseEquals(a ? 1 : 0, b, version);
    if (typeof b === 'boolean') return looseEquals(a, b ? 1 : 0, version);
    return toNumber(a, version) === toNumber(b, version);
  }
  // StrictEquals: same type and value; NaN equals NaN; movie clips by path.
  function strictEquals(a, b) {
    if (isClip(a) || isClip(b)) return isClip(a) && isClip(b) && M.clipPath(a) === M.clipPath(b);
    return a === b || (typeof a === 'number' && a !== a && b !== b);
  }
  // Less2: two strings compare by UTF-16 code units; anything else as numbers, and NaN gives undefined.
  function lessThan(a, b, version) {
    if (typeof a === 'string' && typeof b === 'string') return a < b;
    var x = toNumber(a, version), y = toNumber(b, version);
    return x !== x || y !== y ? undefined : x < y;
  }
  function typeOf(v) { return v === null ? 'null' : isClip(v) ? 'movieclip' : isObjectValue(v) ? v.avm1Type : typeof v; }

  Object.assign(M, {
    UNKNOWN_VALUE: UNKNOWN_VALUE, isClip: isClip, isObjectValue: isObjectValue, stringToNumber: stringToNumber, numberToString: numberToString, toNumber: toNumber,
    toAvmString: toAvmString, toBoolean: toBoolean, toInt32: toInt32, looseEquals: looseEquals,
    strictEquals: strictEquals, lessThan: lessThan, typeOf: typeOf
  });
})(typeof window !== 'undefined' ? window : globalThis);
