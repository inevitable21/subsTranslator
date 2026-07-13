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

module.exports = { _fft, _nextPow2, _crossCorrelate };
