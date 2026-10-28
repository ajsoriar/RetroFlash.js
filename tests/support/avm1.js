'use strict';
// Helpers for AVM1 tests: action records written by hand (SWF 19 layouts), a small assembler with labels for
// branches, and a runner that executes one action block in an Activation.
const { RetroFlash } = require('./load-reader');
const { rec, str, value, push, assemble } = require('./avm1-asm');

const I = RetroFlash.internals;

/* Runs one block. opts: { version (6), limits, random, clip (null), trace }. With `trace`, the result lists
   the offsets of the records executed, in order. */
function exec(records, opts = {}) {
  const reported = [], trace = [], version = opts.version || 6;
  const scheduler = {
    version, limits: I.resolveLimits(opts.limits), steps: 0, report: (feature) => reported.push(feature),
    random: opts.random || Math.random
  };
  const act = new I.Activation(scheduler, opts.clip || null, new I.ActionCode(Uint8Array.from(records.flat(Infinity)), version), 'test');
  if (opts.trace) {
    const step = act.step.bind(act);
    act.step = (action) => { trace.push(action.offset); return step(action); };
  }
  act.run();
  return { act, reported, trace, steps: scheduler.steps, stack: Array.from(act.stack), registers: Array.from(act.rt.registers) };
}

module.exports = { I, rec, str, value, push, assemble, exec };
