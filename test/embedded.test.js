'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const embedded = require('../embedded');

test('parseExtra extracts filename, videoSize, videoHash', () => {
  const r = embedded.parseExtra('filename=Wakfu S01E06.mkv&videoSize=434828263&videoHash=3324c29ac710a548');
  assert.strictEqual(r.filename, 'Wakfu S01E06.mkv');
  assert.strictEqual(r.videoSize, 434828263);
  assert.strictEqual(r.videoHash, '3324c29ac710a548');
});

test('parseExtra returns nulls when fields absent', () => {
  const r = embedded.parseExtra('');
  assert.strictEqual(r.filename, null);
  assert.strictEqual(r.videoSize, null);
  assert.strictEqual(r.videoHash, null);
});

test('parseExtra handles videoSize/videoHash without filename', () => {
  const r = embedded.parseExtra('videoSize=100&videoHash=abcdef01');
  assert.strictEqual(r.filename, null);
  assert.strictEqual(r.videoSize, 100);
  assert.strictEqual(r.videoHash, 'abcdef01');
});
