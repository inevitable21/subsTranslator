'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const display = require('../display');

test('short line is left as a single line', () => {
  assert.strictEqual(display.formatCueText('שלום עולם'), 'שלום עולם');
});

test('long line is wrapped into two balanced lines that rejoin to the original', () => {
  const text = 'זהו משפט ארוך מאוד שצריך להישבר לשתי שורות כדי שיהיה נוח לקרוא אותו על המסך';
  const out = display.formatCueText(text);
  const lines = out.split('\n');
  assert.strictEqual(lines.length, 2);
  assert.ok(lines[0].length > 0 && lines[1].length > 0);
  assert.strictEqual(lines.join(' '), text);
  // reasonably balanced: neither line dwarfs the other
  assert.ok(Math.abs(lines[0].length - lines[1].length) <= text.length / 2);
});

test('dialogue is split into one line per speaker', () => {
  assert.strictEqual(display.formatCueText('- כן - לא'), '- כן\n- לא');
});

test('a leading dash with no second speaker is not treated as dialogue', () => {
  assert.strictEqual(display.formatCueText('- שלום'), '- שלום');
});

test('formatCues formats text and preserves timing', () => {
  const cues = [{ start: 0, end: 1000, text: 'שלום' }];
  const out = display.formatCues(cues);
  assert.strictEqual(out[0].text, 'שלום');
  assert.strictEqual(out[0].start, 0);
  assert.strictEqual(out[0].end, 1000);
});
