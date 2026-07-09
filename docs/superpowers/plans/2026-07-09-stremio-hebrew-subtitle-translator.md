# Stremio Hebrew Subtitle Translator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Node.js Stremio addon that auto-provides a Hebrew (auto-translated) subtitle track for any movie/episode, and auto-starts on Windows login.

**Architecture:** A single Express server on `127.0.0.1:7000` implements the Stremio addon protocol plus a `/translate` route. `/subtitles` returns instantly with a URL to `/translate`; only when the track is selected does the server fetch a source subtitle from the free OpenSubtitles v3 addon, translate it to Hebrew via the free Google Translate endpoint, cache it to disk, and stream it back. A Windows Scheduled Task launches the server hidden at login.

**Tech Stack:** Node.js v24, Express 4, `chardet` + `iconv-lite` (encoding), Node built-in `fetch`/`zlib`, Node built-in `node:test` runner. Windows PowerShell + VBScript for auto-start.

## Global Constraints

- Node.js ≥ 24 (global `fetch` is used — do NOT add `node-fetch`).
- Pin `express` to `^4.19.2` (Express 5 changes regex-route behavior this plan relies on).
- Dependencies limited to: `express`, `chardet`, `iconv-lite`. No other runtime deps.
- Tests use the built-in `node:test` + `node:assert` only. No jest/mocha/supertest.
- Stremio subtitle language label is the 3-letter code `heb`; Google Translate target code is `he`. These are intentionally different.
- All modules use `'use strict';` and CommonJS (`require`/`module.exports`).
- Server binds `127.0.0.1` only (never `0.0.0.0`).
- Every module that does I/O (fetch/network) must accept an injectable dependency so tests never hit the real network.

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | Metadata, scripts (`start`, `test`), pinned deps |
| `config.js` | Host, port, target langs, source preference, cache dir, batching |
| `srt.js` | Charset decode; parse SRT/VTT → cues; serialize cues → SRT |
| `translate.js` | Google free-endpoint translation: batching, concurrency, retry, fallback |
| `sources.js` | Query OpenSubtitles v3 addon; select + download best source (gunzip if needed) |
| `cache.js` | Disk cache get/put of translated SRT strings |
| `manifest.js` | Stremio addon manifest object |
| `server.js` | Express app, CORS, routes, `startServer()` |
| `scripts/run-hidden.vbs` | Self-locating launcher that runs `node server.js` hidden |
| `scripts/install-startup.ps1` | Register Windows logon Scheduled Task |
| `scripts/uninstall-startup.ps1` | Remove the Scheduled Task |
| `README.md` | Install/run/add-to-Stremio instructions |
| `test/*.test.js` | One test file per module |

Cue shape used everywhere: `{ start: <ms:number>, end: <ms:number>, text: <string> }`.

---

## Task 1: Project scaffold + config

**Files:**
- Create: `package.json`
- Create: `config.js`
- Test: `test/config.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `config` object with keys `host, port, targetLangLabel, targetLangGoogle, sourcePreference (string[]), cacheDir, dataDir, opensubtitlesBase, batchSize, concurrency`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "substranslator",
  "version": "1.0.0",
  "private": true,
  "description": "Stremio addon that auto-translates subtitles to Hebrew",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "test": "node --test"
  },
  "dependencies": {
    "express": "^4.19.2",
    "chardet": "^2.0.0",
    "iconv-lite": "^0.6.3"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: creates `node_modules/` and `package-lock.json`, no errors.

- [ ] **Step 3: Write the failing test** — `test/config.test.js`

```js
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
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node --test test/config.test.js`
Expected: FAIL — `Cannot find module '../config'`.

- [ ] **Step 5: Write `config.js`**

```js
'use strict';
const path = require('path');
const os = require('os');

const dataDir = process.env.SUBSTRANSLATOR_DATA
  || (process.platform === 'win32' && process.env.APPDATA
    ? path.join(process.env.APPDATA, 'subsTranslator')
    : path.join(os.homedir(), '.subsTranslator'));

module.exports = {
  host: process.env.SUBSTRANSLATOR_HOST || '127.0.0.1',
  port: Number(process.env.SUBSTRANSLATOR_PORT) || 7000,
  targetLangLabel: 'heb',        // Stremio ISO 639-2 label
  targetLangGoogle: 'he',        // Google Translate target code
  sourcePreference: ['eng', 'en', 'english'],
  dataDir,
  cacheDir: path.join(dataDir, 'cache'),
  opensubtitlesBase: 'https://opensubtitles-v3.strem.io',
  batchSize: 100,
  concurrency: 5,
};
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test test/config.test.js`
Expected: PASS (1 test).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json config.js test/config.test.js
git commit -m "feat: project scaffold and config"
```

