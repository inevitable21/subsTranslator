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

test('computeLinearSync recovers a constant offset', () => {
  const A = [];
  for (let t = 10; t < 600; t += 3) A.push(t); // ~197 onsets across 10 min
  const B = A.map(t => t + 5);                  // B is 5s later
  const r = sync.computeLinearSync(A, B);
  assert.ok(Math.abs(r.scale - 1) < 1e-9, `scale ${r.scale}`);
  assert.ok(Math.abs(r.offset - 5) < 0.1, `offset ${r.offset}`);
  assert.ok(r.score > 0.9, `score ${r.score}`);
});

test('computeLinearSync recovers a framerate scale (23.976→25)', () => {
  const ratio = 23.976 / 25; // ≈0.95904
  const A = [];
  for (let t = 10; t < 600; t += 3) A.push(t);
  const B = A.map(t => t * ratio);
  const r = sync.computeLinearSync(A, B);
  assert.ok(Math.abs(r.scale - ratio) < 1e-3, `scale ${r.scale}`);
  assert.ok(Math.abs(r.offset) < 0.2, `offset ${r.offset}`);
  assert.ok(r.score > 0.9, `score ${r.score}`);
});

test('computeLinearSync gives a low score for uncorrelated onsets', () => {
  // deterministic pseudo-scatter, no shared structure
  const A = [], B = [];
  for (let i = 0; i < 200; i++) A.push((i * 37) % 600 + 0.13 * i);
  for (let i = 0; i < 200; i++) B.push((i * 53) % 600 + 0.07 * i);
  A.sort((x, y) => x - y); B.sort((x, y) => x - y);
  const r = sync.computeLinearSync(A, B);
  assert.ok(r.score < 0.4, `score ${r.score} should be low`);
});

test('computeLinearSync returns zero score for empty input', () => {
  const r = sync.computeLinearSync([], [1, 2, 3]);
  assert.strictEqual(r.score, 0);
});
