# External-text + Embedded-timing Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a torrent-backed file's embedded English subtitle is image-based (PGS/VobSub), produce a well-synced Hebrew track by re-timing OpenSubtitles' English text to the embedded track's cue timings, then translating.

**Architecture:** A new pure `sync.js` module computes a global linear transform (offset + framerate ratio) aligning two subtitle-onset signals via FFT cross-correlation. `embedded.js` gains `probeEnglish` (reports English text *and* image tracks) and `extractCueOnsets` (ffprobe packet start-times). `server.js` orchestrates: for an image English track it reads the embedded onsets, fetches OpenSubtitles, computes the sync, and — if confident — offers and serves a re-timed, translated track. A per-`videoHash` in-memory cache makes the heavy work run once.

**Tech Stack:** Node.js ≥24, CommonJS, Express 4, `node:test`, `ffmpeg-static` (existing) + `ffprobe-static` (new), Google Translate (existing).

## Global Constraints

- **Node.js ≥ 24**, CommonJS, `'use strict';` at top of every new file.
- **Dependency injection everywhere:** new I/O functions take a `deps` object with injectable `fetchFn` / `execFileFn` / `ffprobePath` / `base`, defaulting to real implementations. Tests never hit the network or spawn real binaries.
- **Tests use `node:test` + `node:assert`**, run via `npm test`. Mirror existing helper styles in `test/embedded.test.js` (`mockFetchJson`).
- **Units:** `sync.js` works in **seconds** (onsets, offset). Cue objects from `srt.js` use **milliseconds** (`start`/`end`). `applySync` maps ms cues with `ms*scale + offset*1000`. Onsets passed to `computeLinearSync` are seconds (external cue `start/1000`; ffprobe `pts_time` is already seconds).
- **`trackIndex` is subtitle-relative** (position among subtitle streams), consistent with existing `probeEnglishSub`. Used for both ffmpeg `-map 0:s:<n>` and ffprobe `-select_streams s:<n>`.
- **Image codecs:** `IMAGE_SUB_CODECS = { hdmv_pgs_subtitle, pgssub, dvd_subtitle, dvdsub, vobsub }`. Text codecs: existing `TEXT_SUB_CODECS`.
- **Sync constants:** `BIN_SECONDS = 0.1`, `MAX_OFFSET_SECONDS = 120`, `FRAMERATE_RATIOS = [1, 24/23.976, 23.976/24, 25/24, 24/25, 25/23.976, 23.976/25]`. Score is normalized peak in `[0,1]`.
- **`config.minSyncScore`** default `0.4` (env `SUBSTRANSLATOR_MIN_SYNC_SCORE`). Below it → do not offer the embedded track.
- **Cache key (unchanged):** embedded SRT cached under `${cacheVersion}:emb:${videoHash}:${type}:${id}`.
- **Graceful degradation:** any failure in the image-sync path degrades to the existing external-only behavior; no route throws to the client.
- **Preserve the working text path:** the existing `detectEmbeddedEnglish` / `getEmbeddedSubtitle` text-extraction behavior and its tests must remain green. The image path is additive.

---

### Task 1: `ffprobe-static` dependency + `config.minSyncScore`

**Files:**
- Modify: `package.json`, `config.js`, `test/config.test.js`

**Interfaces:**
- Produces: `config.minSyncScore` (number). `ffprobe-static` resolvable via `require('ffprobe-static').path`.

- [ ] **Step 1: Add the failing config assertion**

In `test/config.test.js`, inside `test('config has expected defaults', ...)` before the closing `});`:

```js
  assert.strictEqual(config.minSyncScore, 0.4);
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm test -- --test-name-pattern="config has expected defaults"`
Expected: FAIL — `undefined !== 0.4`.

- [ ] **Step 3: Add the config field**

In `config.js`, after the `logEmbedded:` line, add:

```js
  minSyncScore: Number(process.env.SUBSTRANSLATOR_MIN_SYNC_SCORE) || 0.4, // image-sync confidence floor
```

- [ ] **Step 4: Add and install ffprobe-static**

In `package.json` `"dependencies"`, add (comma after previous entry):

```json
    "ffprobe-static": "^3.1.0"
```

Run: `npm install`
Expected: `node -e "console.log(require('ffprobe-static').path)"` prints a path ending in `ffprobe.exe`.

- [ ] **Step 5: Verify config test passes + commit**

Run: `npm test -- --test-name-pattern="config has expected defaults"` → PASS.

```bash
git add package.json package-lock.json config.js test/config.test.js
git commit -m "feat: add ffprobe-static dependency and config.minSyncScore"
```

---

