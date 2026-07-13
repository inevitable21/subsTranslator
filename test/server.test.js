'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server');

const quietConfig = { ...require('../config'), logRequests: false, logEmbedded: false };

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

test('GET /translate does NOT cache when translation reports failures', async () => {
  const store = {};
  const app = createApp({
    getSource: async () => ({ bytes: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHola', 'utf8'), lang: 'spa' }),
    translateCues: async (cues, opts) => {
      if (opts && opts.stats) { opts.stats.totalChunks = 1; opts.stats.failedChunks = 1; }
      return cues; // translation failed -> original kept
    },
    cache: { get: () => null, put: (k, v) => { store[k] = v; } },
  });
  const r = await req(app, '/translate/movie/tt555.srt');
  assert.strictEqual(r.status, 200); // still served (best effort)
  assert.strictEqual(Object.keys(store).length, 0); // but nothing cached
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

test('GET /subtitles returns TWO tracks when embedded English is detected', async () => {
  const app = createApp({
    publicBase: 'http://127.0.0.1:7000',
    embedded: {
      parseExtra: () => ({ videoSize: 123, filename: 'a.mkv', videoHash: 'deadbeef' }),
      detectEmbeddedEnglish: async () => ({ mediaUrl: 'http://s/H/0', trackIndex: 0 }),
    },
  });
  const r = await req(app, '/subtitles/series/tt1:1:2/filename=a.mkv&videoSize=123&videoHash=deadbeef.json');
  const body = JSON.parse(r.text);
  assert.strictEqual(body.subtitles.length, 2);
  assert.strictEqual(body.subtitles[0].id, 'substranslator-heb-embedded');
  assert.strictEqual(body.subtitles[0].lang, 'Hebrew (from embedded)');
  assert.match(body.subtitles[0].url, /\/translate-embedded\/series\/tt1:1:2\//);
  assert.strictEqual(body.subtitles[1].id, 'substranslator-heb-external');
  assert.strictEqual(body.subtitles[1].lang, 'Hebrew (from external)');
  assert.match(body.subtitles[1].url, /\/translate\/series\/tt1:1:2\//);
});

test('GET /subtitles returns ONE original track when not detected', async () => {
  const app = createApp({
    publicBase: 'http://127.0.0.1:7000',
    embedded: {
      parseExtra: () => ({ videoSize: 123, filename: 'a.mkv', videoHash: 'deadbeef' }),
      detectEmbeddedEnglish: async () => null,
      findStream: async () => null,
    },
  });
  const r = await req(app, '/subtitles/series/tt1:1:2/filename=a.mkv&videoSize=123.json');
  const body = JSON.parse(r.text);
  assert.strictEqual(body.subtitles.length, 1);
  assert.strictEqual(body.subtitles[0].id, 'substranslator-heb');
  assert.strictEqual(body.subtitles[0].lang, 'heb');
});

test('GET /subtitles offers embedded for an image English track when sync is confident', async () => {
  const app = createApp({
    config: quietConfig,
    publicBase: 'http://127.0.0.1:7000',
    embedded: {
      parseExtra: () => ({ videoSize: 9, filename: 'a.mkv', videoHash: 'h1' }),
      detectEmbeddedEnglish: async () => null,               // no text track
      findStream: async () => ({ mediaUrl: 'http://s/H/6' }),
      probeEnglish: async () => ({ text: null, image: { trackIndex: 0, codec: 'hdmv_pgs_subtitle' } }),
      extractCueOnsets: async () => [10, 13, 16, 19],
    },
    getSource: async () => ({ bytes: Buffer.from('1\n00:00:10,000 --> 00:00:12,000\nhi', 'utf8'), lang: 'eng' }),
    sync: { computeLinearSync: () => ({ scale: 1, offset: 0, score: 0.9 }) },
  });
  const r = await req(app, '/subtitles/series/tt1:1:7/filename=a.mkv&videoSize=9&videoHash=h1.json');
  const body = JSON.parse(r.text);
  assert.strictEqual(body.subtitles.length, 2);
  assert.strictEqual(body.subtitles[0].id, 'substranslator-heb-embedded');
});

test('GET /subtitles does NOT offer embedded for image track when sync score is low', async () => {
  const app = createApp({
    config: quietConfig,
    publicBase: 'http://127.0.0.1:7000',
    embedded: {
      parseExtra: () => ({ videoSize: 9, filename: 'a.mkv', videoHash: 'h2' }),
      detectEmbeddedEnglish: async () => null,
      findStream: async () => ({ mediaUrl: 'http://s/H/6' }),
      probeEnglish: async () => ({ text: null, image: { trackIndex: 0, codec: 'hdmv_pgs_subtitle' } }),
      extractCueOnsets: async () => [10, 13, 16],
    },
    getSource: async () => ({ bytes: Buffer.from('1\n00:00:40,000 --> 00:00:42,000\nx', 'utf8'), lang: 'eng' }),
    sync: { computeLinearSync: () => ({ scale: 1, offset: 0, score: 0.1 }) },
  });
  const r = await req(app, '/subtitles/series/tt1:1:7/filename=a.mkv&videoSize=9&videoHash=h2.json');
  const body = JSON.parse(r.text);
  assert.strictEqual(body.subtitles.length, 1);
  assert.strictEqual(body.subtitles[0].id, 'substranslator-heb');
});

test('GET /subtitles skips embedded detection when videoSize absent', async () => {
  let detectCalled = false;
  const app = createApp({
    publicBase: 'http://127.0.0.1:7000',
    embedded: {
      parseExtra: () => ({ videoSize: null, filename: null, videoHash: null }),
      detectEmbeddedEnglish: async () => { detectCalled = true; return null; },
    },
  });
  const r = await req(app, '/subtitles/movie/tt123.json');
  const body = JSON.parse(r.text);
  assert.strictEqual(body.subtitles.length, 1);
  assert.strictEqual(detectCalled, false);
});

test('GET /translate-embedded extracts, translates, caches under emb key', async () => {
  const store = {};
  const app = createApp({
    embedded: {
      parseExtra: () => ({ videoSize: 9, filename: 'a.mkv', videoHash: 'beef' }),
      getEmbeddedSubtitle: async () => ({
        bytes: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHello', 'utf8'), lang: 'eng' }),
    },
    translateCues: async (cues) => cues.map(c => ({ ...c, text: 'שלום' })),
    getSource: async () => { throw new Error('external should not be called'); },
    cache: { get: (k) => (k in store ? store[k] : null), put: (k, v) => { store[k] = v; } },
  });
  const r = await req(app, '/translate-embedded/series/tt1:1:2/filename=a.mkv&videoHash=beef.srt');
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /שלום/);
  const keys = Object.keys(store);
  assert.strictEqual(keys.length, 1);
  assert.match(keys[0], /:emb:beef:series:tt1:1:2$/);
});

test('GET /translate-embedded falls back to external and does NOT cache emb key', async () => {
  const store = {};
  let externalCalled = false;
  const app = createApp({
    embedded: {
      parseExtra: () => ({ videoSize: 9, filename: 'a.mkv', videoHash: 'beef' }),
      getEmbeddedSubtitle: async () => null, // embedded failed
      findStream: async () => null,
    },
    getSource: async () => {
      externalCalled = true;
      return { bytes: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHello', 'utf8'), lang: 'eng' };
    },
    translateCues: async (cues) => cues.map(c => ({ ...c, text: 'שלום' })),
    cache: { get: () => null, put: (k, v) => { store[k] = v; } },
  });
  const r = await req(app, '/translate-embedded/series/tt1:1:2/filename=a.mkv&videoHash=beef.srt');
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /שלום/);
  assert.strictEqual(externalCalled, true);
  assert.strictEqual(Object.keys(store).length, 0); // embedded key NOT written on fallback
});

test('GET /translate-embedded returns empty when embedded and external both fail', async () => {
  const app = createApp({
    embedded: {
      parseExtra: () => ({ videoSize: 9, filename: 'a.mkv', videoHash: 'beef' }),
      getEmbeddedSubtitle: async () => null,
      findStream: async () => null,
    },
    getSource: async () => null,
    cache: { get: () => null, put: () => {} },
  });
  const r = await req(app, '/translate-embedded/movie/tt9/filename=a.mkv&videoHash=beef.srt');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.text, '');
});

test('GET /translate-embedded image-sync path applies transform, translates, caches', async () => {
  const store = {};
  const app = createApp({
    config: quietConfig,
    embedded: {
      parseExtra: () => ({ videoSize: 9, filename: 'a.mkv', videoHash: 'h3' }),
      getEmbeddedSubtitle: async () => null,                 // no text track
      detectEmbeddedEnglish: async () => null,
      findStream: async () => ({ mediaUrl: 'http://s/H/6' }),
      probeEnglish: async () => ({ text: null, image: { trackIndex: 0, codec: 'hdmv_pgs_subtitle' } }),
      extractCueOnsets: async () => [10, 13, 16, 19],
    },
    getSource: async () => ({ bytes: Buffer.from('1\n00:00:10,000 --> 00:00:12,000\nHello', 'utf8'), lang: 'eng' }),
    translateCues: async (cues) => cues.map(c => ({ ...c, text: 'שלום' })),
    sync: {
      computeLinearSync: () => ({ scale: 1, offset: 5, score: 0.9 }),
      applySync: (cues, t) => cues.map(c => ({ ...c, start: c.start + t.offset * 1000, end: c.end + t.offset * 1000 })),
    },
    cache: { get: (k) => (k in store ? store[k] : null), put: (k, v) => { store[k] = v; } },
  });
  const r = await req(app, '/translate-embedded/series/tt1:1:7/filename=a.mkv&videoHash=h3&videoSize=9.srt');
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /שלום/);
  assert.match(r.text, /00:00:15,000/); // 10s cue shifted +5s
  assert.strictEqual(Object.keys(store).length, 1);
  assert.match(Object.keys(store)[0], /:emb:h3:series:tt1:1:7$/);
});

test('GET /translate-embedded does NOT cache when translation reports failures', async () => {
  const store = {};
  const app = createApp({
    embedded: {
      parseExtra: () => ({ videoSize: 9, filename: 'a.mkv', videoHash: 'beef' }),
      getEmbeddedSubtitle: async () => ({
        bytes: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHi', 'utf8'), lang: 'eng' }),
    },
    translateCues: async (cues, opts) => {
      if (opts && opts.stats) { opts.stats.totalChunks = 1; opts.stats.failedChunks = 1; }
      return cues;
    },
    cache: { get: () => null, put: (k, v) => { store[k] = v; } },
  });
  const r = await req(app, '/translate-embedded/movie/tt9/filename=a.mkv&videoHash=beef.srt');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(Object.keys(store).length, 0);
});

test('syncCache: /translate-embedded after /subtitles reuses the cached verdict (no re-probe)', async () => {
  let findStreamCalls = 0, onsetCalls = 0;
  const store = {};
  const app = createApp({
    config: quietConfig,
    publicBase: 'http://127.0.0.1:7000',
    embedded: {
      parseExtra: () => ({ videoSize: 9, filename: 'a.mkv', videoHash: 'hcache' }),
      detectEmbeddedEnglish: async () => null,
      getEmbeddedSubtitle: async () => null,
      findStream: async () => { findStreamCalls++; return { mediaUrl: 'http://s/H/6' }; },
      probeEnglish: async () => ({ text: null, image: { trackIndex: 0, codec: 'hdmv_pgs_subtitle' } }),
      extractCueOnsets: async () => { onsetCalls++; return [10, 13, 16, 19]; },
    },
    getSource: async () => ({ bytes: Buffer.from('1\n00:00:10,000 --> 00:00:12,000\nHi', 'utf8'), lang: 'eng' }),
    translateCues: async (cues) => cues.map(c => ({ ...c, text: 'שלום' })),
    sync: { computeLinearSync: () => ({ scale: 1, offset: 0, score: 0.9 }), applySync: (cues) => cues },
    cache: { get: (k) => (k in store ? store[k] : null), put: (k, v) => { store[k] = v; } },
  });
  const r1 = await req(app, '/subtitles/series/tt1:1:7/filename=a.mkv&videoSize=9&videoHash=hcache.json');
  assert.strictEqual(JSON.parse(r1.text).subtitles.length, 2);
  const r2 = await req(app, '/translate-embedded/series/tt1:1:7/filename=a.mkv&videoHash=hcache&videoSize=9.srt');
  assert.match(r2.text, /שלום/);
  assert.strictEqual(findStreamCalls, 1); // resolved once at /subtitles; /translate-embedded hits the cache
  assert.strictEqual(onsetCalls, 1);
});
