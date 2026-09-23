// Training data for the melody-track model (see tools/train_melody.py).
//   node tools/extract_melody_features.mjs <raw.json> <src0-block.bin> <src0-block-start> <src1.zip> <out.json>
// Same inputs as rate_karaoke_index.mjs. A song is labeled when its lyric
// events line up with one track's note onsets (>= 60% of 30+ lyric events);
// that track is the melody.
import fs from 'fs';
import zlib from 'zlib';
import { parseMidi } from '../js/midi.js';
import { trackFeatures, lyricMatches } from '../js/melody.js';

const [rawPath, block0Path, block0Start, zip1Path, outPath] = process.argv.slice(2);
const blobs = [
  { buf: fs.readFileSync(block0Path), base: Number(block0Start) },
  { buf: fs.readFileSync(zip1Path), base: 0 },
];
const raw = JSON.parse(fs.readFileSync(rawPath));
const labeled = [];
const seen = new Set();
for (const [title, artist, off, size, method, src] of raw.songs) {
  const key = `${title.toLowerCase()}|${artist.toLowerCase()}`;
  if (seen.has(key)) continue; // same song in both sources: label it once
  let song;
  try {
    const { buf, base } = blobs[src];
    const o = off - base;
    const nl = buf.readUInt16LE(o + 26), el = buf.readUInt16LE(o + 28);
    const data = buf.subarray(o + 30 + nl + el, o + 30 + nl + el + size);
    const bytes = method === 0 ? data : zlib.inflateRawSync(data);
    song = parseMidi(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  } catch { continue; }
  if (song.lyrics.length < 30) continue;
  const feats = trackFeatures(song);
  if (feats.length < 2) continue;
  const lm = lyricMatches(song);
  let best = -1, bv = 0.6;
  for (const f of feats) if (lm[f.index] > bv) { bv = lm[f.index]; best = f.index; }
  if (best < 0) continue;
  seen.add(key);
  labeled.push({ label: best, feats: feats.map((f) => ({ i: f.index, x: f.x })) });
}
fs.writeFileSync(outPath, JSON.stringify(labeled));
console.log(`${labeled.length} labeled songs -> ${outPath}`);
