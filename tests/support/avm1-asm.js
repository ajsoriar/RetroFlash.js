'use strict';
// AVM1 bytecode written by hand (SWF 19 layouts): action records, Push operands, and a small assembler with labels
// for branches. Pure helpers, usable by the fixture builder without loading the player.

// A record with a payload (code >= 0x80): code, UI16 length, data.
const rec = (code, ...data) => [code, data.length & 0xff, data.length >> 8, ...data];
// A null-terminated UTF-8 string.
const str = (s) => [...Buffer.from(s, 'utf8'), 0];
// One Push operand for a JavaScript value: strings, integers, doubles (high word first), booleans, null, undefined.
function value(v) {
  if (v === undefined) return [3];
  if (v === null) return [2];
  if (typeof v === 'boolean') return [5, v ? 1 : 0];
  if (typeof v === 'string') return [0, ...str(v)];
  if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) return [7, v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
  const d = Buffer.alloc(8);
  d.writeDoubleLE(v);
  return [6, ...d.subarray(4), ...d.subarray(0, 4)];
}
const push = (...values) => rec(0x96, ...values.flatMap(value));

/* Assembles records and branches: items are byte arrays (records, possibly nested lists of them), { label },
   { jump: label } or { if: label }. Branch offsets are measured from the end of the branch record (5 bytes). */
function assemble(items) {
  items = items.map((item) => (Array.isArray(item) ? item.flat(Infinity) : item));
  const labels = {};
  let at = 0;
  for (const item of items) {
    if (item.label !== undefined) labels[item.label] = at;
    else at += item.jump !== undefined || item.if !== undefined ? 5 : item.length;
  }
  const out = [];
  for (const item of items) {
    if (item.label !== undefined) continue;
    const name = item.jump !== undefined ? item.jump : item.if;
    if (name === undefined) { out.push(...item); continue; }
    if (!(name in labels)) throw new Error('unknown label ' + name);
    const offset = labels[name] - (out.length + 5);
    out.push(...rec(item.jump !== undefined ? 0x99 : 0x9d, offset & 0xff, (offset >> 8) & 0xff));
  }
  return out;
}

module.exports = { rec, str, value, push, assemble };
