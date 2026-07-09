'use strict';
const zlib = require('zlib');
const config = require('./config');

function selectBest(list, preference = config.sourcePreference) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const prefs = preference.map(p => String(p).toLowerCase());
  for (const pref of prefs) {
    const hit = list.find(s => s && s.lang && String(s.lang).toLowerCase() === pref);
    if (hit) return hit;
  }
  return list[0];
}

function maybeGunzip(buf) {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf);
  return buf;
}

async function getSourceSubtitle(type, id, extra, deps = {}) {
  const fetchFn = deps.fetchFn || fetch;
  const base = deps.base || config.opensubtitlesBase;
  const preference = deps.preference || config.sourcePreference;
  const extraPart = extra ? `/${extra}` : '';
  const url = `${base}/subtitles/${type}/${id}${extraPart}.json`;

  let list;
  try {
    const res = await fetchFn(url);
    if (!res.ok) return null;
    const json = await res.json();
    list = json && json.subtitles;
  } catch { return null; }

  const track = selectBest(list, preference);
  if (!track || !track.url) return null;

  try {
    const res = await fetchFn(track.url);
    if (!res.ok) return null;
    const bytes = maybeGunzip(Buffer.from(await res.arrayBuffer()));
    return { bytes, lang: track.lang || 'unknown' };
  } catch { return null; }
}

module.exports = { selectBest, getSourceSubtitle, maybeGunzip };