### Task 2: `sync.js` — FFT + cross-correlation primitives

**Files:**
- Create: `sync.js`
- Test: `test/sync.test.js`

**Interfaces:**
- Produces (exported for testing): `_fft(re, im, inverse)` (in-place radix-2, `re`/`im` are `Float64Array` of power-of-two length; `inverse` boolean, inverse divides by n), `_nextPow2(n)`, `_crossCorrelate(a, b) → Float64Array` (real cross-correlation; index `m` = lag `m`, and `m ≥ n/2` = negative lag `m - n`, where `corr[lag] = Σ_t a[t]·b[t+lag]`).

- [ ] **Step 1: Write the failing tests**

Create `test/sync.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const sync = require('../sync');

test('_fft round-trips a signal (forward then inverse ≈ identity)', () => {
  const re = Float64Array.from([1, 2, 3, 4, 0, 0, 0, 0]);
  const im = new Float64Array(8);
  const re0 = Float64Array.from(re);
  sync._fft(re, im, false);
  sync._fft(re, im, true);
  for (let i = 0; i < 8; i++) assert.ok(Math.abs(re[i] - re0[i]) < 1e-9, `bin ${i}`);
});

test('_crossCorrelate peaks at the lag by which b leads a', () => {
  // b is a shifted 2 bins later than a: b[t] = a[t-2]
  const a = Float64Array.from([0, 1, 0, 1, 0, 0, 0, 0]);
  const b = Float64Array.from([0, 0, 0, 1, 0, 1, 0, 0]);
  const corr = sync._crossCorrelate(a, b);
  // find lag of max within [-4,4]
  const n = corr.length;
  let bestLag = 0, bestVal = -Infinity;
  for (let lag = -4; lag <= 4; lag++) {
    const v = corr[lag >= 0 ? lag : n + lag];
    if (v > bestVal) { bestVal = v; bestLag = lag; }
  }
  assert.strictEqual(bestLag, 2);
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npm test -- --test-name-pattern="_fft|_crossCorrelate"`
Expected: FAIL — `Cannot find module '../sync'`.

- [ ] **Step 3: Implement**

Create `sync.js`:

```js
'use strict';

// In-place iterative radix-2 Cooley–Tukey FFT. re/im: Float64Array, length a power of 2.
// inverse=false → forward; inverse=true → inverse (divides by n).
function _fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = cwr * re[b] - cwi * im[b];
        const ti = cwr * im[b] + cwi * re[b];
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr; cwr = ncwr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

function _nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// Real cross-correlation via FFT: corr[lag] = Σ_t a[t]·b[t+lag].
// Returns length-n real array; index m = lag m (m ≥ n/2 → negative lag m-n).
function _crossCorrelate(a, b) {
  const n = _nextPow2(a.length + b.length);
  const ar = new Float64Array(n), ai = new Float64Array(n);
  const br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(a); br.set(b);
  _fft(ar, ai, false);
  _fft(br, bi, false);
  const cr = new Float64Array(n), ci = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // conj(A) * B
    cr[i] = ar[i] * br[i] + ai[i] * bi[i];
    ci[i] = ar[i] * bi[i] - ai[i] * br[i];
  }
  _fft(cr, ci, true);
  return cr;
}

module.exports = { _fft, _nextPow2, _crossCorrelate };
```

- [ ] **Step 4: Run, verify pass**

Run: `npm test -- --test-name-pattern="_fft|_crossCorrelate"` → PASS (2).

- [ ] **Step 5: Commit**

```bash
git add sync.js test/sync.test.js
git commit -m "feat: FFT + cross-correlation primitives in sync.js"
```

---

### Task 3: `sync.js` — `computeLinearSync`

**Files:**
- Modify: `sync.js`, `test/sync.test.js`

**Interfaces:**
- Consumes: `_crossCorrelate`.
- Produces: `computeLinearSync(onsetsA, onsetsB, opts={}) → { scale, offset, score }`. `onsetsA`/`onsetsB`: arrays of cue start times in seconds. `offset` in seconds (add to A to match B). `score` in `[0,1]`. Constants `BIN_SECONDS`, `MAX_OFFSET_SECONDS`, `FRAMERATE_RATIOS` exported.

- [ ] **Step 1: Write the failing tests**

Add to `test/sync.test.js`:

```js
test('computeLinearSync recovers a constant offset', () => {
  const A = [];
  for (let t = 10; t < 600; t += 3) A.push(t); // ~197 onsets across 10 min
  const B = A.map(t => t + 5);                  // B is 5s later
  const r = sync.computeLinearSync(A, B);
  assert.ok(Math.abs(r.scale - 1) < 1e-9, `scale ${r.scale}`);
  assert.ok(Math.abs(r.offset - 5) < 0.1, `offset ${r.offset}`);
  assert.ok(r.score > 0.9, `score ${r.score}`);
});

test('computeLinearSync recovers a framerate scale (23.976→25)', () => {
  const ratio = 23.976 / 25; // ≈0.95904
  const A = [];
  for (let t = 10; t < 600; t += 3) A.push(t);
  const B = A.map(t => t * ratio);
  const r = sync.computeLinearSync(A, B);
  assert.ok(Math.abs(r.scale - ratio) < 1e-3, `scale ${r.scale}`);
  assert.ok(Math.abs(r.offset) < 0.2, `offset ${r.offset}`);
  assert.ok(r.score > 0.9, `score ${r.score}`);
});

test('computeLinearSync gives a low score for uncorrelated onsets', () => {
  // deterministic pseudo-scatter, no shared structure
  const A = [], B = [];
  for (let i = 0; i < 200; i++) A.push((i * 37) % 600 + 0.13 * i);
  for (let i = 0; i < 200; i++) B.push((i * 53) % 600 + 0.07 * i);
  A.sort((x, y) => x - y); B.sort((x, y) => x - y);
  const r = sync.computeLinearSync(A, B);
  assert.ok(r.score < 0.4, `score ${r.score} should be low`);
});

test('computeLinearSync returns zero score for empty input', () => {
  const r = sync.computeLinearSync([], [1, 2, 3]);
  assert.strictEqual(r.score, 0);
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npm test -- --test-name-pattern="computeLinearSync"`
Expected: FAIL — `sync.computeLinearSync is not a function`.

- [ ] **Step 3: Implement**

In `sync.js`, add before `module.exports`:

```js
const BIN_SECONDS = 0.1;
const MAX_OFFSET_SECONDS = 120;
const FRAMERATE_RATIOS = [1, 24 / 23.976, 23.976 / 24, 25 / 24, 24 / 25, 25 / 23.976, 23.976 / 25];

function rasterize(onsets, scale, binSeconds, nBins) {
  const sig = new Float64Array(nBins);
  for (const t of onsets) {
    const bin = Math.round((t * scale) / binSeconds);
    if (bin >= 0 && bin < nBins) sig[bin] = 1;
  }
  return sig;
}

function computeLinearSync(onsetsA, onsetsB, opts = {}) {
  const binSeconds = opts.binSeconds || BIN_SECONDS;
  const maxOffset = opts.maxOffsetSeconds || MAX_OFFSET_SECONDS;
  if (!onsetsA.length || !onsetsB.length) return { scale: 1, offset: 0, score: 0 };

  const lastA = onsetsA[onsetsA.length - 1];
  const lastB = onsetsB[onsetsB.length - 1];
  const spanSeconds = Math.max(lastA, lastB) + maxOffset + 1;
  const nBins = Math.ceil(spanSeconds / binSeconds) + 1;
  const sigB = rasterize(onsetsB, 1, binSeconds, nBins);
  const energyB = onsetsB.length;
  const maxLagBins = Math.round(maxOffset / binSeconds);

  let best = { scale: 1, offset: 0, score: 0 };
  for (const r of FRAMERATE_RATIOS) {
    const sigA = rasterize(onsetsA, r, binSeconds, nBins);
    const corr = _crossCorrelate(sigA, sigB);
    const n = corr.length;
    const norm = Math.sqrt(onsetsA.length * energyB) || 1;
    for (let lag = -maxLagBins; lag <= maxLagBins; lag++) {
      const idx = lag >= 0 ? lag : n + lag;
      const v = corr[idx] / norm;
      if (v > best.score) best = { scale: r, offset: lag * binSeconds, score: v };
    }
  }
  return best;
}
```

Update the exports line:

```js
module.exports = {
  _fft, _nextPow2, _crossCorrelate,
  computeLinearSync, BIN_SECONDS, MAX_OFFSET_SECONDS, FRAMERATE_RATIOS,
};
```

- [ ] **Step 4: Run, verify pass**

Run: `npm test -- --test-name-pattern="computeLinearSync"` → PASS (4).

- [ ] **Step 5: Commit**

```bash
git add sync.js test/sync.test.js
git commit -m "feat: computeLinearSync (offset + framerate alignment)"
```

---

### Task 4: `sync.js` — `applySync`

**Files:**
- Modify: `sync.js`, `test/sync.test.js`

**Interfaces:**
- Produces: `applySync(cues, { scale, offset }) → cues'`. Cues have `{start, end, text, ...}` in **milliseconds**. Maps `start/end` by `Math.round(t*scale + offset*1000)`, clamps `start` to ≥0, drops cues with `end ≤ 0`, never edits `text`.

