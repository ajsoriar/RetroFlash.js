/* RetroFlash.js - The browser host: RetroFlash.createBrowserHost(options) does what a movie asks of the page
   that embeds it (the Player option `host`, see avm1/external.js) with the browser's own APIs, under the
   browser's security rules, as the Flash Player plugin did:
   - navigate: getURL opens the URL in a window (window.open), replaces the page (location.assign) or submits
     the variables of a POST as a form;
   - call: javascript: URLs and ExternalInterface.call call a page function by name (`panorama`, `a.b.f`) with
     the arguments the movie gives; nothing is ever evaluated as code;
   - fscommand: calls the page's `<objectID>_DoFSCommand(command, args)`;
   - load: fetches what scripts load (loadMovie, loadVariables). Cross-origin responses can only be read when
     the server allows it (CORS); an image the page may show but not read is shown as it is.
   Relative URLs resolve against `base` (by default the page, as in Flash Player). */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;

  var MAX_FILE_BYTES = 50 * 1024 * 1024;
  var CURRENT_PAGE = { '': 1, _self: 1, _parent: 1, _top: 1 };
  // Property names a call may not go through: they reach the constructors that turn text into code.
  var FORBIDDEN_NAMES = { constructor: 1, prototype: 1, __proto__: 1, __defineGetter__: 1, __defineSetter__: 1 };

  function hostError(code, message) {
    var err = new Error(message);
    err.code = code;
    return err;
  }

  /* options:
     - base: the URL relative URLs resolve against (default: the page's base URL);
     - objectID: the embedding element's id or name (ExternalInterface.objectID, `<objectID>_DoFSCommand`);
     - allowScriptAccess: false refuses javascript: URLs, ExternalInterface, FSCommand and navigating the page
       itself (`_self`, `_parent`, `_top`), as the `allowScriptAccess` parameter did (default true);
     - allowNetworking: 'all' (default); 'internal' also refuses opening pages; 'none' refuses loads as well;
     - rewriteUrl(url, request): returns the URL to use instead of `url` (already resolved), for example a local
       copy of a remote resource; anything else keeps it;
     - maxFileBytes: largest response read (default 50 MiB);
     - window: the window to act on (default the global one). */
  function createBrowserHost(options) {
    options = options || {};
    var win = options.window || global;
    var scriptAccess = options.allowScriptAccess !== false;
    var networking = String(options.allowNetworking || 'all').toLowerCase();
    var maxFileBytes = options.maxFileBytes || MAX_FILE_BYTES;
    var rewrite = typeof options.rewriteUrl === 'function' ? options.rewriteUrl : null;
    function base() {
      return options.base || (win.document && win.document.baseURI) || (win.location && win.location.href) || undefined;
    }
    function resolve(url, request) {
      var href;
      try { href = new URL(url, base()).href; } catch (err) { throw hostError('INVALID_URL', 'Not a valid URL: ' + url); }
      if (rewrite) {
        var replaced = rewrite(href, request);
        if (typeof replaced === 'string' && replaced && replaced !== href) {
          try { href = new URL(replaced, base()).href; } catch (err) { throw hostError('INVALID_URL', 'rewriteUrl gave a URL that is not valid: ' + replaced); }
        }
      }
      return new URL(href);
    }
    function origin() { return win.location ? win.location.origin : null; }
    function requireScriptAccess(what) {
      if (!scriptAccess) throw hostError('BLOCKED', 'allowScriptAccess does not let the movie ' + what + '.');
      if (networking !== 'all') throw hostError('BLOCKED', 'allowNetworking="' + networking + '" does not let the movie ' + what + '.');
    }

    // A POST to a window: a hidden form with the variables, submitted to the target.
    function submitForm(url, target, pairs) {
      var doc = win.document, form = doc.createElement('form');
      form.method = 'POST';
      form.action = url.href;
      if (target) form.target = target;
      form.style.display = 'none';
      pairs.forEach(function (p) {
        var input = doc.createElement('input');
        input.type = 'hidden';
        input.name = p[0];
        input.value = p[1];
        form.appendChild(input);
      });
      (doc.body || doc.documentElement).appendChild(form);
      try { form.submit(); } finally { if (form.parentNode) form.parentNode.removeChild(form); }
    }
    // Functions that run text as code, or arguments that would make a call do it: never called.
    function runsText(fn, args) {
      if (fn === win.eval || fn === win.Function || (win.execScript && fn === win.execScript)) return true;
      if ((fn === win.setTimeout || fn === win.setInterval) && typeof args[0] !== 'function') return true;
      var doc = win.document;
      if (doc && (fn === doc.write || fn === doc.writeln)) return true;
      return args.some(function (a) { return typeof a === 'string' && /^\s*javascript:/i.test(a); });
    }

    var host = {
      objectID: options.objectID ? String(options.objectID) : null,
      allowScriptAccess: scriptAccess,
      allowNetworking: networking,
      resolve: function (url) { return resolve(url, null).href; },

      navigate: function (request) {
        if (networking !== 'all') throw hostError('BLOCKED', 'allowNetworking="' + networking + '" does not let the movie open pages.');
        var target = String(request.target || ''), url = resolve(request.url, request);
        if (url.protocol === 'javascript:') throw hostError('BLOCKED', 'javascript: URLs are calls, not pages to open.');
        if (!scriptAccess && CURRENT_PAGE[target.toLowerCase()]) throw hostError('BLOCKED', 'allowScriptAccess does not let the movie replace this page.');
        if (request.method === 'POST') return submitForm(url, target, request.variables || []);
        if (!target || target.toLowerCase() === '_self') win.location.assign(url.href);
        else if (win.open(url.href, target) === null) throw hostError('BLOCKED', 'The browser refused to open ' + url.href + ' in "' + target + '".');
      },

      call: function (request) {
        requireScriptAccess('call the page');
        if (!request.name) throw hostError('UNSUPPORTED', 'Only calls of page functions with literal arguments are run from javascript: URLs; this one was not run.');
        var parts = String(request.name).split('.'), owner = null, fn = win, args = request.args || [];
        for (var i = 0; i < parts.length; i++) {
          if (!/^[A-Za-z_$][\w$]*$/.test(parts[i]) || FORBIDDEN_NAMES[parts[i]]) throw hostError('BLOCKED', request.name + ' is not a function name the movie may call.');
          owner = fn;
          if (owner === null || owner === undefined) break;
          try { fn = owner[parts[i]]; } catch (err) { fn = undefined; }
        }
        if (typeof fn !== 'function') throw hostError('FUNCTION_MISSING', 'The page has no function ' + request.name + '.');
        if (runsText(fn, args)) throw hostError('BLOCKED', request.name + ' would run text as code; it is never called.');
        try {
          return fn.apply(owner, args);
        } catch (err) {
          throw hostError('CALL_FAILED', request.name + ' failed: ' + (err && err.message ? err.message : String(err)));
        }
      },

      fscommand: function (request) {
        requireScriptAccess('send FSCommands');
        var name = (host.objectID || '') + '_DoFSCommand', handler = host.objectID ? win[name] : null;
        if (typeof handler !== 'function') throw hostError('FUNCTION_MISSING', 'The page has no ' + (host.objectID ? name : '<objectID>_DoFSCommand') + ' function for FSCommand "' + request.command + '".');
        try {
          handler.call(win, request.command, request.args);
        } catch (err) {
          throw hostError('CALL_FAILED', name + ' failed: ' + (err && err.message ? err.message : String(err)));
        }
      },

      load: function (request) {
        if (networking === 'none') return Promise.reject(hostError('LOAD_BLOCKED', 'allowNetworking="none" does not let the movie load ' + request.url + '.'));
        var url;
        try { url = resolve(request.url, request); } catch (err) { return Promise.reject(err); }
        var crossOrigin = url.origin !== origin(), method = request.method || 'GET';
        var init = { method: method, mode: 'cors', credentials: 'same-origin', redirect: 'follow' };
        if (method === 'POST') {
          init.body = request.body || '';
          init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
        }
        return Promise.resolve().then(function () { return win.fetch(url.href, init); }).then(function (response) {
          if (!response.ok) throw hostError('LOAD_HTTP', 'HTTP ' + response.status + ' for ' + url.href);
          var length = Number(response.headers && response.headers.get('content-length'));
          if (length > maxFileBytes) throw hostError('LOAD_TOO_LARGE', url.href + ' is larger than ' + maxFileBytes + ' bytes.');
          return response.arrayBuffer().then(function (bytes) {
            if (bytes.byteLength > maxFileBytes) throw hostError('LOAD_TOO_LARGE', url.href + ' is larger than ' + maxFileBytes + ' bytes.');
            return bytes;
          });
        }, function (err) {
          var failure = crossOrigin
            ? hostError('LOAD_CORS', url.origin + ' did not let this page read ' + url.href + ' (CORS), or could not be reached.')
            : hostError('LOAD_NETWORK', url.href + ' could not be reached (' + (err && err.message ? err.message : err) + ').');
          // The browser may still show a cross-origin image it does not let the page read.
          if (!crossOrigin || request.type !== 'movie' || method !== 'GET' || typeof win.Image !== 'function') throw failure;
          return loadImage(win, url.href).catch(function () { throw failure; });
        });
      }
    };
    return host;
  }
  // An image element the browser decoded; its pixels cannot be read by the page when it is cross-origin.
  function loadImage(win, href) {
    return new Promise(function (resolve, reject) {
      var image = new win.Image();
      image.decoding = 'async';
      image.onload = function () { resolve(image); };
      image.onerror = function () { reject(new Error('not an image')); };
      image.src = href;
    });
  }

  Object.assign(M, { createBrowserHost: createBrowserHost });
})(typeof window !== 'undefined' ? window : globalThis);
