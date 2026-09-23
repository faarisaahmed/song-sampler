import { parseMidi } from './midi.js';
import { analyzeVoice, renderNote, midiToFreq, naturalLength } from './psola.js';
import { assignSyllables, topLine } from './syllables.js';
import { demoSong } from './demo.js';

const $ = (id) => document.getElementById(id);
const COLORS = { o: '#6cc6ff', i: '#ff7ab8', a: '#ffd35c' };
const SAMPLE_NAMES = ['o', 'i', 'i2', 'a'];

const ctx = new (window.AudioContext || window.webkitAudioContext)();
const SR = ctx.sampleRate;
let voices = null; // { o, i, i2, a } -> analyzed voice
const voicesReady = loadVoices();

let song = null; // { tracks, duration, secPerBeatAt, bpm, name }
let enabled = []; // per-track bool
let sung = []; // notes with syllables (all enabled tracks)
let lyricWords = []; // [{ time, end, el }]
let mix = null; // AudioBuffer
let dirty = true;
let source = null, startedAt = 0, startOffset = 0, raf = 0;

async function loadVoices() {
  const out = {};
  await Promise.all(SAMPLE_NAMES.map(async (name) => {
    const res = await fetch(`samples/${name}.wav`);
    const buf = await ctx.decodeAudioData(await res.arrayBuffer());
    out[name] = analyzeVoice(buf.getChannelData(0), buf.sampleRate);
  }));
  voices = out;
  if (song) invalidate(); // natural lengths are known now
}

// ---------- loading songs ----------

$('file').addEventListener('change', (e) => e.target.files[0] && loadFile(e.target.files[0]));
const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault(); drop.classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f);
});
document.querySelectorAll('[data-song]').forEach((btn) => btn.addEventListener('click', async () => {
  const src = btn.dataset.song;
  if (src === 'demo') return setSong(demoSong());
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    loadMidi(await res.arrayBuffer(), btn.textContent);
  } catch (err) {
    $('songInfo').textContent = `Couldn't load ${btn.textContent}: ${err.message}`;
  }
}));

async function loadFile(file) {
  loadMidi(await file.arrayBuffer(), file.name);
}

function loadMidi(buf, name) {
  try {
    const m = parseMidi(buf);
    if (!m.tracks.length) throw new Error('No notes found in this file');
    m.name = name;
    setSong(m);
  } catch (err) {
    $('songInfo').textContent = `Couldn't read that file: ${err.message}`;
  }
}

const GM_FAMILIES = ['Piano', 'Chromatic perc.', 'Organ', 'Guitar', 'Bass', 'Strings', 'Ensemble', 'Brass',
  'Reed', 'Pipe', 'Synth lead', 'Synth pad', 'Synth FX', 'Ethnic', 'Percussive', 'Sound FX'];
const noteName = (m) => ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][m % 12] + (Math.floor(m / 12) - 1);

function setSong(s) {
  stop();
  startOffset = 0;
  song = s;
  enabled = s.tracks.map((t) => !t.isDrums);
  if (!enabled.some(Boolean)) enabled[0] = true;
  $('songInfo').textContent = `${s.name} · ${fmt(s.duration)} · ${s.tracks.length} track${s.tracks.length > 1 ? 's' : ''} · ${Math.round(s.bpm)} bpm`;
  renderTrackList();
  $('tracksCard').classList.remove('hidden');
  $('playCard').classList.remove('hidden');
  invalidate();
}

function renderTrackList() {
  const box = $('tracks');
  box.innerHTML = '';
  song.tracks.forEach((t, i) => {
    const lo = Math.min(...t.notes.map((n) => n.midi)), hi = Math.max(...t.notes.map((n) => n.midi));
    const row = document.createElement('label');
    row.className = 'track';
    row.innerHTML = `
      <input type="checkbox" ${enabled[i] ? 'checked' : ''} />
      <span class="name"></span>
      <span class="meta">${t.isDrums ? 'Drums' : GM_FAMILIES[t.program >> 3]} · ${t.notes.length} notes · ${noteName(lo)}–${noteName(hi)}</span>
      <button type="button" title="Hear only this track">solo</button>`;
    row.querySelector('.name').textContent = t.name;
    row.querySelector('input').addEventListener('change', (e) => { enabled[i] = e.target.checked; invalidate(); });
    row.querySelector('button').addEventListener('click', (e) => {
      e.preventDefault();
      enabled = enabled.map((_, j) => j === i);
      box.querySelectorAll('input').forEach((cb, j) => (cb.checked = enabled[j]));
      invalidate();
    });
    box.appendChild(row);
  });
}

