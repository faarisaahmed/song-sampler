import { parseMidi } from './midi.js';
import { analyzeVoice, renderNote, midiToFreq, naturalLength } from './psola.js';
import { assignSyllables, topLine, nextWildLetter } from './syllables.js';
import { demoSong } from './demo.js';
import { searchSongs, processSong } from './songmode.js';

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
let rendered = null; // Map track index -> AudioBuffer (OIIA voice for that track)
let dirty = true;
let playing = null; // { sources, gains } while playing
let startedAt = 0, startOffset = 0, raf = 0;
// mixer: per-track volume, plus background / original vocals in song mode
let trackVol = [], bgVol = 1, origVol = 0;

// master bus with a limiter so loud mixes don't clip
const HEADROOM = 0.8; // commercial instrumentals already peak near 0 dBFS
const master = ctx.createGain();
const limiter = ctx.createDynamicsCompressor();
limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20;
limiter.attack.value = 0.003; limiter.release.value = 0.2;
master.gain.value = HEADROOM;
master.connect(limiter).connect(ctx.destination);

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
  seed = 0;
  song = s;
  enabled = s.tracks.map((t) => !t.isDrums);
  if (!enabled.some(Boolean)) enabled[0] = true;
  trackVol = s.tracks.map(() => 1);
  bgVol = 1; origVol = 0;
  $('songInfo').textContent = s.audio
    ? `${s.name} · ${fmt(s.duration)} · song mode · ${s.tracks[0].notes.length} sung notes found`
    : `${s.name} · ${fmt(s.duration)} · ${s.tracks.length} track${s.tracks.length > 1 ? 's' : ''} · ${Math.round(s.bpm)} bpm`;
  renderTrackList();
  $('tracksCard').classList.remove('hidden');
  $('playCard').classList.remove('hidden');
  invalidate();
}

function volumeControl(value, onChange) {
  const frag = document.createDocumentFragment();
  const range = document.createElement('input');
  range.type = 'range'; range.className = 'vol'; range.min = 0; range.max = 150; range.value = Math.round(value * 100);
  range.title = 'Volume';
  const val = document.createElement('span');
  val.className = 'volval mono'; val.textContent = `${range.value}%`;
  range.addEventListener('input', () => { val.textContent = `${range.value}%`; onChange(range.value / 100); });
  frag.append(range, val);
  return frag;
}

function renderTrackList() {
  const box = $('tracks');
  box.innerHTML = '';
  song.tracks.forEach((t, i) => {
    const lo = Math.min(...t.notes.map((n) => n.midi)), hi = Math.max(...t.notes.map((n) => n.midi));
    const row = document.createElement('div');
    row.className = 'track';
    row.innerHTML = `
      <label class="tname"><input type="checkbox" ${enabled[i] ? 'checked' : ''} /><span class="name"></span></label>
      <span class="meta">${t.label || (t.isDrums ? 'Drums' : GM_FAMILIES[t.program >> 3])} · ${t.notes.length} notes · ${noteName(lo)}–${noteName(hi)}</span>`;
    row.querySelector('.name').textContent = t.name;
    row.querySelector('input').addEventListener('change', (e) => { enabled[i] = e.target.checked; invalidate(); });
    row.appendChild(volumeControl(trackVol[i], (v) => { trackVol[i] = v; setGain(`t${i}`, v); }));
    const solo = document.createElement('button');
    solo.type = 'button'; solo.title = 'Hear only this track'; solo.textContent = 'solo';
    solo.addEventListener('click', () => {
      enabled = enabled.map((_, j) => j === i);
      box.querySelectorAll('.tname input').forEach((cb, j) => (cb.checked = enabled[j]));
      invalidate();
    });
    row.appendChild(solo);
    box.appendChild(row);
  });

  // song mode: the real instrumental and the original singer
  const mix = $('mixRows');
  mix.innerHTML = '';
  mix.classList.toggle('hidden', !song.audio);
  if (!song.audio) return;
  const addRow = (name, meta, value, key, set) => {
    const row = document.createElement('div');
    row.className = 'track';
    row.innerHTML = `<span class="tname"><span class="name"></span></span><span class="meta"></span>`;
    row.querySelector('.name').textContent = name;
    row.querySelector('.meta').textContent = meta;
    row.appendChild(volumeControl(value, (v) => { set(v); setGain(key, v); }));
    row.appendChild(document.createElement('span'));
    mix.appendChild(row);
  };
  addRow('🎵 Background music', 'instrumental from the AI split', bgVol, 'bg', (v) => (bgVol = v));
  addRow('🗣 Original vocals', 'turn up to compare', origVol, 'orig', (v) => (origVol = v));
}

function setGain(key, v) {
  const g = playing?.gains[key];
  if (g) g.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
}

