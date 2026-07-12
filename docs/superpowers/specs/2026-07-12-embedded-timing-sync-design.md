# External-text + embedded-timing sync (image/PGS embedded tracks)

**Date:** 2026-07-12
**Branch context:** builds on the embedded-Hebrew feature (`fix/rtl-subtitle-direction`)
**Status:** approved design (brainstormed + feasibility-verified), ready for implementation plan

## Goal

When a torrent-backed file's embedded English subtitle is **image-based** (PGS/VobSub) —
untranslatable without OCR — still offer a well-synced Hebrew track by taking
**OpenSubtitles' English text** and re-timing it to the embedded track's **cue timings**
(global offset + framerate ratio), then translating to Hebrew. The embedded track is timed
to the exact file, so its onset pattern is the sync reference; OpenSubtitles provides the
translatable words.

## Decisions (from brainstorming)

- **Sync method:** global **linear** transform — offset + framerate ratio — found by
  FFT cross-correlation of the two tracks' subtitle-onset signals. No per-cue remap.
- **Trigger:** only when the embedded English track is **image** (PGS/VobSub). If the
  embedded English track is **text** (SRT/ASS/mov_text), keep the existing extract-and-
  translate-embedded-text path (its own text+timing are already ideal).
- **Low confidence:** if the best correlation score is below threshold, **do not offer**
  the embedded track for that file; log the reason to `embedded.log`.

## Feasibility (verified by spike, 2026-07-12)

Against the live Wakfu S01E07 torrent stream (456 MB, English PGS track):
- `ffprobe -select_streams s:0 -show_entries packet=pts_time` read **all 540 cue onset
  times in ~3.9 s** (full scan, no full-file download — ffprobe seeks cluster-to-cluster).
- `duration_time` is `N/A` for PGS packets → we align on **onset (start) times only**,
  which is the standard signal for correlation-based sync.
- Stremio `/probe` `duration` is in **milliseconds** (e.g. `1392980` = 1392.98 s).
- Requires **`ffprobe-static`** — `ffmpeg-static` ships only `ffmpeg`.

Conclusion: the full onset scan (~4 s) is fast enough to run at detection time **if the
result is cached per `videoHash`** so it happens once per file.

## Architecture

### New module `sync.js` (pure, no I/O — fully unit-testable)

```js
// FRAMERATE_RATIOS: [1, 24/23.976, 23.976/24, 25/24, 24/25, 25/23.976, 23.976/25]
computeLinearSync(onsetsA, onsetsB, opts = {}) → { scale, offset, score }
  // onsetsA: OpenSubtitles cue start times (seconds, sorted)
  // onsetsB: embedded cue start times (seconds, sorted)
  // 1. Rasterize each to a binary onset signal at BIN_SECONDS (0.1s) over a common span.
  // 2. For each ratio r in FRAMERATE_RATIOS: scale A's onset times by r, rasterize,
  //    FFT-cross-correlate with B, take the lag of peak correlation (bounded to
  //    |offset| ≤ MAX_OFFSET_SECONDS, default 120) and the normalized peak value.
  // 3. Return { scale: r*, offset: lag*, score } for the ratio with the highest
  //    normalized peak score (0..1).

applySync(cues, { scale, offset }) → cues'
  // Map each cue: start' = start*scale + offset, end' = end*scale + offset.
  // Clamp to ≥ 0; drop cues whose end' ≤ 0. Timing only — never touches text.

// Internal: a self-contained radix-2 iterative FFT (pure JS, no dependency).
// Cross-correlation: corr = IFFT(FFT(a) · conj(FFT(b))), zero-padded to a power of two.
```

Constants: `BIN_SECONDS = 0.1`, `MAX_OFFSET_SECONDS = 120`, `MIN_SYNC_SCORE` (config,
initial `0.4` — noted for tuning against real data). Score normalization:
`peak / sqrt(energyA * energyB)` so it is scale-independent in `[0, 1]`.

### `embedded.js` additions

- **`probeEnglish(mediaUrl, deps)` → `{ text: {trackIndex, codec}|null, image: {trackIndex, codec}|null }`**
  Reuses the flat-`streams[]` parsing and subtitle-relative indexing from `probeEnglishSub`.
  Returns the first English **text** track (codec ∈ existing `TEXT_SUB_CODECS`) and the first
  English **image** track (codec ∈ `IMAGE_SUB_CODECS = {hdmv_pgs_subtitle, pgssub, dvd_subtitle, dvdsub, vobsub}`).
  English match = same rule as today (`lang` eng/en OR title /english/i). `probeEnglishSub`
  is kept (delegates to `probeEnglish().text`) for the existing text path and its tests.

- **`extractCueOnsets({ mediaUrl, trackIndex }, deps)` → `number[]`** (seconds, sorted)
  Runs `ffprobe -v error -select_streams s:<trackIndex> -show_entries packet=pts_time -of csv=p=0 <mediaUrl>`.
  Parses the `pts_time` floats, filters non-finite, sorts ascending. `deps.execFileFn`
  (default `child_process.execFile`) and `deps.ffprobePath` (default
  `require('ffprobe-static').path`) are injectable so tests run without a real binary.