['gap', 'chords', 'vibrato', 'range'].forEach((id) => $(id).addEventListener('input', () => {
  $('gapVal').textContent = $('gap').value;
  if (song) invalidate();
}));
document.querySelectorAll('input[name="length"]').forEach((r) => r.addEventListener('change', () => song && invalidate()));
const lengthMode = () => document.querySelector('input[name="length"]:checked').value;

// ---------- syllables + preview ----------

function invalidate() {
  stop();
  dirty = true;
  mix = null;
  $('wavBtn').disabled = true;
  computeSyllables();
  drawRoll();
  renderLyrics();
  $('playBtn').disabled = !sung.length;
  $('time').textContent = `0:00 / ${fmt(song.duration)}`;
}

function computeSyllables() {
  sung = [];
  const opts = { phraseGapBeats: parseFloat($('gap').value) };
  song.tracks.forEach((t, ti) => {
    if (!enabled[ti]) return;
    const notes = $('chords').value === 'top' ? topLine(t.notes) : t.notes;
    const r = assignSyllables(notes, song.secPerBeatAt, opts);
    for (const n of r.notes) sung.push({ ...n, track: ti });
  });
  sung.sort((a, b) => a.time - b.time);

  // octave range: fold every note into a window of N octaves
  const oct = parseInt($('range').value, 10);
  $('rangeVal').textContent = '';
  if (oct && sung.length) {
    const lo = pickWindow(sung, oct), hi = lo + 12 * oct;
    for (const n of sung) {
      while (n.midi < lo) n.midi += 12;
      while (n.midi >= hi) n.midi -= 12;
    }
    // folding can land two notes of a chord on the same pitch; keep one
    const seen = new Map();
    sung = sung.filter((n) => {
      const key = `${n.track}|${n.midi}|${Math.round(n.time * 50)}`;
      const prev = seen.get(key);
      if (prev) { prev.duration = Math.max(prev.duration, n.duration); prev.velocity = Math.max(prev.velocity, n.velocity); return false; }
      seen.set(key, n);
      return true;
    });
    $('rangeVal').textContent = `→ ${noteName(lo)}–${noteName(hi - 1)}`;
  }

  // Held = sing for the whole MIDI note; Normal = the cat's natural syllable length
  const normal = lengthMode() === 'normal';
  for (const n of sung) {
    n.singDur = normal ? Math.min(n.duration, natLen(n.sample)) : n.duration;
  }
}

const FALLBACK_LEN = { o: 0.13, i: 0.075, i2: 0.075, a: 0.18 };
const natLen = (sample) => (voices ? naturalLength(voices[sample]) : FALLBACK_LEN[sample]);

// Place the window where it already holds the most notes (so the melody
// mostly keeps its pitch) but never lower than C3, so deep notes move up.
// Ties go to the window closest to the cat's own voice (around E4).
function pickWindow(notes, oct) {
  let best = 48, bestScore = -Infinity;
  for (let lo = 48; lo <= 72; lo++) {
    let inside = 0;
    for (const n of notes) if (n.midi >= lo && n.midi < lo + 12 * oct) inside++;
    const score = inside - 0.001 * Math.abs(lo + 6 * oct - 64);
    if (score > bestScore) { bestScore = score; best = lo; }
  }
  return best;
}

