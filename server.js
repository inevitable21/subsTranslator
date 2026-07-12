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

  const app = express();
  app.use(cors);

  async function buildTranslatedSrt(source, stats) {
    const cues = srtImpl.parse(source.bytes);
    const translated = await translateCues(cues, { targetLang: cfg.targetLangGoogle, stats });
    const formatted = display.formatCues(translated);
    const finalCues = cfg.targetIsRtl ? rtl.markCuesRtl(formatted) : formatted;
    return srtImpl.serialize(finalCues);
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
