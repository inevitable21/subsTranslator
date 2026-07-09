'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const rtl = require('../rtl');

const RLE = '‫'; // Right-to-Left Embedding
const PDF = '‬'; // Pop Directional Formatting

test('markRtl wraps a single line in an RTL embedding', () => {
  assert.strictEqual(rtl.markRtl('שלום?'), RLE + 'שלום?' + PDF);
});

test('markRtl wraps each line of a multi-line cue independently', () => {
  const out = rtl.markRtl('שורה א\nשורה ב');
  assert.strictEqual(out, RLE + 'שורה א' + PDF + '\n' + RLE + 'שורה ב' + PDF);
});

test('markRtl leaves empty lines untouched', () => {
  assert.strictEqual(rtl.markRtl(''), '');
});

test('markCuesRtl marks every cue text and preserves timing', () => {
  const cues = [{ start: 0, end: 1000, text: 'שלום?' }];
  const out = rtl.markCuesRtl(cues);
  assert.strictEqual(out[0].text, RLE + 'שלום?' + PDF);
  assert.strictEqual(out[0].start, 0);
  assert.strictEqual(out[0].end, 1000);
});
