'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { selectBest, getSourceSubtitle } = require('../sources');

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
function mockFetchSequence(responses) {
  let i = 0;
  return async () => {
    const r = responses[i++];
    return {
      ok: r.ok !== false,
      status: r.status || 200,
      json: async () => r.json,
      arrayBuffer: async () => r.arrayBuffer,
    };
  };
}

test('selectBest prefers english', () => {
  const list = [{ lang: 'spa', url: 'a' }, { lang: 'eng', url: 'b' }];
  assert.strictEqual(selectBest(list, ['eng', 'en']).url, 'b');
});

test('selectBest falls back to first when no preference matches', () => {
  const list = [{ lang: 'spa', url: 'a' }, { lang: 'fre', url: 'b' }];
  assert.strictEqual(selectBest(list, ['eng']).url, 'a');
});

test('selectBest returns null for empty', () => {
  assert.strictEqual(selectBest([], ['eng']), null);
});

test('getSourceSubtitle returns bytes and lang', async () => {
  const srtBytes = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHi', 'utf8');
  const fetchFn = mockFetchSequence([
    { json: { subtitles: [{ lang: 'eng', url: 'http://x/sub.srt' }] } },
    { arrayBuffer: toArrayBuffer(srtBytes) },
  ]);
  const out = await getSourceSubtitle('movie', 'tt1', null, { fetchFn });
  assert.strictEqual(out.lang, 'eng');
  assert.strictEqual(Buffer.from(out.bytes).toString('utf8'), '1\n00:00:01,000 --> 00:00:02,000\nHi');
});

test('getSourceSubtitle gunzips gzipped source', async () => {
  const gz = zlib.gzipSync(Buffer.from('hello', 'utf8'));
  const fetchFn = mockFetchSequence([
    { json: { subtitles: [{ lang: 'eng', url: 'http://x/sub.gz' }] } },
    { arrayBuffer: toArrayBuffer(gz) },
  ]);
  const out = await getSourceSubtitle('movie', 'tt1', null, { fetchFn });
  assert.strictEqual(Buffer.from(out.bytes).toString('utf8'), 'hello');
});

test('getSourceSubtitle returns null when no subtitles', async () => {
  const fetchFn = mockFetchSequence([{ json: { subtitles: [] } }]);
  const out = await getSourceSubtitle('movie', 'tt1', null, { fetchFn });
  assert.strictEqual(out, null);
});
