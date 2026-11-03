/* RetroFlash.js - automatic playback for legacy Flash object/embed markup.
   Each Flash <object> or <embed> is replaced by a canvas that plays its SWF, embedded as the plugin was: the
   browser host (RetroFlash.createBrowserHost) opens the pages the movie asks for, calls page functions for
   javascript: URLs and ExternalInterface, sends FSCommands to `<id>_DoFSCommand`, and loads what scripts load
   under the browser's CORS rules. The element's size (pixels or percent) and parameters are honoured:
   movie/src/data, base, FlashVars, allowScriptAccess, allowNetworking, bgcolor, scale and salign. The canvas
   takes the element's id, its name in `document`, and the plugin's scripting methods (SetVariable, GotoFrame,
   CallFunction, ... and the movie's ExternalInterface callbacks; interop/plugin-api.js), so the page's own
   scripts keep working unchanged. Optional page settings: window.RetroFlashConfig (see the legacy object/embed
   markup API), including scaleMode, align and pixelRatio, which override the markup's, and trust,
   allowedFunctions, allowFSCommand, scriptUrls, executeScript (createBrowserHost), flashVars, flashVersion,
   projectorCommands and onFSCommand (the Player). The players are listed by RetroFlash.getInstances(). */
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

  // Every name and id of the element and its inner <embed>, without repeats.
  function namesOf(element) {
    var names = [element.id, element.getAttribute('name')], embeds = element.getElementsByTagName('embed');
    if (embeds.length) names.push(embeds[0].id, embeds[0].getAttribute('name'));
    return names.filter(function (name, i) { return name && names.indexOf(name) === i; });
  }

  function numericDimension(element, name, fallback) {
    var value = element.getAttribute(name);
    if (value && /^\d+(?:\.\d+)?$/.test(value)) return Math.max(1, Math.round(Number(value)));
    var rect = element.getBoundingClientRect();
    var dimension = name === 'width' ? rect.width : rect.height;
    return dimension > 0 ? Math.max(1, Math.round(dimension)) : fallback;
  }

  // The element's size as CSS, as the plugin took it: pixels ("1920", "1920px") or a percentage ("100%").
  function cssDimension(element, name, fallback) {
    var value = String(element.getAttribute(name) || '').trim();
    if (/^\d+(?:\.\d+)?(?:px)?$/i.test(value)) return Math.max(1, Math.round(parseFloat(value))) + 'px';
    if (/^\d+(?:\.\d+)?%$/.test(value)) return value;
    return numericDimension(element, name, fallback) + 'px';
  }

  // The `scale` parameter: showall (the plugin's default), noborder, exactfit or noscale.
  var SCALE_PARAMS = { showall: 'showAll', noborder: 'noBorder', exactfit: 'exactFit', noscale: 'noScale' };
  function scaleModeOf(value) { return SCALE_PARAMS[String(value || '').toLowerCase()] || 'showAll'; }
  // The `salign` parameter (T, B, L, R, TL, TR, BL, BR); anything else centres the movie.
  function alignOf(value) { return /^[TBLR]*$/i.test(String(value || '')) ? String(value || '').toUpperCase() : ''; }

  /* allowScriptAccess as the plugin read it: "always" allows scripting the page, "never" refuses it, and
     "sameDomain" (the default) allows it when the SWF comes from the page's origin; local files (file:) have no
     origin, so a local SWF on a local page counts as the same domain. */
  function scriptAccessOf(value, swfUrl) {
    value = String(value || 'sameDomain').toLowerCase();
    if (value === 'always') return true;
    if (value === 'never') return false;
    if (swfUrl.protocol === 'file:') return global.location.protocol === 'file:';
    return swfUrl.origin === global.location.origin;
  }

  /* FlashVars, as the plugin passed them to the root: the <param name="flashvars"> (or the <embed>'s attribute),
     then the query string of the movie URL, then RetroFlashConfig.flashVars (a query string or an object); a
     name given twice keeps its last value. */
  function flashVarsOf(element, swfUrl, extra) {
    var vars = paramOf(element, 'flashvars');
    var query = swfUrl.search.replace(/^\?/, '');
    var text = [vars, query].filter(Boolean).join('&');
    if (!extra) return text;
    var pairs = global.RetroFlash.internals.parseVariables(text);
    if (typeof extra === 'string') return pairs.concat(global.RetroFlash.internals.parseVariables(extra.replace(/^\?/, '')));
    return pairs.concat(Object.keys(extra).map(function (k) { return [k, String(extra[k])]; }));
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
    context.fillText('Could not load the SWF movie', canvas.width / 2, canvas.height / 2 - 8);
    context.font = '12px sans-serif';
    context.fillText(error.message.slice(0, 90), canvas.width / 2, canvas.height / 2 + 14);
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

    // The canvas keeps the element's size, in pixels or percent, and the movie is fitted into it by `scale`.
    var canvas = global.document.createElement('canvas');
    canvas.width = numericDimension(element, 'width', 300);
    canvas.height = numericDimension(element, 'height', 150);
    canvas.style.width = cssDimension(element, 'width', 300);
    canvas.style.height = cssDimension(element, 'height', 150);
    canvas.style.display = 'inline-block';
    canvas.style.border = '0';
    canvas.style.outline = 'none';
    canvas.style.backgroundColor = paramOf(element, 'bgcolor');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', element.getAttribute('title') || 'Flash movie');
    // The SWF path exactly as the replaced markup wrote it (movie param, data, src, or the inner <embed>).
    canvas.setAttribute('data-original-source', source);
    if (element.id) canvas.id = element.id;
    if (element.className) canvas.className = element.className;
    element.parentNode.replaceChild(canvas, element);
    /* The names the page reached the plugin by: document[name] for a named <embed> or <object> (and an
       <object id> with an <embed name> inside, one movie under two names). The canvas takes their place where
       the document does not already use the name. */
    namesOf(element).forEach(function (name) {
      if (name && !(name in global.document)) global.document[name] = canvas;
    });

    var playerReportedError = false;
    try {
      var location = global.location;
      // On file: pages the SWF loads only where the browser lets the page read local files (see host.js).
      if (!location || (location.protocol !== 'http:' && location.protocol !== 'https:' && location.protocol !== 'file:')) {
        throw new Error('Serve this page over HTTP or HTTPS to load a SWF automatically.');
      }
      var swfUrl = new URL(source, location.href);
      var base = paramOf(element, 'base');
      var host = global.RetroFlash.createBrowserHost({
        objectID: objectId,
        base: config.base || (base && base !== '.' ? new URL(base, location.href).href : base === '.' ? swfUrl.href : undefined),
        allowScriptAccess: config.allowScriptAccess !== undefined ? config.allowScriptAccess !== false : scriptAccessOf(paramOf(element, 'allowScriptAccess'), swfUrl),
        allowNetworking: config.allowNetworking || paramOf(element, 'allowNetworking') || 'all',
        trust: config.trust, allowedFunctions: config.allowedFunctions, allowFSCommand: config.allowFSCommand,
        scriptUrls: config.scriptUrls, executeScript: config.executeScript,
        rewriteUrl: config.rewriteUrl
      });
      var player = new global.RetroFlash.Player({
        canvas: canvas, autoplay: config.autoplay !== false, host: host, pixelRatio: config.pixelRatio,
        scaleMode: config.scaleMode || scaleModeOf(paramOf(element, 'scale')),
        align: config.align !== undefined ? config.align : alignOf(paramOf(element, 'salign')),
        flashVersion: config.flashVersion, projectorCommands: config.projectorCommands, onFSCommand: config.onFSCommand
      });
      player.on('error', function () { playerReportedError = true; });
      /* The plugin's scripting methods (SetVariable, GotoFrame, CallFunction, ...) and the movie's
         ExternalInterface callbacks become methods of the canvas, as they were of the plugin element:
         document.getElementById(id).name(args...). Destroying the player removes them. */
      global.RetroFlash.attachLegacyInterface(canvas, player);
      logInteractions(player);
      canvas.retroflashPlayer = player;
      if (typeof global.CustomEvent === 'function') {
        canvas.dispatchEvent(new global.CustomEvent('retroflash:player', { bubbles: true, detail: { player: player, element: element } }));
      }
      var name = swfUrl.pathname.split('/').pop();
      log('Loading "' + name + '".');
      host.load({ url: swfUrl.href, type: 'movie', method: null }).then(function (bytes) {
        return player.load(bytes, { url: swfUrl.href, variables: flashVarsOf(element, swfUrl, config.flashVars) });
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