- [ ] **Step 1: Write the failing tests**

Add to `test/sync.test.js`:

```js
test('applySync scales and offsets cue timings in ms, preserving text', () => {
  const cues = [
    { start: 1000, end: 2000, text: 'a' },
    { start: 10000, end: 11000, text: 'b' },
  ];
  const out = sync.applySync(cues, { scale: 1, offset: 5 }); // +5s = +5000ms
  assert.deepStrictEqual(out[0], { start: 6000, end: 7000, text: 'a' });
  assert.deepStrictEqual(out[1], { start: 15000, end: 16000, text: 'b' });
});

test('applySync clamps negative start and drops fully-negative cues', () => {
  const cues = [
    { start: 1000, end: 2000, text: 'x' },   // shifted -3s → start -2000 end -1000 → dropped (end ≤ 0)
    { start: 4000, end: 6000, text: 'y' },   // shifted -3s → start 1000 end 3000
  ];
  const out = sync.applySync(cues, { scale: 1, offset: -3 });
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0], { start: 1000, end: 3000, text: 'y' });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npm test -- --test-name-pattern="applySync"`
Expected: FAIL — `sync.applySync is not a function`.

- [ ] **Step 3: Implement**

In `sync.js`, add before `module.exports`:

```js
function applySync(cues, { scale, offset }) {
  const offMs = offset * 1000;
  const out = [];
  for (const c of cues) {
    const start = Math.round(c.start * scale + offMs);
    const end = Math.round(c.end * scale + offMs);
    if (end <= 0) continue;
    out.push({ ...c, start: Math.max(0, start), end });
  }
  return out;
}
```

Add `applySync` to the exports object.

- [ ] **Step 4: Run, verify pass**

Run: `npm test -- --test-name-pattern="applySync"` → PASS (2). Then `npm test` → full suite green.

- [ ] **Step 5: Commit**

```bash
git add sync.js test/sync.test.js
git commit -m "feat: applySync re-times cues by scale+offset"
```

---

### Task 5: `embedded.js` — `probeEnglish` (text + image tracks)

**Files:**
- Modify: `embedded.js`, `test/embedded.test.js`

**Interfaces:**
- Consumes: existing `fetchWithTimeout`, `TEXT_SUB_CODECS`, streaming-server `/probe`.
- Produces: `probeEnglish(mediaUrl, deps) → { text: {trackIndex, codec}|null, image: {trackIndex, codec}|null }`. `probeEnglishSub` refactored to `return (await probeEnglish(mediaUrl, deps)).text` (existing behavior + tests unchanged). New `IMAGE_SUB_CODECS` set.

- [ ] **Step 1: Write the failing tests**

Add to `test/embedded.test.js`:

```js
test('probeEnglish returns both text and image english tracks (flat streams[])', () => {
  return (async () => {
    const probe = { streams: [
      { codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', lang: 'eng' }, // s:0 image
      { codec_type: 'subtitle', codec_name: 'subrip', lang: 'eng' },            // s:1 text
    ] };
    const fetchFn = mockFetchJson({ '/probe': probe });
    const r = await embedded.probeEnglish('http://s/H/0', { fetchFn, base: 'http://s' });
    assert.deepStrictEqual(r.text, { trackIndex: 1, codec: 'subrip' });
    assert.deepStrictEqual(r.image, { trackIndex: 0, codec: 'hdmv_pgs_subtitle' });
  })();
});

test('probeEnglish returns image only for a PGS-only file (Wakfu case)', async () => {
  const probe = { streams: [
    { codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', lang: 'eng' },
    { codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', lang: 'fre' },
  ] };
  const fetchFn = mockFetchJson({ '/probe': probe });
  const r = await embedded.probeEnglish('http://s/H/0', { fetchFn, base: 'http://s' });
  assert.strictEqual(r.text, null);
  assert.deepStrictEqual(r.image, { trackIndex: 0, codec: 'hdmv_pgs_subtitle' });
});

test('probeEnglishSub still returns just the text track (delegates to probeEnglish)', async () => {
  const probe = { streams: [
    { codec_type: 'subtitle', codec_name: 'subrip', lang: 'eng' },
  ] };
  const fetchFn = mockFetchJson({ '/probe': probe });
  const r = await embedded.probeEnglishSub('http://s/H/0', { fetchFn, base: 'http://s' });
  assert.deepStrictEqual(r, { trackIndex: 0, codec: 'subrip' });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npm test -- --test-name-pattern="probeEnglish"`