function renderLyrics() {
  const box = $('lyrics');
  box.innerHTML = '';
  lyricWords = [];
  // lyrics for the first enabled track (the one most likely to be the melody)
  const ti = enabled.indexOf(true);
  if (ti < 0) return;
  const words = new Map();
  for (const n of sung) {
    if (n.track !== ti) continue;
    const key = `${n.passage}:${n.word}`;
    if (!words.has(key)) words.set(key, { passage: n.passage, events: new Map() });
    const w = words.get(key);
    if (!w.events.has(n.event)) w.events.set(n.event, { syl: n.syl, time: n.time, end: n.time + n.duration });
    const ev = w.events.get(n.event);
    ev.end = Math.max(ev.end, n.time + n.duration);
  }
  let lastPassage = -1;
  const frag = document.createDocumentFragment();
  for (const w of [...words.values()].slice(0, 3000)) {
    if (lastPassage >= 0 && w.passage !== lastPassage) {
      const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '/'; frag.appendChild(sep);
    }
    lastPassage = w.passage;
    const evs = [...w.events.values()];
    const el = document.createElement('span');
    el.className = 'w';
    el.textContent = evs.map((e) => e.syl).join('');
    frag.appendChild(el);
    frag.appendChild(document.createTextNode(' '));
    lyricWords.push({ time: evs[0].time, end: Math.max(...evs.map((e) => e.end)), el });
  }
  box.appendChild(frag);
}

// ---------- piano roll ----------

let pxPerSec = 90;
let rollCache = null; // offscreen canvas with the notes drawn once
function drawRoll(playhead = null) {
  const cv = $('roll');
  const g = cv.getContext('2d');
  if (playhead === null || !rollCache) {
    // browsers cap canvas size, so squeeze long songs
    pxPerSec = Math.min(90, 30000 / Math.max(1, song?.duration ?? 1));
    const w = Math.max($('rollWrap').clientWidth, Math.ceil((song?.duration ?? 0) * pxPerSec) + 40);
    rollCache = document.createElement('canvas');
    rollCache.width = w; rollCache.height = cv.height;
    paintNotes(rollCache);
    if (cv.width !== w) cv.width = w;
  }
  g.clearRect(0, 0, cv.width, cv.height);
  g.drawImage(rollCache, 0, 0);
  if (playhead !== null) {
    g.fillStyle = '#fff';
    g.fillRect(playhead * pxPerSec, 0, 2, cv.height);
  }
}

function paintNotes(cv) {
  const g = cv.getContext('2d');
  if (!sung.length) return;
  let lo = Infinity, hi = -Infinity;
  for (const n of sung) { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); }
  lo -= 2; hi += 2;
  const rowH = Math.min(14, (cv.height - 10) / (hi - lo + 1));
  const top = (cv.height - rowH * (hi - lo + 1)) / 2;
  const y = (m) => top + (hi - m) * rowH;
  g.fillStyle = '#ffffff0d';
  for (let m = lo; m <= hi; m++) if (m % 12 === 0) g.fillRect(0, y(m), cv.width, 1);
  g.font = `bold ${Math.max(8, Math.min(12, rowH))}px system-ui`;
  g.textBaseline = 'middle';
  for (const n of sung) {
    const x = n.time * pxPerSec, ww = Math.max(2, n.singDur * pxPerSec - 1);
    g.globalAlpha = 0.55 + 0.45 * n.velocity;
    g.fillStyle = COLORS[n.syl];
    g.fillRect(x, y(n.midi), ww, Math.max(2, rowH - 1));
    if (n.wordStart) { g.fillStyle = '#fff'; g.fillRect(x, y(n.midi) - 2, 1.5, rowH + 3); }
    if (ww > 10 && rowH >= 8) { g.globalAlpha = 1; g.fillStyle = '#1a1026'; g.fillText(n.syl, x + 3, y(n.midi) + rowH / 2); }
  }
  g.globalAlpha = 1;
}

$('roll').addEventListener('click', (e) => {
  if (!song) return;
  const r = e.target.getBoundingClientRect();
  const t = Math.max(0, (e.clientX - r.left) / pxPerSec);
  play(Math.min(t, song.duration));
});

// ---------- rendering ----------

