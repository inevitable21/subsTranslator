'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const sync = require('../sync');

test('_fft round-trips a signal (forward then inverse ≈ identity)', () => {
  const re = Float64Array.from([1, 2, 3, 4, 0, 0, 0, 0]);
  const im = new Float64Array(8);
  const re0 = Float64Array.from(re);
  sync._fft(re, im, false);
  sync._fft(re, im, true);
  for (let i = 0; i < 8; i++) assert.ok(Math.abs(re[i] - re0[i]) < 1e-9, `bin ${i}`);
});

test('_crossCorrelate peaks at the lag by which b leads a', () => {
  // b is a shifted 2 bins later than a: b[t] = a[t-2]
  const a = Float64Array.from([0, 1, 0, 1, 0, 0, 0, 0]);
  const b = Float64Array.from([0, 0, 0, 1, 0, 1, 0, 0]);
  const corr = sync._crossCorrelate(a, b);
  // find lag of max within [-4,4]
  const n = corr.length;
  let bestLag = 0, bestVal = -Infinity;
  for (let lag = -4; lag <= 4; lag++) {
    const v = corr[lag >= 0 ? lag : n + lag];
    if (v > bestVal) { bestVal = v; bestLag = lag; }
  }
  assert.strictEqual(bestLag, 2);
});
