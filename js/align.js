// Line up a MIDI file with a real recording of the same song, so the cat can
// sing the MIDI's melody on top of the recording's instrumental.
//
// Both are turned into chroma (energy per pitch class, C..B, every ~46 ms):
// the recording through an STFT, the MIDI straight from its notes (with a
// little of the 3rd and 5th harmonics mixed in, like real instruments have).
// Subsequence dynamic time warping then finds the stretch of the MIDI that
// matches the recording, and the tempo map between them. The recording may be
// only a 30 s excerpt, and its tempo may drift. Different keys are handled by
// trying the most likely transpositions and keeping the best match.

import { makeFFT } from './fft.js';

const SR = 22050, N_FFT = 4096, HOP = 1024;
export const FRAME = HOP / SR; // ~46 ms

// Per frame: log-compress, subtract the mean and scale to unit length, so the
// dot product of two frames is their correlation. Silence becomes all zeros
// (it neither matches nor mismatches anything).
function normalizeFrames(frames) {
  let max = 0;
  for (const f of frames) for (const v of f) max = Math.max(max, v);
  const floor = max * 1e-3;
  return frames.map((f) => {
    const out = new Float32Array(12);
    let e = 0;
    for (let k = 0; k < 12; k++) e += f[k];
    if (e < floor) return out;
    let mean = 0, ss = 0;
    for (let k = 0; k < 12; k++) { out[k] = Math.log1p((100 * f[k]) / max); mean += out[k] / 12; }
    for (let k = 0; k < 12; k++) { out[k] -= mean; ss += out[k] * out[k]; }
    const n = Math.sqrt(ss) || 1;
    for (let k = 0; k < 12; k++) out[k] /= n;
    return out;
  });
}

export function audioChroma(mono, sr) {
  // downsample to 22.05 kHz (plain averaging is fine for pitch classes)
  const factor = Math.max(1, Math.round(sr / SR));
  const n = Math.floor(mono.length / factor);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < factor; k++) s += mono[i * factor + k]; x[i] = s / factor; }
  const fft = makeFFT(N_FFT);
  const win = new Float64Array(N_FFT);
  for (let j = 0; j < N_FFT; j++) win[j] = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / N_FFT);
  const binPc = new Int8Array(N_FFT / 2).fill(-1);
  for (let k = 1; k < N_FFT / 2; k++) {
    const f = (k * SR) / N_FFT;
    if (f >= 60 && f <= 5000) binPc[k] = ((Math.round(12 * Math.log2(f / 440) + 69) % 12) + 12) % 12;
  }
  const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT);
  const frames = [];
  for (let s = 0; s + N_FFT <= n || s === 0; s += HOP) {
    for (let j = 0; j < N_FFT; j++) { re[j] = (x[s + j] ?? 0) * win[j]; im[j] = 0; }
    fft.forward(re, im);
    const c = new Float64Array(12);
    for (let k = 1; k < N_FFT / 2; k++) if (binPc[k] >= 0) c[binPc[k]] += Math.hypot(re[k], im[k]);
    frames.push(c);
    if (s + N_FFT > n) break;
  }
  return normalizeFrames(frames);
}

// Chroma straight from notes. `harmonics` mixes in a little of the 3rd and
// 5th harmonics and lets notes decay, like real instruments; sung notes are
// kept pure and sustained.
function noteChroma(notes, count, harmonics) {
  const frames = Array.from({ length: count }, () => new Float64Array(12));
  for (const n of notes) {
    const pc = n.midi % 12;
    const f0 = Math.floor(n.time / FRAME), f1 = Math.min(count - 1, Math.ceil((n.time + n.duration) / FRAME));
    for (let f = Math.max(0, f0); f <= f1; f++) {
      const w = (n.velocity ?? 1) * (harmonics ? Math.exp(-(f - f0) * FRAME / 1.5) : 1);
      frames[f][pc] += w;
      if (harmonics) { frames[f][(pc + 7) % 12] += 0.3 * w; frames[f][(pc + 4) % 12] += 0.15 * w; }
    }
  }
  return normalizeFrames(frames);
}

export function midiChroma(song) {
  return noteChroma(song.tracks.filter((t) => !t.isDrums).flatMap((t) => t.notes), Math.ceil(song.duration / FRAME) + 1, true);
}

// Stack harmony and melody chroma into one 24-dim frame, each block scaled so
// the dot product is wH * (harmony match) + wM * (melody match).
function stack(H, M, wM) {
  const sh = Math.sqrt(1 - wM), sm = Math.sqrt(wM);
  return H.map((h, i) => {
    const o = new Float32Array(24);
    for (let k = 0; k < 12; k++) { o[k] = h[k] * sh; o[12 + k] = (M[i]?.[k] ?? 0) * sm; }
    return o;
  });
}

