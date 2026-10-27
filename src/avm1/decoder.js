/* RetroFlash.js - AVM1 action records: names and bounded decoding. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;

  var ACTION_NAMES = {
    0x04: 'NextFrame', 0x05: 'PreviousFrame', 0x06: 'Play', 0x07: 'Stop', 0x08: 'ToggleQuality', 0x09: 'StopSounds',
    0x0a: 'Add', 0x0b: 'Subtract', 0x0c: 'Multiply', 0x0d: 'Divide', 0x0e: 'Equals', 0x0f: 'Less', 0x10: 'And', 0x11: 'Or',
    0x12: 'Not', 0x13: 'StringEquals', 0x14: 'StringLength', 0x15: 'StringExtract', 0x17: 'Pop', 0x18: 'ToInteger',
    0x1c: 'GetVariable', 0x1d: 'SetVariable', 0x20: 'SetTarget2', 0x21: 'StringAdd', 0x22: 'GetProperty', 0x23: 'SetProperty',
    0x24: 'CloneSprite', 0x25: 'RemoveSprite', 0x26: 'Trace', 0x27: 'StartDrag', 0x28: 'EndDrag', 0x29: 'StringLess',
    0x2a: 'Throw', 0x2b: 'CastOp', 0x2c: 'ImplementsOp', 0x30: 'RandomNumber', 0x31: 'MBStringLength', 0x32: 'CharToAscii',
    0x33: 'AsciiToChar', 0x34: 'GetTime', 0x35: 'MBStringExtract', 0x36: 'MBCharToAscii', 0x37: 'MBAsciiToChar',
    0x3a: 'Delete', 0x3b: 'Delete2', 0x3c: 'DefineLocal', 0x3d: 'CallFunction', 0x3e: 'Return', 0x3f: 'Modulo',
    0x40: 'NewObject', 0x41: 'DefineLocal2', 0x42: 'InitArray', 0x43: 'InitObject', 0x44: 'TypeOf', 0x45: 'TargetPath',
    0x46: 'Enumerate', 0x47: 'Add2', 0x48: 'Less2', 0x49: 'Equals2', 0x4a: 'ToNumber', 0x4b: 'ToString', 0x4c: 'PushDuplicate',
    0x4d: 'StackSwap', 0x4e: 'GetMember', 0x4f: 'SetMember', 0x50: 'Increment', 0x51: 'Decrement', 0x52: 'CallMethod',
    0x53: 'NewMethod', 0x54: 'InstanceOf', 0x55: 'Enumerate2', 0x60: 'BitAnd', 0x61: 'BitOr', 0x62: 'BitXor', 0x63: 'BitLShift',
    0x64: 'BitRShift', 0x65: 'BitURShift', 0x66: 'StrictEquals', 0x67: 'Greater', 0x68: 'StringGreater', 0x69: 'Extends',
    0x81: 'GotoFrame', 0x83: 'GetURL', 0x87: 'StoreRegister', 0x88: 'ConstantPool', 0x8a: 'WaitForFrame', 0x8b: 'SetTarget',
    0x8c: 'GotoLabel', 0x8d: 'WaitForFrame2', 0x8e: 'DefineFunction2', 0x8f: 'Try', 0x94: 'With', 0x96: 'Push', 0x99: 'Jump',
    0x9a: 'GetURL2', 0x9b: 'DefineFunction', 0x9d: 'If', 0x9e: 'Call', 0x9f: 'GotoFrame2'
  };


  // Action records up to ActionEndFlag: [{ code, offset, data, next }]. `truncated` marks a record cut short.
  function parseActions(bytes) {
    var list = [], i = 0;
    list.truncated = false;
    while (i < bytes.length) {
      var code = bytes[i], start = i, length = 0;
      i++;
      if (code === 0) break;
      if (code >= 0x80) {
        if (i + 2 > bytes.length) { list.truncated = true; break; }
        length = bytes[i] | (bytes[i + 1] << 8);
        i += 2;
        if (i + length > bytes.length) { list.truncated = true; break; }
      }
      list.push({ code: code, offset: start, data: bytes.subarray(i, i + length), next: i + length });
      i += length;
    }
    return list;
  }
  function actionString(action, version) { return new global.SWFReader.BitReader(action.data).readString(version, 'action string'); }
  function actionUI16(action) { return action.data[0] | (action.data[1] << 8); }
  // DefineFunction/DefineFunction2: byte length of the body that follows the record (skipped, not run).
  function functionCodeSize(action, version) {
    var r = new global.SWFReader.BitReader(action.data);
    r.readString(version);
    var count = r.readUI16();
    if (action.code === 0x9b) {
      for (var i = 0; i < count; i++) r.readString(version);
    } else {
      r.readUI8();
      r.readUI16();
      for (var j = 0; j < count; j++) { r.readUI8(); r.readString(version); }
    }
    return r.readUI16();
  }

  Object.assign(M, { ACTION_NAMES: ACTION_NAMES, parseActions: parseActions, actionString: actionString,
    actionUI16: actionUI16, functionCodeSize: functionCodeSize });
})(typeof window !== 'undefined' ? window : globalThis);
