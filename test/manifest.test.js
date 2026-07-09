'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildManifest } = require('../manifest');

test('manifest declares subtitles resource for movie and series', () => {
  const m = buildManifest();
  assert.ok(m.resources.includes('subtitles'));
  assert.ok(m.types.includes('movie'));
  assert.ok(m.types.includes('series'));
  assert.ok(m.idPrefixes.includes('tt'));
  assert.ok(typeof m.id === 'string' && m.id.length > 0);
  assert.ok(typeof m.version === 'string');
});
