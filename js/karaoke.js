// Human-made karaoke MIDIs from the Lyrics MIDI Dataset (CC BY-NC-SA 4.0).
// songs/karaoke-index.json lists every song with its byte offset inside one
// of the dataset's zips on Hugging Face, plus which track holds the melody and
// how sure we are (built by tools/build_karaoke_index.py and
// tools/rate_karaoke_index.mjs). A single MIDI is pulled out with an HTTP
// range request, so the multi-GB archive never gets downloaded.

let index = null;

export async function loadIndex() {
  if (index) return index;
  const res = await fetch(new URL('../songs/karaoke-index.json', import.meta.url));
  if (!res.ok) throw new Error(`Couldn't load the song index (HTTP ${res.status})`);
  const data = await res.json();
  index = {
    sources: data.sources,
    songs: data.songs.map(([title, artist, offset, size, melody, confidence, source, method, seconds]) => ({
      title, artist, offset, size, melody, confidence, source, method, seconds,
      key: norm(`${title} ${artist}`), t: norm(title), a: norm(artist),
    })),
  };
  return index;
}

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

export async function searchKaraoke(query, limit = 24) {
  const { songs } = await loadIndex();
  const q = norm(query);
  if (!q) return [];
  const words = q.split(' ');
  const scored = [];
  for (const s of songs) {
    if (!words.every((w) => s.key.includes(w))) continue;
    let score = 0;
    if (s.t === q) score += 100;
    else if (s.t.startsWith(q)) score += 60;
    else if (q.startsWith(s.t) && q.slice(s.t.length).trim() && s.a.includes(q.slice(s.t.length).trim())) score += 90; // "title artist"
    if (s.a === q) score += 50;
    if (words.every((w) => s.t.includes(w))) score += 20;
    if (/\b(live|remix|version|karaoke|edit|mix|instrumental|acoustic|cover|demo)\b/.test(s.t)) score -= 15;
    score -= s.t.length * 0.1;
    score += s.confidence / 25; // prefer files whose melody we're surer about
    if (s.seconds < 90) score -= 8; // and full songs over short clips
    scored.push([score, s]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, limit).map(([, s]) => s);
}

export async function fetchKaraokeMidi(song) {
  const { sources } = await loadIndex();
  const source = sources[song.source];
  // local file header is 30 bytes + name + extra field; grab a little extra
  const end = song.offset + 30 + 2048 + song.size;
  const res = await fetch(source, { headers: { Range: `bytes=${song.offset}-${end}` } });
  if (res.status !== 206) throw new Error(`MIDI download failed (HTTP ${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const dv = new DataView(buf.buffer);
  if (dv.getUint32(0, true) !== 0x04034b50) throw new Error('Unexpected data in the song archive');
  const start = 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
  const data = buf.subarray(start, start + song.size);
  if (song.method === 0) return data.slice().buffer;
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).arrayBuffer();
}
