// Minimal Standard MIDI File parser (format 0/1).
// Returns tracks with notes in seconds, plus a tempo map.

export function parseMidi(arrayBuffer) {
  const d = new DataView(arrayBuffer);
  let p = 0;
  const str = (n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(d.getUint8(p + i)); return s; };
  const u32 = () => { const v = d.getUint32(p); p += 4; return v; };
  const u16 = () => { const v = d.getUint16(p); p += 2; return v; };

  if (str(4) !== 'MThd') throw new Error('Not a MIDI file (missing MThd header)');
  p += 4;
  const hdrLen = u32();
  const hdrStart = p;
  u16(); // format
  const nTracks = u16();
  const division = u16();
  p = hdrStart + hdrLen;
  if (division & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported');
  const ppq = division;

  const rawTracks = [];
  const tempoEvents = [];
  for (let t = 0; t < nTracks && p < d.byteLength - 8; t++) {
    const id = str(4); p += 4;
    const len = u32();
    const end = p + len;
    if (id !== 'MTrk') { p = end; t--; continue; }
    const tr = { name: '', events: [] };
    let tick = 0, status = 0;
    const vlq = () => { let v = 0, b; do { b = d.getUint8(p++); v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
    while (p < end) {
      tick += vlq();
      let b = d.getUint8(p);
      if (b & 0x80) { status = b; p++; } else if (!status) { p++; continue; }
      const type = status & 0xf0, ch = status & 0x0f;
      if (status === 0xff) {
        const mt = d.getUint8(p++); const ml = vlq(); const ms = p; p += ml;
        if (mt === 0x51 && ml === 3) {
          const us = (d.getUint8(ms) << 16) | (d.getUint8(ms + 1) << 8) | d.getUint8(ms + 2);
          tempoEvents.push({ tick, usPerBeat: us });
        } else if ((mt === 0x03 || mt === 0x04) && !tr.name) {
          let s = ''; for (let i = 0; i < ml; i++) s += String.fromCharCode(d.getUint8(ms + i));
          tr.name = s.trim();
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
  for (const tr of rawTracks) {
    const open = new Map();
    const notes = [];
    const programs = {};
    const channels = new Set();
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
        notes.push({ midi: s.note, time, duration: endT - time, velocity: s.vel / 127, channel: s.ch });
        channels.add(s.ch);
      }
    }
    if (!notes.length) continue;
    notes.sort((a, b) => a.time - b.time || b.midi - a.midi);
    const ch = [...channels][0];
    tracks.push({
      name: tr.name || `Track ${tracks.length + 1}`,
      notes,
      channel: ch,
      isDrums: channels.size === 1 && ch === 9,
      program: programs[ch] ?? 0,
    });
  }

  const duration = Math.max(0, ...tracks.flatMap((t) => t.notes.map((n) => n.time + n.duration)));
  const secPerBeatAt = (sec) => {
    let i = tempos.length - 1;
    while (i > 0 && tempos[i].sec > sec) i--;
    return tempos[i].usPerBeat / 1e6;
  };
  return { ppq, tracks, tempos, duration, secPerBeatAt, bpm: 60e6 / tempos[0].usPerBeat };
}
