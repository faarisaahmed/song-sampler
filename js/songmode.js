// Song mode (experimental): search a song, strip its vocals with an AI model,
// read the sung melody, and hand it to the OIIA engine over the real instrumental.
import { MODELS } from './separate.js';

const MODEL = 'voc_ft';
const SR = MODELS[MODEL].sampleRate;

// iTunes Search API: free, no key, CORS-enabled, 30 s previews.
export async function searchSongs(term) {
  const url = `https://itunes.apple.com/search?media=music&entity=song&limit=12&term=${encodeURIComponent(term)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Search failed (HTTP ${res.status})`);
  const data = await res.json();
  return data.results.filter((r) => r.previewUrl).map((r) => ({
    title: r.trackName,
    artist: r.artistName,
    art: r.artworkUrl100 || r.artworkUrl60,
    preview: r.previewUrl,
  }));
}

const norm = (x) => x.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const ODD = /\b(karaoke|instrumental|live|remix|mix|cover|tribute|acoustic|demo|version|edit|sped|slowed)\b/;

// The studio recording of a song on iTunes (null if nothing plausible).
export async function findRecording(title, artist) {
  const results = await searchSongs(`${title} ${artist}`.trim());
  const t = norm(title), a = norm(artist);
  let best = null, bestScore = -Infinity;
  for (const r of results) {
    const rt = norm(r.title), ra = norm(r.artist);
    let score = 0;
    if (rt === t) score += 10; else if (rt.startsWith(t) || t.startsWith(rt)) score += 5; else if (!rt.includes(t)) score -= 10;
    if (a) score += ra === a ? 8 : ra.includes(a) || a.includes(ra) ? 5 : a.split(' ').some((w) => w.length > 2 && ra.includes(w)) ? 2 : -6;
    if (ODD.test(r.title.toLowerCase()) && !ODD.test(title.toLowerCase())) score -= 6;
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return bestScore > 0 ? best : null;
}

// Decode any audio file to stereo Float32 at the model's sample rate.
async function decode(arrayBuffer) {
  const off = new OfflineAudioContext(2, 1, SR);
  const buf = await off.decodeAudioData(arrayBuffer);
  const L = buf.getChannelData(0).slice();
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1).slice() : L.slice();
  return { L, R };
}

let worker = null;

/**
 * Runs the whole pipeline. `source` is { url } or { file }.
 * onStatus(text, fraction|null) reports progress.
 * midi (optional): { duration, melody, tracks: [{ isDrums, notes }] } to line up with the recording.
 * Returns { instrumental: [L, R], vocals: [L, R], notes, align, sampleRate, backend }.
 */
export async function processSong(source, onStatus, midi = null) {
  onStatus('Downloading the song…', null);
  const bytes = source.file ? await source.file.arrayBuffer() : await (await fetch(source.url)).arrayBuffer();
  onStatus('Decoding audio…', null);
  const { L, R } = await decode(bytes);

  worker ??= new Worker(new URL('./sep-worker.js', import.meta.url), { type: 'module' });
  const mins = L.length / SR / 60;
  return new Promise((resolve, reject) => {
    let backend = '';
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        if (m.stage === 'download') onStatus(m.cached ? 'Loading the vocal-removal model…' : `Downloading the vocal-removal model (${MODELS[MODEL].sizeMB} MB, only the first time)…`, m.p);
        else if (m.stage === 'init') onStatus('Starting the model…', null);
        else if (m.stage === 'separate') onStatus(`Separating vocals from the music${backend === 'wasm' ? ` (no WebGPU here, so this is slower: ~${Math.max(1, Math.round(mins * 3))} min)` : ''}…`, m.p);
        else if (m.stage === 'melody') onStatus('Reading the sung melody…', null);
        else if (m.stage === 'align') onStatus('Lining the MIDI up with the recording…', null);
      } else if (m.type === 'backend') {
        backend = m.backend;
      } else if (m.type === 'done') {
        resolve({ instrumental: m.instrumental, vocals: m.vocals, notes: m.notes, align: m.align, sampleRate: SR, backend: m.backend });
      } else if (m.type === 'error') {
        reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => reject(new Error(e.message || 'Worker failed to start'));
    worker.postMessage({ L, R, model: MODEL, midi }, [L.buffer, R.buffer]);
  });
}
