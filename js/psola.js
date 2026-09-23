// TD-PSOLA (time-domain pitch-synchronous overlap-add) voice.
//
// Resampling a sample to change its pitch also changes its speed and moves its
// formants: low notes get slow and muddy, high notes get short and squeaky.
// PSOLA avoids that. The cat sample is cut into one grain per glottal pulse
// (two periods long, centered on each pulse), and the grains are laid back
// down spaced at the *target* period. Grain spacing sets the pitch, the
// grain contents keep the vowel color, and which grain gets used when sets
// the duration, so all three can be controlled separately.

// ---------- analysis ----------

function estimatePeriods(x, sr, fmin = 120, fmax = 900) {
  const tauMax = Math.ceil(sr / fmin), tauMin = Math.floor(sr / fmax);
  const W = tauMax;
  const hop = Math.round(sr * 0.0025);
  const frames = [];
  const d = new Float32Array(tauMax + 1);
  for (let start = 0; start + W + tauMax < x.length; start += hop) {
    let energy = 0;
    for (let j = 0; j < W; j++) energy += x[start + j] * x[start + j];
    let period = 0;
    if (energy / W > 1e-5) {
      // YIN cumulative mean normalized difference
      for (let tau = 1; tau <= tauMax; tau++) {
        let s = 0;
        for (let j = 0; j < W; j++) { const v = x[start + j] - x[start + j + tau]; s += v * v; }
        d[tau] = s;
      }
      let run = 0, best = -1;
      const dn = new Float32Array(tauMax + 1); dn[0] = 1;
      for (let tau = 1; tau <= tauMax; tau++) { run += d[tau]; dn[tau] = run > 0 ? (d[tau] * tau) / run : 1; }
      for (let tau = tauMin; tau < tauMax; tau++) {
        if (dn[tau] < 0.25) { while (tau + 1 < tauMax && dn[tau + 1] < dn[tau]) tau++; best = tau; break; }
      }
      if (best < 0) {
        let m = Infinity;
        for (let tau = tauMin; tau < tauMax; tau++) if (dn[tau] < m) { m = dn[tau]; best = tau; }
        if (m > 0.45) best = -1;
      }
      if (best > 0) {
        // parabolic interpolation
        const a = dn[best - 1], b = dn[best], c = dn[best + 1] ?? b;
        const den = a - 2 * b + c;
        period = best + (den ? (0.5 * (a - c)) / den : 0);
      }
    }
    frames.push({ center: start + W / 2, period });
  }
  const voiced = frames.filter((f) => f.period > 0).map((f) => f.period).sort((a, b) => a - b);
  const median = voiced.length ? voiced[voiced.length >> 1] : sr / 300;
  // fill unvoiced frames, clamp octave jumps, then median smooth
  for (const f of frames) if (!f.period || f.period > median * 1.6 || f.period < median / 1.6) f.period = 0;
  let last = median;
  for (const f of frames) { if (f.period) last = f.period; else f.period = last; }
  const sm = frames.map((f, i) => {
    const w = frames.slice(Math.max(0, i - 2), i + 3).map((g) => g.period).sort((a, b) => a - b);
    return w[w.length >> 1];
  });
  frames.forEach((f, i) => (f.period = sm[i]));
  return { frames, median };
}

