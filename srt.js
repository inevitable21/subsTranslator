'use strict';
const chardet = require('chardet');
const iconv = require('iconv-lite');

function decode(bytes) {
  if (typeof bytes === 'string') return bytes.replace(/^﻿/, '');
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return bytes.slice(3).toString('utf8');
  }
  const utf8 = bytes.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  // We are here only because strict UTF-8 decoding failed, so a UTF-8 verdict
  // from chardet (common on short/ambiguous samples) is wrong — fall back to an
  // 8-bit default instead of re-producing replacement characters.
  let detected = chardet.detect(bytes);
  if (!detected || /utf-?8/i.test(detected)) detected = 'windows-1252';
  return iconv.decode(bytes, detected);
}

function parseTimestamp(str) {
  const m = String(str).trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/);
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = parseInt(m[2], 10);
  const s = parseInt(m[3], 10);
  const ms = parseInt(m[4].padEnd(3, '0'), 10);
  return ((h * 60 + min) * 60 + s) * 1000 + ms;
}

function formatTimestamp(ms) {
  const p = (n, w) => String(n).padStart(w, '0');
  const h = Math.floor(ms / 3600000);
  const min = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${p(h, 2)}:${p(min, 2)}:${p(s, 2)},${p(ms % 1000, 3)}`;
}

function parse(input) {
  const text = decode(input).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = text.split(/\n\s*\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const idx = lines.findIndex(l => l.includes('-->'));
    if (idx === -1) continue;
    const [rawStart, rawEnd] = lines[idx].split('-->');
    if (rawEnd === undefined) continue;
    const start = parseTimestamp(rawStart);
    const end = parseTimestamp(rawEnd);
    if (start === null || end === null) continue;
    const cueText = lines.slice(idx + 1).join('\n').trim();
    if (cueText === '') continue;
    cues.push({ start, end, text: cueText });
  }
  return cues;
}

function serialize(cues) {
  return cues.map((c, i) =>
    `${i + 1}\n${formatTimestamp(c.start)} --> ${formatTimestamp(c.end)}\n${c.text}`
  ).join('\n\n') + '\n';
}

module.exports = { decode, parse, serialize, parseTimestamp, formatTimestamp };