Expected: the two `probeEnglish` tests FAIL (`embedded.probeEnglish is not a function`); existing `probeEnglishSub` tests still pass.

- [ ] **Step 3: Implement**

In `embedded.js`, after the `TEXT_SUB_CODECS` line, add:

```js
const IMAGE_SUB_CODECS = new Set(['hdmv_pgs_subtitle', 'pgssub', 'dvd_subtitle', 'dvdsub', 'vobsub']);
```

Replace the whole `probeEnglishSub` function (lines beginning `async function probeEnglishSub(mediaUrl, deps = {}) {` through its closing `}`) with `probeEnglish` plus a thin `probeEnglishSub` delegate:

```js
async function probeEnglish(mediaUrl, deps = {}) {
  const fetchFn = deps.fetchFn || fetch;
  const base = deps.base || config.streamingServerBase;
  const timeoutMs = deps.probeTimeoutMs || 1500;
  const log = deps.log || (() => {});
  const empty = { text: null, image: null };

  let probe;
  try {
    const url = `${base}/probe?url=${encodeURIComponent(mediaUrl)}`;
    const res = await fetchWithTimeout(fetchFn, url, timeoutMs);
    if (!res.ok) { log(`probeEnglish: /probe HTTP ${res.status}`); return empty; }
    probe = await res.json();
  } catch { log('probeEnglish: /probe request failed'); return empty; }

  // Stremio server 4.x: flat streams[] discriminated by codec_type; older enginefs
  // nested them under streams.subtitles. Support both; preserve file order so the
  // position is subtitle-relative for `-map/-select_streams 0:s:<n>`.
  const streams = probe && probe.streams;
  let subs;
  if (Array.isArray(streams)) {
    subs = streams.filter(s => String(s.codec_type || '').toLowerCase() === 'subtitle');
  } else if (streams && Array.isArray(streams.subtitles)) {
    subs = streams.subtitles;
  } else {
    log('probeEnglish: probe response had no streams');
    return empty;
  }

  log(`probeEnglish: subtitle tracks = [${subs.map(s =>
    `${String(s.codec_name || s.codec || '?')}/${String(s.lang || (s.tags && s.tags.language) || s.language || '?')}`
  ).join(', ') || 'none'}]`);

  let text = null, image = null;
  for (let rel = 0; rel < subs.length; rel++) {
    const s = subs[rel] || {};
    const codec = String(s.codec_name || s.codec || '').toLowerCase();
    const tags = s.tags || {};
    const lang = String(s.lang || tags.language || s.language || '').toLowerCase();
    const title = String(tags.title || s.title || '');
    const isEnglish = lang === 'eng' || lang === 'en' || /english/i.test(title);
    if (!isEnglish) continue;
    if (!text && TEXT_SUB_CODECS.has(codec)) text = { trackIndex: rel, codec };
    if (!image && IMAGE_SUB_CODECS.has(codec)) image = { trackIndex: rel, codec };
  }
  if (text) log(`probeEnglish: english TEXT track at s:${text.trackIndex} (${text.codec})`);
  else if (image) log(`probeEnglish: english IMAGE track at s:${image.trackIndex} (${image.codec}) — timing-only`);
  else log('probeEnglish: no english subtitle track');
  return { text, image };
}

async function probeEnglishSub(mediaUrl, deps = {}) {
  return (await probeEnglish(mediaUrl, deps)).text;
}
```

- [ ] **Step 4: Update exports**

In `module.exports`, add `probeEnglish` to the list (keep `probeEnglishSub`).

- [ ] **Step 5: Run, verify pass**

Run: `npm test -- --test-name-pattern="probeEnglish"` → PASS. Then `npm test` → full suite green (existing probe/detect tests unaffected).

- [ ] **Step 6: Commit**

```bash
git add embedded.js test/embedded.test.js
git commit -m "feat: probeEnglish reports english text and image tracks"
```

---

### Task 6: `embedded.js` — `extractCueOnsets`

**Files:**
- Modify: `embedded.js`, `test/embedded.test.js`

**Interfaces:**
- Produces: `extractCueOnsets({ mediaUrl, trackIndex }, deps) → Promise<number[]>` — cue start times in seconds, sorted ascending. `deps.execFileFn` (default `child_process.execFile`), `deps.ffprobePath` (default `require('ffprobe-static').path`).

- [ ] **Step 1: Write the failing tests**

Add to `test/embedded.test.js`:

