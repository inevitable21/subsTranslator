'use strict';
// Subtitle text is stored in logical order. Players that assume a left-to-right
// base direction push trailing punctuation (? ! . -) to the wrong visual end of a
// Hebrew line. Wrapping each line in an explicit Right-to-Left Embedding forces the
// correct right-to-left base direction in any BiDi-aware renderer.
const RLE = '‫'; // Right-to-Left Embedding
const PDF = '‬'; // Pop Directional Formatting

function markRtl(text) {
  return text.split('\n')
    .map(line => (line === '' ? line : RLE + line + PDF))
    .join('\n');
}

function markCuesRtl(cues) {
  return cues.map(c => ({ ...c, text: markRtl(c.text) }));
}

module.exports = { markRtl, markCuesRtl, RLE, PDF };