// Subsequence DTW of query A (recording) against reference B (MIDI).
// Steps (1,1), (1,2), (2,1) keep the tempo ratio between 0.5x and 2x.
function subsequenceDTW(A, B, rot) {
  const N = A.length, M = B.length;
  const D = A[0].length; // 12 (harmony) or 24 (harmony + melody)
  const Br = B.map((b) => { const o = new Float32Array(D); for (let k = 0; k < D; k++) o[(k - (k % 12)) + ((k + rot) % 12)] = b[k]; return o; });
  const cost = (i, j) => { const a = A[i], b = Br[j]; let d = 0; for (let k = 0; k < D; k++) d += a[k] * b[k]; return 1 - d; };
  const steps = new Uint8Array(N * M); // 1 = diag, 2 = (1,2), 3 = (2,1)
  let prev2 = new Float32Array(M).fill(Infinity), prev = new Float32Array(M), cur = new Float32Array(M);
  const rowCost = new Float32Array(M), prevRowCost = new Float32Array(M);
  for (let j = 0; j < M; j++) { prevRowCost[j] = cost(0, j); prev[j] = prevRowCost[j]; } // free start
  for (let i = 1; i < N; i++) {
    for (let j = 0; j < M; j++) rowCost[j] = cost(i, j);
    for (let j = 0; j < M; j++) {
      let best = Infinity, st = 0;
      if (j >= 1 && prev[j - 1] < best) { best = prev[j - 1]; st = 1; }
      if (j >= 2) { const v = prev[j - 2] + rowCost[j - 1]; if (v < best) { best = v; st = 2; } }
      if (j >= 1 && i >= 2) { const v = prev2[j - 1] + prevRowCost[j]; if (v < best) { best = v; st = 3; } }
      cur[j] = best + rowCost[j];
      steps[i * M + j] = st;
    }
    [prev2, prev, cur] = [prev, cur, prev2];
    prevRowCost.set(rowCost);
  }
  let jEnd = 0;
  for (let j = 1; j < M; j++) if (prev[j] < prev[jEnd]) jEnd = j;
  // backtrack
  const path = [];
  let i = N - 1, j = jEnd;
  while (i >= 0 && j >= 0) {
    path.push([i, j]);
    if (i === 0) break;
    const st = steps[i * M + j];
    if (st === 1) { i--; j--; }
    else if (st === 2) { path.push([i, j - 1]); i--; j -= 2; }
    else if (st === 3) { path.push([i - 1, j]); i -= 2; j--; }
    else break;
  }
  path.reverse();
  let total = 0;
  for (const [pi, pj] of path) total += cost(pi, pj);
  return { path, cost: total / path.length };
}

/**
 * Align a MIDI song to a recording.
 * vocalNotes: the melody transcribed from the separated vocals; melody: the
 * index of the MIDI's melody track. With both, the sung line is matched too.
 * @returns { curve (per MIDI frame from midiStart: recording frame), transpose
 *            (semitones to add to MIDI notes), cost, midiStart, midiEnd (seconds
 *            of the MIDI covered) }. Use mapTime / warpNotes with it.
 */
export function alignMidiToAudio(song, mono, sr, { vocalNotes = null, melody = -1, melodyWeight = 0.7 } = {}) {
  let A = audioChroma(mono, sr);
  let B = midiChroma(song);
  // rank transpositions by how well the overall pitch-class profiles match
  const mean = (F) => { const m = new Float64Array(12); for (const f of F) for (let k = 0; k < 12; k++) m[k] += f[k]; return m; };
  const ma = mean(A), mb = mean(B);
  const rots = [...Array(12).keys()].map((r) => {
    let d = 0; for (let k = 0; k < 12; k++) d += ma[(k + r) % 12] * mb[k];
    return { r, d };
  }).sort((x, y) => y.d - x.d).slice(0, 3);
  // the sung melody (transcribed from the separated vocals) against the MIDI's
  // melody track: this tells apart sections that share the same chords
  if (vocalNotes?.length && melody >= 0) {
    A = stack(A, noteChroma(vocalNotes, A.length, false), melodyWeight);
    B = stack(B, noteChroma(song.tracks[melody].notes, B.length, false), melodyWeight);
  }
  let best = null;
  for (const { r } of rots) {
    const res = subsequenceDTW(A, B, r);
    if (!best || res.cost < best.cost) best = { ...res, rot: r };
  }
  // MIDI frame -> mean audio frame, smoothed and forced monotonic
  const byJ = new Map();
  for (const [i, j] of best.path) { if (!byJ.has(j)) byJ.set(j, []); byJ.get(j).push(i); }
  const js = [...byJ.keys()].sort((a, b) => a - b);
  const j0 = js[0], j1 = js[js.length - 1];
  const raw = new Float32Array(j1 - j0 + 1);
  let last = 0;
  for (let j = j0; j <= j1; j++) {
    const is = byJ.get(j);
    raw[j - j0] = is ? is.reduce((a, b) => a + b, 0) / is.length : last;
    last = raw[j - j0];
  }
  const sm = raw.map((_, k) => {
    let s = 0, c = 0;
    for (let q = Math.max(0, k - 4); q <= Math.min(raw.length - 1, k + 4); q++) { s += raw[q]; c++; }
    return s / c;
  });
  for (let k = 1; k < sm.length; k++) if (sm[k] < sm[k - 1]) sm[k] = sm[k - 1];
  const transpose = best.rot > 6 ? best.rot - 12 : best.rot;
  // plain data, so it can be posted out of a worker
  return { curve: sm, midiStart: j0 * FRAME, midiEnd: j1 * FRAME, transpose, cost: best.cost };
}

// MIDI seconds -> recording seconds (null outside the stretch that matched).
export function mapTime(align, t) {
  const { curve, midiStart, midiEnd } = align;
  if (t < midiStart - FRAME || t > midiEnd + FRAME) return null;
  const x = Math.min(Math.max((t - midiStart) / FRAME, 0), curve.length - 1);
  const k = Math.floor(x), fr = x - k;
  const v = k + 1 < curve.length ? curve[k] * (1 - fr) + curve[k + 1] * fr : curve[k];
  return v * FRAME;
}

// Move a track's notes onto the recording's timeline.
export function warpNotes(notes, align) {
  const out = [];
  for (const n of notes) {
    const s = mapTime(align, n.time);
    if (s === null) continue;
    const e = mapTime(align, Math.min(n.time + n.duration, align.midiEnd)) ?? s + n.duration;
    out.push({ ...n, midi: n.midi + align.transpose, time: s, duration: Math.max(0.05, e - s) });
  }
  return out;
}