```js
test('extractCueOnsets parses ffprobe pts_time CSV into sorted seconds', async () => {
  let capturedArgs = null;
  const execFileFn = (bin, args, opts, cb) => {
    capturedArgs = args;
    cb(null, '85.962000\n1390.348000\n120.500000\n', '');
  };
  const r = await embedded.extractCueOnsets({ mediaUrl: 'http://s/H/6', trackIndex: 0 },
    { execFileFn, ffprobePath: 'ffprobe' });
  assert.deepStrictEqual(r, [85.962, 120.5, 1390.348]);
  assert.ok(capturedArgs.includes('s:0'), 'selects subtitle-relative stream');
});

test('extractCueOnsets returns [] on empty/garbage output', async () => {
  const execFileFn = (bin, args, opts, cb) => cb(null, 'N/A\n\nnotanumber\n', '');
  const r = await embedded.extractCueOnsets({ mediaUrl: 'http://s/H/6', trackIndex: 0 },
    { execFileFn, ffprobePath: 'ffprobe' });
  assert.deepStrictEqual(r, []);
});

test('extractCueOnsets returns [] when ffprobe errors', async () => {
  const execFileFn = (bin, args, opts, cb) => cb(new Error('spawn failed'), '', 'boom');
  const r = await embedded.extractCueOnsets({ mediaUrl: 'http://s/H/6', trackIndex: 0 },
    { execFileFn, ffprobePath: 'ffprobe' });
  assert.deepStrictEqual(r, []);
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npm test -- --test-name-pattern="extractCueOnsets"`
Expected: FAIL — `embedded.extractCueOnsets is not a function`.

- [ ] **Step 3: Implement**

In `embedded.js`, add before `module.exports`:

```js
function extractCueOnsets({ mediaUrl, trackIndex }, deps = {}) {
  const execFileFn = deps.execFileFn || childProcess.execFile;
  const ffprobePath = deps.ffprobePath || require('ffprobe-static').path;
  const args = ['-v', 'error', '-select_streams', `s:${trackIndex}`,
    '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', mediaUrl];

  return new Promise((resolve) => {
    execFileFn(ffprobePath, args, { maxBuffer: 64 * 1024 * 1024, timeout: 60000 }, (err, stdout) => {
      if (err) return resolve([]);
      const onsets = String(stdout || '')
        .split('\n')
        .map(l => parseFloat(l.trim()))
        .filter(v => Number.isFinite(v))
        .sort((a, b) => a - b);
      resolve(onsets);
    });
  });
}
```

Add `extractCueOnsets` to `module.exports`.

- [ ] **Step 4: Run, verify pass**

Run: `npm test -- --test-name-pattern="extractCueOnsets"` → PASS (3). Then `npm test` → green.

- [ ] **Step 5: Commit**

```bash
git add embedded.js test/embedded.test.js
git commit -m "feat: extractCueOnsets reads embedded cue start-times via ffprobe"
```

---

### Task 7: `server.js` — image-sync detection in `/subtitles`

**Files:**
- Modify: `server.js`, `test/server.test.js`

**Interfaces:**
- Consumes: `embeddedImpl.findStream`, `embeddedImpl.probeEnglish`, `embeddedImpl.extractCueOnsets`, `getSource`, `srtImpl.parse`, `syncImpl.computeLinearSync`, `cfg.minSyncScore`.
- Produces: `createApp` gains `deps.sync` (default `require('./sync')`); a module-scoped `syncCache` (Map by videoHash); a local `resolveImageSync(...)`; `/subtitles` offers the embedded track when text detection OR image-sync succeeds.

- [ ] **Step 1: Write the failing tests**

First, near the top of `test/server.test.js` (after the requires), add a shared quiet config so the new tests — which exercise the real `resolveImageSync` and its file logger — never write to the user's real dataDir:

```js
const quietConfig = { ...require('../config'), logRequests: false, logEmbedded: false };
```

Then add:

```js
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
```

Also update the EXISTING test `GET /subtitles returns ONE original track when not detected` so it doesn't fall into the new image path: add `findStream: async () => null` to its `embedded` fake object (alongside `parseExtra` and `detectEmbeddedEnglish`).

- [ ] **Step 2: Run, verify fail**

Run: `npm test -- --test-name-pattern="subtitles"`
Expected: the two new tests FAIL (single track returned / findStream undefined); the updated "ONE original track" test passes.

- [ ] **Step 3: Wire `deps.sync` + `syncCache`**

In `server.js`, add near the top after the other requires (module scope, before `function createApp`):

```js
const sync = require('./sync');
```

Inside `createApp`, after `const embeddedImpl = deps.embedded || require('./embedded');` add:

```js
  const syncImpl = deps.sync || sync;
  const syncCache = deps.syncCache || new Map(); // videoHash -> { mode:'image-sync', transform, score } | null
```

- [ ] **Step 4: Add the `resolveImageSync` helper**

