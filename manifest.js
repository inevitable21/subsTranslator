'use strict';

function buildManifest() {
  return {
    id: 'community.substranslator.hebrew',
    version: '1.0.0',
    name: 'Hebrew Auto-Translate',
    description: 'Auto-translates available subtitles to Hebrew using Google Translate.',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    catalogs: [],
    idPrefixes: ['tt'],
    behaviorHints: { configurable: false },
  };
}

module.exports = { buildManifest };
