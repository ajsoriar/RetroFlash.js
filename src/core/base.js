/* RetroFlash.js - shared base for the player modules: the internal module namespace, the version, limits and
   player errors. Load order: src/modules.json. */
(function (global) {
  'use strict';

  // Modules register their exports here; retroflash.js removes the global once everything is loaded.
  var M = global.RetroFlashModules = {};

  var VERSION = '0.4.0';

  // Default budgets against hostile files. Each one can be set by the Player option of the same name.
  var DEFAULT_LIMITS = Object.freeze({
    maxNesting: 32,                         // nested sprite/button instances
    maxInstances: 100000,                   // sprite/button instances created in one step (tick, seek, input event)
    maxBitmapPixels: 4096 * 4096,           // pixels of one bitmap
    maxTotalBitmapPixels: 4 * 4096 * 4096,  // pixels of all bitmaps of a movie together (about 256 MB of RGBA)
    maxAudioSamples: 64 * 1024 * 1024,      // decoded sound samples of a movie together (about 256 MB as 32-bit floats)
    maxActionBlocks: 10000,                 // AVM1 action blocks run per tick or input event
    maxActionSteps: 100000,                 // AVM1 actions executed per tick or input event
    maxActionStack: 100000,                 // values on the stack of one AVM1 action block
    maxCallDepth: 256                       // nested AVM1 function calls (Flash Player also stops at 256)
  });

  function playerError(code, message) {
    var err = new Error('RetroFlash: ' + message);
    err.name = 'RetroFlashError';
    err.code = code;
    return err;
  }

  // The limits named in `options`, each a positive integer; missing ones (undefined or null) take the default.
  function resolveLimits(options) {
    var limits = {};
    Object.keys(DEFAULT_LIMITS).forEach(function (key) {
      var value = options ? options[key] : undefined;
      if (value === undefined || value === null) value = DEFAULT_LIMITS[key];
      else if (!Number.isInteger(value) || value < 1) throw playerError('INVALID_OPTION', 'options.' + key + ' must be a positive integer');
      limits[key] = value;
    });
    return Object.freeze(limits);
  }

  Object.assign(M, { VERSION: VERSION, DEFAULT_LIMITS: DEFAULT_LIMITS, playerError: playerError, resolveLimits: resolveLimits });
})(typeof window !== 'undefined' ? window : globalThis);