Inside `createApp`, after `buildTranslatedSrt` (and its soon-to-be sibling from Task 8), add:

```js
  // Resolve the image-subtitle → external-text sync for a file. Cached per videoHash
  // (the ffprobe scan + OpenSubtitles fetch are the expensive part). Returns a
  // descriptor when a confident sync exists, else null. Only caches a real verdict.
  async function resolveImageSync({ type, id, extra, videoSize, videoHash, filename }, log) {
    if (videoHash && syncCache.has(videoHash)) return syncCache.get(videoHash);
    const stream = await embeddedImpl.findStream({ videoSize, filename }, { log });
    if (!stream) return null;
    const { image, text } = await embeddedImpl.probeEnglish(stream.mediaUrl, { log });
    if (text || !image) return null; // text handled elsewhere; nothing to sync
    const onsetsB = await embeddedImpl.extractCueOnsets(
      { mediaUrl: stream.mediaUrl, trackIndex: image.trackIndex }, { log });
    const ext = await getSource(type, id, extra || null);
    const onsetsA = ext ? srtImpl.parse(ext.bytes).map(c => c.start / 1000) : [];
    if (!onsetsA.length || !onsetsB.length) {
      if (log) log(`image-sync: insufficient onsets (A=${onsetsA.length} B=${onsetsB.length})`);
      return null; // transient/edge — do not cache
    }
    const s = syncImpl.computeLinearSync(onsetsA, onsetsB);
    if (log) log(`image-sync: A=${onsetsA.length} B=${onsetsB.length} scale=${s.scale.toFixed(4)} offset=${s.offset.toFixed(2)}s score=${s.score.toFixed(3)} min=${cfg.minSyncScore}`);
    const result = s.score >= cfg.minSyncScore
      ? { mode: 'image-sync', transform: { scale: s.scale, offset: s.offset }, score: s.score }
      : null;
    if (!result && log) log('image-sync: dropped (score below minSyncScore)');
    if (videoHash) syncCache.set(videoHash, result); // cache the verdict (confident or dropped)
    return result;
  }
```

- [ ] **Step 5: Extend the `/subtitles` detection**

In the `/subtitles` handler, replace the detection block:

```js
      try { detected = await embeddedImpl.detectEmbeddedEnglish({ videoSize, filename }, { log }); }
      catch (e) { if (log) log(`detect threw: ${e && e.message}`); detected = null; }
    }
```

with:

```js
      try { detected = await embeddedImpl.detectEmbeddedEnglish({ videoSize, filename }, { log }); }
      catch (e) { if (log) log(`detect threw: ${e && e.message}`); detected = null; }
      if (!detected) {
        const { videoHash } = embeddedImpl.parseExtra(extra);
        try { detected = await resolveImageSync({ type, id, extra, videoSize, videoHash, filename }, log); }
        catch (e) { if (log) log(`image-sync detect threw: ${e && e.message}`); }
      }
    }
```

(The two-track vs single-track `if (detected)` block below is unchanged — a truthy `detected` from either path offers both tracks.)

- [ ] **Step 6: Run, verify pass**

Run: `npm test -- --test-name-pattern="subtitles"` → all PASS (new + updated + untouched).

- [ ] **Step 7: Commit**

```bash
git add server.js test/server.test.js
git commit -m "feat: /subtitles offers embedded track via image→external-text sync"
```

---

### Task 8: `server.js` — `/translate-embedded` image-sync branch

**Files:**
- Modify: `server.js`, `test/server.test.js`

**Interfaces:**
- Consumes: `resolveImageSync`, `syncImpl.applySync`, `srtImpl.parse`, `getSource`, a new `translateCuesToSrt` helper.
- Produces: `/translate-embedded` serves the re-timed translated track for image-sync files; text path and external fallback unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `test/server.test.js`:

```js
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
```

- [ ] **Step 2: Run, verify fail**

Run: `npm test -- --test-name-pattern="translate-embedded image-sync"`
Expected: FAIL — no `שלום` / no shifted timestamp (image branch not implemented).

- [ ] **Step 3: Add the `translateCuesToSrt` helper (refactor)**

In `server.js`, replace `buildTranslatedSrt` with a cue-taking helper plus a thin wrapper (behavior identical):

```js
  async function translateCuesToSrt(cues, stats) {
    const translated = await translateCues(cues, { targetLang: cfg.targetLangGoogle, stats });
    const formatted = display.formatCues(translated);
    const finalCues = cfg.targetIsRtl ? rtl.markCuesRtl(formatted) : formatted;
    return srtImpl.serialize(finalCues);
  }

  async function buildTranslatedSrt(source, stats) {
    return translateCuesToSrt(srtImpl.parse(source.bytes), stats);
  }
```