['gap', 'chords', 'vibrato', 'range'].forEach((id) => $(id).addEventListener('input', () => {
  $('gapVal').textContent = $('gap').value;
  if (song) invalidate();
}));
document.querySelectorAll('input[name="length"], input[name="style"]').forEach((r) => r.addEventListener('change', () => {
  $('reroll').disabled = styleMode() !== 'wild';
  if (song) invalidate();
}));
const styleMode = () => document.querySelector('input[name="style"]:checked').value;
let seed = 0; // 0 = the song's own default take
$('reroll').addEventListener('click', () => {
  seed = (Math.random() * 2 ** 31) | 0;
  if (song) invalidate();
});
const lengthMode = () => document.querySelector('input[name="length"]:checked').value;

// ---------- syllables + preview ----------

function invalidate() {
  stop();
  dirty = true;
  rendered = null;
  $('wavBtn').disabled = true;
  computeSyllables();
  drawRoll();
  renderLyrics();
  $('playBtn').disabled = !sung.length;
  $('time').textContent = `0:00 / ${fmt(song.duration)}`;
}

function computeSyllables() {
  sung = [];
  const opts = { phraseGapBeats: parseFloat($('gap').value), style: styleMode(), seed };
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
    const lo = pickWindow(oct), hi = lo + 12 * oct;
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

// Center the window on the cat's own voice (the pitch the o/i/a samples were
// recorded at, about D#4). Notes near that pitch need the least shifting, so
// they sound the most natural, and nothing ends up way up high.
function pickWindow(oct) {
  let center = 63;
  if (voices) {
    const ms = ['o', 'i', 'a'].map((k) => 69 + 12 * Math.log2(voices[k].f0 / 440));
    center = ms.reduce((a, b) => a + b, 0) / ms.length;
  }
  return Math.round(center - 6 * oct);
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
  // one buffer per track, written in place
  const bufs = new Map();
  for (const n of sung) if (!bufs.has(n.track)) bufs.set(n.track, ctx.createBuffer(1, total, SR));
  const data = new Map([...bufs].map(([k, b]) => [k, b.getChannelData(0)]));
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
    const out = data.get(n.track);
    const off = Math.round(n.time * SR);
    const gain = 0.35 + 0.65 * n.velocity;
    const len = Math.min(buf.length, total - off);
    for (let i = 0; i < len; i++) out[off + i] += buf[i] * gain;
    if (k % 150 === 0) {
      $('progressBar').style.width = `${(100 * k) / sung.length}%`;
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  // shared normalization so the tracks keep their balance
  const arrays = [...data.values()];
  let peak = 0;
  for (let i = 0; i < total; i++) {
    let v = 0;
    for (const a of arrays) v += a[i];
    peak = Math.max(peak, Math.abs(v));
  }
  const g = peak > 0 ? 0.89 / peak : 1;
  for (const a of arrays) for (let i = 0; i < total; i++) a[i] *= g;
  $('progress').classList.add('hidden');
  return bufs;
}

// Build the playback graph on any context (live or offline for WAV export).
function buildGraph(ac, dest, offset, when) {
  const sources = [], gains = {};
  const add = (buffer, key, vol) => {
    const src = ac.createBufferSource();
    src.buffer = buffer;
    const g = ac.createGain();
    g.gain.value = vol;
    src.connect(g).connect(dest);
    if (offset < buffer.duration) src.start(when, offset);
    sources.push(src);
    gains[key] = g;
  };
  for (const [ti, buf] of rendered) add(buf, `t${ti}`, trackVol[ti]);
  if (song.audio) {
    add(song.audio.instrumental, 'bg', bgVol);
    add(song.audio.vocals, 'orig', origVol);
  }
  return { sources, gains };
}

// ---------- transport ----------

$('playBtn').addEventListener('click', () => play(playing ? null : startOffset));
$('stopBtn').addEventListener('click', () => { stop(); startOffset = 0; drawRoll(0); highlight(-1); });
$('wavBtn').addEventListener('click', downloadWav);

async function play(offset) {
  if (offset === null) { stop(); return; } // toggle
  await ctx.resume();
  stop();
  if (dirty || !rendered) {
    $('playBtn').disabled = true;
    $('playBtn').textContent = 'Rendering…';
    rendered = await renderMix();
    dirty = false;
    $('playBtn').disabled = false;
    $('wavBtn').disabled = false;
  }
  startOffset = offset;
  startedAt = ctx.currentTime + 0.05;
  playing = buildGraph(ctx, master, offset, startedAt);
  $('playBtn').textContent = '❚❚ Pause';
  $('stopBtn').disabled = false;
  $('cat').classList.add('spin');
  tick();
}

function stop() {
  if (playing) {
    const pos = Math.max(0, ctx.currentTime - startedAt) + startOffset;
    for (const src of playing.sources) { try { src.stop(); } catch {} }
    playing = null;
    startOffset = Math.min(pos, song?.duration ?? 0);
  }
  cancelAnimationFrame(raf);
  $('playBtn').textContent = '▶ Play';
  $('cat').classList.remove('spin');
}

function tick() {
  if (!playing) return;
  const t = Math.max(0, ctx.currentTime - startedAt) + startOffset;
  if (t >= song.duration + 0.3) { stop(); startOffset = 0; drawRoll(0); highlight(-1); return; }
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

async function downloadWav() {
  if (!rendered) return;
  $('wavBtn').disabled = true;
  const rate = 44100;
  const off = new OfflineAudioContext(2, Math.ceil((song.duration + 0.5) * rate), rate);
  const lim = off.createDynamicsCompressor();
  lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.003; lim.release.value = 0.2;
  lim.connect(off.destination);
  const bus = off.createGain();
  bus.gain.value = HEADROOM;
  bus.connect(lim);
  buildGraph(off, bus, 0, 0);
  const out = await off.startRendering();
  const L = out.getChannelData(0), R = out.getChannelData(1), n = L.length;
  const b = new DataView(new ArrayBuffer(44 + n * 4));
  const w = (o, str) => [...str].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); b.setUint32(4, 36 + n * 4, true); w(8, 'WAVEfmt ');
  b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 2, true);
  b.setUint32(24, rate, true); b.setUint32(28, rate * 4, true); b.setUint16(32, 4, true); b.setUint16(34, 16, true);
  w(36, 'data'); b.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    b.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true);
    b.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true);
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
  a.download = `${(song.name || 'song').replace(/\.midi?$/i, '').replace(/[\\/:*?"<>|]/g, '')}-oiia.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  $('wavBtn').disabled = false;
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ---------- live keyboard ----------

const KEYMAP = 'awsedftgyhujk';
const LIVE_LOW = 60; // C4
const LIVE_CYCLE = ['o', 'i', 'i2', 'a'];
let liveStep = 0, lastPress = 0, liveHistory = [];
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
  if (now - lastPress > 1000) { liveStep = 0; liveHistory = []; }
  lastPress = now;
  let sample;
  if (styleMode() === 'wild') {
    const l = nextWildLetter(liveHistory);
    const prevI = liveHistory.length && liveHistory[liveHistory.length - 1] === 'i';
    liveHistory.push(l);
    sample = l === 'i' ? (prevI && liveStep % 2 ? 'i2' : 'i') : l;
  } else {
    sample = LIVE_CYCLE[liveStep % 4];
  }
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
  src.connect(gain).connect(master);
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

// ---------- song mode (experimental) ----------

let smBusy = false;
$('searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (!q) return;
  const box = $('results');
  box.textContent = 'Searching…';
  try {
    const results = await searchSongs(q);
    box.innerHTML = '';
    if (!results.length) { box.textContent = 'No songs found.'; return; }
    for (const r of results) {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'result';
      btn.innerHTML = '<img alt="" /><div><div class="t"></div><div class="a"></div></div>';
      btn.querySelector('img').src = r.art;
      btn.querySelector('.t').textContent = r.title;
      btn.querySelector('.a').textContent = r.artist;
      btn.addEventListener('click', () => runSongMode({ url: r.preview }, `${r.title} – ${r.artist}`));
      box.appendChild(btn);
    }
  } catch (err) {
    box.textContent = `Search failed: ${err.message}`;
  }
});
$('audioFile').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) runSongMode({ file: f }, f.name.replace(/\.[^.]+$/, ''));
  e.target.value = '';
});

async function runSongMode(source, name) {
  if (smBusy) return;
  smBusy = true;
  stop();
  const st = $('smStatus');
  st.classList.remove('hidden', 'err');
  const setStatus = (text, p) => {
    $('smText').textContent = text;
    $('smBar').style.width = p == null ? '100%' : `${Math.round(p * 100)}%`;
    $('smBar').classList.toggle('indet', p == null);
  };
  try {
    const r = await processSong(source, setStatus);
    if (!r.notes.length) throw new Error("couldn't find any singing in this song");
    const mk = ([l, rr]) => { const b = ctx.createBuffer(2, l.length, r.sampleRate); b.copyToChannel(l, 0); b.copyToChannel(rr, 1); return b; };
    const instrumental = mk(r.instrumental), vocals = mk(r.vocals);
    setSong({
      name,
      tracks: [{ name: 'Lead vocal → OIIA', label: 'Sung melody', notes: r.notes, channel: 0, isDrums: false, program: 0 }],
      duration: instrumental.duration,
      bpm: 120,
      secPerBeatAt: () => 0.5,
      audio: { instrumental, vocals },
    });
    setStatus(`Done! Split on ${r.backend === 'webgpu' ? 'your GPU (WebGPU)' : 'your CPU (WebAssembly)'}. Hit play below.`, 1);
    $('smBar').classList.remove('indet');
  } catch (err) {
    st.classList.add('err');
    $('smText').textContent = `Song mode failed: ${err.message}`;
    $('smBar').style.width = '0';
  }
  smBusy = false;
}

buildKeys();
