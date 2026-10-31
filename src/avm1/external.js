/* RetroFlash.js - What a movie asks of the page that embeds it: getURL to a window, javascript: URLs,
   FSCommand and ExternalInterface. The player never navigates, runs page code or fetches anything itself: every
   request goes to the host page's `host` object, after the Player's
   cancelable events. A javascript: URL is never evaluated: it is read as calls of page functions by name with
   literal arguments, and anything else is handed to the host as text it may refuse. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;
  var UNKNOWN_VALUE = M.UNKNOWN_VALUE, AvmObject = M.AvmObject, AvmArray = M.AvmArray, isObject = M.isObject,
    isFunction = M.isFunction, isClip = M.isClip, getMember = M.getMember, setMember = M.setMember, keysOf = M.keysOf,
    toAvmString = M.toAvmString, MAX_ARRAY_INDEX = M.MAX_ARRAY_INDEX;

  var METHODS = [null, 'GET', 'POST'];
  var MAX_HOST_DEPTH = 64;       // nesting of objects and arrays passed to or from the page; deeper values are null
  var MAX_SCRIPT_LENGTH = 4096;  // javascript: URLs longer than this are not read as calls

  function isScriptURL(url) { return /^\s*javascript:/i.test(url); }
  // The command of an "FSCommand:command" URL (any case), or null.
  function fsCommandOf(url) {
    return /^fscommand:/i.test(url) ? url.slice(10) : null;
  }

  /* ---- javascript: URLs ----
     The text after "javascript:" (percent-decoded, as the browser does) read as statements separated by ";":
     calls `name(arg, ...)` or `a.b.name(...)` whose arguments are literals (numbers, strings, true, false, null,
     undefined), and `void expression`. Returns [{ name, args }] in order, or null when the text is anything
     else: it is then never run as code. */
  function parseScriptURL(url) {
    var m = /^\s*javascript:/i.exec(url);
    if (!m) return null;
    var source = url.slice(m[0].length);
    if (source.length > MAX_SCRIPT_LENGTH) return null;
    if (/%[0-9a-f]{2}/i.test(source)) {
      try {
        source = decodeURIComponent(source);
      } catch (err) {
        source = source.replace(/%([0-9a-f]{2})/gi, function (all, hex) { return String.fromCharCode(parseInt(hex, 16)); });
      }
    }
    return new ScriptReader(source).program();
  }
  function ScriptReader(source) { this.s = source; this.i = 0; }
  ScriptReader.prototype.space = function () {
    while (this.i < this.s.length && /\s/.test(this.s.charAt(this.i))) this.i++;
  };
  ScriptReader.prototype.eat = function (c) {
    this.space();
    if (this.s.charAt(this.i) !== c) return false;
    this.i++;
    return true;
  };
  ScriptReader.prototype.word = function () {
    this.space();
    var m = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i));
    if (!m) return null;
    this.i += m[0].length;
    return m[0];
  };
  ScriptReader.prototype.program = function () {
    var calls = [];
    for (;;) {
      while (this.eat(';')) { /* empty statements */ }
      this.space();
      if (this.i >= this.s.length) return calls;
      if (!this.statement(calls)) return null;
      this.space();
      if (this.i < this.s.length && !this.eat(';')) return null;
    }
  };
  // A call, or `void expression` (`void 0`, `void(0)`, `void(f(1))`).
  ScriptReader.prototype.statement = function (calls) {
    var start = this.i;
    if (this.word() === 'void') {
      var open = this.eat('(');
      if (!this.expression(calls)) return false;
      return !open || this.eat(')');
    }
    this.i = start;
    var e = this.expression(calls);
    return !!e && e.call === true;
  };
  ScriptReader.prototype.expression = function (calls) {
    var literal = this.literal();
    if (literal) return literal;
    var name = this.word();
    if (!name) return null;
    while (this.eat('.')) {
      var part = this.word();
      if (!part) return null;
      name += '.' + part;
    }
    if (!this.eat('(')) return null;
    var args = [];
    if (!this.eat(')')) {
      do {
        var arg = this.literal();
        if (!arg) return null;
        args.push(arg.value);
      } while (this.eat(','));
      if (!this.eat(')')) return null;
    }
    calls.push({ name: name, args: args });
    return { call: true };
  };
  var WORDS = { 'true': true, 'false': false, 'null': null, 'undefined': undefined, NaN: NaN, Infinity: Infinity };
  var ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
  // A literal { value }, or null.
  ScriptReader.prototype.literal = function () {
    this.space();
    var rest = this.s.slice(this.i), m = /^([+-]?)(?:0[xX]([0-9a-fA-F]+)|((?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?))(?![\w$.])/.exec(rest);
    if (m) {
      this.i += m[0].length;
      var n = m[2] !== undefined ? parseInt(m[2], 16) : Number(m[3]);
      return { value: m[1] === '-' ? -n : n };
    }
    m = /^(true|false|null|undefined|NaN|Infinity)(?![\w$.(])/.exec(rest);
    if (m) {
      this.i += m[0].length;
      return { value: WORDS[m[1]] };
    }
    var quote = rest.charAt(0);
    if (quote !== '"' && quote !== "'") return null;
    var out = '';
    for (var j = 1; j < rest.length; j++) {
      var c = rest.charAt(j);
      if (c === quote) { this.i += j + 1; return { value: out }; }
      if (c === '\n' || c === '\r') return null;
      if (c !== '\\') { out += c; continue; }
      c = rest.charAt(++j);
      if ((m = /^u([0-9a-fA-F]{4})/.exec(rest.slice(j))) || (m = /^x([0-9a-fA-F]{2})/.exec(rest.slice(j)))) {
        out += String.fromCharCode(parseInt(m[1], 16));
        j += m[0].length - 1;
      } else {
        out += ESCAPES.hasOwnProperty(c) ? ESCAPES[c] : c;
      }
    }
    return null;
  };

  // ---- Variables sent with a request (getURL, loadMovie and loadVariables with GET or POST) ----

  /* [[name, value], ...]: every enumerable variable or member of `scope` (a timeline, or the locals of a
     function), converted to a string, as Flash Player sends them. */
  function variablesOf(rt, scope, version) {
    if (!rt || !(isObject(scope) || isClip(scope))) return [];
    var pairs = [];
    keysOf(rt, scope).forEach(function (name) {
      var value = getMember(rt, scope, name);
      if (value !== UNKNOWN_VALUE) pairs.push([name, toAvmString(value, version)]);
    });
    return pairs;
  }
  // application/x-www-form-urlencoded, UTF-8.
  function encodeForm(pairs) {
    return pairs.map(function (p) {
      return encodeURIComponent(p[0]).replace(/%20/g, '+') + '=' + encodeURIComponent(p[1]).replace(/%20/g, '+');
    }).join('&');
  }
  /* Adds `pairs` to a request with a method: appended to the URL for GET (after "?" or "&"), as the body for
     POST. Sets `variables` (the pairs) and, for POST, `body`. */
  function addForm(request, pairs) {
    request.variables = pairs;
    var form = encodeForm(pairs);
    if (request.method === 'GET') {
      if (form) request.url += (request.url.indexOf('?') >= 0 ? '&' : '?') + form;
    } else {
      request.body = form;
    }
    return request;
  }

  // ---- Values passed to and from the page (ExternalInterface) ----

  /* An AVM1 value as a JavaScript value for the page: primitives as they are, arrays as arrays, objects and
     movie clips as plain objects of their enumerable members; functions and cycles are null. */
  function toHostValue(rt, value, depth, seen) {
    if (value === UNKNOWN_VALUE) return undefined;
    if (value === null || typeof value !== 'object') return value;
    if (isObject(value) && 'primitive' in value) return value.primitive;
    if (isFunction(value)) return null;
    depth = depth || 0;
    seen = seen || [];
    if (depth >= MAX_HOST_DEPTH || seen.indexOf(value) >= 0 || !(isObject(value) || isClip(value))) return null;
    seen.push(value);
    try {
      if (value instanceof AvmArray) {
        var list = new Array(value.items.length);
        for (var i = 0; i < value.items.length; i++) list[i] = toHostValue(rt, value.items[i], depth + 1, seen);
        return list;
      }
      var out = {};
      keysOf(rt, value).forEach(function (name) {
        Object.defineProperty(out, name, {
          value: toHostValue(rt, getMember(rt, value, name), depth + 1, seen), enumerable: true, writable: true, configurable: true
        });
      });
      return out;
    } finally {
      seen.pop();
    }
  }
  /* A JavaScript value from the page as an AVM1 value: primitives as they are (a BigInt as a number), arrays as
     arrays, other objects as objects of their own enumerable properties; functions and symbols are undefined,
     cycles and properties that cannot be read are null. */
  function fromHostValue(rt, value, depth, seen) {
    switch (typeof value) {
      case 'undefined': case 'boolean': case 'number': case 'string': return value;
      case 'bigint': return Number(value);
      case 'object': break;
      default: return undefined;
    }
    if (value === null) return null;
    depth = depth || 0;
    seen = seen || [];
    if (depth >= MAX_HOST_DEPTH || seen.indexOf(value) >= 0) return null;
    seen.push(value);
    try {
      if (Array.isArray(value)) {
        return rt.array(value.slice(0, MAX_ARRAY_INDEX).map(function (item) { return fromHostValue(rt, item, depth + 1, seen); }));
      }
      var obj = new AvmObject(rt.protos.Object);
      Object.keys(value).forEach(function (name) {
        var item;
        try { item = value[name]; } catch (err) { item = null; }
        setMember(rt, obj, name, fromHostValue(rt, item, depth + 1, seen));
      });
      return obj;
    } catch (err) {
      return null;
    } finally {
      seen.pop();
    }
  }

  // ---- The bridge to the host page ----

  // Errors a host throws, by `code`: the feature they are reported as.
  var HOST_ERRORS = {
    BLOCKED: 'browser:blocked', INVALID_URL: 'browser:invalidURL', FUNCTION_MISSING: 'browser:functionMissing',
    UNSUPPORTED: 'browser:javascriptUnsupported', CALL_FAILED: 'browser:callFailed'
  };
  /* A request handed to the Player's listeners and then to the host. A listener that calls preventDefault()
     handles it itself; for a call it may set `result`, the value the movie gets. */
  function hostRequest(fields) {
    var prevented = false, request = Object.assign({}, fields);
    Object.defineProperty(request, 'defaultPrevented', { get: function () { return prevented; } });
    Object.defineProperty(request, 'preventDefault', { value: function () { prevented = true; } });
    return request;
  }

  /* The movie's link to the page (env.host, shared with the ActionScheduler as `scheduler.host`).
     - host: the Player option `host`, an object with any of navigate(request), call(request), fscommand(request)
       and objectID; null when the page gave none.
     - report(feature, reason, source): the movie's report function.
     - dispatch(type, request): the Player's events ('navigate', 'call', 'fscommand'); false when a listener
       prevented the default action.
     ExternalInterface is available when there is a host. Callbacks registered by ExternalInterface.addCallback
     live here; `onCallbacks(names)` hears when they change. */
  function HostBridge(host, report, dispatch, interaction) {
    this.host = host && typeof host === 'object' ? host : null;
    this.report = report || function () {};
    this.dispatch = typeof dispatch === 'function' ? dispatch : null;
    this.interaction = typeof interaction === 'function' ? interaction : null;
    this.available = !!this.host;
    this.objectID = this.host && typeof this.host.objectID === 'string' && this.host.objectID ? this.host.objectID : null;
    this.callbacks = new Map(); // name -> { fn, thisValue }
    this.onCallbacks = null;
  }
  // Hands a request to the listeners, then to host[method]. Returns { value } when the host (or a listener)
  // handled it, or null.
  HostBridge.prototype.send = function (type, method, request, detail, noHost) {
    var interaction = { direction: 'outgoing', channel: type, status: 'requested' };
    if (type === 'navigate') {
      interaction.url = String(request.url || '').split(/[?#]/)[0];
      interaction.target = request.target || '';
      interaction.method = request.method || 'GET';
      interaction.variableCount = request.variables ? request.variables.length : 0;
    } else if (type === 'call') {
      interaction.callType = request.kind || '';
      interaction.name = request.name || '';
      interaction.argumentCount = request.args ? request.args.length : 0;
    } else if (type === 'fscommand') {
      interaction.command = request.command || '';
      interaction.hasArguments = !!request.args;
    }
    if (this.dispatch && !this.dispatch(type, request)) {
      interaction.status = 'handled';
      if (this.interaction) this.interaction(interaction);
      return { value: request.result };
    }
    var fn = this.host && this.host[method];
    if (typeof fn !== 'function') {
      interaction.status = 'no-host';
      if (this.interaction) this.interaction(interaction);
      this.report('browser:noHost', noHost, detail);
      return null;
    }
    try {
      var value = fn.call(this.host, request);
      interaction.status = 'accepted';
      if (this.interaction) this.interaction(interaction);
      return { value: value };
    } catch (err) {
      var code = err && err.code, message = err && err.message ? err.message : String(err);
      interaction.status = 'failed';
      interaction.errorCode = code || 'CALL_FAILED';
      if (this.interaction) this.interaction(interaction);
      this.report(HOST_ERRORS[code] || 'browser:callFailed', message, detail);
      return null;
    }
  };
  // getURL to a window: { url, target, method, variables?, body? }.
  HostBridge.prototype.navigate = function (request) {
    var r = hostRequest(request);
    this.send('navigate', 'navigate', r, r.url + (r.target ? ' → ' + r.target : ''),
      'The movie opens a page (getURL), but the host page handles no navigation (the Player option `host`); ignored.');
  };
  // A call of a page function: { kind: 'javascript' | 'external', name, args, source }. Returns { value } or null.
  HostBridge.prototype.call = function (request) {
    var r = hostRequest(request);
    return this.send('call', 'call', r, r.kind === 'javascript' ? r.source : r.name,
      'The movie calls the page (' + (r.kind === 'javascript' ? 'a javascript: URL' : 'ExternalInterface.call') + '), but the host page handles no calls (the Player option `host`); ignored.');
  };
  // A javascript: URL: each call it holds, in order; text that is not calls goes to the host with name null.
  HostBridge.prototype.script = function (url) {
    var calls = parseScriptURL(url), self = this;
    if (!calls) return this.call({ kind: 'javascript', name: null, args: [], source: url });
    calls.forEach(function (c) { self.call({ kind: 'javascript', name: c.name, args: c.args, source: url }); });
  };
  HostBridge.prototype.fscommand = function (command, args) {
    var r = hostRequest({ command: command, args: args });
    this.send('fscommand', 'fscommand', r, command + (args ? ' ' + args : ''),
      'The movie sends an FSCommand, but the host page handles none (the Player option `host`); ignored.');
  };
  HostBridge.prototype.addCallback = function (name, thisValue, fn) {
    this.callbacks.set(name, { fn: fn, thisValue: thisValue });
    if (this.interaction) this.interaction({ direction: 'outgoing', channel: 'ExternalInterface.addCallback', status: 'registered', name: name });
    if (this.onCallbacks) this.onCallbacks(Array.from(this.callbacks.keys()));
  };
  // The bridge of a scheduler; one without a host when the scheduler has none (tests, tools).
  function hostOf(scheduler) {
    return scheduler.host || (scheduler.host = new HostBridge(null, scheduler.report));
  }

  /* getURL to a window, from a script: an FSCommand, a javascript: URL (calls of page functions), or a page to
     open in `target`. With a method (1 GET, 2 POST) the variables of `scope` go with it. An empty URL does
     nothing, as in Flash Player. */
  function openURL(scheduler, url, target, method, scope, version) {
    if (url === '') return;
    var host = hostOf(scheduler), command = fsCommandOf(url);
    if (command !== null) return host.fscommand(command, target);
    if (isScriptURL(url)) return host.script(url);
    var request = { url: url, target: target, method: METHODS[method] || null };
    if (request.method) addForm(request, variablesOf(scheduler.runtime, scope, version));
    host.navigate(request);
  }

  Object.assign(M, {
    HostBridge: HostBridge, hostOf: hostOf, openURL: openURL, parseScriptURL: parseScriptURL, isScriptURL: isScriptURL,
    fsCommandOf: fsCommandOf, variablesOf: variablesOf, encodeForm: encodeForm, addForm: addForm,
    toHostValue: toHostValue, fromHostValue: fromHostValue
  });
})(typeof window !== 'undefined' ? window : globalThis);
