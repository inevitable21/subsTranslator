'use strict';
const config = require('./config');
const childProcess = require('node:child_process');

const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'text', 'webvtt']);
const IMAGE_SUB_CODECS = new Set(['hdmv_pgs_subtitle', 'pgssub', 'dvd_subtitle', 'dvdsub', 'vobsub']);

function parseExtra(extra) {
  const s = String(extra || '');
  const size = (s.match(/(?:^|&)videoSize=(\d+)/) || [])[1];
  const hash = (s.match(/(?:^|&)videoHash=([A-Za-z0-9]+)/) || [])[1];
  const fn = (s.match(/(?:^|&)filename=([^&]*)/) || [])[1];
  return {
    filename: fn ? fn : null,
    videoSize: size ? Number(size) : null,
    videoHash: hash || null,
  };
}

async function fetchWithTimeout(fetchFn, url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchFn(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function basename(p) {
  return p ? String(p).split(/[\\/]/).pop() : null;
}

async function findStream({ videoSize, filename }, deps = {}) {
  const fetchFn = deps.fetchFn || fetch;
  const base = deps.base || config.streamingServerBase;
  const timeoutMs = deps.statsTimeoutMs || 500;
  const log = deps.log || (() => {});
  if (!videoSize) return null;

  let stats;
  try {
    const res = await fetchWithTimeout(fetchFn, `${base}/stats.json`, timeoutMs);
    if (!res.ok) { log(`findStream: /stats.json HTTP ${res.status} at ${base}`); return null; }
    stats = await res.json();
  } catch { log(`findStream: streaming server unreachable at ${base} (is Stremio running?)`); return null; }
  if (!stats || typeof stats !== 'object') return null;

  const wantSize = Number(videoSize);
  const wantName = basename(filename);
  let sizeOnly = null;
  const torrentCount = Object.keys(stats).length;

  for (const [key, entry] of Object.entries(stats)) {
    const infoHash = (entry && entry.infoHash) || key;
    const files = (entry && entry.files) || [];
    for (let i = 0; i < files.length; i++) {
      if (Number(files[i].length) !== wantSize) continue;
      const hit = { infoHash, fileIdx: i, mediaUrl: `${base}/${infoHash}/${i}` };
      if (wantName && basename(files[i].name) === wantName) {
        log(`findStream: matched "${files[i].name}" -> ${hit.mediaUrl}`);
        return hit; // best match
      }
      if (!sizeOnly) sizeOnly = hit;
    }
  }
  if (sizeOnly) { log(`findStream: matched by size only -> ${sizeOnly.mediaUrl}`); return sizeOnly; }
  log(`findStream: no active file matches videoSize=${wantSize} (${torrentCount} torrent(s) streaming) — debrid/HTTP stream or not torrent-backed`);
  return null;
}

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

function extractSrt({ mediaUrl, trackIndex }, deps = {}) {
  const spawnFn = deps.spawnFn || childProcess.spawn;
  const ffmpegPath = deps.ffmpegPath || require('ffmpeg-static');
  const args = ['-nostdin', '-i', mediaUrl, '-map', `0:s:${trackIndex}`,
    '-c:s', 'srt', '-f', 'srt', 'pipe:1'];

  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnFn(ffmpegPath, args); }
    catch (e) { return reject(e); }

    const chunks = [];
    const errChunks = [];
    let errLen = 0;
    const ERR_CAP = 4096;
    child.stdout.on('data', d => chunks.push(d));
    if (child.stderr) {
      // Drain stderr so a real ffmpeg child can't block on a full pipe;
      // retain only a bounded amount for diagnostics.
      child.stderr.on('data', d => {
        if (errLen < ERR_CAP) { errChunks.push(d); errLen += d.length; }
      });
    }
    child.on('error', reject);
    child.on('close', code => {
      const out = Buffer.concat(chunks);
      if (code === 0 && out.length > 0) return resolve(out);
      const err = Buffer.concat(errChunks).toString('utf8').trim();
      reject(new Error(`ffmpeg exit=${code} bytes=${out.length}${err ? ` stderr=${err}` : ''}`));
    });
  });
}

async function detectEmbeddedEnglish({ videoSize, filename }, deps = {}) {
  const find = deps.findStream || findStream;
  const probe = deps.probeEnglishSub || probeEnglishSub;
  const stream = await find({ videoSize, filename }, deps);
  if (!stream) return null;
  const sub = await probe(stream.mediaUrl, deps);
  if (!sub) return null;
  return { mediaUrl: stream.mediaUrl, trackIndex: sub.trackIndex, codec: sub.codec };
}

async function getEmbeddedSubtitle({ videoSize, filename }, deps = {}) {
  const extract = deps.extractSrt || extractSrt;
  const detected = await detectEmbeddedEnglish({ videoSize, filename }, deps);
  if (!detected) return null;
  try {
    const bytes = await extract(
      { mediaUrl: detected.mediaUrl, trackIndex: detected.trackIndex }, deps);
    if (!bytes || bytes.length === 0) return null;
    return { bytes, lang: 'eng' };
  } catch { return null; }
}

module.exports = {
  parseExtra, findStream, probeEnglish, probeEnglishSub, extractSrt,
  detectEmbeddedEnglish, getEmbeddedSubtitle,
};