---

## Task 2: SRT/VTT parsing (`srt.js`)

**Files:**
- Create: `srt.js`
- Test: `test/srt.test.js`

**Interfaces:**
- Consumes: `chardet`, `iconv-lite`.
- Produces:
  - `decode(bytes: Buffer|string) → string`
  - `parse(input: Buffer|string) → cues[]` (cue: `{start, end, text}`, ms integers)
  - `serialize(cues[]) → string` (SRT text)
  - `parseTimestamp(str) → number|null`, `formatTimestamp(ms) → string`

- [ ] **Step 1: Write the failing test** — `test/srt.test.js`

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/srt.test.js`
Expected: FAIL — `Cannot find module '../srt'`.

- [ ] **Step 3: Write `srt.js`**

```js
'use strict';
const chardet = require('chardet');
const iconv = require('iconv-lite');

function decode(bytes) {
  if (typeof bytes === 'string') return bytes.replace(/^﻿/, '');
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return bytes.slice(3).toString('utf8');
  }
  const utf8 = bytes.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  const detected = chardet.detect(bytes) || 'windows-1252';
  return iconv.decode(bytes, detected);
}

function parseTimestamp(str) {
  const m = String(str).trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/);
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = parseInt(m[2], 10);
  const s = parseInt(m[3], 10);
  const ms = parseInt(m[4].padEnd(3, '0'), 10);
  return ((h * 60 + min) * 60 + s) * 1000 + ms;
}

