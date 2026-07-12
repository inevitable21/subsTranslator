'use strict';
const config = require('./config');
const childProcess = require('node:child_process');

const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'text', 'webvtt']);

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
  if (!videoSize) return null;

  let stats;
  try {
    const res = await fetchWithTimeout(fetchFn, `${base}/stats.json`, timeoutMs);
    if (!res.ok) return null;
    stats = await res.json();
  } catch { return null; }
  if (!stats || typeof stats !== 'object') return null;

  const wantSize = Number(videoSize);
  const wantName = basename(filename);
  let sizeOnly = null;

  for (const [key, entry] of Object.entries(stats)) {
    const infoHash = (entry && entry.infoHash) || key;
    const files = (entry && entry.files) || [];
    for (let i = 0; i < files.length; i++) {
      if (Number(files[i].length) !== wantSize) continue;
      const hit = { infoHash, fileIdx: i, mediaUrl: `${base}/${infoHash}/${i}` };
      if (wantName && basename(files[i].name) === wantName) return hit; // best match
      if (!sizeOnly) sizeOnly = hit;
    }
  }
  return sizeOnly;
}

async function probeEnglishSub(mediaUrl, deps = {}) {
  const fetchFn = deps.fetchFn || fetch;
  const base = deps.base || config.streamingServerBase;
  const timeoutMs = deps.probeTimeoutMs || 1500;

  let probe;
  try {
    const url = `${base}/probe/${encodeURIComponent(mediaUrl)}`;
    const res = await fetchWithTimeout(fetchFn, url, timeoutMs);
    if (!res.ok) return null;
    probe = await res.json();
  } catch { return null; }

  const subs = (probe && probe.streams && probe.streams.subtitles) || [];
  for (let rel = 0; rel < subs.length; rel++) {
    const s = subs[rel] || {};
    const codec = String(s.codec || s.codec_name || '').toLowerCase();
    if (!TEXT_SUB_CODECS.has(codec)) continue;
    const tags = s.tags || {};
    const lang = String(tags.language || s.language || '').toLowerCase();
    const title = String(tags.title || '');
    if (lang === 'eng' || lang === 'en' || /english/i.test(title)) {
      return { trackIndex: rel, codec };
    }
  }
  return null;
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
  parseExtra, findStream, probeEnglishSub, extractSrt,
  detectEmbeddedEnglish, getEmbeddedSubtitle,
};
