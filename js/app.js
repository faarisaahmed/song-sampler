import { parseMidi } from './midi.js';
import { analyzeVoice, renderNote, midiToFreq, naturalLength } from './psola.js';
import { assignSyllables, topLine } from './syllables.js';
import { demoSong } from './demo.js';
import { processSong, findRecording, cancelProcessing } from './songmode.js';
import { alignMidiToAudio, warpNotes, FRAME } from './align.js';
import { guessMelody } from './melody.js';
import { searchKaraoke, fetchKaraokeMidi, loadIndex } from './karaoke.js';

const $ = (id) => document.getElementById(id);
const COLORS = { o: '#6cc6ff', i: '#ff7ab8', a: '#ffd35c' };
const SAMPLE_NAMES = ['o', 'i', 'i2', 'a'];

const ctx = new (window.AudioContext || window.webkitAudioContext)();
const SR = ctx.sampleRate;
let voices = null; // { o, i, i2, a } -> analyzed voice
const voicesReady = loadVoices();

// The song on screen:
// { title, sub, tracks, duration, secPerBeatAt, cat: [track indices the cat sings],
//   topLine (sing only the top note of chords), audio?: { instrumental, vocals } }
let song = null;
// For a searched song: what's needed to redo the alignment with another melody
// track or another recording. { orig, melody, rec?: { vocalNotes, mix, label, preview } }
let search = null;
let loadGen = 0; // bumps on every new song, so stale loads can tell they're stale

let sung = []; // notes with syllables
let lyricWords = []; // [{ time, end, el }]
let catBuf = null; // rendered cat voice
let playing = null; // { sources, gains }
let startedAt = 0, startOffset = 0, raf = 0;

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

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ---------- status line ----------

function setStatus(text, p = null, err = false) {
  const box = $('status');
  box.classList.toggle('hidden', !text);
  box.classList.toggle('err', err);
  $('statusText').textContent = text || '';
  const bar = $('statusBar');
  bar.parentElement.classList.toggle('hidden', err || p === 'none');
  bar.classList.toggle('indet', p == null);
  bar.style.width = typeof p === 'number' ? `${Math.round(p * 100)}%` : '0';
}

// Show the player card for a song that's still loading.
function showLoading(title, sub) {
  stop();
  song = null;
  sung = [];
  catBuf = null;
  $('playerCard').classList.remove('hidden');
  $('songTitle').textContent = title;
  $('songSub').textContent = sub;
  $('playBtn').disabled = true;
  $('stopBtn').disabled = true;
  $('wavBtn').disabled = true;
  $('lyrics').innerHTML = '';
  $('time').textContent = '0:00 / 0:00';
  $('melodyCtl').classList.add('hidden');
  $('fullCtl').classList.add('hidden');
  $('musicCtl').classList.add('hidden');
  drawRoll();
}

// ---------- classics + MIDI files: the cat sings every part ----------

document.querySelectorAll('[data-song]').forEach((btn) => btn.addEventListener('click', async () => {
  ctx.resume();
  const gen = ++loadGen;
  cancelProcessing();
  markActive(null);
  search = null;
  showLoading(btn.textContent, 'Classic · the cat sings it solo');
  try {
    let m;
    if (btn.dataset.song === 'demo') m = demoSong();
    else {
      const res = await fetch(btn.dataset.song);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      m = parseMidi(await res.arrayBuffer());
    }
    if (gen !== loadGen) return;
    setSolo(m, btn.textContent, 'Classic · the cat sings it solo');
    play(0);
  } catch (err) {
    setStatus(`Couldn't load ${btn.textContent}: ${err.message}`, null, true);
  }
}));

$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const gen = ++loadGen;
  cancelProcessing();
  markActive(null);
  search = null;
  const name = f.name.replace(/\.midi?$/i, '');
  showLoading(name, 'Your MIDI file · the cat sings it solo');
  try {
    const m = parseMidi(await f.arrayBuffer());
    if (!m.tracks.length) throw new Error('no notes found in this file');
    if (gen !== loadGen) return;
    setSolo(m, name, 'Your MIDI file · the cat sings it solo');
  } catch (err) {
    setStatus(`Couldn't read that file: ${err.message}`, null, true);
  }
});

function setSolo(m, title, sub) {
  let cat = m.tracks.map((t, i) => (t.isDrums ? -1 : i)).filter((i) => i >= 0);
  if (!cat.length) cat = [0];
  setSong({ title, sub: `${sub} · ${fmt(m.duration)}`, tracks: m.tracks, duration: m.duration, secPerBeatAt: m.secPerBeatAt, cat, topLine: false });
}

