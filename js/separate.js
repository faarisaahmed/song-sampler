// Vocal separation with an MDX-Net model (from Ultimate Vocal Remover),
// run in the browser with onnxruntime-web.
//
// The model takes a stereo spectrogram (real/imag for L and R, the lowest
// `dimF` frequency bins, `dimT` frames) and returns the vocal spectrogram.
// We slice the song into overlapping chunks, run STFT -> model -> inverse
// STFT on each, and stitch the middles together, the same way UVR does.
// The instrumental is then just mix - vocals.

import { makeFFT } from './fft.js';

export const MODELS = {
  voc_ft: {
    name: 'UVR-MDX-NET Voc FT',
    url: 'https://huggingface.co/masszhou/mdxnet/resolve/main/UVR-MDX-NET-Voc_FT.onnx',
    sizeMB: 67,
    sampleRate: 44100,
    nfft: 7680, dimF: 3072, dimT: 256, hop: 1024, compensate: 1.021,
  },
};

/**
 * @param runModel async (Float32Array input [1,4,dimF,dimT]) => Float32Array output (same shape)
 * @param L, R     Float32Array channels at cfg.sampleRate
 * @returns { vocals: [L, R], instrumental: [L, R] }
 */
export async function separateVocals(runModel, L, R, cfg, onProgress = () => {}) {
  const { nfft, dimF, dimT, hop, compensate } = cfg;
  const N = nfft, nBins = N / 2 + 1;
  const chunk = hop * (dimT - 1);
  const trim = N / 2;
  const gen = chunk - 2 * trim;
  const n = L.length;
  const pad = gen - (n % gen);
  const padded = (x) => { const p = new Float32Array(trim + n + pad + trim); p.set(x, trim); return p; };
  const pL = padded(L), pR = padded(R);
  const vL = new Float32Array(n + pad), vR = new Float32Array(n + pad);

  const fft = makeFFT(N);
  const win = new Float64Array(N);
  for (let j = 0; j < N; j++) win[j] = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / N);
  const re = new Float64Array(N), im = new Float64Array(N);
  const input = new Float32Array(4 * dimF * dimT);
  const plane = dimF * dimT;
  const olaLen = chunk + N;
  const yL = new Float64Array(olaLen), yR = new Float64Array(olaLen), wsum = new Float64Array(olaLen);

  const chunks = (n + pad) / gen;
  for (let c = 0; c < chunks; c++) {
    const start = c * gen;
    // ---- STFT (center=True, reflect padding), L and R packed as one complex signal
    input.fill(0);
    for (let t = 0; t < dimT; t++) {
      for (let j = 0; j < N; j++) {
        let idx = t * hop - trim + j;
        if (idx < 0) idx = -idx;
        else if (idx >= chunk) idx = 2 * (chunk - 1) - idx;
        re[j] = pL[start + idx] * win[j];
        im[j] = pR[start + idx] * win[j];
      }
      fft.forward(re, im);
      for (let k = 3; k < dimF; k++) { // UVR zeroes the lowest 3 bins
        const zr = re[k], zi = im[k], nr = re[N - k], ni = im[N - k];
        const o = k * dimT + t;
        input[o] = (zr + nr) / 2;             // L real
        input[plane + o] = (zi - ni) / 2;     // L imag
        input[2 * plane + o] = (zi + ni) / 2; // R real
        input[3 * plane + o] = (nr - zr) / 2; // R imag
      }
    }

    const out = await runModel(input);

    // ---- inverse STFT (overlap-add, normalized by the summed squared window)
    yL.fill(0); yR.fill(0); wsum.fill(0);
    for (let t = 0; t < dimT; t++) {
      re.fill(0); im.fill(0);
      for (let k = 0; k < Math.min(dimF, nBins); k++) {
        const o = k * dimT + t;
        const lr = out[o], li = out[plane + o], rr = out[2 * plane + o], ri = out[3 * plane + o];
        re[k] = lr - ri; im[k] = li + rr;               // Z = XL + i*XR
        if (k > 0 && k < N - k) { re[N - k] = lr + ri; im[N - k] = rr - li; } // Hermitian halves
      }
      fft.inverse(re, im);
      const off = t * hop;
      for (let j = 0; j < N; j++) {
        yL[off + j] += (re[j] / N) * win[j];
        yR[off + j] += (im[j] / N) * win[j];
        wsum[off + j] += win[j] * win[j];
      }
    }
    for (let s = trim; s < chunk - trim; s++) {
      const q = s + trim; // undo the center padding
      const w = wsum[q] > 1e-8 ? wsum[q] : 1;
      vL[start + s - trim] = (yL[q] / w) * compensate;
      vR[start + s - trim] = (yR[q] / w) * compensate;
    }
    onProgress((c + 1) / chunks);
  }

  const vocalsL = vL.slice(0, n), vocalsR = vR.slice(0, n);
  const instL = new Float32Array(n), instR = new Float32Array(n);
  for (let i = 0; i < n; i++) { instL[i] = L[i] - vocalsL[i]; instR[i] = R[i] - vocalsR[i]; }
  return { vocals: [vocalsL, vocalsR], instrumental: [instL, instR] };
}
