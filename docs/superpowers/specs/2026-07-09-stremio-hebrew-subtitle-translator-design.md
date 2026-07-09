# Design: subsTranslator — Stremio Hebrew Subtitle Translator Addon

**Date:** 2026-07-09
**Status:** Approved (design phase)

## Purpose

A personal Stremio addon that automatically provides a **Hebrew (auto-translated)**
subtitle track for any movie or episode. It fetches an existing source subtitle
(any available language, preferring English), translates it to Hebrew using the
free Google Translate endpoint, and serves it back to Stremio.

The addon runs as a **local Node.js server** that **auto-starts on Windows login**,
so it is always available whenever Stremio is open — the user installs it into
Stremio once and never has to run anything manually again.

## Goals

- One-time install into Stremio; zero manual steps per playback.
- Fully free: no API keys, no paid services, no download quotas.
- Target language: **Hebrew** (`heb` / ISO-639). RTL.
- Source language: **auto / any available** (prefer English when present).
- Hebrew-only output (not bilingual).
- Fast on repeat views via on-disk caching.

## Non-Goals (YAGNI)

- No web configuration UI. Settings live in a small `config.js`.
- No multi-user / hosted deployment. Local-only.
- No bilingual/dual-subtitle output.
- No support for translation engines other than Google free endpoint.
- No account-based subtitle providers requiring keys.

## Architecture

### Runtime shape

A single Node.js process running an **Express** server bound to `127.0.0.1:7000`
(configurable). It implements the Stremio addon HTTP protocol plus one extra route
that serves translated subtitle files.

```
Stremio  ──GET /manifest.json──────────────▶  server (addon manifest)
Stremio  ──GET /subtitles/{type}/{id}/…json─▶  server → returns 1 subtitle entry:
                                                 { lang: "heb",
                                                   url: http://127.0.0.1:7000/translate/{type}/{id}.srt }
Stremio  ──GET /translate/{type}/{id}.srt───▶  server → (cache hit? return)
                                                 else: fetch source SRT →
                                                       translate → cache → return
```

### Lazy translation

The `/subtitles` handler responds **immediately** with a URL pointing at the
addon's own `/translate` route — it does not translate up front. Translation only
happens when the user actually selects the Hebrew track and Stremio downloads that
URL. This keeps subtitle-menu population instant and avoids translating tracks the
user never watches.

### Source subtitle acquisition

Source subtitles come from the **public OpenSubtitles v3 Stremio addon**
(`https://opensubtitles-v3.strem.io`), which needs no API key and no quota:

```
GET https://opensubtitles-v3.strem.io/subtitles/{type}/{id}/{extra}.json
  → { subtitles: [ { id, url, lang }, … ] }
```

Selection rule: prefer a track whose `lang` is English (`eng`/`en`); otherwise take
the first available track. Download that track's `url` to get the raw source subtitle
bytes.

If no source subtitle is available, the `/translate` route returns an empty/valid
SRT and logs it; the `/subtitles` route may omit the Hebrew entry when a cheap
pre-check shows nothing is available (best-effort — the definitive check happens at
translate time).

### Translation

Uses the **unofficial free Google Translate endpoint** (`translate_a/single`) via a
thin wrapper. Strategy:

- Parse the source into subtitle cues (index, start/end timestamps, text).
- Batch cue texts into chunks (~100 cues joined by newline) to minimize requests.
- Translate chunks with **limited concurrency** (e.g. 5 at a time) and retry with
  backoff on transient errors / rate limits.
- **Line-count guard:** if a translated chunk does not split back into the same
  number of lines as it went in, fall back to translating that chunk's cues
  individually so cue↔text alignment is never corrupted.
- On a batch that still fails after retries, keep the **original text** for those
  cues rather than dropping them.
- Reassemble cues (translated text, original timestamps) into SRT and cache.

### Caching

Translated files are cached on disk under a per-user data dir
(`%APPDATA%\subsTranslator\cache` or `./cache`), keyed by `{type}:{id}` (+ a small
version/config hash). Cache hits are served directly, making re-watches and scrubbing
instant and avoiding repeated calls to Google / OpenSubtitles.

