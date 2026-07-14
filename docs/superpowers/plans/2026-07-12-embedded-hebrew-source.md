# Embedded-English → Hebrew Source Track Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Offer a second Hebrew subtitle track translated from a video's embedded English track (when present), which syncs better than external OpenSubtitles because it is timed to the exact file being played.

**Architecture:** A new `embedded.js` module talks to Stremio's local streaming server (`http://127.0.0.1:11470`): it locates the playing file in `/stats.json` by matching `videoSize`, probes it for an English text-subtitle track via `/probe/`, and extracts that track to SRT with a bundled `ffmpeg-static` binary. `server.js` uses this at `/subtitles` time to decide whether to advertise one or two Hebrew tracks, and serves the embedded one from a new `/translate-embedded` route that reuses the existing translate→display→rtl pipeline and falls back to external translation on any failure.

**Tech Stack:** Node.js (≥24), Express 4, `node:test`, `ffmpeg-static`, Stremio streaming-server HTTP API, Google Translate (existing `translate.js`).

## Global Constraints

- **Node.js ≥ 24** (per README requirements).
- **Dependency injection everywhere:** every function that does I/O (fetch, spawn) takes a `deps` object with injectable `fetchFn` / `spawnFn` / `base` / `ffmpegPath`, defaulting to the real implementation — matching `sources.js` and `createApp`. Tests never hit the network or spawn real processes.
- **Tests use `node:test` + `node:assert`**, run with `npm test` (`node --test`). Mirror the `mockFetchSequence` helper style in `test/sources.test.js`.
- **`'use strict';`** at the top of every new `.js` file.
- **Graceful degradation:** no embedded-path failure may throw to the HTTP client; it degrades to the external Hebrew track. `console.error` for logging, never `throw` out of a route handler.
- **Streaming-server base URL:** `http://127.0.0.1:11470` (config `streamingServerBase`).
- **ffmpeg map selector is subtitle-relative:** `-map 0:s:<n>` counts within subtitle streams only, including image-based ones. `probeEnglishSub` returns this relative position, NOT ffprobe's absolute `index`.
- **Track labels (verbatim):** `'Hebrew (from embedded)'` and `'Hebrew (from external)'`. Single-track fallback keeps today's label `'heb'` and id `'substranslator-heb'`.
- **Cache keys:** external (unchanged) `${cacheVersion}:${type}:${id}`; embedded `${cacheVersion}:emb:${videoHash}:${type}:${id}`.

---

### Task 1: Config + `ffmpeg-static` dependency

**Files:**
- Modify: `config.js`
- Modify: `package.json`
- Test: `test/config.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `config.streamingServerBase` (string), `config.embeddedLabel` (string), `config.embeddedExternalLabel` (string). `ffmpeg-static` resolvable via `require('ffmpeg-static')` → absolute path to the ffmpeg binary.

- [ ] **Step 1: Add the failing config assertions**

In `test/config.test.js`, add inside the existing `test('config has expected defaults', ...)` body, before the closing `});`:

```js
  assert.strictEqual(config.streamingServerBase, 'http://127.0.0.1:11470');
  assert.strictEqual(config.embeddedLabel, 'Hebrew (from embedded)');
  assert.strictEqual(config.embeddedExternalLabel, 'Hebrew (from external)');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="config has expected defaults"`
Expected: FAIL — `undefined !== 'http://127.0.0.1:11470'`.

- [ ] **Step 3: Add the config fields**

In `config.js`, inside the exported object, add these three lines after the `opensubtitlesBase` line:

```js
  streamingServerBase: process.env.SUBSTRANSLATOR_STREAMING_BASE || 'http://127.0.0.1:11470',
  embeddedLabel: 'Hebrew (from embedded)',
  embeddedExternalLabel: 'Hebrew (from external)',
```

- [ ] **Step 4: Add the ffmpeg-static dependency**

In `package.json`, add to `"dependencies"` (keep JSON valid — add a comma after the previous entry):

```json
    "ffmpeg-static": "^5.2.0"
