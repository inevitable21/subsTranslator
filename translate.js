'use strict';
const config = require('./config');

const GOOGLE_URL = 'https://translate.googleapis.com/translate_a/single';

function parseGoogleResponse(json) {
  if (!Array.isArray(json) || !Array.isArray(json[0])) return '';
  return json[0].map(seg => (seg && seg[0]) ? seg[0] : '').join('');
}

async function translateText(text, targetLang, sl = 'auto', fetchFn = fetch) {
  // The text goes in the POST body, never the URL. A GET query string is capped
  // at ~16k chars, and non-Latin scripts (Greek, Russian, Hebrew, ...) URL-encode
  // to ~5x their length, so a full batch would exceed the limit and return HTTP 400.
  const url = `${GOOGLE_URL}?client=gtx&sl=${encodeURIComponent(sl)}`
    + `&tl=${encodeURIComponent(targetLang)}&dt=t`;
  const body = new URLSearchParams({ q: text }).toString();
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body,
  });
  if (!res.ok) throw new Error(`translate HTTP ${res.status}`);
  return parseGoogleResponse(await res.json());
}

async function retry(fn, attempts = 3, baseDelay = 500) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

function flatten(text) {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

async function translateChunk(cues, targetLang, translateFn, stats) {
  const texts = cues.map(c => flatten(c.text));
  try {
    const translated = await translateFn(texts.join('\n'), targetLang);
    const parts = translated.split('\n');
    if (parts.length === texts.length) {
      return cues.map((c, i) => ({ ...c, text: parts[i].trim() }));
    }
    const perCue = await Promise.all(texts.map(t => translateFn(t, targetLang)));
    return cues.map((c, i) => ({ ...c, text: perCue[i].trim() }));
  } catch (e) {
    if (stats) stats.failedChunks++;
    return cues; // keep original text on failure
  }
}

async function translateCues(cues, opts = {}) {
  const targetLang = opts.targetLang || config.targetLangGoogle;
  const batchSize = opts.batchSize || config.batchSize;
  const concurrency = opts.concurrency || config.concurrency;
  const translateFn = opts.translateFn || ((t, tl) => retry(() => translateText(t, tl)));
  const stats = opts.stats;
  const chunks = [];
  for (let i = 0; i < cues.length; i += batchSize) chunks.push(cues.slice(i, i + batchSize));
  if (stats) { stats.totalChunks = chunks.length; stats.failedChunks = 0; }
  const out = await mapWithConcurrency(chunks, concurrency,
    (chunk) => translateChunk(chunk, targetLang, translateFn, stats));
  return out.flat();
}

module.exports = { translateCues, translateText, parseGoogleResponse, mapWithConcurrency };
