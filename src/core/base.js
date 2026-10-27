/* RetroFlash.js - shared base for the player modules: the internal module namespace, the version, default
   budgets and player errors. Load order: src/modules.json. */
(function (global) {
  'use strict';

  // Modules register their exports here; retroflash.js removes the global once everything is loaded.
  var M = global.RetroFlashModules = {};

  var VERSION = '0.4.0';

  // Default budgets against hostile files.
  var MAX_NESTING = 32;           // nested sprite/button instances
  var MAX_INSTANCES = 100000;     // sprite/button instances created in one step (tick, seek, input event); hostile-file budget
  var DEFAULT_MAX_BITMAP_PIXELS = 4096 * 4096;
  var DEFAULT_MAX_TOTAL_BITMAP_PIXELS = 4 * DEFAULT_MAX_BITMAP_PIXELS; // about 256 MB of RGBA for all bitmaps of a movie
  // AVM1 budgets per tick: action blocks run and actions executed.
  var MAX_ACTION_BLOCKS = 10000;
  var MAX_ACTION_STEPS = 100000;

  function playerError(code, message) {
    var err = new Error('RetroFlash: ' + message);
    err.name = 'RetroFlashError';
    err.code = code;
    return err;
  }

  Object.assign(M, { VERSION: VERSION, MAX_NESTING: MAX_NESTING, MAX_INSTANCES: MAX_INSTANCES,
    DEFAULT_MAX_BITMAP_PIXELS: DEFAULT_MAX_BITMAP_PIXELS,
    DEFAULT_MAX_TOTAL_BITMAP_PIXELS: DEFAULT_MAX_TOTAL_BITMAP_PIXELS, MAX_ACTION_BLOCKS: MAX_ACTION_BLOCKS,
    MAX_ACTION_STEPS: MAX_ACTION_STEPS, playerError: playerError });
})(typeof window !== 'undefined' ? window : globalThis);
