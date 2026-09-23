// Monophonic melody transcription for a separated vocal track.
//
// 1. Downsample to ~11 kHz (plenty for sung pitch, and 16x less work).
// 2. YIN pitch per 10 ms frame, plus loudness. A frame counts as sung if
//    it's periodic enough and loud enough compared with the rest of the stem
//    (separation leaves some quiet bleed that shouldn't turn into notes).
// 3. Median-smooth the pitch curve and fix one-frame octave jumps.
// 4. Cut the curve into notes: a new note starts after silence, when the
//    pitch moves more than ~0.8 semitone away from the current note, or when
//    the loudness dips and comes back (a new syllable on the same pitch).
// 5. Drop blips shorter than 70 ms and round each note to the nearest semitone.
// 6. Move notes that landed an octave away from their neighbors back in line.

const HOP_SEC = 0.01;

function downsample(x, sr, factor) {
  // windowed-sinc lowpass at 0.45 of the new Nyquist, then decimate
  const taps = 63, fc = 0.45 / factor, h = new Float32Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const m = i - (taps - 1) / 2;
    const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
    h[i] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1)));
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  const out = new Float32Array(Math.floor(x.length / factor));
  const half = (taps - 1) / 2;
  for (let o = 0; o < out.length; o++) {
    const c = o * factor;
    let acc = 0;
    for (let i = 0; i < taps; i++) { const k = c + i - half; if (k >= 0 && k < x.length) acc += x[k] * h[i]; }
    out[o] = acc;
  }
  return { x: out, sr: sr / factor };
}

function yinTrack(x, sr, fmin = 70, fmax = 1100) {
  const tauMax = Math.ceil(sr / fmin), tauMin = Math.floor(sr / fmax);
  const W = Math.max(tauMax, Math.round(sr * 0.025));
  const hop = Math.round(sr * HOP_SEC);
  const frames = [];
  const d = new Float32Array(tauMax + 2), dn = new Float32Array(tauMax + 2);
  for (let s = 0; s + W + tauMax < x.length; s += hop) {
    let e = 0;
    for (let j = 0; j < W; j++) e += x[s + j] * x[s + j];
    const rms = Math.sqrt(e / W);
    let f0 = 0, ap = 1;
    if (rms > 1e-4) {
      for (let tau = 1; tau <= tauMax; tau++) {
        let acc = 0;
        for (let j = 0; j < W; j++) { const v = x[s + j] - x[s + j + tau]; acc += v * v; }
        d[tau] = acc;
      }
      let run = 0; dn[0] = 1;
      for (let tau = 1; tau <= tauMax; tau++) { run += d[tau]; dn[tau] = run > 0 ? (d[tau] * tau) / run : 1; }
      let best = -1;
      for (let tau = tauMin; tau < tauMax; tau++) {
        if (dn[tau] < 0.15) { while (tau + 1 < tauMax && dn[tau + 1] < dn[tau]) tau++; best = tau; break; }
      }
      if (best < 0) { let m = Infinity; for (let tau = tauMin; tau < tauMax; tau++) if (dn[tau] < m) { m = dn[tau]; best = tau; } }
      const a = dn[best - 1] ?? dn[best], b = dn[best], c = dn[best + 1] ?? dn[best];
      const den = a - 2 * b + c;
      const tau = best + (den ? (0.5 * (a - c)) / den : 0);
      f0 = sr / tau; ap = b;
    }
    frames.push({ t: (s + W / 2) / sr, rms, f0, ap });
  }
  return frames;
}

const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[s.length >> 1]; };

export function transcribeMelody(mono, sr, opts = {}) {
  const factor = Math.max(1, Math.round(sr / 11025));
  const ds = downsample(mono, sr, factor);
  const frames = yinTrack(ds.x, ds.sr);
  if (!frames.length) return [];

  // loudness gate relative to the loud parts of the stem
  const loud = median(frames.map((f) => f.rms).filter((r) => r > 1e-4).sort((a, b) => b - a).slice(0, Math.max(1, frames.length >> 3)));
  const gate = (opts.sensitivity ?? 0.12) * loud;
  const midi = frames.map((f) => (f.rms > gate && f.ap < 0.3 && f.f0 > 0 ? 69 + 12 * Math.log2(f.f0 / 440) : NaN));

  // smooth: median of 5 over voiced neighbors, and pull octave errors back
  const sm = midi.map((m, i) => {
    if (Number.isNaN(m)) return NaN;
    const w = midi.slice(Math.max(0, i - 2), i + 3).filter((v) => !Number.isNaN(v));
    return median(w);
  });
  for (let i = 1; i < sm.length - 1; i++) {
    const a = sm[i - 1], b = sm[i], c = sm[i + 1];
    if (!Number.isNaN(a) && !Number.isNaN(b) && !Number.isNaN(c) && Math.abs(a - c) < 1) {
      if (Math.abs(b - 12 - a) < 1) sm[i] -= 12; else if (Math.abs(b + 12 - a) < 1) sm[i] += 12;
    }
  }

  // segment into notes
  const notes = [];
  let cur = null;
  const close = () => {
    if (cur && cur.frames.length * HOP_SEC >= 0.07) {
      const p = median(cur.frames.map((i) => sm[i]));
      const r = cur.frames.map((i) => frames[i].rms);
      notes.push({
        midi: Math.round(p),
        time: frames[cur.frames[0]].t - HOP_SEC / 2,
        duration: cur.frames.length * HOP_SEC,
        velocity: Math.min(1, 0.5 + 0.5 * (median(r) / loud)),
        channel: 0,
      });
    }
    cur = null;
  };
  for (let i = 0; i < sm.length; i++) {
    const m = sm[i];
    if (Number.isNaN(m)) { close(); continue; }
    if (cur) {
      const recent = cur.frames.slice(-8).map((k) => sm[k]);
      const center = median(recent);
      const rmsNow = frames[i].rms;
      const minRecent = Math.min(...cur.frames.slice(-4).map((k) => frames[k].rms));
      const peak = Math.max(...cur.frames.map((k) => frames[k].rms));
      const pitchMove = Math.abs(m - center) > 0.8 && cur.frames.length >= 3;
      const reattack = minRecent < 0.45 * peak && rmsNow > 1.6 * minRecent && cur.frames.length >= 6;
      if (pitchMove || reattack) close();
    }
    if (!cur) cur = { frames: [] };
    cur.frames.push(i);
  }
  close();

  // octave errors: pull notes that sit far from their neighbors back by octaves
  const fixed = notes.map((n, i) => {
    const nb = notes.slice(Math.max(0, i - 4), i + 5).filter((_, j) => j !== Math.min(i, 4)).map((x) => x.midi);
    if (!nb.length) return n;
    const med = median(nb);
    let m = n.midi;
    while (m - med > 7) m -= 12;
    while (med - m > 7) m += 12;
    return { ...n, midi: m };
  });
  return fixed;
}
