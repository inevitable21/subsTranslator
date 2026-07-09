'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const srt = require('../srt');

test('parse SRT into cues', () => {
  const input = '1\n00:00:01,000 --> 00:00:02,500\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nWorld';
  const cues = srt.parse(input);
  assert.strictEqual(cues.length, 2);
  assert.strictEqual(cues[0].start, 1000);
  assert.strictEqual(cues[0].end, 2500);
  assert.strictEqual(cues[0].text, 'Hello');
  assert.strictEqual(cues[1].text, 'World');
});

test('parse keeps multi-line cue text', () => {
  const input = '1\n00:00:01,000 --> 00:00:02,000\nLine A\nLine B';
  const cues = srt.parse(input);
  assert.strictEqual(cues[0].text, 'Line A\nLine B');
});

test('serialize cues to SRT and round-trip', () => {
  const cues = [{ start: 1000, end: 2500, text: 'Hello' }];
  const out = srt.serialize(cues);
  assert.match(out, /1\n00:00:01,000 --> 00:00:02,500\nHello/);
  assert.deepStrictEqual(srt.parse(out), cues);
});

test('parse VTT into cues', () => {
  const input = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:start\nHi there';
  const cues = srt.parse(input);
  assert.strictEqual(cues.length, 1);
  assert.strictEqual(cues[0].start, 1000);
  assert.strictEqual(cues[0].text, 'Hi there');
});

test('decode strips UTF-8 BOM', () => {
  const buf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('שלום', 'utf8')]);
  assert.strictEqual(srt.decode(buf), 'שלום');
});

test('decode falls back for non-UTF8 without replacement chars', () => {
  const buf = Buffer.from([0x63, 0x61, 0x66, 0xE9]); // "café" in latin1/win1252
  const out = srt.decode(buf);
  assert.ok(!out.includes('�'));
  assert.ok(out.startsWith('caf'));
});