- [ ] **Step 4: Add the image-sync branch to `/translate-embedded`**

In the `/translate-embedded` handler, after the text-extract success block (`if (source && source.bytes && source.bytes.length) { ... }`) and before the external fallback, insert:

```js
      // No embedded text track → try image→external-text sync (cached from detection).
      const log = cfg.logEmbedded
        ? (m) => embLog(cfg, `[${filename || `${type}/${id}`}] ${m}`)
        : undefined;
      const imageResult = await resolveImageSync({ type, id, extra, videoSize, videoHash, filename }, log);
      if (imageResult && imageResult.mode === 'image-sync') {
        const ext = await getSource(type, id, extra || null);
        if (!ext) return res.send('');
        const synced = syncImpl.applySync(srtImpl.parse(ext.bytes), imageResult.transform);
        const stats = {};
        const out = await translateCuesToSrt(synced, stats);
        if (!stats.failedChunks) cacheImpl.put(key, out);
        return res.send(out);
      }
```

(`filename` is already destructured from `parseExtra` at the top of the handler alongside `videoSize`/`videoHash`.)

- [ ] **Step 5: Run, verify pass**

Run: `npm test -- --test-name-pattern="translate-embedded"` → all PASS (new + existing). Then `npm test` → full suite green.

- [ ] **Step 6: Commit**

```bash
git add server.js test/server.test.js
git commit -m "feat: /translate-embedded serves re-timed translated track for image subs"
```

---

### Task 9: Live verification + README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Live end-to-end test against the real PGS file**

Ensure Stremio is playing the Wakfu (PGS) file so its torrent is active. Then `npm start` (or restart the running server) and, in Stremio, open the subtitle menu for that episode.

Expected: **Hebrew (from embedded)** now appears alongside **Hebrew (from external)**; selecting it shows Hebrew text timed to the video. Inspect `%APPDATA%\subsTranslator\embedded.log` for a line like `image-sync: A=… B=540 scale=… offset=…s score=… -> OFFER`. Note the observed `score` — if the track is offered but visibly mis-synced, or dropped despite looking alignable, that is the signal to tune `config.minSyncScore` (Step 2).

- [ ] **Step 2: Sanity-check the threshold**

If the live `score` for a correctly-aligning file sits far from `0.4`, adjust `config.minSyncScore` (in `config.js`) to a value that offers good syncs and drops bad ones, and note the chosen value in the commit message. If `0.4` works, leave it.

- [ ] **Step 3: Update the README**

In `README.md`, under `## How it works`, after the existing "Hebrew (from embedded)" bullet, add:

```markdown
- **Image (PGS/VobSub) embedded English:** when the embedded English track is an image
  subtitle (can't be read as text), the addon instead re-times the **OpenSubtitles**
  English text to the embedded track's cue timings (a global offset + framerate fit,
  computed with `ffprobe` packet timestamps — no OCR) and translates that. If the two
  don't align confidently, the embedded track is withheld (external Hebrew still shows).
  Tunable via `SUBSTRANSLATOR_MIN_SYNC_SCORE`.
```

- [ ] **Step 4: Commit**

```bash
git add README.md config.js
git commit -m "docs: document image-subtitle timing sync; tune minSyncScore if needed"
```

---

## Self-Review Notes

- **Spec coverage:** sync algorithm (Tasks 2–4), image/text probe (Task 5), onset extraction (Task 6), detection + confidence gate + per-videoHash cache (Task 7), re-timed translate serving (Task 8), ffprobe-static + config (Task 1), live tuning + docs (Task 9) — all mapped.
- **Units:** `computeLinearSync`/`offset` in seconds; `applySync` converts to ms (`offset*1000`); onsetsA from `cue.start/1000`. Consistent across Tasks 3/4/7/8.
- **Type consistency:** `probeEnglish` → `{text, image}` (Task 5) consumed by `resolveImageSync` (Task 7); `computeLinearSync` → `{scale, offset, score}` (Task 3) flows into `resolveImageSync`'s `transform` and `applySync` (Task 4/8). `resolveImageSync` returns `{mode:'image-sync', transform, score}` shared by Tasks 7 and 8.
- **Backward compatibility:** the text path (`detectEmbeddedEnglish`/`getEmbeddedSubtitle`) is untouched; only one existing `/subtitles` test gains a `findStream: async () => null` fake to avoid the new image branch.
- **Carried risk (Task 9):** `MIN_SYNC_SCORE = 0.4` and the first-detection latency are validated only against a live PGS file; Task 9 is the gate.
