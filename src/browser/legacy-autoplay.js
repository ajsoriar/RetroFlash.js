/* RetroFlash.js - automatic playback for legacy Flash object/embed markup.
   Only same-origin HTTP(S) resources are loaded; cross-origin URLs and redirects are refused. */
(function (global) {
  'use strict';

  var MAX_FILE_BYTES = 50 * 1024 * 1024;
  var FLASH_CLASSID = 'd27cdb6e-ae6d-11cf-96b8-444553540000';

  function log(message) {
    if (!global.console) return;
    var write = global.console.info || global.console.log;
    if (write) write.call(global.console, '[RetroFlash.js] ' + message);
  }

  if (global.RetroFlash) log('v' + global.RetroFlash.version + ' ready — Canvas 2D player.');

  function movieParam(object) {
    var params = object.getElementsByTagName('param');
    for (var i = 0; i < params.length; i++) {
      if (String(params[i].getAttribute('name') || '').toLowerCase() === 'movie') {
        return params[i].getAttribute('value') || '';
      }
    }
    return '';
  }

  function embedSource(element) {
    var embeds = element.getElementsByTagName('embed');
    return embeds.length ? (embeds[0].getAttribute('src') || '') : '';
  }

  function sourceOf(element) {
    return movieParam(element) || element.getAttribute('data') || element.getAttribute('src') || embedSource(element);
  }

  function isFlashElement(element) {
    var type = String(element.getAttribute('type') || '').toLowerCase();
    var classid = String(element.getAttribute('classid') || '').toLowerCase();
    return type.indexOf('application/x-shockwave-flash') !== -1 || classid.indexOf(FLASH_CLASSID) !== -1 ||
      /\.swf(?:[?#]|$)/i.test(sourceOf(element));
  }

  function sameOriginUrl(value, base) {
    var location = global.location;
    if (!location || (location.protocol !== 'http:' && location.protocol !== 'https:')) {
      throw new Error('Serve this page over HTTP or HTTPS to load a SWF automatically.');
    }
    var url = new URL(value, base || location.href);
    if (url.origin !== location.origin) throw new Error('Only same-origin SWF resources can be loaded automatically.');
    return url;
  }

  async function fetchBytes(url) {
    var response = await global.fetch(url.href, {
      mode: 'same-origin', credentials: 'same-origin', redirect: 'error'
    });
    if (!response.ok) throw new Error('HTTP ' + response.status + ' while loading ' + url.pathname);
    var length = Number(response.headers.get('content-length'));
    if (length > MAX_FILE_BYTES) throw new Error('The file exceeds the 50 MiB automatic-load limit.');
    var bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('The file exceeds the 50 MiB automatic-load limit.');
    return bytes;
  }

  function numericDimension(element, name, fallback) {
    var value = element.getAttribute(name);
    if (value && /^\d+(?:\.\d+)?$/.test(value)) return Math.max(1, Math.round(Number(value)));
    var rect = element.getBoundingClientRect();
    var dimension = name === 'width' ? rect.width : rect.height;
    return dimension > 0 ? Math.max(1, Math.round(dimension)) : fallback;
  }

  function backgroundOf(element) {
    var params = element.getElementsByTagName('param');
    for (var i = 0; i < params.length; i++) {
      if (String(params[i].getAttribute('name') || '').toLowerCase() === 'bgcolor') {
        return params[i].getAttribute('value') || '';
      }
    }
    return element.getAttribute('bgcolor') || '';
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

  function mount(element) {
    if (!isFlashElement(element)) return;
    var source = sourceOf(element);
    if (!source) return;

    log('Detected <' + element.tagName.toLowerCase() + '> ' + (element.id ? '#' + element.id + ' ' : '') +
      'for "' + source + '" (' + numericDimension(element, 'width', 300) + 'x' +
      numericDimension(element, 'height', 150) + ').');

    var canvas = global.document.createElement('canvas');
    canvas.width = numericDimension(element, 'width', 300);
    canvas.height = numericDimension(element, 'height', 150);
    canvas.style.width = canvas.width + 'px';
    canvas.style.height = canvas.height + 'px';
    canvas.style.display = 'inline-block';
    canvas.style.backgroundColor = backgroundOf(element);
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', element.getAttribute('title') || 'Película Flash');
    if (element.id) canvas.id = element.id;
    if (element.className) canvas.className = element.className;
    element.parentNode.replaceChild(canvas, element);

    var playerReportedError = false;
    try {
      var swfUrl = sameOriginUrl(source, global.location.href);
      var player = new global.RetroFlash.Player({
        canvas: canvas,
        autoplay: true,
        loader: function (request) {
          var resourceUrl = sameOriginUrl(request.url, swfUrl.href);
          return fetchBytes(resourceUrl);
        }
      });
      player.on('error', function () { playerReportedError = true; });
      log('Loading "' + swfUrl.pathname.split('/').pop() + '".');
      fetchBytes(swfUrl).then(function (bytes) {
        return player.load(bytes);
      }).then(function (info) {
        if (info) log('Loaded "' + swfUrl.pathname.split('/').pop() + '": SWF ' + info.version + ', ' +
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
