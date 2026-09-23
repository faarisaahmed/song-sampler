// Minimal Standard MIDI File parser (format 0/1).
// Returns tracks with notes in seconds, plus a tempo map and lyric events.
// Tracks that mix several channels (all of format 0, some format 1) are
// split into one track per channel so each instrument can be handled on its own.

import { GM_NAMES } from './gm.js';

export function parseMidi(arrayBuffer) {
  const d = new DataView(arrayBuffer);
  const len = d.byteLength;
  let p = 0;
  const str = (n) => { let s = ''; for (let i = 0; i < n && p + i < len; i++) s += String.fromCharCode(d.getUint8(p + i)); return s; };
  const u32 = () => { const v = d.getUint32(p); p += 4; return v; };
  const u16 = () => { const v = d.getUint16(p); p += 2; return v; };

  if (len < 14 || str(4) !== 'MThd') throw new Error('Not a MIDI file (missing MThd header)');
  p += 4;
  const hdrLen = u32();
  const hdrStart = p;
  u16(); // format
  const nTracks = u16();
  const division = u16();
  p = hdrStart + hdrLen;
  if (division & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported');
  const ppq = division || 480;

  const rawTracks = [];
  const tempoEvents = [];
  for (let t = 0; t < nTracks && p + 8 <= len; t++) {
    const id = str(4); p += 4;
    const tlen = u32();
    const end = Math.min(p + tlen, len);
    if (id !== 'MTrk') { p = end; t--; continue; }
    const tr = { name: '', events: [], lyrics: [] };
    let tick = 0, status = 0;
    const vlq = () => { let v = 0, b; do { b = d.getUint8(p++); v = (v << 7) | (b & 0x7f); } while (b & 0x80 && p < end); return v; };
    try {
      while (p < end) {
        tick += vlq();
        const b = d.getUint8(p);
        if (b & 0x80) { status = b; p++; } else if (!status) { p++; continue; }
        const type = status & 0xf0, ch = status & 0x0f;
        if (status === 0xff) {
          const mt = d.getUint8(p++); const ml = vlq(); const ms = p; p += ml;
          const text = () => { let s = ''; for (let i = 0; i < ml && ms + i < end; i++) s += String.fromCharCode(d.getUint8(ms + i)); return s; };
          if (mt === 0x51 && ml === 3) {
            tempoEvents.push({ tick, usPerBeat: (d.getUint8(ms) << 16) | (d.getUint8(ms + 1) << 8) | d.getUint8(ms + 2) });
          } else if ((mt === 0x03 || mt === 0x04) && !tr.name) {
            tr.name = text().trim();
          } else if (mt === 0x05 || mt === 0x01) {
            const s = text();
            // .kar files put lyrics in text events; their headers start with @ or %
            if (s.trim() && !/^[@%]/.test(s)) tr.lyrics.push({ tick, text: s, lyric: mt === 0x05 });
          } else if (mt === 0x2f) break;
          status = 0;
        } else if (status === 0xf0 || status === 0xf7) {
          p += vlq(); status = 0;
        } else if (type === 0x90 || type === 0x80) {
          const note = d.getUint8(p++), vel = d.getUint8(p++);
          tr.events.push({ tick, on: type === 0x90 && vel > 0, note, vel, ch });
        } else if (type === 0xc0) {
          tr.events.push({ tick, program: d.getUint8(p++), ch });
        } else if (type === 0xd0) {
          p += 1;
        } else {
          p += 2; // 0xA0 aftertouch, 0xB0 control, 0xE0 pitch bend
        }
      }
    } catch { /* truncated track: keep what we got */ }
    p = end;
    rawTracks.push(tr);
  }

  // Tempo map: tick -> seconds
  tempoEvents.sort((a, b) => a.tick - b.tick);
  const tempos = [{ tick: 0, usPerBeat: 500000, sec: 0 }];
  for (const e of tempoEvents) {
    const last = tempos[tempos.length - 1];
    const sec = last.sec + ((e.tick - last.tick) / ppq) * (last.usPerBeat / 1e6);
    if (e.tick === last.tick) { last.usPerBeat = e.usPerBeat; } else tempos.push({ tick: e.tick, usPerBeat: e.usPerBeat, sec });
  }
  const tickToSec = (tick) => {
    let i = tempos.length - 1;
    while (i > 0 && tempos[i].tick > tick) i--;
    const t = tempos[i];
    return t.sec + ((tick - t.tick) / ppq) * (t.usPerBeat / 1e6);
  };

  const tracks = [];
  const lyrics = [];
  for (const tr of rawTracks) {
    for (const l of tr.lyrics) lyrics.push({ time: tickToSec(l.tick), text: l.text, lyric: l.lyric });
    const open = new Map();
    const byCh = new Map(); // channel -> notes
    const programs = {};
    for (const e of tr.events) {
      if (e.program !== undefined) { if (programs[e.ch] === undefined) programs[e.ch] = e.program; continue; }
      const key = e.ch * 128 + e.note;
      if (e.on) {
        if (!open.has(key)) open.set(key, []);
        open.get(key).push(e);
      } else {
        const q = open.get(key);
        if (!q || !q.length) continue;
        const s = q.shift();
        const time = tickToSec(s.tick);
        const endT = tickToSec(e.tick);
        if (endT - time <= 0) continue;
        if (!byCh.has(s.ch)) byCh.set(s.ch, []);
        byCh.get(s.ch).push({ midi: s.note, time, duration: endT - time, velocity: s.vel / 127, channel: s.ch });
      }
    }
    const split = byCh.size > 1;
    for (const [ch, notes] of [...byCh].sort((a, b) => a[0] - b[0])) {
      notes.sort((a, b) => a.time - b.time || b.midi - a.midi);
      const program = programs[ch] ?? 0;
      const isDrums = ch === 9;
      const inst = isDrums ? 'Drums' : GM_NAMES[program];
      let name = tr.name && !/^track\s*\d*$/i.test(tr.name) ? tr.name : '';
      name = split ? (name ? `${name} · ${inst}` : inst) : (name || inst);
      tracks.push({ name, notes, channel: ch, isDrums, program });
    }
  }
  lyrics.sort((a, b) => a.time - b.time);

  // Some files start with minutes (or hours) of silence; start half a second before the first note.
  const first = Math.min(Infinity, ...tracks.map((t) => (t.notes.length ? t.notes[0].time : Infinity)));
  const shift = first > 2 && first !== Infinity ? first - 0.5 : 0;
  if (shift) {
    for (const t of tracks) for (const n of t.notes) n.time -= shift;
    for (const l of lyrics) l.time -= shift;
  }

  const duration = Math.max(0, ...tracks.flatMap((t) => t.notes.map((n) => n.time + n.duration)));
  const secPerBeatAt = (sec) => {
    let i = tempos.length - 1;
    while (i > 0 && tempos[i].sec > sec + shift) i--;
    return tempos[i].usPerBeat / 1e6;
  };
  // tempo in effect when the music starts
  let ti = tempos.length - 1;
  while (ti > 0 && tempos[ti].sec > shift) ti--;
  return { ppq, tracks, tempos, duration, secPerBeatAt, lyrics, bpm: 60e6 / tempos[ti].usPerBeat };
}
