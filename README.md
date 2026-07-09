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

This adds a hidden launcher to your per-user **Startup folder** (no administrator rights
needed) that starts the server whenever you log in, so it's always ready when you open
Stremio. It also starts the server immediately. Remove it with:

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

## Development

```powershell
npm test   # runs the full node:test suite
```
