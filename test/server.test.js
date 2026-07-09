'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server');

async function req(app, pathname, method = 'GET') {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method });
    return { status: res.status, headers: res.headers, text: await res.text() };
  } finally {
    server.close();
  }
}

test('GET /manifest.json returns subtitles addon manifest with CORS', async () => {
  const r = await req(createApp({}), '/manifest.json');
  assert.strictEqual(r.status, 200);
  const m = JSON.parse(r.text);
  assert.ok(m.resources.includes('subtitles'));
  assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
});

test('GET /subtitles returns a hebrew entry pointing at /translate', async () => {
  const app = createApp({ publicBase: 'http://127.0.0.1:7000' });
  const r = await req(app, '/subtitles/movie/tt123.json');
  const body = JSON.parse(r.text);
  assert.strictEqual(body.subtitles.length, 1);
  assert.strictEqual(body.subtitles[0].lang, 'heb');
  assert.match(body.subtitles[0].url, /\/translate\/movie\/tt123\.srt$/);
});

test('GET /subtitles handles series id with colons', async () => {
  const app = createApp({ publicBase: 'http://127.0.0.1:7000' });
  const r = await req(app, '/subtitles/series/tt123:1:2.json');
  const body = JSON.parse(r.text);
  assert.match(body.subtitles[0].url, /\/translate\/series\/tt123:1:2\.srt$/);
});

test('GET /translate translates source, sets content-type, and caches', async () => {
  const store = {};
  let sourceCalls = 0;
  const app = createApp({
    getSource: async () => {
      sourceCalls++;
      return { bytes: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHello', 'utf8'), lang: 'eng' };
    },
    translateCues: async (cues) => cues.map(c => ({ ...c, text: 'שלום' })),
    cache: { get: (k) => (k in store ? store[k] : null), put: (k, v) => { store[k] = v; } },
  });
  const r1 = await req(app, '/translate/movie/tt123.srt');
  assert.strictEqual(r1.status, 200);
  assert.match(r1.text, /שלום/);
  assert.strictEqual(r1.headers.get('content-type'), 'application/x-subrip; charset=utf-8');
  const r2 = await req(app, '/translate/movie/tt123.srt');
  assert.match(r2.text, /שלום/);
  assert.strictEqual(sourceCalls, 1); // second request served from cache
});

test('GET /translate returns empty body when no source found', async () => {
  const app = createApp({
    getSource: async () => null,
    cache: { get: () => null, put: () => {} },
  });
  const r = await req(app, '/translate/movie/tt999.srt');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.text, '');
});
