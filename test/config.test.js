'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../config');

test('config has expected defaults', () => {
  assert.strictEqual(config.targetLangLabel, 'heb');
  assert.strictEqual(config.targetLangGoogle, 'he');
  assert.strictEqual(config.host, '127.0.0.1');
  assert.strictEqual(config.port, 7000);
  assert.ok(Array.isArray(config.sourcePreference) && config.sourcePreference.length > 0);
  assert.ok(typeof config.cacheDir === 'string' && config.cacheDir.length > 0);
  assert.strictEqual(config.opensubtitlesBase, 'https://opensubtitles-v3.strem.io');
});
