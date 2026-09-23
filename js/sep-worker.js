// Web Worker: downloads + caches the separation model, runs it (WebGPU when
// available, WebAssembly otherwise), transcribes the vocal melody, and sends
// back vocals, instrumental and notes.
import { separateVocals, MODELS } from './separate.js';
import { transcribeMelody } from './transcribe.js';

const ORT_DIR = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
let ort = null;
const sessions = {};

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

async function loadModelBytes(url) {
  const cache = 'caches' in self ? await caches.open('oiia-models-v1') : null;
  const hit = cache && (await cache.match(url));
  if (hit) {
    post({ type: 'progress', stage: 'download', p: 1, cached: true });
    return new Uint8Array(await hit.arrayBuffer());
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Model download failed (HTTP ${res.status})`);
  const total = +res.headers.get('content-length') || 0;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (total) post({ type: 'progress', stage: 'download', p: got / total });
  }
  const bytes = new Uint8Array(got);
  let o = 0;
  for (const part of parts) { bytes.set(part, o); o += part.length; }
  if (cache) {
    try { await cache.put(url, new Response(bytes)); } catch { /* storage full: just don't cache */ }
  }
  return bytes;
}

async function getSession(key) {
  if (sessions[key]) return sessions[key];
  if (!ort) {
    ort = await import(`${ORT_DIR}ort.webgpu.min.mjs`);
    ort.env.wasm.wasmPaths = ORT_DIR;
  }
  const bytes = await loadModelBytes(MODELS[key].url);
  post({ type: 'progress', stage: 'init', p: 0 });
  let session = null, backend = 'wasm';
  if (self.navigator?.gpu) {
    try {
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'] });
      backend = 'webgpu';
    } catch { session = null; }
  }
  if (!session) session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
  sessions[key] = { session, backend };
  return sessions[key];
}

self.onmessage = async (e) => {
  const { L, R, model = 'voc_ft' } = e.data;
  try {
    const cfg = MODELS[model];
    const { session, backend } = await getSession(model);
    post({ type: 'backend', backend });
    const run = async (x) => {
      const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', x, [1, 4, cfg.dimF, cfg.dimT]) });
      return out[session.outputNames[0]].data;
    };
    const res = await separateVocals(run, L, R, cfg, (p) => post({ type: 'progress', stage: 'separate', p }));
    post({ type: 'progress', stage: 'melody', p: 0 });
    const [vl, vr] = res.vocals;
    const mono = new Float32Array(vl.length);
    for (let i = 0; i < mono.length; i++) mono[i] = (vl[i] + vr[i]) / 2;
    const notes = transcribeMelody(mono, cfg.sampleRate);
    const bufs = [...res.vocals, ...res.instrumental].map((a) => a.buffer);
    post({ type: 'done', vocals: res.vocals, instrumental: res.instrumental, notes, backend }, bufs);
  } catch (err) {
    post({ type: 'error', message: err?.message || String(err) });
  }
};
