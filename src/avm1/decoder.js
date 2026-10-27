/* RetroFlash.js - AVM1 action decoding: action records and their operands (SWF19, "Actions"), bounds-checked.
   Nothing is executed here, and no JavaScript is ever generated from the bytecode. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;

  // Action code -> [name, SWF version that introduced the action].
  var ACTIONS = {
    0x04: ['NextFrame', 3], 0x05: ['PreviousFrame', 3], 0x06: ['Play', 3], 0x07: ['Stop', 3], 0x08: ['ToggleQuality', 3],
    0x09: ['StopSounds', 3], 0x0a: ['Add', 4], 0x0b: ['Subtract', 4], 0x0c: ['Multiply', 4], 0x0d: ['Divide', 4],
    0x0e: ['Equals', 4], 0x0f: ['Less', 4], 0x10: ['And', 4], 0x11: ['Or', 4], 0x12: ['Not', 4], 0x13: ['StringEquals', 4],
    0x14: ['StringLength', 4], 0x15: ['StringExtract', 4], 0x17: ['Pop', 4], 0x18: ['ToInteger', 4], 0x1c: ['GetVariable', 4],
    0x1d: ['SetVariable', 4], 0x20: ['SetTarget2', 4], 0x21: ['StringAdd', 4], 0x22: ['GetProperty', 4],
    0x23: ['SetProperty', 4], 0x24: ['CloneSprite', 4], 0x25: ['RemoveSprite', 4], 0x26: ['Trace', 4], 0x27: ['StartDrag', 4],
    0x28: ['EndDrag', 4], 0x29: ['StringLess', 4], 0x2a: ['Throw', 7], 0x2b: ['CastOp', 7], 0x2c: ['ImplementsOp', 7],
    0x30: ['RandomNumber', 4], 0x31: ['MBStringLength', 4], 0x32: ['CharToAscii', 4], 0x33: ['AsciiToChar', 4],
    0x34: ['GetTime', 4], 0x35: ['MBStringExtract', 4], 0x36: ['MBCharToAscii', 4], 0x37: ['MBAsciiToChar', 4],
    0x3a: ['Delete', 5], 0x3b: ['Delete2', 5], 0x3c: ['DefineLocal', 5], 0x3d: ['CallFunction', 5], 0x3e: ['Return', 5],
    0x3f: ['Modulo', 5], 0x40: ['NewObject', 5], 0x41: ['DefineLocal2', 5], 0x42: ['InitArray', 5], 0x43: ['InitObject', 5],
    0x44: ['TypeOf', 5], 0x45: ['TargetPath', 5], 0x46: ['Enumerate', 5], 0x47: ['Add2', 5], 0x48: ['Less2', 5],
    0x49: ['Equals2', 5], 0x4a: ['ToNumber', 5], 0x4b: ['ToString', 5], 0x4c: ['PushDuplicate', 5], 0x4d: ['StackSwap', 5],
    0x4e: ['GetMember', 5], 0x4f: ['SetMember', 5], 0x50: ['Increment', 5], 0x51: ['Decrement', 5], 0x52: ['CallMethod', 5],
    0x53: ['NewMethod', 5], 0x54: ['InstanceOf', 6], 0x55: ['Enumerate2', 6], 0x60: ['BitAnd', 5], 0x61: ['BitOr', 5],
    0x62: ['BitXor', 5], 0x63: ['BitLShift', 5], 0x64: ['BitRShift', 5], 0x65: ['BitURShift', 5], 0x66: ['StrictEquals', 6],
    0x67: ['Greater', 6], 0x68: ['StringGreater', 6], 0x69: ['Extends', 7], 0x81: ['GotoFrame', 3], 0x83: ['GetURL', 3],
    0x87: ['StoreRegister', 5], 0x88: ['ConstantPool', 5], 0x8a: ['WaitForFrame', 3], 0x8b: ['SetTarget', 3],
    0x8c: ['GotoLabel', 3], 0x8d: ['WaitForFrame2', 4], 0x8e: ['DefineFunction2', 7], 0x8f: ['Try', 7], 0x94: ['With', 5],
    0x96: ['Push', 4], 0x99: ['Jump', 4], 0x9a: ['GetURL2', 4], 0x9b: ['DefineFunction', 5], 0x9d: ['If', 4], 0x9e: ['Call', 4],
    0x9f: ['GotoFrame2', 4]
  };
  var ACTION_NAMES = {};
  Object.keys(ACTIONS).forEach(function (code) { ACTION_NAMES[code] = ACTIONS[code][0]; });

  // DefineFunction2 flags, from the most significant bit of the first byte; PreloadGlobal is bit 0 of the second.
  var FUNCTION2_FLAGS = ['preloadParent', 'preloadRoot', 'suppressSuper', 'preloadSuper', 'suppressArguments',
    'preloadArguments', 'suppressThis', 'preloadThis'];

  function decodeError(code, message) {
    var err = new Error(message);
    err.name = 'AVM1DecodeError';
    err.code = code;
    return err;
  }
  // `count` raw bytes from the reader, as a DataView (little-endian numbers).
  function view(r, count, what) {
    r.align();
    r.need(count * 8, what);
    var at = r.byteOffset();
    r.seek(at + count);
    return new DataView(r.bytes.buffer, r.bytes.byteOffset + at, count);
  }
  // A body of `size` bytes that follows the record (function, With, Try) must lie inside the block.
  function bodyRange(start, size, length, what) {
    if (start + size > length) throw decodeError('INVALID_RANGE', what + ' of ' + size + ' bytes runs past the end of the action block');
    return start + size;
  }

  /* ActionPush values: { type, value }, where type is 'string', 'number', 'null', 'undefined', 'register'
     (value: register number), 'boolean' or 'constant' (value: constant pool index). Float, double and integer
     values all become 'number'. A double is stored as two little-endian 32-bit words, the high word first;
     an integer is read as a signed 32-bit value. */
  function readPushValues(r, version) {
    var values = [];
    while (r.remainingBytes() > 0) {
      var type = r.readUI8('Push type'), v;
      switch (type) {
        case 0: values.push({ type: 'string', value: r.readString(version, 'Push string') }); break;
        case 1: values.push({ type: 'number', value: view(r, 4, 'Push float').getFloat32(0, true) }); break;
        case 2: values.push({ type: 'null', value: null }); break;
        case 3: values.push({ type: 'undefined', value: undefined }); break;
        case 4: values.push({ type: 'register', value: r.readUI8('Push register') }); break;
        case 5: values.push({ type: 'boolean', value: r.readUI8('Push boolean') !== 0 }); break;
        case 6:
          v = view(r, 8, 'Push double');
          var swapped = new DataView(new ArrayBuffer(8));
          swapped.setUint32(0, v.getUint32(4, true), true);
          swapped.setUint32(4, v.getUint32(0, true), true);
          values.push({ type: 'number', value: swapped.getFloat64(0, true) });
          break;
        case 7: values.push({ type: 'number', value: view(r, 4, 'Push integer').getInt32(0, true) }); break;
        case 8: values.push({ type: 'constant', value: r.readUI8('Push constant8') }); break;
        case 9: values.push({ type: 'constant', value: r.readUI16('Push constant16') }); break;
        default: throw decodeError('INVALID_OPERANDS', 'Push value type ' + type + ' is not defined');
      }
    }
    return values;
  }

  /* Operands of the actions that have them. r reads the record's data, [start, end) of the block; `end` is
     also the offset of the next record, from which branch offsets and bodies are measured. */
  function readOperands(code, r, end, length, version) {
    var a = {}, count, i;
    switch (code) {
      case 0x81: a.frame = r.readUI16('GotoFrame frame'); break;
      case 0x83: a.url = r.readString(version, 'GetURL url'); a.target = r.readString(version, 'GetURL target'); break;
      case 0x87: a.register = r.readUI8('StoreRegister register'); break;
      case 0x88:
        count = r.readUI16('ConstantPool count');
        a.pool = [];
        for (i = 0; i < count; i++) a.pool.push(r.readString(version, 'ConstantPool string'));
        break;
      case 0x8a: a.frame = r.readUI16('WaitForFrame frame'); a.skipCount = r.readUI8('WaitForFrame skip count'); break;
      case 0x8b: a.path = r.readString(version, 'SetTarget path'); break;
      case 0x8c: a.label = r.readString(version, 'GotoLabel label'); break;
      case 0x8d: a.skipCount = r.readUI8('WaitForFrame2 skip count'); break;
      case 0x9b:
        a.name = r.readString(version, 'DefineFunction name');
        count = r.readUI16('DefineFunction parameter count');
        a.params = [];
        for (i = 0; i < count; i++) a.params.push(r.readString(version, 'DefineFunction parameter'));
        a.bodyStart = end;
        a.bodyEnd = bodyRange(end, r.readUI16('DefineFunction code size'), length, 'The function body');
        break;
      case 0x8e:
        a.name = r.readString(version, 'DefineFunction2 name');
        count = r.readUI16('DefineFunction2 parameter count');
        a.registerCount = r.readUI8('DefineFunction2 register count');
        var flags = r.readUI8('DefineFunction2 flags'), flags2 = r.readUI8('DefineFunction2 flags');
        a.flags = {};
        FUNCTION2_FLAGS.forEach(function (name, bit) { a.flags[name] = (flags & (0x80 >> bit)) !== 0; });
        a.flags.preloadGlobal = (flags2 & 1) !== 0;
        a.params = [];
        for (i = 0; i < count; i++) {
          a.params.push({ register: r.readUI8('DefineFunction2 parameter register'), name: r.readString(version, 'DefineFunction2 parameter') });
        }
        a.bodyStart = end;
        a.bodyEnd = bodyRange(end, r.readUI16('DefineFunction2 code size'), length, 'The function body');
        break;
      case 0x8f:
        var tryFlags = r.readUI8('Try flags');
        var trySize = r.readUI16('Try size'), catchSize = r.readUI16('Catch size'), finallySize = r.readUI16('Finally size');
        a.catchInRegister = (tryFlags & 4) !== 0;
        a.hasFinally = (tryFlags & 2) !== 0;
        a.hasCatch = (tryFlags & 1) !== 0;
        if (a.catchInRegister) a.catchRegister = r.readUI8('Try catch register');
        else a.catchName = r.readString(version, 'Try catch name');
        a.tryStart = end;
        a.tryEnd = bodyRange(end, trySize, length, 'The try block');
        a.catchEnd = bodyRange(a.tryEnd, catchSize, length, 'The catch block');
        a.finallyEnd = bodyRange(a.catchEnd, finallySize, length, 'The finally block');
        break;
      case 0x94:
        a.bodyStart = end;
        a.bodyEnd = bodyRange(end, r.readUI16('With size'), length, 'The With block');
        break;
      case 0x96: a.values = readPushValues(r, version); break;
      case 0x99: case 0x9d:
        a.offset = r.readSI16('Branch offset');
        a.target = end + a.offset;
        if (a.target < 0 || a.target > length) {
          throw decodeError('INVALID_BRANCH', 'Branch target ' + a.target + ' is outside the action block [0, ' + length + ']');
        }
        break;
      case 0x9a:
        var method = r.readUI8('GetURL2 flags');
        a.sendVarsMethod = method >> 6;
        a.loadTarget = (method & 2) !== 0;
        a.loadVariables = (method & 1) !== 0;
        break;
      case 0x9f:
        var goto2 = r.readUI8('GotoFrame2 flags');
        a.play = (goto2 & 1) !== 0;
        a.sceneBias = goto2 & 2 ? r.readUI16('GotoFrame2 scene bias') : 0;
        break;
      default:
        return undefined;
    }
    return a;
  }

  /* The action record at `offset` of `bytes`: { code, name, since, offset, end, data, args, error }.
     - `end` is the offset of the next record; `data` is the record's payload (a view, not a copy).
     - `args` holds the decoded operands of actions that have them (see readOperands); extra payload bytes
       after them are ignored, as Flash Player does.
     - `error` ({ code, message }) marks a record that cannot be used: TRUNCATED_RECORD (the header or the
       declared length runs past the block; `end` is then the block length), INVALID_OPERANDS (the payload
       does not hold the operands), INVALID_BRANCH (a Jump/If target outside the block) or INVALID_RANGE (a
       function, With or Try body that runs past the block).
     Code 0 is ActionEndFlag. Unknown codes are decoded by their length, as Flash Player skips them. */
  var NO_DATA = new Uint8Array(0); // shared by the records without a payload, so cached records stay small

  function decodeAction(bytes, offset, version) {
    var code = bytes[offset], info = ACTIONS[code], length = bytes.length;
    var action = {
      code: code, name: code === 0 ? 'End' : info ? info[0] : 'Unknown_0x' + code.toString(16), since: info ? info[1] : null,
      offset: offset, end: offset + 1, data: NO_DATA, args: undefined, error: undefined
    };
    if (code < 0x80) return action;
    if (offset + 3 > length) {
      action.end = length;
      action.error = { code: 'TRUNCATED_RECORD', message: 'The action record header runs past the end of the action block' };
      return action;
    }
    var size = bytes[offset + 1] | (bytes[offset + 2] << 8), start = offset + 3;
    if (start + size > length) {
      action.end = length;
      action.error = { code: 'TRUNCATED_RECORD', message: 'The action record declares ' + size + ' bytes, past the end of the action block' };
      return action;
    }
    action.end = start + size;
    action.data = bytes.subarray(start, action.end);
    try {
      action.args = readOperands(code, new global.SWFReader.BitReader(bytes, start, action.end), action.end, length, version);
    } catch (err) {
      if (err.name !== 'SWFReaderError' && err.name !== 'AVM1DecodeError') throw err;
      action.error = { code: err.name === 'AVM1DecodeError' ? err.code : 'INVALID_OPERANDS', message: String(err.message).replace(/^SWFReader: /, '') };
    }
    return action;
  }

  /* The decoded code of one action block: a DoAction body, a DoInitAction body after its sprite id, or a
     button's action list. Records are decoded on demand at any offset and cached, so a branch into the middle
     of a record (which some tools emit) decodes from there. list() is the linear decoding from offset 0 up to
     ActionEndFlag: the records before it, with `endFound`, `endOffset`, `trailingBytes` (bytes after the
     end flag) and `truncated` (a record runs past the block; it is not listed).
     `budget` ({ used, max }, optional) can be shared by the blocks of a movie. It is counted in bytes of
     bytecode, which is what the memory of the cached records follows (see recordCost). Once `used` reaches
     `max`, decoding a new record throws DECODE_BUDGET; the record that crosses `max` is kept, so `used` may end
     above it by one record. Records already decoded stay available. */
  function ActionCode(bytes, version, budget) {
    this.bytes = bytes;
    this.version = version;
    this.length = bytes.length;
    this.budget = budget || null;
    this.records = new Map();
    this.linear = null;
  }
  ActionCode.prototype.at = function (offset) {
    if (!Number.isInteger(offset) || offset < 0 || offset >= this.length) {
      throw decodeError('INVALID_OFFSET', 'Action offset ' + offset + ' is outside the action block');
    }
    var action = this.records.get(offset), budget = this.budget;
    if (!action) {
      if (budget && budget.used >= budget.max) {
        throw decodeError('DECODE_BUDGET', 'More than ' + budget.max + ' bytes of actions decoded');
      }
      action = decodeAction(this.bytes, offset, this.version);
      if (budget) budget.used += recordCost(action) + (this.records.size ? 0 : BLOCK_COST);
      this.records.set(offset, action);
    }
    return action;
  };

  /* Budget cost of a cached record: its length, since its memory grows with its operands. A record with an
     error keeps no operands, so it costs at most its 3-byte header, whatever length it declares. The first
     record of a block also pays BLOCK_COST for the block's own objects (this ActionCode, its map, its byte
     view and the caller's cache entry: about 350 bytes of memory, as much as 4 bytes of one-byte actions). */
  var BLOCK_COST = 4;
  function recordCost(action) {
    var length = action.end - action.offset;
    return action.error ? Math.min(length, 3) : length;
  }
  ActionCode.prototype.list = function () {
    if (this.linear) return this.linear;
    var list = [], offset = 0;
    list.endFound = false;
    list.truncated = false;
    list.endOffset = this.length;
    while (offset < this.length) {
      var action = this.at(offset);
      if (action.code === 0) { list.endFound = true; list.endOffset = offset; break; }
      if (action.error && action.error.code === 'TRUNCATED_RECORD') { list.truncated = true; break; }
      list.push(action);
      offset = action.end;
    }
    list.trailingBytes = list.endFound ? this.length - list.endOffset - 1 : 0;
    this.linear = list;
    return list;
  };

  Object.assign(M, {
    ACTIONS: ACTIONS, ACTION_NAMES: ACTION_NAMES, decodeAction: decodeAction, ActionCode: ActionCode, ACTION_BLOCK_COST: BLOCK_COST
  });
})(typeof window !== 'undefined' ? window : globalThis);