async function renderMix() {
  await voicesReady;
  const vib = $('vibrato').checked;
  const total = Math.ceil((song.duration + 0.5) * SR);
  const out = new Float32Array(total);
  const cache = new Map();
  $('progress').classList.remove('hidden');
  for (let k = 0; k < sung.length; k++) {
    const n = sung[k];
    const dur = Math.max(0.04, n.singDur);
    const key = `${n.sample}|${n.midi}|${Math.round(dur * 200)}`;
    let buf = cache.get(key);
    if (!buf) {
      buf = renderNote(voices[n.sample], midiToFreq(n.midi), dur, { vibrato: vib });
      cache.set(key, buf);
    }
    const off = Math.round(n.time * SR);
    const gain = 0.35 + 0.65 * n.velocity;
    const len = Math.min(buf.length, total - off);
    for (let i = 0; i < len; i++) out[off + i] += buf[i] * gain;
    if (k % 150 === 0) {
      $('progressBar').style.width = `${(100 * k) / sung.length}%`;
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(out[i]));
  const g = peak > 0 ? 0.89 / peak : 1;
  for (let i = 0; i < total; i++) out[i] *= g;
  $('progress').classList.add('hidden');
  const ab = ctx.createBuffer(1, total, SR);
  ab.copyToChannel(out, 0);
  return ab;
}

// ---------- transport ----------

$('playBtn').addEventListener('click', () => play(source ? null : startOffset));
$('stopBtn').addEventListener('click', () => { stop(); startOffset = 0; drawRoll(0); highlight(-1); });
$('wavBtn').addEventListener('click', downloadWav);

async function play(offset) {
  if (offset === null) { stop(); return; } // toggle
  await ctx.resume();
  stop();
  if (dirty || !mix) {
    $('playBtn').disabled = true;
    $('playBtn').textContent = 'Rendering…';
    mix = await renderMix();
    dirty = false;
    $('playBtn').disabled = false;
    $('wavBtn').disabled = false;
  }
  source = ctx.createBufferSource();
  source.buffer = mix;
  source.connect(ctx.destination);
  startOffset = offset;
  startedAt = ctx.currentTime;
  source.start(0, offset);
  source.onended = () => { if (source && ctx.currentTime - startedAt + startOffset >= mix.duration - 0.05) { stop(); startOffset = 0; } };
  $('playBtn').textContent = '❚❚ Pause';
  $('stopBtn').disabled = false;
  $('cat').classList.add('spin');
  tick();
}

function stop() {
  if (source) {
    const pos = ctx.currentTime - startedAt + startOffset;
    source.onended = null;
    try { source.stop(); } catch {}
    source = null;
    startOffset = Math.min(pos, song?.duration ?? 0);
  }
  cancelAnimationFrame(raf);
  $('playBtn').textContent = '▶ Play';
  $('cat').classList.remove('spin');
}

function tick() {
  if (!source) return;
  const t = ctx.currentTime - startedAt + startOffset;
  $('time').textContent = `${fmt(t)} / ${fmt(song.duration)}`;
  drawRoll(t);
  const wrap = $('rollWrap');
  const x = t * pxPerSec;
  if (x > wrap.scrollLeft + wrap.clientWidth * 0.8 || x < wrap.scrollLeft) wrap.scrollLeft = x - wrap.clientWidth * 0.2;
  highlight(t);
  raf = requestAnimationFrame(tick);
}

let lit = null;
function highlight(t) {
  let found = null;
  for (const w of lyricWords) { if (w.time <= t && t < w.end + 0.05) found = w; if (w.time > t) break; }
  if (found === lit) return;
  lit?.el.classList.remove('on');
  lit = found;
  if (lit) {
    lit.el.classList.add('on');
    const box = $('lyrics');
    const top = lit.el.offsetTop - box.offsetTop;
    if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - 24) box.scrollTop = top - 8;
  }
}

