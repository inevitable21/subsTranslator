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

function mockFetchJson(map) {
  // map: { urlSubstring: jsonValue | { status } }
  return async (url) => {
    for (const key of Object.keys(map)) {
      if (String(url).includes(key)) {
        const v = map[key];
        if (v && typeof v === 'object' && 'status' in v && v.status >= 400) {
          return { ok: false, status: v.status, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => v };
      }
    }
    throw new Error('unexpected url ' + url);
  };
}

test('findStream matches file by exact videoSize', async () => {
  const stats = {
    HASHA: { files: [{ name: 'a.mkv', length: 111 }, { name: 'b.mkv', length: 222 }] },
  };
  const fetchFn = mockFetchJson({ '/stats.json': stats });
  const r = await embedded.findStream({ videoSize: 222, filename: 'b.mkv' },
    { fetchFn, base: 'http://s' });
  assert.deepStrictEqual(r, { infoHash: 'HASHA', fileIdx: 1, mediaUrl: 'http://s/HASHA/1' });
});

test('findStream uses filename basename as tiebreaker on equal sizes', async () => {
  const stats = {
    H1: { files: [{ name: 'wrong.mkv', length: 500 }] },
    H2: { files: [{ name: 'dir/right.mkv', length: 500 }] },
  };
  const fetchFn = mockFetchJson({ '/stats.json': stats });
  const r = await embedded.findStream({ videoSize: 500, filename: 'x/right.mkv' },
    { fetchFn, base: 'http://s' });
  assert.strictEqual(r.infoHash, 'H2');
});

test('findStream returns null when no size matches (debrid case)', async () => {
  const stats = { H1: { files: [{ name: 'a.mkv', length: 999 }] } };
  const fetchFn = mockFetchJson({ '/stats.json': stats });
  const r = await embedded.findStream({ videoSize: 123, filename: 'a.mkv' },
    { fetchFn, base: 'http://s' });
  assert.strictEqual(r, null);
});

test('findStream returns null on stats fetch error', async () => {
  const fetchFn = mockFetchJson({ '/stats.json': { status: 500 } });
  const r = await embedded.findStream({ videoSize: 1, filename: 'a' },
    { fetchFn, base: 'http://s' });
  assert.strictEqual(r, null);
});

test('findStream returns null when videoSize missing', async () => {
  let called = false;
  const fetchFn = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  const r = await embedded.findStream({ videoSize: null, filename: 'a' }, { fetchFn });
  assert.strictEqual(r, null);
  assert.strictEqual(called, false); // early-out, no network
});