// ---------- search ----------

loadIndex().then((idx) => { $('kq').placeholder = `Search ${idx.songs.length.toLocaleString()} songs by title or artist`; }).catch(() => {});

const normKey = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

$('kSearch').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('kq').value.trim();
  if (!q) return;
  const box = $('kResults');
  box.innerHTML = '<div class="msg">Searching…</div>';
  try {
    const results = await searchKaraoke(q, 40);
    // the dataset often has several MIDIs of one song; show the best one
    const seen = new Set();
    const list = results.filter((r) => {
      const k = normKey(`${r.title}|${r.artist}`);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 8);
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = '<div class="msg">No songs found. Try just the title, or just the artist.</div>'; return; }
    for (const r of list) {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'result';
      btn.innerHTML = '<span class="play-dot"><svg class="icon"><use href="#i-play"/></svg></span><div class="txt"><div class="t"></div><div class="a"></div></div>';
      btn.querySelector('.t').textContent = r.title;
      btn.querySelector('.a').textContent = r.artist;
      btn.addEventListener('click', () => { ctx.resume(); markActive(btn); loadSearched(r); });
      box.appendChild(btn);
    }
  } catch (err) {
    box.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'msg'; d.textContent = `Search failed: ${err.message}`;
    box.appendChild(d);
  }
});

function markActive(btn) {
  document.querySelectorAll('.result.active').forEach((b) => b.classList.remove('active'));
  btn?.classList.add('active');
}

async function loadSearched(r) {
  const gen = ++loadGen;
  cancelProcessing();
  search = null;
  showLoading(r.title, r.artist);
  $('playerCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const stale = () => gen !== loadGen;
  try {
    setStatus('Getting the melody…', null);
    const orig = parseMidi(await fetchKaraokeMidi(r));
    const g = guessMelody(orig);
    if (g.index < 0) throw new Error("couldn't find the melody in this MIDI");
    if (stale()) return;
    search = { orig, melody: g.index, polyphonic: g.polyphonic, title: r.title, artist: r.artist };

    setStatus('Finding the recording…', null);
    const hit = await findRecording(r.title, r.artist);
    if (stale()) return;
    if (!hit) {
      buildSolo();
      setStatus("Couldn't find this recording on iTunes, so the cat sings solo. Load the song from an audio file to add the music.", 'none');
      return;
    }
    await addRecording({ url: hit.preview }, `${hit.title} by ${hit.artist}`, true, gen);
    if (!stale()) play(0);
  } catch (err) {
    if (err.cancelled || stale()) return;
    setStatus(`Couldn't load that song: ${err.message}`, null, true);
  }
}

// Separate + align a recording for the current searched song.
async function addRecording(source, label, preview, gen) {
  const { orig, melody } = search;
  const midi = { duration: orig.duration, melody, tracks: orig.tracks.map((t) => ({ isDrums: t.isDrums, notes: t.notes })) };
  const r = await processSong(source, (t, p) => gen === loadGen && setStatus(t, p), midi);
  if (gen !== loadGen) return;
  const mk = ([l, rr]) => { const b = ctx.createBuffer(2, l.length, r.sampleRate); b.copyToChannel(l, 0); b.copyToChannel(rr, 1); return b; };
  const mix = new Float32Array(r.instrumental[0].length);
  for (let i = 0; i < mix.length; i++) mix[i] = (r.instrumental[0][i] + r.instrumental[1][i] + r.vocals[0][i] + r.vocals[1][i]) / 2;
  search.rec = { vocalNotes: r.notes, mix, sampleRate: r.sampleRate, label, preview, align: r.align, instrumental: mk(r.instrumental), vocals: mk(r.vocals) };
  buildAligned();
  setStatus('');
}

// The cat sings the melody over the recording, lined up by search.rec.align.
function buildAligned() {
  const { orig, melody, rec } = search;
  const al = rec.align;
  const mel = warpNotes(orig.tracks[melody].notes, al);
  if (!mel.length) throw new Error("the melody doesn't show up in the part of the song that matched");
  // tempo on the new timeline: the MIDI's tempo times how much it got stretched
  const stretch = ((al.curve[al.curve.length - 1] - al.curve[0]) * FRAME) / Math.max(FRAME, al.midiEnd - al.midiStart) || 1;
  const spb = orig.secPerBeatAt(al.midiStart) * stretch;
  const dur = rec.instrumental.duration;
  setSong({
    title: search.title,
    sub: `${search.artist} · ${rec.preview ? `${fmt(dur)} clip` : fmt(dur)} of the real song`,
    tracks: [{ ...orig.tracks[melody], notes: mel }],
    duration: dur,
    secPerBeatAt: () => spb,
    cat: [0],
    topLine: search.polyphonic,
    audio: { instrumental: rec.instrumental, vocals: rec.vocals },
  });
}

// No recording: the cat sings the MIDI melody on its own.
function buildSolo() {
  const { orig, melody } = search;
  setSong({
    title: search.title,
    sub: `${search.artist} · ${fmt(orig.duration)} · cat solo`,
    tracks: orig.tracks, duration: orig.duration, secPerBeatAt: orig.secPerBeatAt,
    cat: [melody], topLine: search.polyphonic,
  });
}

// Wrong melody track: pick another and line it up again.
$('melodySel').addEventListener('change', async () => {
  if (!search) return;
  search.melody = +$('melodySel').value;
  const t = search.orig.tracks[search.melody];
  search.polyphonic = topLine(t.notes).length < t.notes.length * 0.8;
  const rec = search.rec;
  if (!rec) return buildSolo();
  setStatus('Lining the melody up with the music…', null);
  $('playBtn').disabled = true;
  await new Promise((r) => setTimeout(r, 30)); // let the status paint
  try {
    rec.align = alignMidiToAudio(search.orig, rec.mix, rec.sampleRate, { vocalNotes: rec.vocalNotes, melody: search.melody });
    buildAligned();
    setStatus('');
  } catch (err) {
    setStatus(`Couldn't use that track: ${err.message}`, null, true);
  }
});

$('fullFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !search) return;
  const gen = ++loadGen;
  cancelProcessing();
  stop();
  $('playBtn').disabled = true;
  try {
    await addRecording({ file: f }, f.name, false, gen);
  } catch (err) {
    if (!err.cancelled && gen === loadGen) setStatus(`Couldn't use that file: ${err.message}`, null, true);
  }
});

