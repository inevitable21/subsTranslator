# subsTranslator — Hebrew subtitles for Stremio

A local Stremio addon that adds a **Hebrew (auto-translated)** subtitle track to any
movie or episode. It fetches an existing subtitle from the free OpenSubtitles v3 addon,
translates it to Hebrew with Google Translate, caches the result, and serves it back to
Stremio. No API keys, no accounts, no cost.

## Requirements

- Windows with Node.js ≥ 24 installed (`node --version`).
- The **Stremio desktop app** (recommended — the local `http://127.0.0.1` addon works
  cleanly there without browser mixed-content restrictions).
- `npm install` downloads a bundled `ffmpeg` binary (`ffmpeg-static`, ~80 MB) used to
  extract embedded subtitle tracks. No manual ffmpeg install is needed.

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

This adds a hidden launcher to your per-user **Startup folder** (no administrator rights
needed) that starts the server whenever you log in, so it's always ready when you open
Stremio. It also starts the server immediately. Remove it with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall-startup.ps1
```

## How it works

- **Hebrew (from embedded):** when you play a **torrent-backed** file that contains an
  embedded English subtitle track, a second Hebrew track appears, translated from that
  embedded English. Because it is timed to the exact file you are watching, it usually
  syncs better than the external source. It is extracted with a bundled `ffmpeg` binary
  (`ffmpeg-static`) via Stremio's local streaming server. Direct-HTTP / debrid streams
  don't pass through that server, so only the external Hebrew track is offered for them.
- `GET /manifest.json` — declares a subtitles addon.
- `GET /subtitles/{type}/{id}/{extra}.json` — returns one Hebrew track whose URL points
  back at this server's `/translate` route (instant; no translation yet).
- `GET /translate/{type}/{id}.srt` — on first request, fetches a source subtitle, translates
  it to Hebrew, caches it under `%APPDATA%\subsTranslator\cache`, and streams SRT. Later
  requests are served from cache.

## Troubleshooting: the "Hebrew (from embedded)" track doesn't appear

The embedded track only shows when **all** of these hold: Stremio's streaming server is
running, the file is **torrent-backed** (debrid/direct-HTTP streams aren't visible to the
addon), and the file has an embedded English **text** subtitle (SRT/ASS/`mov_text`).
Image subtitles (PGS/VobSub, common in BDRIPs) are skipped — they'd need OCR.

Every detection attempt is logged to `%APPDATA%\subsTranslator\embedded.log`, which states
exactly why a track was or wasn't offered (server unreachable, no size match, the subtitle
codecs it found, or the English text track it selected). Disable with
`SUBSTRANSLATOR_LOG_EMBEDDED=0`.

## Config

Edit `config.js` (or set env vars): `SUBSTRANSLATOR_PORT`, `SUBSTRANSLATOR_HOST`,
`SUBSTRANSLATOR_DATA`, `SUBSTRANSLATOR_LOG_EMBEDDED`.

## Development

```powershell
npm test   # runs the full node:test suite
```