function biquadLowpass(x, sr, fc) {
  const w0 = (2 * Math.PI * fc) / sr, Q = 0.707;
  const alpha = Math.sin(w0) / (2 * Q), cs = Math.cos(w0);
  const a0 = 1 + alpha;
  const b0 = (1 - cs) / 2 / a0, b1 = (1 - cs) / a0, b2 = b0, a1 = (-2 * cs) / a0, a2 = (1 - alpha) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

// zero-phase lowpass (forward + backward) so peaks don't shift in time
function filtfilt(x, sr, fc) {
  const y = biquadLowpass(x, sr, fc).reverse();
  return biquadLowpass(y, sr, fc).reverse();
}

export function analyzeVoice(data, sr) {
  const x = data instanceof Float32Array ? data : Float32Array.from(data);
  const { frames, median } = estimatePeriods(x, sr);
  const periodAt = (pos) => {
    if (!frames.length) return median;
    if (pos <= frames[0].center) return frames[0].period;
    for (let i = 1; i < frames.length; i++) {
      if (frames[i].center >= pos) {
        const a = frames[i - 1], b = frames[i];
        const t = (pos - a.center) / (b.center - a.center);
        return a.period + t * (b.period - a.period);
      }
    }
    return frames[frames.length - 1].period;
  };

  // Pitch marks: follow the fundamental's peaks, one per period.
  const lp = filtfilt(x, sr, Math.min(1.5 * (sr / median), 900));
  // anchor on the strongest peak (take polarity from it)
  let anchor = 0, amax = 0;
  for (let i = 0; i < lp.length; i++) if (Math.abs(lp[i]) > amax) { amax = Math.abs(lp[i]); anchor = i; }
  const pol = lp[anchor] >= 0 ? 1 : -1;
  // Next mark = the spot around the estimate whose waveform best matches the
  // current mark's (normalized cross-correlation), so marks stay on the same
  // phase of the cycle instead of hopping between formant ripples.
  const pick = (m, est, P) => {
    const R = Math.round(0.2 * P), H = Math.round(P / 2);
    let bi = Math.round(est), bv = -Infinity;
    for (let k = Math.round(est) - R; k <= Math.round(est) + R; k++) {
      let xy = 0, yy = 0;
      for (let j = -H; j <= H; j++) {
        const a = x[m + j] ?? 0, b = x[k + j] ?? 0;
        xy += a * b; yy += b * b;
      }
      const v = xy / Math.sqrt(yy + 1e-9) + 0.02 * pol * lp[k] / (amax || 1);
      if (v > bv) { bv = v; bi = k; }
    }
    return bi;
  };
  let marks = [anchor];
  for (let m = anchor; ;) {
    const P = periodAt(m), est = m + P;
    if (est + P * 0.5 >= x.length) break;
    const k = pick(m, est, P);
    if (k <= m) break;
    marks.push((m = k));
  }
  for (let m = anchor; ;) {
    const P = periodAt(m), est = m - P;
    if (est - P * 0.5 < 0) break;
    const k = pick(m, est, P);
    if (k >= m) break;
    marks.unshift((m = k));
  }
  // drop marks in the near-silent fade-in / fade-out
  const localRms = (c) => {
    const H = Math.round(periodAt(c) / 2); let s = 0, n = 0;
    for (let j = -H; j <= H; j++) { const v = x[c + j] ?? 0; s += v * v; n++; }
    return Math.sqrt(s / n);
  };
  const rmsList = marks.map(localRms);
  const rmsMax = Math.max(...rmsList);
  const keep = marks.filter((_, i) => rmsList[i] >= 0.1 * rmsMax);
  if (keep.length >= 4) marks = keep;
  // fill in skipped cycles (octave errors) by splitting oversized gaps
  const filled = [marks[0]];
  for (let i = 1; i < marks.length; i++) {
    const gap = marks[i] - marks[i - 1];
    const parts = Math.round(gap / median);
    for (let k = 1; k < parts; k++) filled.push(Math.round(marks[i - 1] + (gap * k) / parts));
    filled.push(marks[i]);
  }
  marks = filled;
  const periods = marks.map((m, i) => {
    if (marks.length < 2) return median;
    if (i === 0) return marks[1] - marks[0];
    if (i === marks.length - 1) return marks[i] - marks[i - 1];
    return (marks[i + 1] - marks[i - 1]) / 2;
  });
  return { data: x, sr, marks: Int32Array.from(marks), periods: Float32Array.from(periods), f0: sr / median };
}

// ---------- synthesis ----------

function nearestMark(marks, pos) {
  let lo = 0, hi = marks.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (marks[mid] <= pos) lo = mid; else hi = mid; }
  return pos - marks[lo] <= marks[hi] - pos ? lo : hi;
}