```

- [ ] **Step 5: Install it**

Run: `npm install`
Expected: `ffmpeg-static` appears under `node_modules/`; `node -e "console.log(require('ffmpeg-static'))"` prints an absolute path ending in `ffmpeg.exe`.

- [ ] **Step 6: Run the config test to verify it passes**

Run: `npm test -- --test-name-pattern="config has expected defaults"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add config.js package.json package-lock.json test/config.test.js
git commit -m "feat: add streaming-server config + ffmpeg-static dependency"
```

---

### Task 2: `embedded.js` — `parseExtra`

Parses Stremio's `extra` path segment (e.g. `filename=Wakfu S01E06.mkv&videoSize=434828263&videoHash=3324c29ac710a548`) into fields. Express has already URL-decoded `req.params[0]` by the time we see it (confirmed: `requests.log` shows decoded spaces), so we do NOT decode again.

**Files:**
- Create: `embedded.js`
- Test: `test/embedded.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseExtra(extra: string) → { filename: string|null, videoSize: number|null, videoHash: string|null }`.

- [ ] **Step 1: Write the failing test**

Create `test/embedded.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="parseExtra"`
Expected: FAIL — `Cannot find module '../embedded'`.

- [ ] **Step 3: Write the minimal implementation**

Create `embedded.js`:

```js
'use strict';
const config = require('./config');

function parseExtra(extra) {
  const s = String(extra || '');
  const size = (s.match(/(?:^|&)videoSize=(\d+)/) || [])[1];
  const hash = (s.match(/(?:^|&)videoHash=([A-Za-z0-9]+)/) || [])[1];
  const fn = (s.match(/(?:^|&)filename=([^&]*)/) || [])[1];
  return {
    filename: fn ? fn : null,
    videoSize: size ? Number(size) : null,
    videoHash: hash || null,
  };
}

