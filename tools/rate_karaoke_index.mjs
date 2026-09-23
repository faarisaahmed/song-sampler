// Step 2 of 2: find every candidate's melody track and write songs/karaoke-index.json.
//
//   node tools/rate_karaoke_index.mjs <raw.json> <src0-block.bin> <src0-block-start> <src1.zip>
//
// <src0-block.bin> is the byte range of the full archive that holds the
// "Deduped" folder (one range request, ~330 MB), starting at <src0-block-start>.
// <src1.zip> is the whole Genius subset zip (169 MB).
//
// Songs (at least 30 s long) are kept when the melody is certain (lyrics line
// up with one track) or the model is at least 70% sure. When a song appears
// more than once, a full-length version (90 s+) beats a short clip, then the
// more confident one wins.
// Output rows: [title, artist, offset, size, melodyTrack, confidence%, source, method, seconds]
import fs from 'fs';
import zlib from 'zlib';
import { parseMidi } from '../js/midi.js';
import { guessMelody } from '../js/melody.js';

const [rawPath, block0Path, block0Start, zip1Path] = process.argv.slice(2);
const MIN_CONF = 0.7;
const blobs = [
  { buf: fs.readFileSync(block0Path), base: Number(block0Start) },
  { buf: fs.readFileSync(zip1Path), base: 0 },
];
const raw = JSON.parse(fs.readFileSync(rawPath));
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const best = new Map();
const stats = { candidates: raw.songs.length, lyrics: 0, model: 0, only: 0, lowConfidence: 0, errors: 0 };

for (const [title, artist, off, size, method, src] of raw.songs) {
  try {
    const { buf, base } = blobs[src];
    const o = off - base;
    const nl = buf.readUInt16LE(o + 26), el = buf.readUInt16LE(o + 28);
    const data = buf.subarray(o + 30 + nl + el, o + 30 + nl + el + size);
    const bytes = method === 0 ? data : zlib.inflateRawSync(data);
    const song = parseMidi(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    const g = guessMelody(song);
    if (g.index < 0 || g.confidence < MIN_CONF || song.duration < 30) { stats.lowConfidence++; continue; }
    stats[g.source]++;
    const key = `${norm(title)}|${norm(artist)}`;
    const row = [title, artist, off, size, g.index, Math.round(g.confidence * 100), src, method, Math.round(song.duration)];
    const prev = best.get(key);
    const rank = (r) => (r[8] >= 90 ? 1000 : 0) + r[5];
    if (!prev || rank(row) > rank(prev)) best.set(key, row);
  } catch { stats.errors++; }
}

const songs = [...best.values()].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
fs.writeFileSync(new URL('../songs/karaoke-index.json', import.meta.url), JSON.stringify({ sources: raw.sources, songs }));
console.log({ ...stats, kept: songs.length });
