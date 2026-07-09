'use strict';
const express = require('express');
const config = require('./config');
const { buildManifest } = require('./manifest');
const srt = require('./srt');
const sources = require('./sources');
const translate = require('./translate');
const cache = require('./cache');
const rtl = require('./rtl');

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
    const key = `${cfg.cacheVersion || 'v1'}:${type}:${id}`;
    res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');

    const cached = cacheImpl.get(key);
    if (cached != null) return res.send(cached);

    try {
      const source = await getSource(type, id, extra);
      if (!source) return res.send('');
      const cues = srtImpl.parse(source.bytes);
      const stats = {};
      const translated = await translateCues(cues, { targetLang: cfg.targetLangGoogle, stats });
      const finalCues = cfg.targetIsRtl ? rtl.markCuesRtl(translated) : translated;
      const out = srtImpl.serialize(finalCues);
      // Only cache a fully-translated result. If any chunk failed (e.g. a transient
      // rate-limit), serve best-effort but don't poison the cache with untranslated text.
      if (!stats.failedChunks) cacheImpl.put(key, out);
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