module.exports = { parseExtra };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --test-name-pattern="parseExtra"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add embedded.js test/embedded.test.js
git commit -m "feat: parse Stremio extra segment in embedded.js"
```

---

### Task 3: `embedded.js` — `findStream` (+ `fetchWithTimeout` helper)

Locates the playing file in the streaming server's `/stats.json` by exact byte-size match, with filename basename as tiebreaker. Tolerant of both `/stats.json` shapes (object keyed by infoHash, or array of engine entries) via `Object.entries` + `entry.infoHash || key`.

**Files:**
- Modify: `embedded.js`
- Test: `test/embedded.test.js`

**Interfaces:**
- Consumes: `config.streamingServerBase`.
- Produces:
  - `findStream({ videoSize, filename }, deps={}) → Promise<{ infoHash, fileIdx, mediaUrl }|null>`. `deps`: `fetchFn` (default global `fetch`), `base` (default `config.streamingServerBase`), `statsTimeoutMs` (default 500).
  - Internal `fetchWithTimeout(fetchFn, url, timeoutMs) → Promise<Response>` (not exported).

- [ ] **Step 1: Write the failing tests**

Add to `test/embedded.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="findStream"`
Expected: FAIL — `embedded.findStream is not a function`.

- [ ] **Step 3: Write the implementation**

In `embedded.js`, add above `module.exports` and extend the exports:

```js
async function fetchWithTimeout(fetchFn, url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchFn(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function basename(p) {
  return p ? String(p).split(/[\\/]/).pop() : null;
}

async function findStream({ videoSize, filename }, deps = {}) {
  const fetchFn = deps.fetchFn || fetch;
  const base = deps.base || config.streamingServerBase;
  const timeoutMs = deps.statsTimeoutMs || 500;
  if (!videoSize) return null;

  let stats;
  try {
    const res = await fetchWithTimeout(fetchFn, `${base}/stats.json`, timeoutMs);
    if (!res.ok) return null;
    stats = await res.json();
  } catch { return null; }
  if (!stats || typeof stats !== 'object') return null;

  const wantSize = Number(videoSize);
  const wantName = basename(filename);
  let sizeOnly = null;

  for (const [key, entry] of Object.entries(stats)) {
    const infoHash = (entry && entry.infoHash) || key;
    const files = (entry && entry.files) || [];
    for (let i = 0; i < files.length; i++) {
      if (Number(files[i].length) !== wantSize) continue;
      const hit = { infoHash, fileIdx: i, mediaUrl: `${base}/${infoHash}/${i}` };
      if (wantName && basename(files[i].name) === wantName) return hit; // best match
      if (!sizeOnly) sizeOnly = hit;
    }
  }
  return sizeOnly;
}
```

Update the exports line:

```js
module.exports = { parseExtra, findStream };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern="findStream"`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add embedded.js test/embedded.test.js
git commit -m "feat: locate playing file via streaming-server stats.json"
```

---

### Task 4: `embedded.js` — `probeEnglishSub`

Calls `/probe/<encoded mediaUrl>` and returns the **subtitle-relative** index of the first English text-codec track. Image codecs are skipped but still advance the relative counter (because `-map 0:s:N` counts all subtitle streams).

**Files:**
- Modify: `embedded.js`
- Test: `test/embedded.test.js`

**Interfaces:**
- Consumes: `config.streamingServerBase`, `fetchWithTimeout`.
- Produces: `probeEnglishSub(mediaUrl, deps={}) → Promise<{ trackIndex: number, codec: string }|null>`. `deps`: `fetchFn`, `base`, `probeTimeoutMs` (default 1500).

- [ ] **Step 1: Write the failing tests**

Add to `test/embedded.test.js`:

```js
test('probeEnglishSub returns subtitle-relative index of english subrip', async () => {
  const probe = { streams: { subtitles: [
    { codec: 'hdmv_pgs_subtitle', tags: { language: 'eng' } }, // rel 0, image -> skip
    { codec: 'subrip', tags: { language: 'eng' } },            // rel 1, match
  ] } };
  const fetchFn = mockFetchJson({ '/probe/': probe });
  const r = await embedded.probeEnglishSub('http://s/H/0', { fetchFn, base: 'http://s' });
  assert.deepStrictEqual(r, { trackIndex: 1, codec: 'subrip' });
});

test('probeEnglishSub matches english by title when language tag missing', async () => {
  const probe = { streams: { subtitles: [
    { codec: 'ass', tags: { title: 'English (Full)' } },
  ] } };
  const fetchFn = mockFetchJson({ '/probe/': probe });
  const r = await embedded.probeEnglishSub('http://s/H/0', { fetchFn, base: 'http://s' });
  assert.strictEqual(r.trackIndex, 0);
});

test('probeEnglishSub returns null when only image tracks', async () => {
  const probe = { streams: { subtitles: [
    { codec: 'hdmv_pgs_subtitle', tags: { language: 'eng' } },
  ] } };
  const fetchFn = mockFetchJson({ '/probe/': probe });
  const r = await embedded.probeEnglishSub('http://s/H/0', { fetchFn, base: 'http://s' });
  assert.strictEqual(r, null);
});

test('probeEnglishSub returns null when no english track', async () => {
  const probe = { streams: { subtitles: [
    { codec: 'subrip', tags: { language: 'spa' } },
  ] } };
  const fetchFn = mockFetchJson({ '/probe/': probe });
  const r = await embedded.probeEnglishSub('http://s/H/0', { fetchFn, base: 'http://s' });
  assert.strictEqual(r, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="probeEnglishSub"`
Expected: FAIL — `embedded.probeEnglishSub is not a function`.

- [ ] **Step 3: Write the implementation**

In `embedded.js`, add:

```js
const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'text', 'webvtt']);

async function probeEnglishSub(mediaUrl, deps = {}) {
  const fetchFn = deps.fetchFn || fetch;
  const base = deps.base || config.streamingServerBase;
  const timeoutMs = deps.probeTimeoutMs || 1500;

  let probe;
  try {
    const url = `${base}/probe/${encodeURIComponent(mediaUrl)}`;
    const res = await fetchWithTimeout(fetchFn, url, timeoutMs);
    if (!res.ok) return null;
    probe = await res.json();
  } catch { return null; }

  const subs = (probe && probe.streams && probe.streams.subtitles) || [];
  for (let rel = 0; rel < subs.length; rel++) {
    const s = subs[rel] || {};
    const codec = String(s.codec || s.codec_name || '').toLowerCase();
    if (!TEXT_SUB_CODECS.has(codec)) continue;
    const tags = s.tags || {};
    const lang = String(tags.language || s.language || '').toLowerCase();
    const title = String(tags.title || '');
    if (lang === 'eng' || lang === 'en' || /english/i.test(title)) {
      return { trackIndex: rel, codec };
    }
  }
  return null;
}
```

Update the exports line:

```js
module.exports = { parseExtra, findStream, probeEnglishSub };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern="probeEnglishSub"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add embedded.js test/embedded.test.js
git commit -m "feat: probe embedded English subtitle track via ffprobe endpoint"
```

---

### Task 5: `embedded.js` — `extractSrt`

Spawns ffmpeg to convert the chosen subtitle-relative track to SRT on stdout. `spawnFn` is injectable so tests use a fake child process.

**Files:**
- Modify: `embedded.js`
- Test: `test/embedded.test.js`

**Interfaces:**
- Consumes: `ffmpeg-static` (`require('ffmpeg-static')`), `child_process.spawn`.
- Produces: `extractSrt({ mediaUrl, trackIndex }, deps={}) → Promise<Buffer>` (rejects on non-zero exit or empty output). `deps`: `spawnFn` (default `child_process.spawn`), `ffmpegPath` (default `require('ffmpeg-static')`).

- [ ] **Step 1: Write the failing tests**

Add to the top of `test/embedded.test.js` (after the existing requires):

```js
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');

function fakeSpawn({ stdout = '', code = 0 } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      if (stdout) child.stdout.write(Buffer.from(stdout, 'utf8'));
      child.stdout.end();
      child.emit('close', code);
    });
    return child;
  };
}
```

Then add the tests:

```js
test('extractSrt resolves with stdout buffer on exit 0', async () => {
  const srtText = '1\n00:00:01,000 --> 00:00:02,000\nHello';
  const out = await embedded.extractSrt({ mediaUrl: 'http://s/H/0', trackIndex: 1 },
    { spawnFn: fakeSpawn({ stdout: srtText, code: 0 }), ffmpegPath: 'ffmpeg' });
  assert.strictEqual(out.toString('utf8'), srtText);
});

test('extractSrt rejects on non-zero exit', async () => {
  await assert.rejects(
    embedded.extractSrt({ mediaUrl: 'http://s/H/0', trackIndex: 0 },
      { spawnFn: fakeSpawn({ stdout: '', code: 1 }), ffmpegPath: 'ffmpeg' })
  );
});

test('extractSrt rejects on empty output', async () => {
  await assert.rejects(
    embedded.extractSrt({ mediaUrl: 'http://s/H/0', trackIndex: 0 },
      { spawnFn: fakeSpawn({ stdout: '', code: 0 }), ffmpegPath: 'ffmpeg' })
  );
});

test('extractSrt builds a subtitle-relative -map selector', async () => {
  let capturedArgs = null;
  const spawnFn = (bin, args) => {
    capturedArgs = args;
    return fakeSpawn({ stdout: 'x', code: 0 })();
  };
  await embedded.extractSrt({ mediaUrl: 'http://s/H/0', trackIndex: 2 },
    { spawnFn, ffmpegPath: 'ffmpeg' });
  assert.ok(capturedArgs.includes('0:s:2'), 'uses subtitle-relative map index');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="extractSrt"`
Expected: FAIL — `embedded.extractSrt is not a function`.

- [ ] **Step 3: Write the implementation**

In `embedded.js`, add near the top after the `config` require:

```js
const childProcess = require('node:child_process');
```

Then add before `module.exports`:

```js
function extractSrt({ mediaUrl, trackIndex }, deps = {}) {
  const spawnFn = deps.spawnFn || childProcess.spawn;
  const ffmpegPath = deps.ffmpegPath || require('ffmpeg-static');
  const args = ['-nostdin', '-i', mediaUrl, '-map', `0:s:${trackIndex}`,
    '-c:s', 'srt', '-f', 'srt', 'pipe:1'];

  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnFn(ffmpegPath, args); }
    catch (e) { return reject(e); }

    const chunks = [];
    child.stdout.on('data', d => chunks.push(d));
    child.on('error', reject);
    child.on('close', code => {
      const out = Buffer.concat(chunks);
      if (code === 0 && out.length > 0) resolve(out);
      else reject(new Error(`ffmpeg exit=${code} bytes=${out.length}`));
    });
  });
}
```

Update the exports line:

```js
module.exports = { parseExtra, findStream, probeEnglishSub, extractSrt };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern="extractSrt"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add embedded.js test/embedded.test.js
git commit -m "feat: extract embedded subtitle track to SRT via ffmpeg"
```

---

### Task 6: `embedded.js` — `detectEmbeddedEnglish` + `getEmbeddedSubtitle` composites

Compose the primitives into the two functions `server.js` consumes. Mirrors `sources.getSourceSubtitle`'s shape (`{ bytes, lang }`).

**Files:**
- Modify: `embedded.js`
- Test: `test/embedded.test.js`

**Interfaces:**
- Consumes: `findStream`, `probeEnglishSub`, `extractSrt`.
- Produces:
  - `detectEmbeddedEnglish({ videoSize, filename }, deps={}) → Promise<{ mediaUrl, trackIndex, codec }|null>`.
  - `getEmbeddedSubtitle({ videoSize, filename }, deps={}) → Promise<{ bytes: Buffer, lang: 'eng' }|null>`.

  `deps` for both flows through to all primitives (`fetchFn`, `base`, `spawnFn`, `ffmpegPath`, timeouts). To keep them independently testable, both also accept `deps.findStream`, `deps.probeEnglishSub`, `deps.extractSrt` overrides (defaulting to this module's own functions).

- [ ] **Step 1: Write the failing tests**

Add to `test/embedded.test.js`:

```js
test('detectEmbeddedEnglish returns mediaUrl + trackIndex when found', async () => {
  const r = await embedded.detectEmbeddedEnglish({ videoSize: 10, filename: 'a' }, {
    findStream: async () => ({ infoHash: 'H', fileIdx: 0, mediaUrl: 'http://s/H/0' }),
    probeEnglishSub: async () => ({ trackIndex: 1, codec: 'subrip' }),
  });
  assert.deepStrictEqual(r, { mediaUrl: 'http://s/H/0', trackIndex: 1, codec: 'subrip' });
});

test('detectEmbeddedEnglish returns null when stream not found', async () => {
  const r = await embedded.detectEmbeddedEnglish({ videoSize: 10, filename: 'a' }, {
    findStream: async () => null,
    probeEnglishSub: async () => { throw new Error('should not be called'); },
  });
  assert.strictEqual(r, null);
});

test('detectEmbeddedEnglish returns null when no english track', async () => {
  const r = await embedded.detectEmbeddedEnglish({ videoSize: 10, filename: 'a' }, {
    findStream: async () => ({ infoHash: 'H', fileIdx: 0, mediaUrl: 'http://s/H/0' }),
    probeEnglishSub: async () => null,
  });
  assert.strictEqual(r, null);
});

test('getEmbeddedSubtitle returns bytes on success', async () => {
  const r = await embedded.getEmbeddedSubtitle({ videoSize: 10, filename: 'a' }, {
    findStream: async () => ({ infoHash: 'H', fileIdx: 0, mediaUrl: 'http://s/H/0' }),
    probeEnglishSub: async () => ({ trackIndex: 0, codec: 'subrip' }),
    extractSrt: async () => Buffer.from('SRT', 'utf8'),
  });
  assert.strictEqual(r.lang, 'eng');
  assert.strictEqual(r.bytes.toString('utf8'), 'SRT');
});

test('getEmbeddedSubtitle returns null when extraction throws', async () => {
  const r = await embedded.getEmbeddedSubtitle({ videoSize: 10, filename: 'a' }, {
    findStream: async () => ({ infoHash: 'H', fileIdx: 0, mediaUrl: 'http://s/H/0' }),
    probeEnglishSub: async () => ({ trackIndex: 0, codec: 'subrip' }),
    extractSrt: async () => { throw new Error('ffmpeg failed'); },
  });
  assert.strictEqual(r, null);
});

test('getEmbeddedSubtitle returns null when detection fails', async () => {
  const r = await embedded.getEmbeddedSubtitle({ videoSize: 10, filename: 'a' }, {
    findStream: async () => null,
  });
  assert.strictEqual(r, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="detectEmbeddedEnglish|getEmbeddedSubtitle"`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Write the implementation**

In `embedded.js`, add before `module.exports`:

```js
async function detectEmbeddedEnglish({ videoSize, filename }, deps = {}) {
  const find = deps.findStream || findStream;
  const probe = deps.probeEnglishSub || probeEnglishSub;
  const stream = await find({ videoSize, filename }, deps);
  if (!stream) return null;
  const sub = await probe(stream.mediaUrl, deps);
  if (!sub) return null;
  return { mediaUrl: stream.mediaUrl, trackIndex: sub.trackIndex, codec: sub.codec };
}

async function getEmbeddedSubtitle({ videoSize, filename }, deps = {}) {
  const extract = deps.extractSrt || extractSrt;
  const detected = await detectEmbeddedEnglish({ videoSize, filename }, deps);
  if (!detected) return null;
  try {
    const bytes = await extract(
      { mediaUrl: detected.mediaUrl, trackIndex: detected.trackIndex }, deps);
    if (!bytes || bytes.length === 0) return null;
    return { bytes, lang: 'eng' };
  } catch { return null; }
}
```

Update the exports line:

```js
module.exports = {
  parseExtra, findStream, probeEnglishSub, extractSrt,
  detectEmbeddedEnglish, getEmbeddedSubtitle,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern="detectEmbeddedEnglish|getEmbeddedSubtitle"`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the whole embedded suite + commit**

Run: `npm test -- --test-name-pattern="parseExtra|findStream|probeEnglishSub|extractSrt|detectEmbeddedEnglish|getEmbeddedSubtitle"`
Expected: all PASS.

```bash
git add embedded.js test/embedded.test.js
git commit -m "feat: compose embedded detection + extraction helpers"
```

---

### Task 7: `server.js` — extract shared pipeline helper + two-track `/subtitles`

Refactor the translate pipeline into a reusable local helper (DRY), then make `/subtitles` advertise two Hebrew tracks when embedded English is detected. `createApp` gains a `deps.embedded` override defaulting to `require('./embedded')`.

**Files:**
- Modify: `server.js`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `embedded.parseExtra`, `embedded.detectEmbeddedEnglish`; `config.embeddedLabel`, `config.embeddedExternalLabel`.
- Produces: `createApp({ embedded })` override; two-entry `/subtitles` response `[{ id:'substranslator-heb-embedded', ... }, { id:'substranslator-heb-external', ... }]` when detected, else the original single `substranslator-heb` entry. Local helper `buildTranslatedSrt(source, stats) → Promise<string>`.

- [ ] **Step 1: Write the failing tests**

Add to `test/server.test.js`:

```js
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
    },
  });
  const r = await req(app, '/subtitles/series/tt1:1:2/filename=a.mkv&videoSize=123.json');
  const body = JSON.parse(r.text);
  assert.strictEqual(body.subtitles.length, 1);
  assert.strictEqual(body.subtitles[0].id, 'substranslator-heb');
  assert.strictEqual(body.subtitles[0].lang, 'heb');
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="TWO tracks|ONE original track|skips embedded detection"`
Expected: FAIL — single-entry response / `detectCalled` undefined behavior.

- [ ] **Step 3: Wire `deps.embedded` and add the shared helper**

In `server.js`, inside `createApp`, add directly after the existing
`const publicBase = deps.publicBase || \`http://${cfg.host}:${cfg.port}\`;` line
(the last of the `deps` destructuring block, ~line 37):

```js
  const embeddedImpl = deps.embedded || require('./embedded');
```

Then add this local helper inside `createApp` (before `app.get('/manifest.json' ...)`):

```js
  async function buildTranslatedSrt(source, stats) {
    const cues = srtImpl.parse(source.bytes);
    const translated = await translateCues(cues, { targetLang: cfg.targetLangGoogle, stats });
    const formatted = display.formatCues(translated);
    const finalCues = cfg.targetIsRtl ? rtl.markCuesRtl(formatted) : formatted;
    return srtImpl.serialize(finalCues);
  }
```

- [ ] **Step 4: Refactor the existing `/translate` route to use the helper**

Replace the body of the `/translate` route (the `try { ... }` block that builds `out`) so the pipeline lines become:

```js
    try {
      const source = await getSource(type, id, extra);
      if (!source) return res.send('');
      const stats = {};
      const out = await buildTranslatedSrt(source, stats);
      // Only cache a fully-translated result (see note above).
      if (!stats.failedChunks) cacheImpl.put(key, out);
      return res.send(out);
    } catch (e) {
      console.error('translate error:', e);
      return res.send('');
    }
```

- [ ] **Step 5: Rewrite the `/subtitles` handler as async with detection**

Replace the entire `/subtitles` route handler with:

```js
  app.get(/^\/subtitles\/(.+)\.json$/, async (req, res) => {
    logRequest(cfg, 'subtitles', req.params[0]);
    const segs = req.params[0].split('/');
    const type = segs[0];
    const id = segs[1];
    const extra = segs.slice(2).join('/');
    const extraPart = extra ? `/${extra}` : '';
    const externalUrl = `${publicBase}/translate/${type}/${id}${extraPart}.srt`;

    const { videoSize, filename } = embeddedImpl.parseExtra(extra);
    let detected = null;
    if (videoSize) {
      try { detected = await embeddedImpl.detectEmbeddedEnglish({ videoSize, filename }); }
      catch { detected = null; }
    }

    if (detected) {
      const embeddedUrl = `${publicBase}/translate-embedded/${type}/${id}${extraPart}.srt`;
      return res.json({ subtitles: [
        { id: 'substranslator-heb-embedded', url: embeddedUrl, lang: cfg.embeddedLabel },
        { id: 'substranslator-heb-external', url: externalUrl, lang: cfg.embeddedExternalLabel },
      ] });
    }
    // Not detected → single track, byte-identical to prior behavior.
    return res.json({ subtitles: [
      { id: 'substranslator-heb', url: externalUrl, lang: cfg.targetLangLabel },
    ] });
  });
```

- [ ] **Step 6: Run the new + existing subtitles/translate tests**

Run: `npm test -- --test-name-pattern="subtitles|translate"`
Expected: PASS — including the pre-existing `/subtitles` and `/translate` tests (backward compatibility preserved).

- [ ] **Step 7: Commit**

```bash
git add server.js test/server.test.js
git commit -m "feat: advertise embedded + external Hebrew tracks; extract translate helper"
```

---

### Task 8: `server.js` — `/translate-embedded` route with external fallback

Serve the embedded-sourced Hebrew, cached under the `emb:<videoHash>` key. On any embedded failure (no stream / no track / extraction empty), fall back to external translation without writing the embedded cache key.

**Files:**
- Modify: `server.js`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `embedded.parseExtra`, `embedded.getEmbeddedSubtitle`, `getSource`, `buildTranslatedSrt`, `cacheImpl`.
- Produces: route `GET /translate-embedded/(.+).srt`; cache key `${cacheVersion}:emb:${videoHash}:${type}:${id}`.

- [ ] **Step 1: Write the failing tests**

Add to `test/server.test.js`:

```js
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
    },
    getSource: async () => null,
    cache: { get: () => null, put: () => {} },
  });
  const r = await req(app, '/translate-embedded/movie/tt9/filename=a.mkv&videoHash=beef.srt');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.text, '');
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="translate-embedded"`
Expected: FAIL — route returns 404 (Express default) / `r.text` empty HTML.

- [ ] **Step 3: Add the `/translate-embedded` route**

In `server.js`, add immediately after the `/translate` route handler (before `return app;`):

```js
  app.get(/^\/translate-embedded\/(.+)\.srt$/, async (req, res) => {
    const segs = req.params[0].split('/');
    const type = segs[0];
    const id = segs[1];
    const extra = segs.slice(2).join('/') || '';
    const { videoSize, videoHash, filename } = embeddedImpl.parseExtra(extra);
    const key = `${cfg.cacheVersion || 'v1'}:emb:${videoHash || 'nohash'}:${type}:${id}`;
    res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');

    const cached = cacheImpl.get(key);
    if (cached != null) return res.send(cached);

    try {
      const source = await embeddedImpl.getEmbeddedSubtitle({ videoSize, filename });
      if (source && source.bytes && source.bytes.length) {
        const stats = {};
        const out = await buildTranslatedSrt(source, stats);
        if (!stats.failedChunks) cacheImpl.put(key, out);
        return res.send(out);
      }
      // Embedded unavailable → fall back to external translation.
      // Best-effort; do NOT write the embedded cache key so replay retries embedded.
      const ext = await getSource(type, id, extra || null);
      if (!ext) return res.send('');
      const out = await buildTranslatedSrt(ext, {});
      return res.send(out);
    } catch (e) {
      console.error('translate-embedded error:', e);
      return res.send('');
    }
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern="translate-embedded"`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the FULL suite**

Run: `npm test`
Expected: all tests PASS (existing + new).

- [ ] **Step 6: Commit**

```bash
git add server.js test/server.test.js
git commit -m "feat: serve embedded-sourced Hebrew with external fallback"
```

---

### Task 9: Live end-to-end verification + README

Confirm the design against a real Stremio stream (this is where the `/stats.json` shape and ffmpeg extraction are proven against live data), then document the feature.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Manual end-to-end test against Stremio**

Ensure Stremio Desktop is running and its streaming server responds:

Run: `curl -s -m 3 http://127.0.0.1:11470/settings | head -c 80`
Expected: JSON including `"serverVersion"`.

Then: `npm start`, install `http://127.0.0.1:7000/manifest.json` in Stremio, and **play a torrent-backed .mkv known to contain an embedded English subtitle track** (not a debrid/HTTP stream). Open the subtitle menu.

Expected: two entries — **Hebrew (from embedded)** and **Hebrew (from external)**. Selecting the embedded one shows Hebrew text timed to the video. If `/stats.json`'s real shape differs from the `{ [infoHash]: { files } }` / array forms `findStream` handles, adjust `findStream`'s iteration and re-run its unit tests before continuing.

- [ ] **Step 2: Verify graceful degradation**

Play a **direct-HTTP / debrid** stream (not torrent-backed). Open the subtitle menu.
Expected: only a single Hebrew track (the embedded one is correctly absent because the file isn't in `/stats.json`).

- [ ] **Step 3: Update the README**

In `README.md`, under the `## How it works` section, add:

```markdown
- **Hebrew (from embedded):** when you play a **torrent-backed** file that contains an
  embedded English subtitle track, a second Hebrew track appears, translated from that
  embedded English. Because it is timed to the exact file you are watching, it usually
  syncs better than the external source. It is extracted with a bundled `ffmpeg` binary
  (`ffmpeg-static`) via Stremio's local streaming server. Direct-HTTP / debrid streams
  don't pass through that server, so only the external Hebrew track is offered for them.
```

Under `## Requirements`, add:

```markdown
- `npm install` downloads a bundled `ffmpeg` binary (`ffmpeg-static`, ~80 MB) used to
  extract embedded subtitle tracks. No manual ffmpeg install is needed.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document embedded Hebrew track and ffmpeg-static requirement"
```

---

## Self-Review Notes

- **Spec coverage:** two-track UX (Task 7), streaming-server detection (Tasks 3–4, 6), ffmpeg-static extraction (Tasks 1, 5), subtitle-relative index (Tasks 4, 5), emb+videoHash cache key (Task 8), fallback-to-external-without-poisoning (Task 8), no-videoSize early-out (Task 7), graceful degradation matrix (Tasks 3/4/6/8 + Task 9 step 2), tests (every task), README (Task 9) — all mapped.
- **Type consistency:** `getEmbeddedSubtitle` returns `{ bytes, lang }` matching `getSource`'s shape, so `buildTranslatedSrt(source, stats)` consumes both identically. `trackIndex` is subtitle-relative end-to-end (`probeEnglishSub` produces it, `extractSrt` consumes it into `0:s:<n>`).
- **Known risk carried to Task 9:** the exact `/stats.json` JSON shape is confirmed only against live Stremio (server was offline at plan-writing time). `findStream` handles both documented shapes; Task 9 Step 1 is the live gate that proves it.