// ---------- song on screen ----------

function setSong(s) {
  stop();
  startOffset = 0;
  song = s;
  $('songTitle').textContent = s.title;
  $('songSub').textContent = s.sub;
  $('musicCtl').classList.toggle('hidden', !s.audio);
  // searched songs: let the user fix a wrong melody pick, and add the full song
  const sel = $('melodySel');
  sel.innerHTML = '';
  if (search) {
    search.orig.tracks.forEach((t, i) => {
      if (t.isDrums) return;
      const o = document.createElement('option');
      o.value = i;
      o.textContent = `${t.name} (${t.notes.length} notes)`;
      sel.appendChild(o);
    });
    sel.value = search.melody;
  }
  $('melodyCtl').classList.toggle('hidden', !search || sel.options.length < 2);
  $('fullCtl').classList.toggle('hidden', !search || !!(search.rec && !search.rec.preview));
  $('fullCtl').firstChild.textContent = search?.rec ? 'Only a 30-second clip. Load the full song from an audio file' : 'Load the song from an audio file to add the music';
  invalidate();
}

document.querySelectorAll('input[name="length"], input[name="range"]').forEach((r) => r.addEventListener('change', () => song && invalidate()));
const lengthMode = () => document.querySelector('input[name="length"]:checked').value;
const rangeOctaves = () => parseInt(document.querySelector('input[name="range"]:checked').value, 10);
const catVol = () => $('catVol').value / 100;
const musicVol = () => $('musicVol').value / 100;
$('catVol').addEventListener('input', () => setGain('cat', catVol()));
$('musicVol').addEventListener('input', () => setGain('music', musicVol()));

function setGain(key, v) {
  const g = playing?.gains[key];
  if (g) g.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
}

function invalidate() {
  stop();
  catBuf = null;
  $('wavBtn').disabled = true;
  computeSyllables();
  drawRoll();
  renderLyrics();
  $('playBtn').disabled = !sung.length;
  $('stopBtn').disabled = true;
  $('time').textContent = `0:00 / ${fmt(song.duration)}`;
}

