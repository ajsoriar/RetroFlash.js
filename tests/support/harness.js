'use strict';
// Minimal dependency-free test harness: test(name, fn) registers, run() executes sequentially.
const assert = require('assert');

const tests = [];
let currentGroup = '';

function group(name) { currentGroup = name; }
function test(name, fn) { tests.push({ group: currentGroup, name, fn }); }

// Resolves when `promise` rejects with an SWFReaderError carrying `code`.
async function rejectsWithCode(promise, code) {
  let error = null;
  try { await promise; } catch (err) { error = err; }
  assert.ok(error, 'expected rejection with ' + code + ' but the promise resolved');
  assert.strictEqual(error.name, 'SWFReaderError', 'unexpected error: ' + (error && error.stack));
  assert.strictEqual(error.code, code, 'error message: ' + error.message);
  assert.ok(/^SWFReader: /.test(error.message), 'message prefix');
  return error;
}

function throwsWithCode(fn, code) {
  assert.throws(fn, (err) => err.name === 'SWFReaderError' && err.code === code);
}

async function run() {
  let failed = 0, shownGroup = null;
  for (const { group: groupName, name, fn } of tests) {
    if (groupName !== shownGroup) { console.log((shownGroup === null ? '' : '\n') + groupName); shownGroup = groupName; }
    try {
      await fn();
      console.log('  ok   ' + name);
    } catch (err) {
      failed++;
      console.log('  FAIL ' + name);
      console.log(String(err && err.stack || err).replace(/^/gm, '       '));
    }
  }
  console.log('\n' + (tests.length - failed) + ' passed, ' + failed + ' failed, ' + tests.length + ' total');
  return failed;
}

module.exports = { group, test, run, assert, rejectsWithCode, throwsWithCode };