/**
 * Render one sung note.
 * @param voice  result of analyzeVoice
 * @param freq   target fundamental in Hz
 * @param dur    note length in seconds
 * @param opts   { vibrato: bool, level: target RMS }
 */
export function renderNote(voice, freq, dur, opts = {}) {
  const { data: x, sr, marks, periods } = voice;
  const vibrato = opts.vibrato ?? true;
  const level = opts.level ?? 0.18;
  const N = Math.max(8, Math.round(dur * sr));
  const out = new Float32Array(N);

  const src0 = marks[0], src1 = marks[marks.length - 1];
  const L = src1 - src0;

  // Output time -> source time.
  // Shorter than the sample: squeeze the whole syllable (pitch is unaffected).
  // Longer: play the attack and the release at normal speed and hold the
  // vowel in between, sweeping back and forth through the middle of the
  // sample so a long note doesn't freeze into a flat buzz.
  const att = Math.min(L * 0.3, 0.035 * sr);
  const rel = Math.min(L * 0.25, 0.03 * sr);
  const mid0 = src0 + att, mid1 = src1 - rel, midLen = Math.max(1, mid1 - mid0);
  const outMid = N - att - rel;
  let sweep = 1;
  if (N > L && outMid > midLen * 1.6) {
    sweep = Math.max(1, Math.round((outMid * 0.5) / midLen));
    if (sweep % 2 === 0) sweep += 1; // odd number of sweeps so we finish at mid1
  }
  const srcPos = (t) => {
    if (N <= L) return src0 + (t * L) / N;
    if (t < att) return src0 + t;
    if (t >= N - rel) return src1 - (N - t);
    const u = (t - att) / outMid; // 0..1 through the sustain
    if (sweep === 1) return mid0 + u * midLen;
    let ph = u * sweep; const k = Math.floor(ph); ph -= k;
    return k % 2 === 0 ? mid0 + ph * midLen : mid1 - ph * midLen;
  };

  const Pt = sr / freq;
  const vibRate = 5.5, vibDepth = 0.22; // Hz, semitones
  for (let t = 0; t < N + Pt; ) {
    const k = nearestMark(marks, srcPos(Math.min(t, N - 1)));
    const c = marks[k];
    const half = Math.max(2, Math.round(periods[k]));
    const ti = Math.round(t);
    const j0 = Math.max(-half, -ti, -c), j1 = Math.min(half, N - 1 - ti, x.length - 1 - c);
    for (let j = j0; j <= j1; j++) {
      out[ti + j] += x[c + j] * (0.5 + 0.5 * Math.cos((Math.PI * j) / half));
    }
    let step = Pt;
    if (vibrato) {
      const sec = t / sr;
      const depth = vibDepth * Math.min(1, Math.max(0, (sec - 0.25) / 0.35));
      if (depth > 0) step = Pt / Math.pow(2, (depth * Math.sin(2 * Math.PI * vibRate * sec)) / 12);
    }
    t += step;
  }

  // Level-match every note, so pitch doesn't change loudness
  let ss = 0;
  for (let i = 0; i < N; i++) ss += out[i] * out[i];
  const rms = Math.sqrt(ss / N) || 1;
  const g = level / rms;
  const fin = Math.min(Math.round(0.003 * sr), N >> 2);
  const fout = Math.min(Math.round(0.02 * sr), N >> 2);
  for (let i = 0; i < N; i++) {
    let e = g;
    if (i < fin) e *= i / fin;
    if (i >= N - fout) e *= (N - 1 - i) / fout;
    out[i] *= e;
  }
  return out;
}

// how long the syllable lasts when spoken at its natural speed
export const naturalLength = (voice) => (voice.marks[voice.marks.length - 1] - voice.marks[0]) / voice.sr;

export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