function computeSyllables() {
  sung = [];
  const opts = { phraseGapBeats: 0.5, style: 'wild', seed: 0 };
  for (const ti of song.cat) {
    const t = song.tracks[ti];
    const notes = song.topLine ? topLine(t.notes) : t.notes;
    const r = assignSyllables(notes, song.secPerBeatAt, opts);
    for (const n of r.notes) sung.push({ ...n, track: ti });
  }
  sung.sort((a, b) => a.time - b.time);

  // octave range: fold every note into a window of N octaves
  const oct = rangeOctaves();
  if (oct && sung.length) {
    const lo = pickWindow(oct), hi = lo + 12 * oct;
    for (const n of sung) {
      while (n.midi < lo) n.midi += 12;
      while (n.midi >= hi) n.midi -= 12;
    }
    // folding can land two notes of a chord on the same pitch; keep one
    const seen = new Map();
    sung = sung.filter((n) => {
      const key = `${n.midi}|${Math.round(n.time * 50)}`;
      const prev = seen.get(key);
      if (prev) { prev.duration = Math.max(prev.duration, n.duration); prev.velocity = Math.max(prev.velocity, n.velocity); return false; }
      seen.set(key, n);
      return true;
    });
  }

  // Held = sing for the whole note; Short = the cat's natural syllable length
  const normal = lengthMode() === 'normal';
  for (const n of sung) n.singDur = normal ? Math.min(n.duration, natLen(n.sample)) : n.duration;
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
  const ti = song.cat[0];
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
  if (hi - lo < 18) { const mid = (hi + lo) / 2; lo = Math.floor(mid - 9); hi = Math.ceil(mid + 9); }
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
  if (!song || $('playBtn').disabled) return;
  const r = e.target.getBoundingClientRect();
  const t = Math.max(0, (e.clientX - r.left) / pxPerSec);
  play(Math.min(t, song.duration));
});

// ---------- rendering ----------

async function renderCat() {
  await voicesReady;
  const total = Math.ceil((song.duration + 0.5) * SR);
  const buffer = ctx.createBuffer(1, total, SR);
  const out = buffer.getChannelData(0);
  const cache = new Map();
  for (let k = 0; k < sung.length; k++) {
    const n = sung[k];
    const dur = Math.max(0.04, n.singDur);
    const key = `${n.sample}|${n.midi}|${Math.round(dur * 200)}`;
    let buf = cache.get(key);
    if (!buf) {
      buf = renderNote(voices[n.sample], midiToFreq(n.midi), dur, { vibrato: true });
      cache.set(key, buf);
    }
    const off = Math.round(n.time * SR);
    const gain = 0.35 + 0.65 * n.velocity;
    const len = Math.min(buf.length, total - off);
    for (let i = 0; i < len; i++) out[off + i] += buf[i] * gain;
    if (k % 150 === 0) {
      setStatus('Getting the cat ready…', k / sung.length);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(out[i]));
  const g = peak > 0 ? 0.89 / peak : 1;
  for (let i = 0; i < total; i++) out[i] *= g;
  setStatus('');
  return buffer;
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
  add(catBuf, 'cat', catVol());
  if (song.audio) add(song.audio.instrumental, 'music', musicVol());
  return { sources, gains };
}

// ---------- transport ----------

$('playBtn').addEventListener('click', () => play(playing ? null : startOffset));
$('stopBtn').addEventListener('click', () => { stop(); startOffset = 0; drawRoll(0); highlight(-1); $('stopBtn').disabled = true; $('time').textContent = `0:00 / ${fmt(song.duration)}`; });
$('wavBtn').addEventListener('click', downloadWav);

async function play(offset) {
  if (offset === null) { stop(); return; } // toggle
  await ctx.resume();
  stop();
  if (!catBuf) {
    $('playBtn').disabled = true;
    const s = song;
    try {
      const buf = await renderCat();
      if (s !== song) return; // another song got picked meanwhile
      catBuf = buf;
    } catch (err) {
      setStatus(`Couldn't get ready to play: ${err.message}`, null, true);
      return;
    } finally {
      $('playBtn').disabled = false;
    }
    $('wavBtn').disabled = false;
  }
  startOffset = offset;
  startedAt = ctx.currentTime + 0.1;
  playing = buildGraph(ctx, master, offset, startedAt);
  $('playIcon').setAttribute('href', '#i-pause');
  $('playBtn').setAttribute('aria-label', 'Pause');
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
  $('playIcon').setAttribute('href', '#i-play');
  $('playBtn').setAttribute('aria-label', 'Play');
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
  if (!catBuf) return;
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
  a.download = `${song.title.replace(/[\\/:*?"<>|]/g, '')} - oiia.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  $('wavBtn').disabled = false;
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && song && !e.target.matches('input, select, button, textarea')) { e.preventDefault(); $('playBtn').click(); }
});
