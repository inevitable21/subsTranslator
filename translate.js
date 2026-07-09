'use strict';
const config = require('./config');

const GOOGLE_URL = 'https://translate.googleapis.com/translate_a/single';

function parseGoogleResponse(json) {
  if (!Array.isArray(json) || !Array.isArray(json[0])) return '';
  return json[0].map(seg => (seg && seg[0]) ? seg[0] : '').join('');
}

async function translateText(text, targetLang, sl = 'auto', fetchFn = fetch) {
  const url = `${GOOGLE_URL}?client=gtx&sl=${encodeURIComponent(sl)}`
    + `&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetchFn(url);
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

async function translateChunk(cues, targetLang, translateFn) {
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
    return cues; // keep original text on failure
  }
}

async function translateCues(cues, opts = {}) {
  const targetLang = opts.targetLang || config.targetLangGoogle;
  const batchSize = opts.batchSize || config.batchSize;
  const concurrency = opts.concurrency || config.concurrency;
  const translateFn = opts.translateFn || ((t, tl) => retry(() => translateText(t, tl)));
  const chunks = [];
  for (let i = 0; i < cues.length; i += batchSize) chunks.push(cues.slice(i, i + batchSize));
  const out = await mapWithConcurrency(chunks, concurrency,
    (chunk) => translateChunk(chunk, targetLang, translateFn));
  return out.flat();
}

module.exports = { translateCues, translateText, parseGoogleResponse, mapWithConcurrency };
