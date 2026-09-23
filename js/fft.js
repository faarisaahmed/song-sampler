// Complex FFT for any length: radix-2 when the size is a power of two,
// Bluestein's algorithm otherwise (the separation model uses n_fft = 7680).

function radix2(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

// Plan for length n. fft.forward(re, im) / fft.inverse(re, im) work in place
// (the inverse is unnormalized, like numpy's ifft * n).
export function makeFFT(n) {
  if ((n & (n - 1)) === 0) {
    return { n, forward: (re, im) => radix2(re, im, false), inverse: (re, im) => radix2(re, im, true) };
  }
  let m = 1;
  while (m < 2 * n - 1) m <<= 1;
  // chirp w[k] = exp(-i*pi*k^2/n)
  const cr = new Float64Array(n), ci = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const a = (Math.PI * ((k * k) % (2 * n))) / n;
    cr[k] = Math.cos(a); ci[k] = -Math.sin(a);
  }
  // FFT of the conjugate chirp, wrapped
  const br = new Float64Array(m), bi = new Float64Array(m);
  br[0] = cr[0]; bi[0] = -ci[0];
  for (let k = 1; k < n; k++) { br[k] = br[m - k] = cr[k]; bi[k] = bi[m - k] = -ci[k]; }
  radix2(br, bi, false);
  const ar = new Float64Array(m), ai = new Float64Array(m);
  const run = (re, im, inverse) => {
    ar.fill(0); ai.fill(0);
    for (let k = 0; k < n; k++) {
      const xr = re[k], xi = inverse ? -im[k] : im[k]; // inverse via conjugation
      ar[k] = xr * cr[k] - xi * ci[k];
      ai[k] = xr * ci[k] + xi * cr[k];
    }
    radix2(ar, ai, false);
    for (let k = 0; k < m; k++) {
      const t = ar[k] * br[k] - ai[k] * bi[k];
      ai[k] = ar[k] * bi[k] + ai[k] * br[k];
      ar[k] = t;
    }
    radix2(ar, ai, true);
    for (let k = 0; k < n; k++) {
      const yr = ar[k] / m, yi = ai[k] / m;
      re[k] = yr * cr[k] - yi * ci[k];
      im[k] = yr * ci[k] + yi * cr[k];
      if (inverse) im[k] = -im[k];
    }
  };
  return { n, forward: (re, im) => run(re, im, false), inverse: (re, im) => run(re, im, true) };
}