### `server.js` changes

A **per-`videoHash` sync cache** (module-level `Map`, ephemeral) stores the detection
outcome so the heavy work runs once:
`{ mode: 'text' | 'image-sync' | 'none', imageTrackIndex?, transform?: {scale, offset}, score? }`.

**`/subtitles` detection** (extends `detectEmbeddedEnglish`, image path added):
```
probeEnglish(mediaUrl)
  text track  → mode 'text'      → offer embedded (existing extract path)
  else image track:
      cache hit for videoHash → use it
      else compute:
        onsetsB = extractCueOnsets(imageTrack)            (~4s, once per file)
        externalSource = getSource(...)  → onsetsA (external English cue starts)
        { scale, offset, score } = computeLinearSync(onsetsA, onsetsB)
        cache { mode: score≥MIN ? 'image-sync' : 'none', imageTrackIndex, transform, score }
      score ≥ MIN_SYNC_SCORE → offer embedded ; else → do NOT offer (log reason)
  else → no embedded track
```
Detection for an image file may take several seconds on first encounter (then cached).
This is gated behind "image English track exists", so text/no-embedded files stay fast.
The existing `!videoSize` early-out is unchanged (browsing stays free). **Risk:** if the
first detection exceeds Stremio's request tolerance, that first menu-open may miss the
embedded entry — but the per-`videoHash` cache makes Stremio's subsequent /subtitles
requests instant, so it appears on the next menu open. Verify against a real PGS file
(live gate).

**`/translate-embedded`** gains an image-sync branch:
```
mode from probe/cache:
  text     → existing: extract embedded text → translate (unchanged)
  image-sync:
      transform = cache[videoHash].transform  (recompute via the detection routine if missing)
      externalSource = getSource(...) ; cues = srt.parse(externalSource.bytes)
      synced = sync.applySync(cues, transform)
      translate(synced) → serialize → serve ; cache under emb key (existing guard)
  none / miss → existing external fallback (best-effort, not cached under emb key)
```
The final translated SRT is cached under the existing embedded key
`${cacheVersion}:emb:${videoHash}:${type}:${id}` (unchanged).

### Diagnostics

The `embedded.log` diagnostic (via injected `deps.log`) is extended to report the
image-sync path: track found, onset counts (A/B), chosen `{scale, offset, score}`, and
whether the track was offered or dropped for low confidence.

### Config / dependencies

- `config.minSyncScore` (default `0.4`, env `SUBSTRANSLATOR_MIN_SYNC_SCORE`).
- Add **`ffprobe-static`** to `package.json` dependencies.

## Testing

**`test/sync.test.js`** (pure, deterministic):
- `computeLinearSync` recovers a known constant offset (B = A + 5s → offset≈5, scale≈1, high score).
- recovers a known framerate scale (B = A × 0.959 → scale≈0.959, score high).
- returns a low score for uncorrelated random onsets (below `MIN_SYNC_SCORE`).
- `applySync` maps `t*scale+offset`, clamps negatives, drops fully-negative cues, never edits text.
- (internal) FFT round-trips a known signal.

**`test/embedded.test.js`** additions:
- `probeEnglish` returns both text and image English tracks from a flat `streams[]` probe;
  returns `image` for a PGS-only file (the Wakfu case) and `text: null`.
- `extractCueOnsets` parses `ffprobe` CSV (`execFileFn` injected returns canned `pts_time` lines) → sorted seconds.
- `extractCueOnsets` handles empty/garbage output → `[]`.

**`test/server.test.js`** additions (inject fake `embedded` + `sync`):
- `/subtitles` offers the embedded track for an image English track when sync score ≥ MIN.
- `/subtitles` does NOT offer it when score < MIN (single track).
- `/translate-embedded` image path: applies the transform, translates, serves Hebrew, caches emb key.
- text path and external fallback remain unchanged (existing tests pass).

## Files touched

- **New:** `sync.js`, `test/sync.test.js`
- **Edit:** `embedded.js` (`probeEnglish`, `extractCueOnsets`, `IMAGE_SUB_CODECS`),
  `test/embedded.test.js`, `server.js` (image-sync detection + `/translate-embedded`
  branch + per-videoHash sync cache + diagnostics), `test/server.test.js`,
  `config.js` (`minSyncScore`), `package.json` (`ffprobe-static`), `README.md`.

## Explicit non-goals (YAGNI)

- No OCR of image subtitles (we use their timing only).
- No non-linear / DTW alignment — linear offset+scale only.
- No audio-based (VAD) sync.
- No windowed onset sampling — the full ~4 s scan is fast enough; revisit only if a real
  file proves too slow.
- `MIN_SYNC_SCORE = 0.4` is an initial value to be tuned against real files, not a proven constant.
