'use strict';

// In-place iterative radix-2 Cooley–Tukey FFT. re/im: Float64Array, length a power of 2.
// inverse=false → forward; inverse=true → inverse (divides by n).
function _fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = cwr * re[b] - cwi * im[b];
        const ti = cwr * im[b] + cwi * re[b];
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr; cwr = ncwr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

function _nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// Real cross-correlation via FFT: corr[lag] = Σ_t a[t]·b[t+lag].
// Returns length-n real array; index m = lag m (m ≥ n/2 → negative lag m-n).
function _crossCorrelate(a, b) {
  const n = _nextPow2(a.length + b.length);
  const ar = new Float64Array(n), ai = new Float64Array(n);
  const br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(a); br.set(b);
  _fft(ar, ai, false);
  _fft(br, bi, false);
  const cr = new Float64Array(n), ci = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // conj(A) * B
    cr[i] = ar[i] * br[i] + ai[i] * bi[i];
    ci[i] = ar[i] * bi[i] - ai[i] * br[i];
  }
  _fft(cr, ci, true);
  return cr;
}

const BIN_SECONDS = 0.1;
const MAX_OFFSET_SECONDS = 120;
const FRAMERATE_RATIOS = [1, 24 / 23.976, 23.976 / 24, 25 / 24, 24 / 25, 25 / 23.976, 23.976 / 25];

function rasterize(onsets, scale, binSeconds, nBins) {
  const sig = new Float64Array(nBins);
  for (const t of onsets) {
    const bin = Math.round((t * scale) / binSeconds);
    if (bin >= 0 && bin < nBins) sig[bin] = 1;
  }
  return sig;
}

function computeLinearSync(onsetsA, onsetsB, opts = {}) {
  const binSeconds = opts.binSeconds || BIN_SECONDS;
  const maxOffset = opts.maxOffsetSeconds || MAX_OFFSET_SECONDS;
  if (!onsetsA.length || !onsetsB.length) return { scale: 1, offset: 0, score: 0 };

  const lastA = onsetsA[onsetsA.length - 1];
  const lastB = onsetsB[onsetsB.length - 1];
  const spanSeconds = Math.max(lastA, lastB) + maxOffset + 1;
  const nBins = Math.ceil(spanSeconds / binSeconds) + 1;
  const sigB = rasterize(onsetsB, 1, binSeconds, nBins);
  const energyB = onsetsB.length;
  const maxLagBins = Math.round(maxOffset / binSeconds);

  let best = { scale: 1, offset: 0, score: 0 };
  for (const r of FRAMERATE_RATIOS) {
    const sigA = rasterize(onsetsA, r, binSeconds, nBins);
    const corr = _crossCorrelate(sigA, sigB);
    const n = corr.length;
    const norm = Math.sqrt(onsetsA.length * energyB) || 1;
    for (let lag = -maxLagBins; lag <= maxLagBins; lag++) {
      const idx = lag >= 0 ? lag : n + lag;
      const v = Math.min(1, corr[idx] / norm);
      if (v > best.score) best = { scale: r, offset: lag * binSeconds, score: v };
    }
  }
  return best;
}

function applySync(cues, { scale, offset }) {
  const offMs = offset * 1000;
  const out = [];
  for (const c of cues) {
    const start = Math.round(c.start * scale + offMs);
    const end = Math.round(c.end * scale + offMs);
    if (end <= 0) continue;
    out.push({ ...c, start: Math.max(0, start), end });
  }
  return out;
}

module.exports = {
  _fft, _nextPow2, _crossCorrelate,
  computeLinearSync, BIN_SECONDS, MAX_OFFSET_SECONDS, FRAMERATE_RATIOS,
  applySync,
};
