'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('./config');
const { buildManifest } = require('./manifest');
const srt = require('./srt');
const sources = require('./sources');
const translate = require('./translate');
const cache = require('./cache');
const rtl = require('./rtl');
const display = require('./display');
const sync = require('./sync');

function logRequest(cfg, kind, captured) {
  if (!cfg.logRequests) return;
  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.appendFileSync(path.join(cfg.dataDir, 'requests.log'),
      `${new Date().toISOString()} ${kind} ${captured}\n`);
  } catch { /* logging must never break a request */ }
}

function embLog(cfg, msg) {
  if (!cfg.logEmbedded) return;
  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.appendFileSync(path.join(cfg.dataDir, 'embedded.log'),
      `${new Date().toISOString()} ${msg}\n`);
  } catch { /* logging must never break a request */ }
}

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
  const embeddedImpl = deps.embedded || require('./embedded');
  const syncImpl = deps.sync || sync;
  const syncCache = deps.syncCache || new Map(); // videoHash -> { mode:'image-sync', transform, score } | null

  const app = express();
  app.use(cors);

  async function translateCuesToSrt(cues, stats) {
    const translated = await translateCues(cues, { targetLang: cfg.targetLangGoogle, stats });
    const formatted = display.formatCues(translated);
    const finalCues = cfg.targetIsRtl ? rtl.markCuesRtl(formatted) : formatted;
    return srtImpl.serialize(finalCues);
  }

  async function buildTranslatedSrt(source, stats) {
    return translateCuesToSrt(srtImpl.parse(source.bytes), stats);
  }

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

  app.get('/manifest.json', (req, res) => res.json(buildManifest()));

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
      const log = cfg.logEmbedded
        ? (m) => embLog(cfg, `[${filename || `${type}/${id}`}] ${m}`)
        : undefined;
      try { detected = await embeddedImpl.detectEmbeddedEnglish({ videoSize, filename }, { log }); }
      catch (e) { if (log) log(`detect threw: ${e && e.message}`); detected = null; }
      if (!detected) {
        const { videoHash } = embeddedImpl.parseExtra(extra);
        try { detected = await resolveImageSync({ type, id, extra, videoSize, videoHash, filename }, log); }
        catch (e) { if (log) log(`image-sync detect threw: ${e && e.message}`); }
      }
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

  app.get(/^\/translate\/(.+)\.srt$/, async (req, res) => {
    const segs = req.params[0].split('/');
    const type = segs[0];
    const id = segs[1];
    const extra = segs.slice(2).join('/') || null;
    const key = `${cfg.cacheVersion || 'v1'}:${type}:${id}`;
    res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');

    const cached = cacheImpl.get(key);
    if (cached != null) return res.send(cached);

    try {
      const source = await getSource(type, id, extra);
      if (!source) return res.send('');
      const stats = {};
      const out = await buildTranslatedSrt(source, stats);
      // Only cache a fully-translated result. If any chunk failed (e.g. a transient
      // rate-limit), serve best-effort but don't poison the cache with untranslated text.
      if (!stats.failedChunks) cacheImpl.put(key, out);
      return res.send(out);
    } catch (e) {
      console.error('translate error:', e);
      return res.send('');
    }
  });

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
      // No embedded text track → try image→external-text sync (cached from detection).
      const log = cfg.logEmbedded
        ? (m) => embLog(cfg, `[${filename || `${type}/${id}`}] ${m}`)
        : undefined;
      let imageResult = null;
      try { imageResult = await resolveImageSync({ type, id, extra, videoSize, videoHash, filename }, log); }
      catch (e) { if (log) log(`image-sync resolve threw: ${e && e.message}`); }
      if (imageResult && imageResult.mode === 'image-sync') {
        const ext = await getSource(type, id, extra || null);
        if (!ext) return res.send('');
        const synced = syncImpl.applySync(srtImpl.parse(ext.bytes), imageResult.transform);
        const stats = {};
        const out = await translateCuesToSrt(synced, stats);
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
