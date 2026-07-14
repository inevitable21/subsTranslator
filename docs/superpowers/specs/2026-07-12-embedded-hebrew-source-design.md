# Embedded-English → Hebrew source track

**Date:** 2026-07-12
**Branch context:** builds on `fix/rtl-subtitle-direction`
**Status:** approved design, ready for implementation plan

## Goal

When a video being played has an **embedded English subtitle track**, offer a Hebrew
track translated *from that embedded English*, because it is timed to the exact file the
viewer is watching and therefore syncs better than an external OpenSubtitles source.

The viewer chooses between the two Hebrew tracks in Stremio's subtitle menu:

- **Hebrew (from embedded)** — appears only when an English text-subtitle track is
  detected inside the file being played.
- **Hebrew (from external)** — the existing behavior; always available.

## Constraint that shapes everything

A Stremio subtitle addon never receives the video file. Stremio forwards only:

```
type, id, filename, videoSize, videoHash
```

Embedded tracks live inside the container (mkv) and are parsed by Stremio's *player*,
never handed to an addon. Therefore "prefer embedded" cannot be a change to source
selection — the addon has nothing embedded to select. Instead the addon must reach the
**Stremio streaming server** (`http://127.0.0.1:11470`) to locate the file being served
and read its embedded tracks.

This works only for **torrent-backed playback** (the file passes through the streaming
server). For debrid / direct-HTTP streams the file is proxied and does not appear in the
server's registry — in that case embedded detection returns nothing and only the external
Hebrew track is offered. This is an accepted limitation, handled by graceful degradation.

## Streaming-server API (verified)

- `GET /stats.json` → object keyed by torrent `infoHash`; each has
  `files: [{ name, length, ... }]`. Match the played file by exact
  `files[fileIdx].length === videoSize` (filename basename as tiebreaker).
- Media URL for a matched file: `http://127.0.0.1:11470/{infoHash}/{fileIdx}`.
- `GET /probe/{encodeURIComponent(mediaUrl)}` → ffprobe wrapper returning
  `{ streams: { subtitles: [{ index, codec, tags: { language, title } }] } }`.
  Stremio ships ffprobe, so **probing needs no bundled binary**; it fetches only the
  container header (~hundreds of KB), not the whole file.

There is **no** endpoint that maps an IMDb id / videoHash / filename directly to a stream
handle, which is why size-matching against `/stats.json` is the lookup mechanism.

## Architecture

### New module: `embedded.js`

All dependencies injected, matching the existing `sources.js` / `createApp` DI style, so
everything is unit-testable without a running Stremio or a real ffmpeg.

```js
findStream({ videoSize, filename }, { fetchFn, base })
  // → { infoHash, fileIdx, mediaUrl } | null
  // GET {base}/stats.json; find file where length === videoSize
  // (basename match breaks ties); null on no match or fetch error.

probeEnglishSub(mediaUrl, { fetchFn, base })
  // → { trackIndex, codec } | null
  // GET {base}/probe/{encodeURIComponent(mediaUrl)}; keep subtitle streams whose
  // codec ∈ {subrip, ass, ssa, mov_text} AND
  // (tags.language ∈ {eng, en} OR /english/i.test(tags.title));
  // return the first match. IMPORTANT: trackIndex is the SUBTITLE-RELATIVE position
  // (0 = first subtitle stream, 1 = second, ...), NOT ffprobe's absolute stream
  // `index`, because ffmpeg's `-map 0:s:<n>` selector counts within subtitle streams
  // only. Compute it by enumerating the subtitle streams in order. Image codecs
  // (hdmv_pgs_subtitle, dvd_subtitle) are excluded — they need OCR to become SRT.

extractSrt({ mediaUrl, trackIndex }, { spawnFn, ffmpegPath })
  // → Buffer (SRT bytes)
  // spawn ffmpeg (trackIndex is subtitle-relative, per probeEnglishSub):
  //   ffmpeg -nostdin -i <mediaUrl> -map 0:s:<trackIndex> -c:s srt -f srt pipe:1
  // resolve with stdout buffer on exit 0 and non-empty output;
  // reject on non-zero exit or empty stdout. No temp files.
```

`base` defaults to `http://127.0.0.1:11470` (add `streamingServerBase` to `config.js`).
`ffmpegPath` defaults to `require('ffmpeg-static')`. `spawnFn` defaults to
`child_process.spawn`.

### ffmpeg

Probing uses Stremio's bundled ffprobe (no binary needed). **Extraction** has no
streaming-server endpoint, so we bundle ffmpeg via the **`ffmpeg-static`** npm package
(prebuilt per-platform binary, ~80 MB in `node_modules`, resolved with
`require('ffmpeg-static')`). This keeps installation a single `npm install`, matching the
project's "no accounts, no cost" promise. Trade-off: `node_modules` grows ~80 MB —
acceptable for a local personal addon; noted in README requirements.

### `server.js` changes

`createApp` gains a `deps.embedded` override (defaults to `require('./embedded')`), exactly
like the existing `deps.getSource`.

**`GET /subtitles/:type/:id/:extra.json`** — detection happens here, in the request path,
with a total budget of ~2s:

```
1. Parse extras → { filename, videoSize, videoHash }.
2. If no videoSize → return external-only (Stremio has not resolved a stream yet;
   this is the common case during episode browsing, so detection stays free).
3. embedded.findStream({ videoSize, filename })      (stats.json fetch, ~500ms timeout)
4. If null → external-only.
5. embedded.probeEnglishSub(mediaUrl)                 (~1500ms timeout)
6. If null → external-only.
7. Return TWO entries (see Track shape).
```

Detection results are **not** cached at this layer; the mapping is cheap and stateless
recomputation is simpler than another cache.

**New route `GET /translate-embedded/:type/:id/:extra.srt`** — mirrors `/translate` but
sources from the embedded track:

```
key = `${cacheVersion}:emb:${videoHash}:${type}:${id}`
if cache hit → serve.
findStream → probeEnglishSub → extractSrt  → SRT bytes
  parse → translateCues → display.formatCues → rtl.markCuesRtl → serialize
on success (and no failedChunks) → cache under key, serve.
on extraction failure / empty → FALL BACK to external:
  run the normal getSource path, serve best-effort,
  but DO NOT write the embedded cache key (so replay retries embedded).
```

### Track shape (Stremio subtitle menu)

When embedded English is detected, `/subtitles` returns:

```json
{ "subtitles": [
  { "id": "substranslator-heb-embedded",
    "url": ".../translate-embedded/series/tt1807824:1:3/<extra>.srt",
    "lang": "Hebrew (from embedded)" },
  { "id": "substranslator-heb-external",
    "url": ".../translate/series/tt1807824:1:3/<extra>.srt",
    "lang": "Hebrew (from external)" }
] }
```

Both URLs carry the same `<extra>` segment that today's external URL already includes
(`server.js` builds `/translate/${type}/${id}${extraPart}.srt`); the embedded route
additionally *needs* it, since extraction reads `videoSize`/`videoHash` from there.

When not detected, a single entry is returned — **identical to today's output**
(`id: substranslator-heb`, `lang: heb`, `/translate/.../<extra>.srt` URL) so existing
behavior and cache are untouched.

The embedded `/translate-embedded` URL must carry the `extra` segment (filename +
videoSize + videoHash) because extraction needs `videoSize` to re-locate the stream and
`videoHash` for the cache key.

## Caching

- **External key (unchanged):** `${cacheVersion}:${type}:${id}` — existing cache stays valid.
- **Embedded key:** `${cacheVersion}:emb:${videoHash}:${type}:${id}` — videoHash included so
  each distinct file cut gets its own timing. Costs extra misses when switching files;
  accepted for correctness.
- **Anti-poisoning (unchanged spirit):** cache only when `stats.failedChunks` is falsy.
  Embedded additionally caches only on non-empty extraction. On fallback-to-external, the
  external result is served but **not** written to the embedded key.

## Error handling / graceful degradation

Every failure path degrades to a working track and logs; nothing throws to the client.

| Situation | Behavior |
|---|---|
| No `videoSize` in request | External-only track (browsing) |
| Stream not in `/stats.json` (debrid / HTTP / server down) | External-only track |
| Probe finds no English text track (or only image tracks) | External-only track |
| `ffmpeg-static` missing / spawn fails / non-zero exit / empty stdout | `/translate-embedded` falls back to external translation |
| Playback stopped between detection and extraction | Extraction fails → fallback to external |

## Testing

Follows the existing `node:test` + injected-`fetchFn` conventions.

**`test/embedded.test.js`:**
- `findStream` matches by exact `length === videoSize`.
- `findStream` uses filename basename as tiebreaker when two files share a size.
- `findStream` → null when no size match (debrid case).
- `findStream` → null on stats.json fetch error / non-200.
- `probeEnglishSub` selects `eng` `subrip` track and returns its index.
- `probeEnglishSub` selects a track whose `tags.title` matches /english/i.
- `probeEnglishSub` → null when only image tracks (`hdmv_pgs_subtitle`) exist.
- `probeEnglishSub` → null when only non-English text tracks exist.
- `extractSrt` with a fake `spawnFn` (emits SRT on stdout, exit 0) resolves with buffer.
- `extractSrt` rejects/empties on non-zero exit or empty stdout.

**`test/server.test.js` additions** (inject a fake `deps.embedded`):
- `/subtitles` returns two entries when probe finds English (assert both ids + labels).
- `/subtitles` returns one entry (unchanged) when detection returns null.
- `/subtitles` skips detection when `videoSize` extra is absent.
- `/translate-embedded` extracts → translates → serves Hebrew, caches under `emb:`+hash key.
- `/translate-embedded` falls back to `getSource` on empty extraction and does NOT write
  the embedded cache key.
- `/translate-embedded` respects the `failedChunks` no-cache guard.

## Files touched

- **New:** `embedded.js`, `test/embedded.test.js`
- **Edit:** `server.js` (embedded detection in `/subtitles`, new `/translate-embedded`
  route, `deps.embedded`), `config.js` (`streamingServerBase`), `package.json`
  (`ffmpeg-static` dependency), `test/server.test.js`, `README.md` (document the two
  tracks + torrent-only caveat).

## Explicit non-goals (YAGNI)

- No support for debrid / direct-HTTP embedded extraction (not reachable via the server).
- No OCR of image-based (PGS/VobSub) subtitle tracks.
- No caching of the detection (`videoSize → stream`) mapping.
- No config toggle; both tracks are always offered when embedded English is present.
