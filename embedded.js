'use strict';
const config = require('./config');

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

module.exports = { parseExtra, findStream, probeEnglishSub };
