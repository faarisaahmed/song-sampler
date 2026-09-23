# OIIA Song Sampler 🐈

Turn any MIDI file into an OIIA cat song, right in your browser.

**Live:** https://faarisaahmed.github.io/song-sampler/

## How it works

- **Samples**: the `o`, `i` (plus a second take, `i2`) and `a` syllables were cut from the original OIIA spinning-cat clip (`samples/`).
- **Pitch**: every note is made with TD-PSOLA (`js/psola.js`). It detects the cat's pitch cycles and rebuilds the sound at the target pitch one cycle at a time. Pitch and length are set separately, and the vowel formants stay put, so low notes aren't slow and muddy and high notes aren't chipmunk squeaks. Every note is matched to the same loudness.
- **Syllables** (`js/syllables.js`):
  1. Notes that start together (chords) count as one syllable.
  2. The song is cut into passages at rests (≥ 0.5 beat by default). Passages shorter than 3 notes merge with a nearby one.
  3. Each passage is sung as words that always start `o i` and end `a`: `oia` (3), `oiia` (4), `oiiia` (5).
  4. A dynamic-programming pass picks the split that puts the drawn-out `a` on long notes and before breaks, so the same song always gets the same lyrics.
- **Length**: *Held* stretches syllables across the whole note. *Normal* uses the cat's natural syllable length.
- **Octave range**: optionally fold every note into 1–3 octaves, centered on the cat's natural pitch (about D#4).
- **MIDI**: a small built-in parser (`js/midi.js`) with tempo map support. No dependencies.

Run it locally with any static server, e.g. `python3 -m http.server`.

## Credits

- Für Elise and Rondo alla Turca MIDI by Bernd Krueger, [piano-midi.de](http://www.piano-midi.de), licensed [CC BY-SA 3.0 DE](https://creativecommons.org/licenses/by-sa/3.0/de/deed.en).
- The Entertainer MIDI from the [Tonejs/Midi](https://github.com/Tonejs/Midi) test files.
