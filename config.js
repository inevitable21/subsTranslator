'use strict';
const path = require('path');
const os = require('os');

const dataDir = process.env.SUBSTRANSLATOR_DATA
  || (process.platform === 'win32' && process.env.APPDATA
    ? path.join(process.env.APPDATA, 'subsTranslator')
    : path.join(os.homedir(), '.subsTranslator'));

module.exports = {
  host: process.env.SUBSTRANSLATOR_HOST || '127.0.0.1',
  port: Number(process.env.SUBSTRANSLATOR_PORT) || 7000,
  targetLangLabel: 'heb',        // Stremio ISO 639-2 label
  targetLangGoogle: 'he',        // Google Translate target code
  targetIsRtl: true,             // Hebrew is right-to-left; mark served lines RTL
  cacheVersion: 'v3',            // bump to invalidate cached output when format changes
  logRequests: true,             // append incoming subtitle requests to dataDir/requests.log
  sourcePreference: ['eng', 'en', 'english'],
  dataDir,
  cacheDir: path.join(dataDir, 'cache'),
  opensubtitlesBase: 'https://opensubtitles-v3.strem.io',
  batchSize: 100,
  concurrency: 5,
};
