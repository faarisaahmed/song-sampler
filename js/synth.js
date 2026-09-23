// Instrument playback for the non-cat tracks.
// Melodic instruments use the FluidR3 General MIDI soundfont from
// gleitz/midi-js-soundfonts (one sample per key, so no repitching needed).
// That set has no drum kit, so drums are synthesized here.

import { GM_SLUGS } from './gm.js';

const SF_BASE = 'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/';
const PC = { C: 0, Db: 1, D: 2, Eb: 3, E: 4, F: 5, Gb: 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };

const fonts = new Map(); // program -> Promise<Map(midi -> base64)>
const buffers = new Map(); // `${program}:${midi}` -> AudioBuffer
let drumKit = null;

async function fetchText(url) {
  const cache = 'caches' in self ? await caches.open('oiia-soundfonts-v1') : null;
  const hit = cache && (await cache.match(url));
  if (hit) return hit.text();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load instrument (HTTP ${res.status})`);
  const text = await res.text();
  if (cache) cache.put(url, new Response(text)).catch(() => {});
  return text;
}

function loadFont(program) {
  if (!fonts.has(program)) {
    fonts.set(program, fetchText(`${SF_BASE}${GM_SLUGS[program]}-mp3.js`).then((text) => {
      const map = new Map();
      for (const m of text.matchAll(/"([A-G]b?)(-?\d)":\s*"data:audio\/mp3;base64,([^"]+)"/g)) {
        map.set(12 * (Number(m[2]) + 1) + PC[m[1]], m[3]);
      }
      return map;
    }).catch((err) => { fonts.delete(program); throw err; }));
  }
  return fonts.get(program);
}

const b64ToBuf = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
};

// Which sample plays a note: the exact key if there is one, else the nearest (repitched).
function nearestKey(map, midi) {
  if (map.has(midi)) return midi;
  let best = null;
  for (const k of map.keys()) if (best === null || Math.abs(k - midi) < Math.abs(best - midi)) best = k;
  return best;
}

/**
 * Download + decode everything the given tracks need.
 * tracks: [{ program, isDrums, notes }]
 */
export async function prepareInstruments(ctx, tracks, onProgress = () => {}) {
  const melodic = tracks.filter((t) => !t.isDrums);
  if (tracks.some((t) => t.isDrums) && !drumKit) drumKit = makeDrumKit(ctx.sampleRate);
  const programs = [...new Set(melodic.map((t) => t.program))];
  let done = 0;
  await Promise.all(programs.map(async (program) => {
    const map = await loadFont(program);
    const keys = new Set();
    for (const t of melodic) if (t.program === program) for (const n of t.notes) keys.add(nearestKey(map, n.midi));
    await Promise.all([...keys].map(async (k) => {
      const id = `${program}:${k}`;
      if (!buffers.has(id)) buffers.set(id, await ctx.decodeAudioData(b64ToBuf(map.get(k))));
    }));
    onProgress(++done / programs.length);
  }));
}

// Release time per instrument family (seconds): plucked/struck sounds ring, others stop quicker.
function releaseFor(program) {
  if (program < 8 || (program >= 24 && program < 32) || program === 46 || program === 45) return 0.3;
  if (program >= 88 && program < 96) return 0.6;
  return 0.12;
}

function scheduleNote(ac, dest, track, n, when, fonts) {
  if (track.isDrums) {
    const buf = drumKit?.get(drumVoice(n.midi));
    if (!buf) return null;
    const src = ac.createBufferSource();
    src.buffer = buf;
    const g = ac.createGain();
    g.gain.value = 0.25 + 0.75 * n.velocity;
    src.connect(g).connect(dest);
    src.start(when);
    return src;
  }
  const map = fonts.get(track.program);
  if (!map) return null;
  const key = nearestKey(map, n.midi);
  const buf = buffers.get(`${track.program}:${key}`);
  if (!buf) return null;
  const src = ac.createBufferSource();
  src.buffer = buf;
  if (key !== n.midi) src.playbackRate.value = Math.pow(2, (n.midi - key) / 12);
  const g = ac.createGain();
  const v = 0.2 + 0.8 * n.velocity * n.velocity;
  const end = when + n.duration;
  const rel = releaseFor(track.program);
  g.gain.setValueAtTime(v, when);
  g.gain.setValueAtTime(v, end);
  g.gain.setTargetAtTime(0, end, rel / 3);
  src.connect(g).connect(dest);
  src.start(when);
  src.stop(end + rel * 2);
  return src;
}

/**
 * Plays instrument tracks on a context. For a live AudioContext notes are
 * scheduled a little ahead of time (so seeking and stopping are instant); on
 * an OfflineAudioContext everything is scheduled up front.
 * tracks: [{ program, isDrums, notes, dest }] (dest = that track's GainNode)
 */
export async function startInstruments(ac, tracks, offset, when) {
  const loaded = new Map();
  for (const t of tracks) if (!t.isDrums && !loaded.has(t.program)) loaded.set(t.program, await loadFont(t.program));
  const active = new Set();
  const cursors = tracks.map((t) => { let i = 0; while (i < t.notes.length && t.notes[i].time < offset) i++; return i; });
  const pump = (horizon) => {
    tracks.forEach((t, k) => {
      const notes = t.notes;
      let i = cursors[k];
      while (i < notes.length && notes[i].time - offset < horizon) {
        const src = scheduleNote(ac, t.dest, t, notes[i], when + notes[i].time - offset, loaded);
        if (src) { active.add(src); src.onended = () => active.delete(src); }
        i++;
      }
      cursors[k] = i;
    });
  };
  if (ac instanceof OfflineAudioContext) {
    // Chrome processes every scheduled node on every audio block, even ones that
    // haven't started yet, so scheduling a whole song up front is very slow.
    // Pause the render every 2 s and only schedule the next few seconds.
    const end = Math.max(0, ...tracks.map((t) => (t.notes.length ? t.notes[t.notes.length - 1].time : 0))) - offset;
    pump(4);
    const renderEnd = ac.length / ac.sampleRate;
    for (let t = 2; t < end + 2 && when + t < renderEnd - 0.01; t += 2) {
      ac.suspend(when + t).then(() => { pump(t + 4); ac.resume(); });
    }
    return { stop() {} };
  }
  pump(ac.currentTime - when + 1);
  const timer = setInterval(() => pump(ac.currentTime - when + 1), 200);
  return {
    stop() {
      clearInterval(timer);
      for (const src of active) { try { src.stop(); } catch {} }
      active.clear();
    },
  };
}

// ---------- synthesized drum kit ----------

const DRUM_MAP = {
  35: 'kick', 36: 'kick', 37: 'rim', 38: 'snare', 40: 'snare', 39: 'clap',
  42: 'hat', 44: 'hat', 46: 'openhat', 41: 'tomL', 43: 'tomL', 45: 'tomM', 47: 'tomM', 48: 'tomH', 50: 'tomH',
  49: 'crash', 52: 'crash', 55: 'crash', 57: 'crash', 51: 'ride', 53: 'ride', 59: 'ride',
  54: 'shaker', 69: 'shaker', 70: 'shaker', 82: 'shaker', 56: 'cowbell',
};
const drumVoice = (m) => DRUM_MAP[m] || 'shaker';

function makeDrumKit(sr) {
  const kit = new Map();
  const make = (sec, fn) => { const n = Math.round(sec * sr), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = fn(i / sr, i); return x; };
  let seed = 1;
  const noise = () => { seed = (seed * 16807) % 2147483647; return seed / 1073741823.5 - 1; };
  const hp = (x, a = 0.85) => { let py = 0, px = 0; for (let i = 0; i < x.length; i++) { const y = a * (py + x[i] - px); px = x[i]; x[i] = py = y; } return x; };
  const tom = (f) => { let ph = 0; return make(0.45, (t) => { ph += (2 * Math.PI * f * (1 + 0.6 * Math.exp(-t * 20))) / sr; return Math.sin(ph) * Math.exp(-t * 7) * 0.8; }); };
  let ph = 0;
  kit.set('kick', make(0.45, (t) => { ph += (2 * Math.PI * (45 + 110 * Math.exp(-t * 30))) / sr; return Math.sin(ph) * Math.exp(-t * 8) * 1.0; }));
  let ph2 = 0;
  kit.set('snare', make(0.25, (t) => { ph2 += (2 * Math.PI * 185) / sr; return (noise() * 0.6 * Math.exp(-t * 18) + Math.sin(ph2) * 0.4 * Math.exp(-t * 30)); }));
  hp(kit.get('snare'), 0.7);
  kit.set('clap', hp(make(0.25, (t) => noise() * Math.exp(-((t % 0.012) * 250)) * Math.exp(-t * 14) * 0.7), 0.6));
  kit.set('rim', hp(make(0.05, (t) => noise() * Math.exp(-t * 120) * 0.6), 0.5));
  kit.set('hat', hp(make(0.08, (t) => noise() * Math.exp(-t * 60) * 0.35), 0.95));
  kit.set('openhat', hp(make(0.35, (t) => noise() * Math.exp(-t * 9) * 0.3), 0.95));
  kit.set('shaker', hp(make(0.06, (t) => noise() * Math.exp(-t * 70) * 0.2), 0.95));
  const metal = (t) => [3.1, 4.7, 5.9, 7.3, 8.9].reduce((a, f) => a + Math.sign(Math.sin(2 * Math.PI * f * 173 * t)), 0) / 5;
  kit.set('crash', hp(make(1.6, (t) => (noise() * 0.7 + metal(t) * 0.3) * Math.exp(-t * 2.5) * 0.35), 0.9));
  kit.set('ride', hp(make(0.9, (t) => (noise() * 0.3 + metal(t) * 0.7) * Math.exp(-t * 4) * 0.25), 0.9));
  kit.set('cowbell', make(0.3, (t) => (Math.sign(Math.sin(2 * Math.PI * 562 * t)) + Math.sign(Math.sin(2 * Math.PI * 845 * t))) * 0.15 * Math.exp(-t * 12)));
  kit.set('tomL', tom(90)); kit.set('tomM', tom(130)); kit.set('tomH', tom(180));
  const out = new Map();
  for (const [k, x] of kit) {
    const b = new AudioBuffer({ length: x.length, sampleRate: sr, numberOfChannels: 1 });
    b.copyToChannel(x, 0);
    out.set(k, b);
  }
  return out;
}
