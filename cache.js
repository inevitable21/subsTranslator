'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');

function keyToFile(key, dir = config.cacheDir) {
  const safe = String(key).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(dir, `${safe}.srt`);
}

function get(key, dir = config.cacheDir) {
  try { return fs.readFileSync(keyToFile(key, dir), 'utf8'); }
  catch { return null; }
}

function put(key, srt, dir = config.cacheDir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyToFile(key, dir), srt, 'utf8');
}

module.exports = { get, put, keyToFile };
