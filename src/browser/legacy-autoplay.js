/* RetroFlash.js - automatic playback for legacy Flash object/embed markup.
   Each Flash <object> or <embed> is replaced by a canvas that plays its SWF, embedded as the plugin was: the
   browser host (RetroFlash.createBrowserHost) opens the pages the movie asks for, calls page functions for
   javascript: URLs and ExternalInterface, sends FSCommands to `<id>_DoFSCommand`, and loads what scripts load
   under the browser's CORS rules. The element's parameters are honoured: movie/src/data, base, FlashVars,
   allowScriptAccess, allowNetworking, bgcolor. Optional page settings: window.RetroFlashConfig (see
   src/README.md, "Legacy markup"). */
(function (global) {
  'use strict';

  var FLASH_CLASSID = 'd27cdb6e-ae6d-11cf-96b8-444553540000';

  function log(message) {
    if (!global.console) return;
    var write = global.console.info || global.console.log;
    if (write) write.call(global.console, '[RetroFlash.js] ' + message);
  }

  if (global.RetroFlash) log('v' + global.RetroFlash.version + ' ready — Canvas 2D player.');

  // A parameter of the element: a <param name> (any case) of an <object>, else an attribute of it or its <embed>.
  function paramOf(element, name) {
    var params = element.getElementsByTagName('param'), lower = name.toLowerCase();
    for (var i = 0; i < params.length; i++) {
      if (String(params[i].getAttribute('name') || '').toLowerCase() === lower) return params[i].getAttribute('value') || '';
    }
    if (element.hasAttribute(name)) return element.getAttribute(name) || '';
    var embeds = element.getElementsByTagName('embed');
    return embeds.length && embeds[0].hasAttribute(name) ? embeds[0].getAttribute(name) || '' : '';
  }

  function embedSource(element) {
    var embeds = element.getElementsByTagName('embed');
    return embeds.length ? (embeds[0].getAttribute('src') || '') : '';
  }

  function sourceOf(element) {
    return paramOf(element, 'movie') || element.getAttribute('data') || element.getAttribute('src') || embedSource(element);
  }

  function isFlashElement(element) {
    var type = String(element.getAttribute('type') || '').toLowerCase();
    var classid = String(element.getAttribute('classid') || '').toLowerCase();
    return type.indexOf('application/x-shockwave-flash') !== -1 || classid.indexOf(FLASH_CLASSID) !== -1 ||
      /\.swf(?:[?#]|$)/i.test(sourceOf(element));
  }

  // The name the page knows the movie by: the id, else the name of the element or its <embed>.
  function objectIdOf(element) {
    var embeds = element.getElementsByTagName('embed');
    return element.id || element.getAttribute('name') || (embeds.length && (embeds[0].id || embeds[0].getAttribute('name'))) || '';
  }

  function numericDimension(element, name, fallback) {
    var value = element.getAttribute(name);
    if (value && /^\d+(?:\.\d+)?$/.test(value)) return Math.max(1, Math.round(Number(value)));
    var rect = element.getBoundingClientRect();
    var dimension = name === 'width' ? rect.width : rect.height;
    return dimension > 0 ? Math.max(1, Math.round(dimension)) : fallback;
  }

  /* allowScriptAccess as the plugin read it: "always" allows scripting the page, "never" refuses it, and
     "sameDomain" (the default) allows it when the SWF comes from the page's origin. */
  function scriptAccessOf(value, swfUrl) {
    value = String(value || 'sameDomain').toLowerCase();
    if (value === 'always') return true;
    if (value === 'never') return false;
    return swfUrl.origin === global.location.origin;
  }

  // FlashVars, then the query string of the movie URL, as the plugin passed them to the root.
  function flashVarsOf(element, swfUrl) {
    var vars = paramOf(element, 'flashvars');
    var query = swfUrl.search.replace(/^\?/, '');
    return [vars, query].filter(Boolean).join('&');
  }

  function showError(canvas, error, source, report) {
    canvas.title = 'RetroFlash: ' + error.message;
    if (report && global.console && global.console.error) {
      global.console.error('[RetroFlash.js] Could not play "' + source + '": ' + error.message, error);
    }
    var context = canvas.getContext('2d');
    if (!context) return;
    context.fillStyle = '#f3f4f6';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#334155';
    context.font = '14px sans-serif';
    context.textAlign = 'center';
    context.fillText('No se pudo cargar la película SWF', canvas.width / 2, canvas.height / 2 - 8);
    context.font = '12px sans-serif';
    context.fillText(error.message.slice(0, 90), canvas.width / 2, canvas.height / 2 + 14);
  }

  /* Callbacks the movie registers with ExternalInterface.addCallback become methods of the canvas, as they were
     methods of the plugin element: document.getElementById(id).name(args...). */
  function exposeCallbacks(canvas, player) {
    var exposed = [];
    player.on('callbacks', function (names) {
      exposed.forEach(function (name) { if (names.indexOf(name) < 0) delete canvas[name]; });
      exposed = names.filter(function (name) { return !(name in canvas) || exposed.indexOf(name) >= 0; });
      exposed.forEach(function (name) {
        canvas[name] = function () { return player.callback(name, Array.prototype.slice.call(arguments)); };
      });
    });
  }

  function logInteractions(player) {
    player.on('navigate', function (r) { log('getURL ' + r.url + (r.target ? ' → ' + r.target : '') + (r.method ? ' (' + r.method + ')' : '')); });
    player.on('call', function (r) { log((r.kind === 'javascript' ? 'javascript: ' : 'ExternalInterface.call ') + (r.name || r.source)); });
    player.on('fscommand', function (r) { log('FSCommand ' + r.command + (r.args ? ' ' + r.args : '')); });
  }

  function mount(element) {
    if (!isFlashElement(element)) return;
    var source = sourceOf(element);
    if (!source) return;
    var config = global.RetroFlashConfig || {};
    var objectId = objectIdOf(element);

    log('Detected <' + element.tagName.toLowerCase() + '> ' + (objectId ? '#' + objectId + ' ' : '') +
      'for "' + source + '" (' + numericDimension(element, 'width', 300) + 'x' +
      numericDimension(element, 'height', 150) + ').');

    var canvas = global.document.createElement('canvas');
    canvas.width = numericDimension(element, 'width', 300);
    canvas.height = numericDimension(element, 'height', 150);
    canvas.style.width = canvas.width + 'px';
    canvas.style.height = canvas.height + 'px';
    canvas.style.display = 'inline-block';
    canvas.style.backgroundColor = paramOf(element, 'bgcolor');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', element.getAttribute('title') || 'Película Flash');
    if (element.id) canvas.id = element.id;
    if (element.className) canvas.className = element.className;
    element.parentNode.replaceChild(canvas, element);
    // An <embed name> was reachable as document[name]; the canvas takes its place.
    if (objectId && !element.id && !(objectId in global.document)) global.document[objectId] = canvas;

    var playerReportedError = false;
    try {
      var location = global.location;
      if (!location || (location.protocol !== 'http:' && location.protocol !== 'https:')) {
        throw new Error('Serve this page over HTTP or HTTPS to load a SWF automatically.');
      }
      var swfUrl = new URL(source, location.href);
      var base = paramOf(element, 'base');
      var host = global.RetroFlash.createBrowserHost({
        objectID: objectId,
        base: config.base || (base && base !== '.' ? new URL(base, location.href).href : base === '.' ? swfUrl.href : undefined),
        allowScriptAccess: config.allowScriptAccess !== undefined ? config.allowScriptAccess !== false : scriptAccessOf(paramOf(element, 'allowScriptAccess'), swfUrl),
        allowNetworking: config.allowNetworking || paramOf(element, 'allowNetworking') || 'all',
        rewriteUrl: config.rewriteUrl
      });
      var player = new global.RetroFlash.Player({ canvas: canvas, autoplay: config.autoplay !== false, host: host });
      player.on('error', function () { playerReportedError = true; });
      exposeCallbacks(canvas, player);
      logInteractions(player);
      canvas.retroflashPlayer = player;
      if (typeof global.CustomEvent === 'function') {
        canvas.dispatchEvent(new global.CustomEvent('retroflash:player', { bubbles: true, detail: { player: player, element: element } }));
      }
      var name = swfUrl.pathname.split('/').pop();
      log('Loading "' + name + '".');
      host.load({ url: swfUrl.href, type: 'movie', method: null }).then(function (bytes) {
        return player.load(bytes, { url: swfUrl.href, variables: flashVarsOf(element, swfUrl) });
      }).then(function (info) {
        if (info) log('Loaded "' + name + '": SWF ' + info.version + ', ' +
          info.width + 'x' + info.height + ', ' + info.fps + ' fps, ' + info.frameCount + ' frames.');
      }).catch(function (error) {
        showError(canvas, error, source, !playerReportedError);
      });
    } catch (error) {
      showError(canvas, error, source, !playerReportedError);
    }
  }

  function start() {
    var elements = global.document.querySelectorAll('object, embed');
    Array.prototype.forEach.call(elements, function (element) {
      if (element.tagName.toLowerCase() === 'embed' && element.parentElement &&
          element.parentElement.tagName.toLowerCase() === 'object') return;
      mount(element);
    });
  }

  if (global.document) {
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }
})(typeof window !== 'undefined' ? window : globalThis);
