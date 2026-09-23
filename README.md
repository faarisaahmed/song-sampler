# OIIA Song Sampler 🐈

Turn any MIDI file into an OIIA cat song, right in your browser.

**Live:** https://faarisaahmed.github.io/song-sampler/

## How it works

- **Samples**: the `o`, `i` (plus a second take, `i2`) and `a` syllables were cut from the original OIIA spinning-cat clip (`samples/`).
- **Pitch**: every note is made with TD-PSOLA (`js/psola.js`). It detects the cat's pitch cycles and rebuilds the sound at the target pitch one cycle at a time. Pitch and length are set separately, and the vowel formants stay put, so low notes aren't slow and muddy and high notes aren't chipmunk squeaks. Every note is matched to the same loudness.
- **Syllables** (`js/syllables.js`):
  1. Notes that start together (chords) count as one syllable.
  2. The song is cut into passages at rests (≥ 0.5 beat by default). Passages shorter than 3 notes merge with a nearby one.
  3. Every passage starts `o i` and ends `a`.
  - **Wild** (default): the middle comes from a Markov chain learned from real OIIA strings (`oiiaioiiiai`, `oiiaoiia`, ...). The chain is conditioned on finishing with `a`, long notes lean toward `a`, and it's seeded from the song so it's the same on every play (🎲 rerolls).
  - **Classic**: tidy words `oia` / `oiia` / `oiiia`, split by dynamic programming so each `a` lands on a long note.
- **Length**: *Held* stretches syllables across the whole note. *Normal* uses the cat's natural syllable length.
- **Octave range**: optionally fold every note into 1–3 octaves, centered on the cat's natural pitch (about D#4).
- **Song mode (experimental)** (`js/songmode.js`, `js/sep-worker.js`, `js/separate.js`, `js/transcribe.js`):
  1. Search with the [iTunes Search API](https://performance-partners.apple.com/search-api) (30 s previews), or load your own audio file.
  2. The [UVR-MDX-NET Voc_FT](https://github.com/Anjok07/ultimatevocalremovergui) model runs in a Web Worker with [onnxruntime-web](https://onnxruntime.ai/) (WebGPU, falling back to WebAssembly) and splits vocals from the instrumental. The 67 MB model is cached after the first download.
  3. The vocal stem goes through pitch tracking (YIN every 10 ms, a loudness gate, median smoothing) and is cut into notes, which the OIIA engine sings over the instrumental.
  4. The mixer has live volume for every track, the background music and the original vocals.
- **MIDI**: a small built-in parser (`js/midi.js`) with tempo map support. No dependencies.

Run it locally with any static server, e.g. `python3 -m http.server`.

## Credits

- Vocal separation model: UVR-MDX-NET Voc_FT from [Ultimate Vocal Remover](https://github.com/Anjok07/ultimatevocalremovergui) (MIT), loaded from [Hugging Face](https://huggingface.co/masszhou/mdxnet).
- Song search and previews: iTunes Search API.

- Für Elise and Rondo alla Turca MIDI by Bernd Krueger, [piano-midi.de](http://www.piano-midi.de), licensed [CC BY-SA 3.0 DE](https://creativecommons.org/licenses/by-sa/3.0/de/deed.en).
- The Entertainer MIDI from the [Tonejs/Midi](https://github.com/Tonejs/Midi) test files.
