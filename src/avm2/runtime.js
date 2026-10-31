/* RetroFlash.js - The AVM2 runtime: names, objects, classes and the interpreter of ABC method bodies. It keeps
   AVM2 values apart from AVM1 ones, dispatches every instruction through an explicit switch, and never turns
   movie code into JavaScript. Only the subset that the supported movies need is implemented; anything else
   stops the running script with an Avm2Unsupported error naming the instruction or feature. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;
  var NS = M.AVM2_NS, MN = M.AVM2_MN, TRAIT = M.AVM2_TRAIT, METHOD_FLAGS = M.AVM2_METHOD_FLAGS,
    CLASS_FLAGS = M.AVM2_CLASS_FLAGS, multinameText = M.abcMultinameText, LimitError = M.LimitError;

  // ---- Errors ----

  // An ActionScript error the VM raises (TypeError, ReferenceError, ArgumentError, ...).
  function Avm2Error(type, message) { this.type = type; this.message = message; }
  // A value thrown by the `throw` instruction.
  function Avm2Throw(value) { this.value = value; }
  // Code that needs an AVM2 feature or API this runtime does not implement; `feature` is the report key.
  function Avm2Unsupported(feature, message) { this.feature = feature; this.message = message; }
  function typeError(message) { return new Avm2Error('TypeError', message); }
  function referenceError(message) { return new Avm2Error('ReferenceError', message); }

  // ---- Names ----

  /* Each namespace gets a key: its URI for public, package and user namespaces (which compare by URI), a
     prefixed URI for internal and protected ones, and a unique key for every private namespace. A property
     key is "<namespace key>::<local name>"; public names are "::name". */
  var privateSerial = 0;
  function nsKey(ns) {
    if (ns.key === undefined) {
      if (ns.kind === NS.PRIVATE) ns.key = '#private' + (++privateSerial);
      else if (ns.kind === NS.PACKAGE_INTERNAL) ns.key = 'internal:' + ns.uri;
      else if (ns.kind === NS.PROTECTED) ns.key = 'protected:' + ns.uri;
      else if (ns.kind === NS.STATIC_PROTECTED) ns.key = 'static:' + ns.uri;
      else ns.key = ns.uri;
    }
    return ns.key;
  }
  function qkey(nsk, name) { return nsk + '::' + name; }
  function publicKey(name) { return '::' + name; }
  // The keys a multiname can name, for a local name (a runtime name, or the multiname's own).
  function keysOf(mn, name) {
    if (!mn.namespaces) return [publicKey(name)];
    var keys = new Array(mn.namespaces.length);
    for (var i = 0; i < keys.length; i++) keys[i] = qkey(nsKey(mn.namespaces[i]), name);
    return keys;
  }
  // Dynamic properties live in the public namespace only.
  function hasPublic(mn) {
    if (!mn.namespaces) return true;
    for (var i = 0; i < mn.namespaces.length; i++) if (nsKey(mn.namespaces[i]) === '') return true;
    return false;
  }

  // ---- Classes and objects ----

  /* The instance side of a class: its traits (property key -> binding, inherited ones included), its slot
     layout and defaults, its instance initializer (`init`: { method } for ABC code, { native } for builtins)
     and the scope its methods run in. Bindings are { kind: 'slot', index, type, constant }, { kind: 'method',
     method | native, scope } or { kind: 'accessor', get, set } (each a method binding or null). */
  function Klass(name, superKlass, dynamic) {
    this.name = name;
    this.superKlass = superKlass || null;
    this.traits = new Map(superKlass ? superKlass.traits : undefined);
    this.slotCount = superKlass ? superKlass.slotCount : 0;
    this.slotDefaults = superKlass ? superKlass.slotDefaults.slice() : [undefined];
    this.dynamic = !!dynamic;
    this.init = null;
    this.scope = [];
    this.classObject = null;
  }
  Klass.prototype.isSubclassOf = function (other) {
    for (var k = this; k; k = k.superKlass) if (k === other) return true;
    return false;
  };
  Klass.prototype.shortName = function () { return this.name.slice(this.name.lastIndexOf(':') + 1); };
  // A slot for a trait: absolute slot ids continue after the superclass's slots; id 0 takes the next free one.
  Klass.prototype.addSlot = function (key, slotId, type, value, constant) {
    var index = slotId ? (this.superKlass ? this.superKlass.slotCount : 0) + slotId : this.slotCount + 1;
    this.slotCount = Math.max(this.slotCount, index);
    this.slotDefaults[index] = value;
    var binding = { kind: 'slot', index: index, type: type, constant: !!constant };
    this.traits.set(key, binding);
    return binding;
  };
  // Adds a getter or setter, keeping an inherited half (a new binding: the superclass keeps its own).
  Klass.prototype.addAccessor = function (key, half, fn) {
    var old = this.traits.get(key), binding = { kind: 'accessor', get: null, set: null };
    if (old && old.kind === 'accessor') { binding.get = old.get; binding.set = old.set; }
    binding[half] = fn;
    this.traits.set(key, binding);
  };

  /* An AVM2 object. `klass` gives its traits; `slots` holds the values of slot traits; `dyn` (a Map, made on
     first use) holds dynamic public properties of dynamic classes. Builtins keep their own state in `state`;
     functions have `fn` ({ method, scope, receiver } or { native }); class objects have `instanceKlass`. */
  function AObject(klass) {
    this.klass = klass;
    this.slots = klass.slotDefaults.slice();
    this.dyn = null;
  }
  function isObject(v) { return v instanceof AObject; }
  function isFunction(v) { return v instanceof AObject && !!v.fn; }
  function isClass(v) { return v instanceof AObject && !!v.instanceKlass; }

  // The default value of a slot of type `type` (a multiname; null is *).
  function typeDefault(type) {
    if (!type || !type.name) return undefined;
    if (type.namespaces && type.namespaces.length === 1 && nsKey(type.namespaces[0]) !== '') return null;
    switch (type.name) {
      case 'int': case 'uint': return 0;
      case 'Number': return NaN;
      case 'Boolean': return false;
      default: return null;
    }
  }
  // The public builtin types whose values are primitives (coerce converts to them instead of checking).
  var VALUE_TYPES = { int: 1, uint: 1, Number: 1, Boolean: 1, String: 1, Object: 1 };
  function isValueType(type) {
    return !!type && type.name !== null && VALUE_TYPES[type.name] === 1 && (!type.namespaces || type.namespaces.some(function (ns) { return nsKey(ns) === ''; }));
  }
  // Coercion of a value stored into a slot or passed to a parameter of a builtin type; other types keep the value.
  function coerceTo(type, value) {
    if (!type || !type.name) return value;
    switch (type.name) {
      case 'int': return toInt32(value);
      case 'uint': return toUint32(value);
      case 'Number': return toNumber(value);
      case 'Boolean': return toBoolean(value);
      case 'String': return value === null || value === undefined ? null : toStr(value);
      case 'Object': return value === undefined ? null : value;
      default: return value === undefined ? null : value;
    }
  }

  // ---- Conversions (ECMA-262 rules, as AVM2 follows them) ----

  function toNumber(v) {
    if (typeof v === 'number') return v;
    if (v === undefined) return NaN;
    if (v === null || v === false) return 0;
    if (v === true) return 1;
    if (typeof v === 'string') return v.trim() === '' ? 0 : Number(v);
    return toNumber(toPrimitive(v));
  }
  function toInt32(v) { return toNumber(v) | 0; }
  function toUint32(v) { return toNumber(v) >>> 0; }
  function toBoolean(v) { return v instanceof AObject ? true : !!v; }
  function toStr(v) {
    if (typeof v === 'string') return v;
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    if (v instanceof AObject) return objectText(v);
    return String(v);
  }
  function objectText(v) {
    if (v.instanceKlass) return '[class ' + v.instanceKlass.shortName() + ']';
    if (v.fn) return 'function Function() {}';
    if (v.klass.toText) return v.klass.toText(v);
    return '[object ' + v.klass.shortName() + ']';
  }
  function toPrimitive(v) { return v instanceof AObject ? objectText(v) : v; }
  function checkString(s) { return M.checkString(s); }
  function typeOf(v) {
    if (v === undefined) return 'undefined';
    if (v === null) return 'object';
    if (v instanceof AObject) return v.fn ? 'function' : 'object';
    return typeof v;
  }
  function add(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a + b;
    a = toPrimitive(a);
    b = toPrimitive(b);
    if (typeof a === 'string' || typeof b === 'string') return checkString(toStr(a) + toStr(b));
    return toNumber(a) + toNumber(b);
  }
  function looseEquals(a, b) {
    if (a instanceof AObject || b instanceof AObject) {
      if (a instanceof AObject && b instanceof AObject) return a === b;
      if (a === null || a === undefined || b === null || b === undefined) return false;
      return looseEquals(toPrimitive(a), toPrimitive(b));
    }
    return a == b; // eslint-disable-line eqeqeq
  }
  // a < b: true, false, or undefined when a NaN is involved.
  function compare(a, b) {
    a = toPrimitive(a);
    b = toPrimitive(b);
    if (typeof a === 'string' && typeof b === 'string') return a < b;
    a = toNumber(a);
    b = toNumber(b);
    if (a !== a || b !== b) return undefined;
    return a < b;
  }

  // ---- Runtime ----

  /* The AVM2 state of one movie. `scheduler` is the movie's ActionScheduler (its step budget and report
     function are shared with AVM1), `limits` the player limits, `natives` the builtin definitions (avm2/api.js).
     `definitions` maps the qualified names of script traits to their scripts, whose initializers run on first
     use. `owners` maps instance initializers to their classes (for constructsuper). */
  function Runtime(options) {
    this.scheduler = options.scheduler;
    this.limits = options.limits;
    this.report = options.report;
    this.env = options.env || null;
    this.depth = 0;
    this.definitions = new Map();
    this.owners = new Map();
    this.objectKlass = new Klass('Object', null, true);
    this.functionKlass = new Klass('Function', this.objectKlass, true);
    this.classKlass = new Klass('Class', this.objectKlass, true);
    this.nativeGlobal = new AObject(new Klass('global', this.objectKlass, true));
    this.nativeGlobal.klass.isGlobal = true;
    this.reported = Object.create(null);
  }
  Runtime.prototype.allocate = function () {
    var env = this.env;
    if (env && ++env.instances > this.limits.maxInstances) throw new LimitError('More than ' + this.limits.maxInstances + ' objects created in one step.');
  };
  // Reports a feature once per runtime (rather than at every call).
  Runtime.prototype.reportOnce = function (feature, reason, source) {
    if (this.reported[feature + '\n' + source]) return;
    this.reported[feature + '\n' + source] = true;
    this.report(feature, reason, source);
  };
  // A class object for a Klass: its static side is a Klass of its own (`statics`).
  Runtime.prototype.classObjectFor = function (klass, statics) {
    var obj = new AObject(statics);
    obj.instanceKlass = klass;
    klass.classObject = obj;
    return obj;
  };
  // A function object: { method, scope, receiver } for ABC code, { native } for builtins.
  Runtime.prototype.makeFunction = function (fn) {
    var obj = new AObject(this.functionKlass);
    obj.fn = fn;
    return obj;
  };

  // Installs the traits of an ABC instance, class, script or activation into `klass`, with `scope` for its methods.
  Runtime.prototype.addTraits = function (klass, traits, scope, label) {
    var self = this;
    traits.forEach(function (t) {
      var key = qkey(nsKey(t.name.namespaces[0]), t.name.name);
      if (t.method && !t.method.label) t.method.label = label + '/' + t.name.name + (t.kind === TRAIT.GETTER ? ' (get)' : t.kind === TRAIT.SETTER ? ' (set)' : '');
      switch (t.kind) {
        case TRAIT.SLOT: case TRAIT.CONST:
          klass.addSlot(key, t.slotId, t.typeName, t.hasValue ? coerceTo(t.typeName, t.value) : typeDefault(t.typeName), t.kind === TRAIT.CONST);
          break;
        case TRAIT.CLASS: klass.addSlot(key, t.slotId, null, null, false); break;
        case TRAIT.FUNCTION: klass.addSlot(key, t.slotId, null, self.makeFunction({ method: t.method, scope: scope }), false); break;
        case TRAIT.METHOD: klass.traits.set(key, { kind: 'method', method: t.method, scope: scope }); break;
        case TRAIT.GETTER: klass.addAccessor(key, 'get', { method: t.method, scope: scope }); break;
        case TRAIT.SETTER: klass.addAccessor(key, 'set', { method: t.method, scope: scope }); break;
      }
    });
  };

  /* Loads a parsed ABC block (avm2/abc.js): every script gets its global object, and the names its traits
     define are registered. `name` labels its methods in diagnostics. Returns the scripts; the last one is the
     block's entry point. */
  Runtime.prototype.loadAbc = function (abc, name) {
    var self = this;
    return abc.scripts.map(function (info, i) {
      var klass = new Klass('global', self.objectKlass, true), script = { info: info, started: false, global: null, abc: abc };
      klass.isGlobal = true;
      var label = name + ' script ' + i;
      info.init.label = info.init.label || label + ' initializer';
      script.global = new AObject(klass);
      script.global.scope = [{ obj: script.global, isWith: false }];
      self.addTraits(klass, info.traits, script.global.scope, label);
      script.global.slots = klass.slotDefaults.slice();
      info.traits.forEach(function (t) {
        var key = qkey(nsKey(t.name.namespaces[0]), t.name.name);
        if (!self.definitions.has(key)) self.definitions.set(key, script);
      });
      return script;
    });
  };
  // Runs a script's initializer once (on first use of a name it defines, or as an entry point).
  Runtime.prototype.ensureScript = function (script) {
    if (script.started) return;
    script.started = true;
    this.execute(script.info.init, [], script.global, []);
  };
  /* The object holding a global definition named by `mn` (a script's global object, after its initializer,
     or the builtin global), or null. */
  Runtime.prototype.findDefinition = function (mn, name) {
    var keys = keysOf(mn, name);
    for (var i = 0; i < keys.length; i++) {
      var script = this.definitions.get(keys[i]);
      if (script) { this.ensureScript(script); return script.global; }
      if (this.nativeGlobal.klass.traits.has(keys[i])) return this.nativeGlobal;
    }
    return null;
  };
  // A class by its qualified name "package.Name" (SymbolClass), or null.
  Runtime.prototype.classByName = function (qualified) {
    var dot = qualified.lastIndexOf('.'), key = qkey(dot < 0 ? '' : qualified.slice(0, dot), qualified.slice(dot + 1));
    var script = this.definitions.get(key), holder = script ? (this.ensureScript(script), script.global) : this.nativeGlobal;
    var binding = holder.klass.traits.get(key), value = binding ? this.readBinding(holder, binding, qualified) : undefined;
    return isClass(value) ? value : null;
  };

  // ---- Properties ----

  function findBinding(traits, keys) {
    for (var i = 0; i < keys.length; i++) {
      var b = traits.get(keys[i]);
      if (b) return b;
    }
    return null;
  }
  Runtime.prototype.readBinding = function (obj, b, name) {
    switch (b.kind) {
      case 'slot': return obj.slots[b.index];
      case 'method': return this.boundMethod(obj, b);
      case 'accessor':
        if (!b.get) throw referenceError('Error #1077: Illegal read of write-only property ' + name + ' on ' + obj.klass.name + '.');
        return this.callBinding(b.get, obj, []);
    }
  };
  // A method read as a value: a function bound to its object, the same function on every read.
  Runtime.prototype.boundMethod = function (obj, b) {
    var cache = obj.bound || (obj.bound = new Map()), fn = cache.get(b);
    if (!fn) {
      fn = this.makeFunction(b.native ? { native: b.native, receiver: obj } : { method: b.method, scope: b.scope, receiver: obj });
      cache.set(b, fn);
    }
    return fn;
  };
  Runtime.prototype.callBinding = function (b, obj, args) {
    return b.native ? b.native(this, obj, args) : this.execute(b.method, b.scope, obj, args);
  };
  // Properties of primitive values: the few that the supported movies may read.
  function primitiveProperty(value, name) {
    if (typeof value === 'string' && name === 'length') return value.length;
    throw new Avm2Unsupported('avm2:primitiveProperty', 'Property ' + name + ' of a ' + typeof value + ' value');
  }
  function nullReference(value, name) {
    return typeError('Error #1009: Cannot access a property or method of a null object reference (' + name + ' of ' + value + ').');
  }
  Runtime.prototype.getProperty = function (obj, mn, name) {
    if (obj === null || obj === undefined) throw nullReference(obj, name);
    if (!(obj instanceof AObject)) return primitiveProperty(obj, name);
    var b = findBinding(obj.klass.traits, keysOf(mn, name));
    if (b) return this.readBinding(obj, b, name);
    if (obj.dyn && hasPublic(mn) && obj.dyn.has(name)) return obj.dyn.get(name);
    if (obj.klass.dynamic) return undefined;
    throw referenceError('Error #1069: Property ' + name + ' not found on ' + obj.klass.name + ' and there is no default value.');
  };
  Runtime.prototype.setProperty = function (obj, mn, name, value, init) {
    if (obj === null || obj === undefined) throw nullReference(obj, name);
    if (!(obj instanceof AObject)) throw new Avm2Unsupported('avm2:primitiveProperty', 'Setting property ' + name + ' of a ' + typeof obj + ' value');
    var b = findBinding(obj.klass.traits, keysOf(mn, name));
    if (b) {
      if (b.kind === 'slot') {
        if (b.constant && !init) throw referenceError('Error #1074: Illegal write to read-only property ' + name + ' on ' + obj.klass.name + '.');
        obj.slots[b.index] = coerceTo(b.type, value);
      } else if (b.kind === 'accessor') {
        if (!b.set) throw referenceError('Error #1074: Illegal write to read-only property ' + name + ' on ' + obj.klass.name + '.');
        this.callBinding(b.set, obj, [value]);
      } else {
        throw referenceError('Error #1037: Cannot assign to a method ' + name + ' on ' + obj.klass.name + '.');
      }
      return;
    }
    if (!obj.klass.dynamic || !hasPublic(mn)) throw referenceError('Error #1056: Cannot create property ' + name + ' on ' + obj.klass.name + '.');
    (obj.dyn || (obj.dyn = new Map())).set(name, value);
  };
  Runtime.prototype.hasProperty = function (obj, mn, name, dynamicToo) {
    if (!(obj instanceof AObject)) return false;
    if (findBinding(obj.klass.traits, keysOf(mn, name))) return true;
    return !!(dynamicToo && obj.dyn && hasPublic(mn) && obj.dyn.has(name));
  };
  Runtime.prototype.callProperty = function (obj, mn, name, args) {
    if (obj === null || obj === undefined) throw nullReference(obj, name);
    if (obj instanceof AObject) {
      var b = findBinding(obj.klass.traits, keysOf(mn, name));
      if (b && b.kind === 'method') return this.callBinding(b, obj, args);
      var fn = b ? this.readBinding(obj, b, name) : obj.dyn && hasPublic(mn) ? obj.dyn.get(name) : undefined;
      if (!isFunction(fn)) throw typeError('Error #1006: ' + name + ' is not a function (on ' + obj.klass.name + ').');
      return this.call(fn, obj, args);
    }
    if (name === 'toString' && !args.length) return toStr(obj);
    throw new Avm2Unsupported('avm2:primitiveMethod', 'Method ' + name + ' of a ' + typeof obj + ' value');
  };
  Runtime.prototype.call = function (fn, thisValue, args) {
    if (!isFunction(fn)) throw typeError('Error #1006: value is not a function.');
    var f = fn.fn, self = f.receiver !== undefined ? f.receiver : thisValue;
    return f.native ? f.native(this, self, args) : this.execute(f.method, f.scope, self, args);
  };
  // `new` on a class object: a new instance, initialized by the class's instance initializer chain.
  Runtime.prototype.construct = function (ctor, args) {
    if (!isClass(ctor)) throw typeError('Error #1007: Instantiation attempted on a non-constructor.');
    var klass = ctor.instanceKlass;
    this.allocate();
    var obj = new AObject(klass);
    this.initialize(klass, obj, args);
    return obj;
  };
  // Runs the instance initializer of `klass` (or of its nearest superclass that has one) on `obj`.
  Runtime.prototype.initialize = function (klass, obj, args) {
    for (var k = klass; k; k = k.superKlass) {
      if (!k.init) continue;
      if (k.init.native) return k.init.native(this, obj, args);
      return this.execute(k.init.method, k.scope, obj, args);
    }
  };
  // Is `value` an instance of the class object `cls`? (istype, astype, instanceof)
  function isInstance(value, cls) {
    if (!isClass(cls)) throw typeError('Error #1041: The right-hand side of operator must be a class.');
    var k = cls.instanceKlass;
    if (value instanceof AObject) return value.klass.isSubclassOf(k);
    switch (k.name) {
      case 'Object': return value !== null && value !== undefined;
      case 'String': return typeof value === 'string';
      case 'Number': return typeof value === 'number';
      case 'int': return typeof value === 'number' && (value | 0) === value;
      case 'uint': return typeof value === 'number' && (value >>> 0) === value;
      case 'Boolean': return typeof value === 'boolean';
      default: return false;
    }
  }

  /* newclass: the class described by `info` (an ABC class_info), extending the class object `base` (null for
     a class without superclass), defined in `scope` (the scope chain at newclass). Its static initializer
     runs before the class object is returned. */
  Runtime.prototype.defineClass = function (info, base, scope) {
    var inst = info.instance, name = multinameText(inst.name);
    if (base !== null && !isClass(base)) throw typeError('Error #1041: ' + name + ' extends a value that is not a class.');
    if (inst.flags & CLASS_FLAGS.INTERFACE) throw new Avm2Unsupported('avm2:interface', 'Interface ' + name);
    var superKlass = base ? base.instanceKlass : null;
    if (superKlass && superKlass.final) throw new Avm2Unsupported('avm2:finalClass', name + ' extends a final builtin class');
    var klass = new Klass(name, superKlass, !(inst.flags & CLASS_FLAGS.SEALED));
    var statics = new Klass(name + '$', this.classKlass, true);
    var classObject = this.classObjectFor(klass, statics);
    klass.scope = statics.scope = scope.concat([{ obj: classObject, isWith: false }]);
    inst.init.label = inst.init.label || name + ' constructor';
    info.init.label = info.init.label || name + ' class initializer';
    this.addTraits(klass, inst.traits, klass.scope, name);
    this.addTraits(statics, info.traits, statics.scope, name + ' (static)');
    classObject.slots = statics.slotDefaults.slice();
    klass.init = { method: inst.init };
    this.owners.set(inst.init, klass);
    this.execute(info.init, scope, classObject, []);
    return classObject;
  };

  // ---- Scope lookup ----

  /* findproperty and findpropstrict: the innermost scope object that has the name (traits; dynamic properties
     too for `with` scopes and global objects), then the global definitions. Not found: a ReferenceError
     (strict) or the global object. */
  Runtime.prototype.findProperty = function (scope, outer, mn, name, strict) {
    var i, s;
    for (i = scope.length - 1; i >= 0; i--) {
      s = scope[i];
      if (this.hasProperty(s.obj, mn, name, s.isWith || s.obj.klass.isGlobal)) return s.obj;
    }
    for (i = outer.length - 1; i >= 0; i--) {
      s = outer[i];
      if (this.hasProperty(s.obj, mn, name, s.isWith || s.obj.klass.isGlobal)) return s.obj;
    }
    var holder = this.findDefinition(mn, name);
    if (holder) return holder;
    if (strict) throw referenceError('Error #1065: Variable ' + name + ' is not defined.');
    return outer.length ? outer[0].obj : scope.length ? scope[0].obj : this.nativeGlobal;
  };
  // The class object a type multiname names (istype, astype, coerce to a class).
  Runtime.prototype.typeByName = function (mn) {
    var holder = this.findDefinition(mn, mn.name), value = holder ? this.getProperty(holder, mn, mn.name) : undefined;
    if (!isClass(value)) throw referenceError('Error #1065: Variable ' + multinameText(mn) + ' is not defined.');
    return value;
  };

  // ---- Interpreter ----

  var UNSUPPORTED_FLAGS = METHOD_FLAGS.NEED_ARGUMENTS | METHOD_FLAGS.NEED_ACTIVATION | METHOD_FLAGS.NEED_REST | METHOD_FLAGS.SET_DXNS;

  // The local name of a multiname operand; runtime names are popped from `stack`.
  function nameOf(mn, stack) {
    if (mn.runtimeNs) throw new Avm2Unsupported('avm2:runtimeNamespace', 'Multiname with a namespace computed at run time');
    if (mn.kind === MN.TYPENAME) throw new Avm2Unsupported('avm2:typeName', 'Parameterized type ' + multinameText(mn));
    if (mn.runtimeName) {
      var v = stack.pop();
      if (v instanceof AObject) throw new Avm2Unsupported('avm2:objectName', 'An object used as a property name');
      return toStr(v);
    }
    return mn.name === null ? '*' : mn.name;
  }
  function popArgs(stack, count) {
    if (count > stack.length) throw typeError('Error #1023: Stack underflow.');
    return stack.splice(stack.length - count, count);
  }

  /* Runs an ABC method with `outer` as its captured scope chain ([{ obj, isWith }]), `thisValue` in local 0 and
     `args` as its parameters (missing ones take their default values). Each instruction costs one step of the
     update's budget (limits.maxActionSteps, shared with AVM1); calls nest up to limits.maxCallDepth. Errors
     leave with `where`: the method and bytecode offset. */
  Runtime.prototype.execute = function (method, outer, thisValue, args) {
    var label = method.label || ('method ' + method.index);
    if (!method.body) throw new Avm2Unsupported('avm2:noBody', label + ' has no body (a native method)');
    if (method.flags & UNSUPPORTED_FLAGS) {
      throw new Avm2Unsupported('avm2:methodFlags', label + ' needs ' + ['arguments', 'an activation', '...rest', 'dxns']
        .filter(function (n, i) { return method.flags & [METHOD_FLAGS.NEED_ARGUMENTS, METHOD_FLAGS.NEED_ACTIVATION, METHOD_FLAGS.NEED_REST, METHOD_FLAGS.SET_DXNS][i]; }).join(', '));
    }
    if (method.body.exceptions.length) this.reportOnce('avm2:exceptionHandlers', 'try/catch blocks are not supported; an error inside them stops the script.', label);
    if (this.depth >= this.limits.maxCallDepth) throw new LimitError('More than ' + this.limits.maxCallDepth + ' nested ActionScript 3 calls.');
    this.depth++;
    try {
      return this.run(method, label, outer, thisValue, args);
    } finally {
      this.depth--;
    }
  };
  Runtime.prototype.run = function (method, label, outer, thisValue, args) {
    var body = method.body, code = body.instructions, locals = new Array(body.localCount), stack = [], scope = [];
    var scheduler = this.scheduler, maxSteps = this.limits.maxActionSteps, maxStack = this.limits.maxActionStack;
    locals[0] = thisValue;
    var params = method.paramCount, optionalStart = params - method.optional.length;
    for (var p = 0; p < params; p++) {
      var value = p < args.length ? args[p] : p >= optionalStart ? method.optional[p - optionalStart].value : undefined;
      if (p >= args.length && p < optionalStart) throw new Avm2Error('ArgumentError', 'Error #1063: Argument count mismatch on ' + label + '. Expected ' + optionalStart + ', got ' + args.length + '.');
      locals[p + 1] = coerceTo(method.paramTypes[p], value);
    }
    var pc = 0, ins = null, a, b, v, name, obj, list;
    try {
      for (;;) {
        if (pc >= code.length) throw new Avm2Error('VerifyError', 'Error #1020: Code cannot fall off the end of a method.');
        ins = code[pc++];
        if (++scheduler.steps > maxSteps) throw new LimitError('More than ' + maxSteps + ' actions in one tick or event; the script was stopped.');
        if (stack.length > maxStack || scope.length > maxStack) throw new LimitError('The stack of a script grew past ' + maxStack + ' values.');
        switch (ins.op) {
          case 0x01: case 0x02: case 0x09: case 0xef: case 0xf0: case 0xf1: break; // bkpt nop label debug debugline debugfile
          case 0x03: throw new Avm2Throw(stack.pop());
          case 0x08: locals[ins.args[0]] = undefined; break; // kill
          // Branches
          case 0x0c: b = stack.pop(); a = stack.pop(); if (compare(a, b) !== true) pc = ins.targets[0]; break;  // ifnlt
          case 0x0d: b = stack.pop(); a = stack.pop(); if (compare(b, a) !== false) pc = ins.targets[0]; break; // ifnle
          case 0x0e: b = stack.pop(); a = stack.pop(); if (compare(b, a) !== true) pc = ins.targets[0]; break;  // ifngt
          case 0x0f: b = stack.pop(); a = stack.pop(); if (compare(a, b) !== false) pc = ins.targets[0]; break; // ifnge
          case 0x10: pc = ins.targets[0]; break; // jump
          case 0x11: if (toBoolean(stack.pop())) pc = ins.targets[0]; break; // iftrue
          case 0x12: if (!toBoolean(stack.pop())) pc = ins.targets[0]; break; // iffalse
          case 0x13: b = stack.pop(); a = stack.pop(); if (looseEquals(a, b)) pc = ins.targets[0]; break; // ifeq
          case 0x14: b = stack.pop(); a = stack.pop(); if (!looseEquals(a, b)) pc = ins.targets[0]; break; // ifne
          case 0x15: b = stack.pop(); a = stack.pop(); if (compare(a, b) === true) pc = ins.targets[0]; break; // iflt
          case 0x16: b = stack.pop(); a = stack.pop(); if (compare(b, a) === false) pc = ins.targets[0]; break; // ifle
          case 0x17: b = stack.pop(); a = stack.pop(); if (compare(b, a) === true) pc = ins.targets[0]; break; // ifgt
          case 0x18: b = stack.pop(); a = stack.pop(); if (compare(a, b) === false) pc = ins.targets[0]; break; // ifge
          case 0x19: b = stack.pop(); a = stack.pop(); if (a === b) pc = ins.targets[0]; break; // ifstricteq
          case 0x1a: b = stack.pop(); a = stack.pop(); if (a !== b) pc = ins.targets[0]; break; // ifstrictne
          case 0x1b: // lookupswitch: targets[0] is the default, targets[1 + i] case i
            v = toInt32(stack.pop());
            pc = ins.targets[v >= 0 && v < ins.targets.length - 1 ? v + 1 : 0];
            break;
          // Scope stack
          case 0x1c: case 0x30: // pushwith, pushscope
            v = stack.pop();
            if (v === null || v === undefined) throw nullReference(v, 'scope');
            if (!(v instanceof AObject)) throw new Avm2Unsupported('avm2:primitiveScope', 'A primitive value on the scope stack');
            scope.push({ obj: v, isWith: ins.op === 0x1c });
            break;
          case 0x1d: scope.pop(); break; // popscope
          case 0x64: stack.push(outer.length ? outer[0].obj : scope.length ? scope[0].obj : this.nativeGlobal); break; // getglobalscope
          case 0x65: // getscopeobject
            if (ins.args[0] >= scope.length) throw new Avm2Error('VerifyError', 'Error #1019: getscopeobject ' + ins.args[0] + ' is out of bounds.');
            stack.push(scope[ins.args[0]].obj);
            break;
          // Constants and stack
          case 0x20: stack.push(null); break;
          case 0x21: stack.push(undefined); break;
          case 0x24: case 0x25: case 0x2c: case 0x2d: case 0x2e: case 0x2f: stack.push(ins.args[0]); break; // pushbyte pushshort pushstring pushint pushuint pushdouble
          case 0x26: stack.push(true); break;
          case 0x27: stack.push(false); break;
          case 0x28: stack.push(NaN); break;
          case 0x29: stack.pop(); break;
          case 0x2a: if (!stack.length) throw typeError('Error #1023: Stack underflow.'); stack.push(stack[stack.length - 1]); break; // dup
          case 0x2b: b = stack.pop(); a = stack.pop(); stack.push(b, a); break; // swap
          // Locals
          case 0x62: stack.push(locals[ins.args[0]]); break;
          case 0x63: locals[ins.args[0]] = stack.pop(); break;
          case 0xd0: case 0xd1: case 0xd2: case 0xd3: stack.push(locals[ins.op - 0xd0]); break;
          case 0xd4: case 0xd5: case 0xd6: case 0xd7: locals[ins.op - 0xd4] = stack.pop(); break;
          case 0x92: case 0x94: locals[ins.args[0]] = toNumber(locals[ins.args[0]]) + (ins.op === 0x92 ? 1 : -1); break; // inclocal declocal
          case 0xc2: case 0xc3: locals[ins.args[0]] = (toInt32(locals[ins.args[0]]) + (ins.op === 0xc2 ? 1 : -1)) | 0; break; // inclocal_i declocal_i
          // Functions, classes and calls
          case 0x40: stack.push(this.makeFunction({ method: ins.args[0], scope: outer.concat(scope) })); break; // newfunction
          case 0x41: // call
            list = popArgs(stack, ins.args[0]);
            obj = stack.pop();
            v = stack.pop();
            stack.push(this.call(v, obj, list));
            break;
          case 0x42: // construct
            list = popArgs(stack, ins.args[0]);
            stack.push(this.construct(stack.pop(), list));
            break;
          case 0x46: case 0x4c: case 0x4f: // callproperty callproplex callpropvoid
            list = popArgs(stack, ins.args[1]);
            name = nameOf(ins.args[0], stack);
            v = this.callProperty(stack.pop(), ins.args[0], name, list);
            if (ins.op !== 0x4f) stack.push(v);
            break;
          case 0x47: return undefined; // returnvoid
          case 0x48: return stack.pop(); // returnvalue
          case 0x49: // constructsuper
            list = popArgs(stack, ins.args[0]);
            obj = stack.pop();
            v = this.owners.get(method);
            if (!v) throw new Avm2Error('VerifyError', 'constructsuper outside a constructor.');
            if (v.superKlass) this.initialize(v.superKlass, obj, list);
            break;
          case 0x4a: // constructprop
            list = popArgs(stack, ins.args[1]);
            name = nameOf(ins.args[0], stack);
            obj = stack.pop();
            stack.push(this.construct(this.getProperty(obj, ins.args[0], name), list));
            break;
          case 0x58: // newclass
            v = stack.pop();
            stack.push(this.defineClass(ins.args[0], v === null || v === undefined ? null : v, outer.concat(scope)));
            break;
          // Properties
          case 0x5d: case 0x5e: // findpropstrict findproperty
            name = nameOf(ins.args[0], stack);
            stack.push(this.findProperty(scope, outer, ins.args[0], name, ins.op === 0x5d));
            break;
          case 0x5f: // finddef
            name = nameOf(ins.args[0], stack);
            obj = this.findDefinition(ins.args[0], name);
            if (!obj) throw referenceError('Error #1065: Variable ' + name + ' is not defined.');
            stack.push(obj);
            break;
          case 0x60: // getlex
            if (ins.args[0].runtimeName || ins.args[0].runtimeNs) throw new Avm2Error('VerifyError', 'getlex with a runtime name.');
            name = nameOf(ins.args[0], stack);
            stack.push(this.getProperty(this.findProperty(scope, outer, ins.args[0], name, true), ins.args[0], name));
            break;
          case 0x61: case 0x68: // setproperty initproperty
            v = stack.pop();
            name = nameOf(ins.args[0], stack);
            this.setProperty(stack.pop(), ins.args[0], name, v, ins.op === 0x68);
            break;
          case 0x66: // getproperty
            name = nameOf(ins.args[0], stack);
            stack.push(this.getProperty(stack.pop(), ins.args[0], name));
            break;
          case 0x6a: // deleteproperty: only dynamic properties can be deleted
            name = nameOf(ins.args[0], stack);
            obj = stack.pop();
            stack.push(obj instanceof AObject && !findBinding(obj.klass.traits, keysOf(ins.args[0], name)) ? (obj.dyn ? (obj.dyn.delete(name), true) : true) : false);
            break;
          case 0x6c: case 0x6d: // getslot setslot
            if (ins.op === 0x6d) v = stack.pop();
            obj = stack.pop();
            if (!(obj instanceof AObject)) throw nullReference(obj, 'slot ' + ins.args[0]);
            if (!(ins.args[0] >= 1 && ins.args[0] <= obj.klass.slotCount)) throw new Avm2Error('VerifyError', 'Error #1026: Slot ' + ins.args[0] + ' exceeds the slot count of ' + obj.klass.name + '.');
            if (ins.op === 0x6c) stack.push(obj.slots[ins.args[0]]);
            else obj.slots[ins.args[0]] = v;
            break;
          case 0xb4: // in
            obj = stack.pop();
            name = toStr(stack.pop());
            if (!(obj instanceof AObject)) throw typeError('Error #1006: in needs an object.');
            stack.push(obj.klass.traits.has(publicKey(name)) || !!(obj.dyn && obj.dyn.has(name)));
            break;
          // Conversions and types
          case 0x70: stack.push(toStr(stack.pop())); break; // convert_s
          case 0x85: v = stack.pop(); stack.push(v === null || v === undefined ? null : toStr(v)); break; // coerce_s
          case 0x73: case 0x83: stack.push(toInt32(stack.pop())); break; // convert_i coerce_i
          case 0x74: case 0x88: stack.push(toUint32(stack.pop())); break; // convert_u coerce_u
          case 0x75: case 0x84: stack.push(toNumber(stack.pop())); break; // convert_d coerce_d
          case 0x76: case 0x81: stack.push(toBoolean(stack.pop())); break; // convert_b coerce_b
          case 0x77: // convert_o
            v = stack[stack.length - 1];
            if (v === null || v === undefined) throw nullReference(v, 'convert_o');
            break;
          case 0x89: v = stack.pop(); stack.push(v === undefined ? null : v); break; // coerce_o
          case 0x82: break; // coerce_a
          case 0x80: // coerce: builtin value types convert; other classes check the type when they are defined here
            v = stack.pop();
            a = ins.args[0];
            if (v === null || v === undefined || isValueType(a)) { stack.push(coerceTo(a, v)); break; }
            b = this.findDefinition(a, a.name);
            b = b ? this.getProperty(b, a, a.name) : null;
            if (isClass(b) && !isInstance(v, b)) throw typeError('Error #1034: Type Coercion failed: cannot convert ' + toStr(v) + ' to ' + multinameText(a) + '.');
            stack.push(v);
            break;
          case 0x86: v = stack.pop(); stack.push(isInstance(v, this.typeByName(ins.args[0])) ? v : null); break; // astype
          case 0x87: b = stack.pop(); a = stack.pop(); stack.push(isInstance(a, b) ? a : null); break; // astypelate
          case 0xb2: stack.push(isInstance(stack.pop(), this.typeByName(ins.args[0]))); break; // istype
          case 0xb3: case 0xb1: b = stack.pop(); a = stack.pop(); stack.push(isInstance(a, b)); break; // istypelate instanceof
          case 0x95: stack.push(typeOf(stack.pop())); break; // typeof
          // Arithmetic, logic and comparison
          case 0x90: stack.push(-toNumber(stack.pop())); break; // negate
          case 0x91: stack.push(toNumber(stack.pop()) + 1); break; // increment
          case 0x93: stack.push(toNumber(stack.pop()) - 1); break; // decrement
          case 0xc0: stack.push((toInt32(stack.pop()) + 1) | 0); break; // increment_i
          case 0xc1: stack.push((toInt32(stack.pop()) - 1) | 0); break; // decrement_i
          case 0xc4: stack.push(-toInt32(stack.pop()) | 0); break; // negate_i
          case 0x96: stack.push(!toBoolean(stack.pop())); break; // not
          case 0x97: stack.push(~toInt32(stack.pop())); break; // bitnot
          case 0xa0: b = stack.pop(); a = stack.pop(); stack.push(add(a, b)); break;
          case 0xa1: b = stack.pop(); a = stack.pop(); stack.push(toNumber(a) - toNumber(b)); break;
          case 0xa2: b = stack.pop(); a = stack.pop(); stack.push(toNumber(a) * toNumber(b)); break;
          case 0xa3: b = stack.pop(); a = stack.pop(); stack.push(toNumber(a) / toNumber(b)); break;
          case 0xa4: b = stack.pop(); a = stack.pop(); stack.push(toNumber(a) % toNumber(b)); break;
          case 0xa5: b = stack.pop(); a = stack.pop(); stack.push(toInt32(a) << (toUint32(b) & 31)); break;
          case 0xa6: b = stack.pop(); a = stack.pop(); stack.push(toInt32(a) >> (toUint32(b) & 31)); break;
          case 0xa7: b = stack.pop(); a = stack.pop(); stack.push(toUint32(a) >>> (toUint32(b) & 31)); break;
          case 0xa8: b = stack.pop(); a = stack.pop(); stack.push(toInt32(a) & toInt32(b)); break;
          case 0xa9: b = stack.pop(); a = stack.pop(); stack.push(toInt32(a) | toInt32(b)); break;
          case 0xaa: b = stack.pop(); a = stack.pop(); stack.push(toInt32(a) ^ toInt32(b)); break;
          case 0xab: b = stack.pop(); a = stack.pop(); stack.push(looseEquals(a, b)); break;
          case 0xac: b = stack.pop(); a = stack.pop(); stack.push(a === b); break;
          case 0xad: b = stack.pop(); a = stack.pop(); stack.push(compare(a, b) === true); break;
          case 0xae: b = stack.pop(); a = stack.pop(); stack.push(compare(b, a) === false); break;
          case 0xaf: b = stack.pop(); a = stack.pop(); stack.push(compare(b, a) === true); break;
          case 0xb0: b = stack.pop(); a = stack.pop(); stack.push(compare(a, b) === false); break;
          case 0xc5: b = stack.pop(); a = stack.pop(); stack.push((toInt32(a) + toInt32(b)) | 0); break;
          case 0xc6: b = stack.pop(); a = stack.pop(); stack.push((toInt32(a) - toInt32(b)) | 0); break;
          case 0xc7: b = stack.pop(); a = stack.pop(); stack.push(Math.imul(toInt32(a), toInt32(b))); break;
          default:
            throw new Avm2Unsupported('avm2:unsupportedOpcode', 'Instruction ' + ins.name + ' (0x' + ins.op.toString(16) + ')');
        }
      }
    } catch (err) {
      if (err && typeof err === 'object' && !err.where && ins) err.where = label + ' at offset ' + ins.offset;
      throw err;
    }
  };

  Object.assign(M, {
    Avm2Runtime: Runtime, Avm2Klass: Klass, Avm2Object: AObject, Avm2Error: Avm2Error, Avm2Throw: Avm2Throw,
    Avm2Unsupported: Avm2Unsupported, avm2: {
      nsKey: nsKey, qkey: qkey, publicKey: publicKey, toNumber: toNumber, toInt32: toInt32, toUint32: toUint32,
      toBoolean: toBoolean, toStr: toStr, typeOf: typeOf, add: add, looseEquals: looseEquals, compare: compare,
      isObject: isObject, isFunction: isFunction, isClass: isClass, isInstance: isInstance, coerceTo: coerceTo
    }
  });
})(typeof window !== 'undefined' ? window : globalThis);