function formatTimestamp(ms) {
  const p = (n, w) => String(n).padStart(w, '0');
  const h = Math.floor(ms / 3600000);
  const min = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${p(h, 2)}:${p(min, 2)}:${p(s, 2)},${p(ms % 1000, 3)}`;
}

function parse(input) {
  const text = decode(input).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = text.split(/\n\s*\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const idx = lines.findIndex(l => l.includes('-->'));
    if (idx === -1) continue;
    const [rawStart, rawEnd] = lines[idx].split('-->');
    if (rawEnd === undefined) continue;
    const start = parseTimestamp(rawStart);
    const end = parseTimestamp(rawEnd);
    if (start === null || end === null) continue;
    const cueText = lines.slice(idx + 1).join('\n').trim();
    if (cueText === '') continue;
    cues.push({ start, end, text: cueText });
  }
  return cues;
}

function serialize(cues) {
  return cues.map((c, i) =>
    `${i + 1}\n${formatTimestamp(c.start)} --> ${formatTimestamp(c.end)}\n${c.text}`
  ).join('\n\n') + '\n';
}

module.exports = { decode, parse, serialize, parseTimestamp, formatTimestamp };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/srt.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add srt.js test/srt.test.js
git commit -m "feat: SRT/VTT parse, serialize, and charset decode"
```

---

## Task 3: Translation engine (`translate.js`)

**Files:**
- Create: `translate.js`
- Test: `test/translate.test.js`

**Interfaces:**
- Consumes: `config`, global `fetch`.
- Produces:
  - `translateCues(cues[], opts?) → Promise<cues[]>` where `opts = { targetLang?, batchSize?, concurrency?, translateFn? }` and `translateFn(text, targetLang) → Promise<string>`.
  - `translateText(text, targetLang, sl?, fetchFn?) → Promise<string>`
  - `parseGoogleResponse(json) → string`
  - `mapWithConcurrency(items, limit, fn) → Promise<any[]>`

- [ ] **Step 1: Write the failing test** — `test/translate.test.js`

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { translateCues, parseGoogleResponse } = require('../translate');

test('parseGoogleResponse concatenates segments', () => {
  const json = [[['שלום ', 'Hello ', null], ['עולם', 'world', null]], null, 'en'];
  assert.strictEqual(parseGoogleResponse(json), 'שלום עולם');
});

test('translateCues maps translations back to cues', async () => {
  const cues = [
    { start: 0, end: 1000, text: 'Hello' },
    { start: 1000, end: 2000, text: 'World' },
  ];
  const fn = async (t) => t.split('\n').map(l => 'X:' + l).join('\n');
  const out = await translateCues(cues, { translateFn: fn, batchSize: 100 });
  assert.strictEqual(out[0].text, 'X:Hello');
  assert.strictEqual(out[1].text, 'X:World');
});

test('translateCues falls back to per-cue on line-count mismatch', async () => {
  const cues = [
    { start: 0, end: 1000, text: 'Hello' },
    { start: 1000, end: 2000, text: 'World' },
  ];
  const fn = async (t) => (t.includes('\n') ? 'collapsed' : 'T:' + t);
  const out = await translateCues(cues, { translateFn: fn, batchSize: 100 });
  assert.strictEqual(out[0].text, 'T:Hello');
  assert.strictEqual(out[1].text, 'T:World');
});

test('translateCues keeps original text when translation fails', async () => {
  const cues = [{ start: 0, end: 1000, text: 'Hello' }];
  const fn = async () => { throw new Error('boom'); };
  const out = await translateCues(cues, { translateFn: fn, batchSize: 100 });
  assert.strictEqual(out[0].text, 'Hello');
});

test('translateCues flattens internal newlines before sending', async () => {
  const cues = [{ start: 0, end: 1000, text: 'Line A\nLine B' }];
  let received;
  const fn = async (t) => { received = t; return t; };
  await translateCues(cues, { translateFn: fn, batchSize: 100 });
  assert.strictEqual(received, 'Line A Line B');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/translate.test.js`
Expected: FAIL — `Cannot find module '../translate'`.

- [ ] **Step 3: Write `translate.js`**

```js
'use strict';
const config = require('./config');

const GOOGLE_URL = 'https://translate.googleapis.com/translate_a/single';

function parseGoogleResponse(json) {
  if (!Array.isArray(json) || !Array.isArray(json[0])) return '';
  return json[0].map(seg => (seg && seg[0]) ? seg[0] : '').join('');
}

async function translateText(text, targetLang, sl = 'auto', fetchFn = fetch) {
  const url = `${GOOGLE_URL}?client=gtx&sl=${encodeURIComponent(sl)}`
    + `&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`translate HTTP ${res.status}`);
  return parseGoogleResponse(await res.json());
}

async function retry(fn, attempts = 3, baseDelay = 500) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

function flatten(text) {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

async function translateChunk(cues, targetLang, translateFn) {
  const texts = cues.map(c => flatten(c.text));
  try {
    const translated = await translateFn(texts.join('\n'), targetLang);
    const parts = translated.split('\n');
    if (parts.length === texts.length) {
      return cues.map((c, i) => ({ ...c, text: parts[i].trim() }));
    }
    const perCue = await Promise.all(texts.map(t => translateFn(t, targetLang)));
    return cues.map((c, i) => ({ ...c, text: perCue[i].trim() }));
  } catch (e) {
    return cues; // keep original text on failure
  }
}

async function translateCues(cues, opts = {}) {
  const targetLang = opts.targetLang || config.targetLangGoogle;
  const batchSize = opts.batchSize || config.batchSize;
  const concurrency = opts.concurrency || config.concurrency;
  const translateFn = opts.translateFn || ((t, tl) => retry(() => translateText(t, tl)));
  const chunks = [];
  for (let i = 0; i < cues.length; i += batchSize) chunks.push(cues.slice(i, i + batchSize));
  const out = await mapWithConcurrency(chunks, concurrency,
    (chunk) => translateChunk(chunk, targetLang, translateFn));
  return out.flat();
}

module.exports = { translateCues, translateText, parseGoogleResponse, mapWithConcurrency };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/translate.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add translate.js test/translate.test.js
git commit -m "feat: Google Translate engine with batching, concurrency, and fallback"
```

---

## Task 4: Source subtitle acquisition (`sources.js`)

**Files:**
- Create: `sources.js`
- Test: `test/sources.test.js`

**Interfaces:**
- Consumes: `config`, `zlib`, global `fetch`.
- Produces:
  - `selectBest(list[], preference?) → track|null` (track: `{lang, url, ...}`)
  - `getSourceSubtitle(type, id, extra, deps?) → Promise<{bytes: Buffer, lang: string}|null>` where `deps = { fetchFn?, base?, preference? }`
  - `maybeGunzip(buf) → Buffer`

- [ ] **Step 1: Write the failing test** — `test/sources.test.js`

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sources.test.js`
Expected: FAIL — `Cannot find module '../sources'`.

- [ ] **Step 3: Write `sources.js`**

```js
'use strict';
const zlib = require('zlib');
const config = require('./config');

function selectBest(list, preference = config.sourcePreference) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const prefs = preference.map(p => String(p).toLowerCase());
  for (const pref of prefs) {
    const hit = list.find(s => s && s.lang && String(s.lang).toLowerCase() === pref);
    if (hit) return hit;
  }
  return list[0];
}

function maybeGunzip(buf) {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf);
  return buf;
}

async function getSourceSubtitle(type, id, extra, deps = {}) {
  const fetchFn = deps.fetchFn || fetch;
  const base = deps.base || config.opensubtitlesBase;
  const preference = deps.preference || config.sourcePreference;
  const extraPart = extra ? `/${extra}` : '';
  const url = `${base}/subtitles/${type}/${id}${extraPart}.json`;

  let list;
  try {
    const res = await fetchFn(url);
    if (!res.ok) return null;
    const json = await res.json();
    list = json && json.subtitles;
  } catch { return null; }

  const track = selectBest(list, preference);
  if (!track || !track.url) return null;

  try {
    const res = await fetchFn(track.url);
    if (!res.ok) return null;
    const bytes = maybeGunzip(Buffer.from(await res.arrayBuffer()));
    return { bytes, lang: track.lang || 'unknown' };
  } catch { return null; }
}

module.exports = { selectBest, getSourceSubtitle, maybeGunzip };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sources.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add sources.js test/sources.test.js
git commit -m "feat: fetch and select source subtitles from OpenSubtitles v3 addon"
```

---

## Task 5: Disk cache (`cache.js`)

**Files:**
- Create: `cache.js`
- Test: `test/cache.test.js`

**Interfaces:**
- Consumes: `fs`, `path`, `config`.
- Produces:
  - `get(key, dir?) → string|null`
  - `put(key, srt, dir?) → void`
  - `keyToFile(key, dir?) → string`

- [ ] **Step 1: Write the failing test** — `test/cache.test.js`

```js
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
  assert.ok(!f.includes(':') || process.platform === 'win32');
  assert.ok(f.endsWith('.srt'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cache.test.js`
Expected: FAIL — `Cannot find module '../cache'`.

- [ ] **Step 3: Write `cache.js`**

```js
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');

function keyToFile(key, dir = config.cacheDir) {
  const safe = String(key).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(dir, `${safe}.srt`);
}

function get(key, dir = config.cacheDir) {
  try { return fs.readFileSync(keyToFile(key, dir), 'utf8'); }
  catch { return null; }
}

function put(key, srt, dir = config.cacheDir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyToFile(key, dir), srt, 'utf8');
}

module.exports = { get, put, keyToFile };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/cache.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add cache.js test/cache.test.js
git commit -m "feat: disk cache for translated subtitles"
```

---

## Task 6: Addon manifest (`manifest.js`)

**Files:**
- Create: `manifest.js`
- Test: `test/manifest.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `buildManifest() → object`.

- [ ] **Step 1: Write the failing test** — `test/manifest.test.js`

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/manifest.test.js`
Expected: FAIL — `Cannot find module '../manifest'`.

- [ ] **Step 3: Write `manifest.js`**

```js
'use strict';

function buildManifest() {
  return {
    id: 'community.substranslator.hebrew',
    version: '1.0.0',
    name: 'Hebrew Auto-Translate',
    description: 'Auto-translates available subtitles to Hebrew using Google Translate.',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    catalogs: [],
    idPrefixes: ['tt'],
    behaviorHints: { configurable: false },
  };
}

module.exports = { buildManifest };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/manifest.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add manifest.js test/manifest.test.js
git commit -m "feat: Stremio addon manifest"
```

---

## Task 7: Express server (`server.js`)

**Files:**
- Create: `server.js`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `express`, `config`, `manifest.buildManifest`, `srt`, `sources.getSourceSubtitle`, `translate.translateCues`, `cache`.
- Produces:
  - `createApp(deps?) → express.Application` where `deps = { config?, getSource?, translateCues?, cache?, srt?, publicBase? }`
  - `startServer(config?) → http.Server`

- [ ] **Step 1: Write the failing test** — `test/server.test.js`

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server.test.js`
Expected: FAIL — `Cannot find module '../server'`.

- [ ] **Step 3: Write `server.js`**

```js
'use strict';
const express = require('express');
const config = require('./config');
const { buildManifest } = require('./manifest');
const srt = require('./srt');
const sources = require('./sources');
const translate = require('./translate');
const cache = require('./cache');

function cors(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

function createApp(deps = {}) {
  const cfg = deps.config || config;
  const getSource = deps.getSource || sources.getSourceSubtitle;
  const translateCues = deps.translateCues || translate.translateCues;
  const cacheImpl = deps.cache || cache;
  const srtImpl = deps.srt || srt;
  const publicBase = deps.publicBase || `http://${cfg.host}:${cfg.port}`;

  const app = express();
  app.use(cors);

  app.get('/manifest.json', (req, res) => res.json(buildManifest()));

  app.get(/^\/subtitles\/(.+)\.json$/, (req, res) => {
    const segs = req.params[0].split('/');
    const type = segs[0];
    const id = segs[1];
    const extra = segs.slice(2).join('/');
    const extraPart = extra ? `/${extra}` : '';
    const url = `${publicBase}/translate/${type}/${id}${extraPart}.srt`;
    res.json({ subtitles: [{ id: 'substranslator-heb', url, lang: cfg.targetLangLabel }] });
  });

  app.get(/^\/translate\/(.+)\.srt$/, async (req, res) => {
    const segs = req.params[0].split('/');
    const type = segs[0];
    const id = segs[1];
    const extra = segs.slice(2).join('/') || null;
    const key = `${type}:${id}`;
    res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');

    const cached = cacheImpl.get(key);
    if (cached != null) return res.send(cached);

    try {
      const source = await getSource(type, id, extra);
      if (!source) return res.send('');
      const cues = srtImpl.parse(source.bytes);
      const translated = await translateCues(cues, { targetLang: cfg.targetLangGoogle });
      const out = srtImpl.serialize(translated);
      cacheImpl.put(key, out);
      return res.send(out);
    } catch (e) {
      console.error('translate error:', e);
      return res.send('');
    }
  });

  return app;
}

function startServer(cfg = config) {
  const app = createApp({ config: cfg });
  return app.listen(cfg.port, cfg.host, () => {
    console.log(`subsTranslator running at http://${cfg.host}:${cfg.port}/manifest.json`);
  });
}

if (require.main === module) startServer();

module.exports = { createApp, startServer };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — all tests across every file (config, srt, translate, sources, cache, manifest, server).

- [ ] **Step 6: Commit**

```bash
git add server.js test/server.test.js
git commit -m "feat: Express server with manifest, subtitles, and translate routes"
```

---

## Task 8: Windows auto-start + README

**Files:**
- Create: `scripts/run-hidden.vbs`
- Create: `scripts/install-startup.ps1`
- Create: `scripts/uninstall-startup.ps1`
- Create: `README.md`

**Interfaces:** none (operational scripts + docs). This task is verified manually, not by unit tests.

- [ ] **Step 1: Create `scripts/run-hidden.vbs`** (self-locating launcher, hidden window)

```vbs
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectDir = fso.GetParentFolderName(scriptDir)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = projectDir
' 0 = hidden window, False = do not wait for the process to exit
sh.Run "node server.js", 0, False
```

- [ ] **Step 2: Create `scripts/install-startup.ps1`**

```powershell
$ErrorActionPreference = 'Stop'
$vbs = Join-Path $PSScriptRoot 'run-hidden.vbs'
if (-not (Test-Path $vbs)) { throw "run-hidden.vbs not found at $vbs" }

$action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName 'subsTranslator' -Action $action -Trigger $trigger `
  -Settings $settings -Description 'Starts the subsTranslator Stremio addon server at login.' -Force | Out-Null

Write-Host "Registered scheduled task 'subsTranslator'. Starting it now..."
Start-ScheduledTask -TaskName 'subsTranslator'
Write-Host "Verify with: Invoke-RestMethod http://127.0.0.1:7000/manifest.json"
```

- [ ] **Step 3: Create `scripts/uninstall-startup.ps1`**

```powershell
$ErrorActionPreference = 'Stop'
try { Stop-ScheduledTask -TaskName 'subsTranslator' -ErrorAction Stop } catch {}
Unregister-ScheduledTask -TaskName 'subsTranslator' -Confirm:$false
Write-Host "Removed scheduled task 'subsTranslator'."
```

- [ ] **Step 4: Create `README.md`**

````markdown
# subsTranslator — Hebrew subtitles for Stremio

A local Stremio addon that adds a **Hebrew (auto-translated)** subtitle track to any
movie or episode. It fetches an existing subtitle from the free OpenSubtitles v3 addon,
translates it to Hebrew with Google Translate, caches the result, and serves it back to
Stremio. No API keys, no accounts, no cost.

## Requirements

- Windows with Node.js ≥ 24 installed (`node --version`).
- The **Stremio desktop app** (recommended — the local `http://127.0.0.1` addon works
  cleanly there without browser mixed-content restrictions).

## Install

```powershell
npm install
```

## Run once (manual)

```powershell
npm start
```

Leave it running, then in Stremio: **Addons → paste** `http://127.0.0.1:7000/manifest.json`
→ **Install**. Play something and pick **Hebrew (auto-translated)** in the subtitle menu.

## Run automatically at every login

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-startup.ps1
```

This registers a hidden Scheduled Task that starts the server whenever you log in, so it's
always ready when you open Stremio. Remove it with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall-startup.ps1
```

## How it works

- `GET /manifest.json` — declares a subtitles addon.
- `GET /subtitles/{type}/{id}/{extra}.json` — returns one Hebrew track whose URL points
  back at this server's `/translate` route (instant; no translation yet).
- `GET /translate/{type}/{id}.srt` — on first request, fetches a source subtitle, translates
  it to Hebrew, caches it under `%APPDATA%\subsTranslator\cache`, and streams SRT. Later
  requests are served from cache.

## Config

Edit `config.js` (or set env vars): `SUBSTRANSLATOR_PORT`, `SUBSTRANSLATOR_HOST`,
`SUBSTRANSLATOR_DATA`.
````

- [ ] **Step 5: Verify the server runs manually**

Run: `npm start` (in one terminal)
Then in another terminal: `powershell -Command "Invoke-RestMethod http://127.0.0.1:7000/manifest.json"`
Expected: JSON manifest with `resources` containing `subtitles`. Stop the server (Ctrl+C).

- [ ] **Step 6: Install and verify the scheduled task**

Run: `powershell -ExecutionPolicy Bypass -File scripts\install-startup.ps1`
Then: `powershell -Command "Get-ScheduledTask -TaskName subsTranslator"`
Then: `powershell -Command "Start-Sleep -Seconds 3; Invoke-RestMethod http://127.0.0.1:7000/manifest.json"`
Expected: task exists and the manifest responds (server started hidden by the task).

- [ ] **Step 7: Commit**

```bash
git add scripts/run-hidden.vbs scripts/install-startup.ps1 scripts/uninstall-startup.ps1 README.md
git commit -m "feat: Windows login auto-start scripts and README"
```

---

## Task 9: Live end-to-end smoke check (manual, network-dependent)

**Files:** none (uses the running server).

**Interfaces:** none.

- [ ] **Step 1: Start the server**

Run: `npm start`

- [ ] **Step 2: Request subtitles for a known movie**

Run: `powershell -Command "Invoke-RestMethod 'http://127.0.0.1:7000/subtitles/movie/tt0111161.json'"`
Expected: JSON with one subtitle whose `lang` is `heb` and whose `url` ends in
`/translate/movie/tt0111161.srt`.

- [ ] **Step 3: Fetch and translate**

Run: `powershell -Command "(Invoke-WebRequest 'http://127.0.0.1:7000/translate/movie/tt0111161.srt').Content.Substring(0,400)"`
Expected: SRT text containing Hebrew characters (may take several seconds the first time;
instant on repeat thanks to the cache). If OpenSubtitles has no source for this id, the body
is empty — try another popular IMDb id.

- [ ] **Step 4: Confirm the cache file exists**

Run: `powershell -Command "Get-ChildItem $env:APPDATA\subsTranslator\cache"`
Expected: a `movie_tt0111161.srt` file.

- [ ] **Step 5: Stop the server** (Ctrl+C). No commit needed (no file changes).

---

## Self-Review Notes

- **Spec coverage:** local server ✓ (Task 7), auto-start on login ✓ (Task 8), OpenSubtitles v3
  source ✓ (Task 4), Google free translation ✓ (Task 3), Hebrew-only ✓ (single track, Task 7),
  auto/any source with English preference ✓ (Task 4 `selectBest`), lazy translation ✓ (Task 7),
  disk cache ✓ (Task 5), charset decode ✓ (Task 2), error handling (no source / failed batch /
  non-UTF8 / rate-limit retry) ✓ (Tasks 2/3/7), testing strategy ✓ (unit tests per module +
  Task 9 smoke).
- **Type consistency:** cue shape `{start, end, text}` used identically across srt/translate/
  server; `getSourceSubtitle` returns `{bytes, lang}` consumed in server; `translateCues(cues,
  {targetLang})` signature matches server call; `cache.get/put(key, ...)` matches server usage;
  `buildManifest()` name consistent.
- **No placeholders:** every code step contains complete, runnable code.
