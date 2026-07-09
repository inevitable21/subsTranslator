'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const cache = require('../cache');

test('cache put then get round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subs-'));
  assert.strictEqual(cache.get('movie:tt1', dir), null);
  cache.put('movie:tt1', 'SRT CONTENT', dir);
  assert.strictEqual(cache.get('movie:tt1', dir), 'SRT CONTENT');
});

test('keyToFile sanitizes unsafe characters', () => {
  const f = cache.keyToFile('series:tt1:1:2', '/tmp/x');
  assert.ok(!path.basename(f).includes(':'));
  assert.ok(f.endsWith('.srt'));
});
