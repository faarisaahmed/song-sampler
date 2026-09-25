# OIIA Song Sampler 🐈

Turn any MIDI file into an OIIA cat song, right in your browser.

**Live:** https://faarisaahmed.github.io/song-sampler/

## How it works

Search a song and hit play: the cat sings the song's melody over the real instrumental. Or pick a classic (Ode to Joy, Für Elise, Rondo alla Turca, The Entertainer) for a cat solo.

- **Songs** (`js/karaoke.js`, `js/melody.js`): about 26,500 human-made karaoke MIDIs from the [Lyrics MIDI Dataset](https://huggingface.co/datasets/asigalov61/Lyrics-MIDI-Dataset). `songs/karaoke-index.json` stores each song's byte offset inside the dataset's zip on Hugging Face, so one MIDI is fetched with a single range request. The melody track is found by lyric alignment, or by a small MLP trained on 8,134 lyric-labeled songs (85% test accuracy, 92% when ≥70% confident; only lyric-matched or ≥70%-confident songs are listed). If it picks wrong, "Wrong melody?" lets you choose another track.
  - Rebuild the index: `python3 tools/build_karaoke_index.py raw.json`, then `node tools/rate_karaoke_index.mjs raw.json <deduped-block> <block-start> <genius.zip>`. Retrain with `tools/extract_melody_features.mjs` + `tools/train_melody.py`.
- **Background music** (`js/songmode.js`, `js/sep-worker.js`, `js/separate.js`, `js/transcribe.js`, `js/align.js`):
  1. The recording is found with the [iTunes Search API](https://performance-partners.apple.com/search-api) (30 s preview), or loaded from your own audio file for the whole song.
  2. [UVR-MDX-NET Voc_FT](https://github.com/Anjok07/ultimatevocalremovergui) runs in a Web Worker with [onnxruntime-web](https://onnxruntime.ai/) and removes the vocals (WebGPU; if WebGPU hangs for 25 s the worker is restarted on plain WebAssembly for the rest of the session).
  3. The removed vocal is pitch-tracked into notes.
  4. The MIDI is lined up with the recording by subsequence dynamic time warping on chroma: the whole MIDI against the full mix (harmony) plus the melody track against the sung notes (melody, weight 0.7), trying the three likeliest transpositions. The melody is then warped onto the recording's timeline and key.
- **Syllables** (`js/syllables.js`): the melody is cut into passages at rests (≥ 0.5 beat); every passage starts `o i` and ends `a`. The middle comes from a Markov chain learned from real OIIA strings (`oiiaioiiiai`, `oiiaoiia`, ...), conditioned on finishing with `a`, with long notes leaning toward `a`.
- **Pitch** (`js/psola.js`): every note is made with TD-PSOLA from the `o`, `i`, `i2` and `a` samples (`samples/`), so pitch and length are set separately with no chipmunk effect.
- **Octave range**: notes are folded into 1 octave by default (2, 3 or full on request), centered on the cat's natural pitch (about D#4). **Length**: *Held* fills each note, *Short* uses the cat's natural syllable length.
- **MIDI**: a small built-in parser (`js/midi.js`) with tempo map support. No dependencies.

Run it locally with any static server, e.g. `python3 -m http.server`.

## Credits

- Song search MIDIs: [Lyrics MIDI Dataset](https://huggingface.co/datasets/asigalov61/Lyrics-MIDI-Dataset) by asigalov61 (Project Los Angeles), [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).

- Vocal separation model: UVR-MDX-NET Voc_FT from [Ultimate Vocal Remover](https://github.com/Anjok07/ultimatevocalremovergui) (MIT), loaded from [Hugging Face](https://huggingface.co/masszhou/mdxnet).
- Song search and previews: iTunes Search API.

- Für Elise and Rondo alla Turca MIDI by Bernd Krueger, [piano-midi.de](http://www.piano-midi.de), licensed [CC BY-SA 3.0 DE](https://creativecommons.org/licenses/by-sa/3.0/de/deed.en).
- The Entertainer MIDI from the [Tonejs/Midi](https://github.com/Tonejs/Midi) test files.