function downloadWav() {
  if (!mix) return;
  const x = mix.getChannelData(0);
  const b = new DataView(new ArrayBuffer(44 + x.length * 2));
  const w = (o, s) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); b.setUint32(4, 36 + x.length * 2, true); w(8, 'WAVEfmt ');
  b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
  b.setUint32(24, SR, true); b.setUint32(28, SR * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true);
  w(36, 'data'); b.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) b.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x[i])) * 32767, true);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
  a.download = `${(song.name || 'song').replace(/\.midi?$/i, '')}-oiia.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ---------- live keyboard ----------

const KEYMAP = 'awsedftgyhujk';
const LIVE_LOW = 60; // C4
const LIVE_CYCLE = ['o', 'i', 'i2', 'a'];
let liveStep = 0, lastPress = 0;
const liveVoices = new Map();

function buildKeys() {
  const box = $('keys');
  const whites = [0, 2, 4, 5, 7, 9, 11];
  const count = 25; // C4..C6
  const nWhite = [...Array(count)].filter((_, i) => whites.includes(i % 12)).length;
  const ww = 100 / nWhite;
  let wi = 0;
  for (let i = 0; i < count; i++) {
    const midi = LIVE_LOW + i;
    const el = document.createElement('div');
    const white = whites.includes(i % 12);
    el.className = `key ${white ? 'white' : 'black'}`;
    el.dataset.midi = midi;
    if (white) { el.style.left = `${wi * ww}%`; el.style.width = `${ww}%`; wi++; }
    else { el.style.left = `${wi * ww - ww * 0.3}%`; el.style.width = `${ww * 0.6}%`; }
    el.innerHTML = `<span class="syl"></span>${KEYMAP[i] ? KEYMAP[i].toUpperCase() : ''}`;
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.setPointerCapture(e.pointerId); liveOn(midi); });
    el.addEventListener('pointerup', () => liveOff(midi));
    el.addEventListener('pointercancel', () => liveOff(midi));
    box.appendChild(el);
  }
}

async function liveOn(midi) {
  if (liveVoices.has(midi)) return;
  await ctx.resume();
  await voicesReady;
  const now = performance.now();
  if (now - lastPress > 1000) liveStep = 0;
  lastPress = now;
  const sample = LIVE_CYCLE[liveStep % 4];
  liveStep++;
  // Held: sustain while the key is down. Normal: the syllable at its natural length.
  const held = lengthMode() === 'held';
  const data = renderNote(voices[sample], midiToFreq(midi), held ? 2.5 : natLen(sample), { vibrato: $('vibrato').checked });
  const buf = ctx.createBuffer(1, data.length, SR);
  buf.copyToChannel(data, 0);
  const src = ctx.createBufferSource();
  const gain = ctx.createGain();
  gain.gain.value = 0.8;
  src.buffer = buf;
  src.connect(gain).connect(ctx.destination);
  src.start();
  liveVoices.set(midi, { src, gain, held });
  const el = document.querySelector(`.key[data-midi="${midi}"]`);
  el?.classList.add('down');
  if (el) el.querySelector('.syl').textContent = sample[0];
}

function liveOff(midi) {
  const v = liveVoices.get(midi);
  if (!v) return;
  liveVoices.delete(midi);
  if (v.held) {
    const t = ctx.currentTime;
    v.gain.gain.setValueAtTime(v.gain.gain.value, t);
    v.gain.gain.linearRampToValueAtTime(0, t + 0.06);
    v.src.stop(t + 0.07);
  }
  const el = document.querySelector(`.key[data-midi="${midi}"]`);
  el?.classList.remove('down');
  if (el) el.querySelector('.syl').textContent = '';
}

window.addEventListener('keydown', (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.target.matches('input, select, button')) return;
  const i = KEYMAP.indexOf(e.key.toLowerCase());
  if (i >= 0) liveOn(LIVE_LOW + i);
  if (e.code === 'Space' && song) { e.preventDefault(); $('playBtn').click(); }
});
window.addEventListener('keyup', (e) => {
  const i = KEYMAP.indexOf(e.key.toLowerCase());
  if (i >= 0) liveOff(LIVE_LOW + i);
});

buildKeys();