### Character encoding

OpenSubtitles files are frequently not UTF-8. The `srt` module detects charset
(`chardet`) and decodes to UTF-8 (`iconv-lite`) before parsing. Output is always
UTF-8 SRT.

### Windows auto-start

A PowerShell script registers a **Scheduled Task** that runs at user logon and
launches the server hidden (no console window). An uninstall script removes it.
(Startup-folder shortcut is an acceptable fallback if Scheduled Task registration is
blocked.)

## Components

Each module has one responsibility and a small, well-defined interface.

| File | Responsibility | Key interface |
|---|---|---|
| `server.js` | Express app, CORS headers Stremio requires, route wiring, `listen()` | `startServer(config)` |
| `manifest.js` | Stremio manifest object declaring a subtitles addon | `buildManifest()` |
| `sources.js` | Query OpenSubtitles v3 addon, choose + download best source | `getSourceSubtitle(type, id, extra) → { bytes, lang } \| null` |
| `srt.js` | Charset decode, parse SRT→cues, serialize cues→SRT | `parse(bytes) → cues`, `serialize(cues) → string` |
| `translate.js` | Google free-endpoint translation with batching/concurrency/retry | `translateCues(cues, targetLang) → cues` |
| `cache.js` | Disk cache get/put of translated SRT strings | `get(key)`, `put(key, srt)` |
| `config.js` | Port, host, target lang (`heb`), source-language preference, cache dir | exported config object |
| `scripts/install-startup.ps1` | Register Windows logon Scheduled Task (hidden) | — |
| `scripts/uninstall-startup.ps1` | Remove the Scheduled Task | — |
| `README.md` | Install/run instructions, how to add to Stremio | — |

## Data flow (translate route)

1. `GET /translate/{type}/{id}.srt`.
2. `cache.get(key)` → hit? stream it, done.
3. `sources.getSourceSubtitle()` → source bytes + lang (or null → empty SRT).
4. `srt.parse(bytes)` → cues (decoded to UTF-8).
5. `translate.translateCues(cues, "he")` → translated cues.
6. `srt.serialize(cues)` → SRT string.
7. `cache.put(key, srt)`; stream it with `Content-Type: application/x-subrip; charset=utf-8`.

## Error handling

| Situation | Behavior |
|---|---|
| No source subtitle found | Return a valid empty SRT; omit Hebrew entry from `/subtitles` when pre-check is negative. |
| Translation chunk fails after retries | Keep original text for those cues. |
| Chunk line-count mismatch | Fall back to per-cue translation for that chunk. |
| Non-UTF8 source | Detect + decode before parsing. |
| Rate limit / network error | Exponential backoff retry; cache prevents re-hits. |
| OpenSubtitles addon unreachable | Log, return empty SRT, do not crash the server. |

## Testing strategy

- **Unit — `srt.js`:** parse/serialize round-trip; decode a Windows-1255/1256 sample;
  malformed cue tolerance.
- **Unit — `translate.js`:** batching splits/rejoins correctly (mocked network);
  line-count-mismatch triggers per-cue fallback; failed batch keeps original text.
- **Unit — `sources.js`:** source-selection prefers English, falls back to first
  available, handles empty list (mocked HTTP).
- **Integration — smoke:** against a known IMDb id, `/subtitles` returns a Hebrew
  entry and `/translate` returns a non-empty UTF-8 SRT (network-dependent; can be
  gated/skippable).

## Tech stack

- Node.js (v24 present) + Express.
- `chardet`, `iconv-lite` for encoding.
- A small unofficial Google Translate wrapper (thin custom fetch, or a maintained
  package like `google-translate-api-x`) — decided at plan time.
- Test runner: Node's built-in `node:test` + `assert`.

## Deployment / usage

1. `npm install`.
2. `npm start` (or auto-start task) → server on `http://127.0.0.1:7000`.
3. In Stremio: Addons → paste `http://127.0.0.1:7000/manifest.json` → Install.
4. Run `scripts/install-startup.ps1` once so the server auto-starts on login.
5. Play anything → pick **Hebrew (auto-translated)** in the subtitle menu.
