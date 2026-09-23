// O-I-A syllable assignment.
//
// The meme itself goes "o-i-i-a", and people shorten it to "o-i-a" when it's
// sung fast. The rules:
//
//  1. Notes that start together (a chord) count as one event and share a syllable.
//  2. Events are split into PASSAGES wherever there's a rest of at least
//     `phraseGapBeats` beats. Passages shorter than 3 events join the
//     neighbor with the smaller gap if that gap is under `mergeBeats` beats.
//  3. Every passage is split into WORDS. A word always starts "o i" and ends "a":
//         3 notes -> o i a        4 notes -> o i i a        5 notes -> o i i i a
//     Every length from 3 up can be built from these words (3 and 4 cover
//     everything except 5, which gets its own word).
//  4. The split is chosen by dynamic programming, and it's deterministic.
//     Each word scores points when its final "a" lands on a long note or right
//     before a small break, since that's where the drawn-out "aaa" sounds right.
//     The full "oiia" gets a small bonus. The best-scoring split wins.
//  5. Passages of 1 or 2 events that couldn't be merged are sung "a" or "o a".
//
// Two "i"s in a row use two different recordings (i, i2) so they don't sound copy-pasted.

const WORDS = {
  3: ['o', 'i', 'a'],
  4: ['o', 'i', 'i', 'a'],
  5: ['o', 'i', 'i', 'i', 'a'],
};
const WORD_BONUS = { 3: 0, 4: 0.35, 5: -1.5 };

export function groupEvents(notes, onsetTol = 0.03) {
  const sorted = [...notes].sort((a, b) => a.time - b.time || b.midi - a.midi);
  const events = [];
  for (const n of sorted) {
    const ev = events[events.length - 1];
    if (ev && n.time - ev.time <= onsetTol) {
      ev.notes.push(n);
      ev.end = Math.max(ev.end, n.time + n.duration);
    } else {
      events.push({ time: n.time, end: n.time + n.duration, notes: [n] });
    }
  }
  return events;
}

export function splitPassages(events, secPerBeatAt, { phraseGapBeats = 0.5, mergeBeats = 2 } = {}) {
  if (!events.length) return [];
  let passages = [[events[0]]];
  let runEnd = events[0].end;
  for (let i = 1; i < events.length; i++) {
    const e = events[i];
    const gap = e.time - runEnd;
    if (gap >= phraseGapBeats * secPerBeatAt(e.time) - 1e-6) passages.push([e]);
    else passages[passages.length - 1].push(e);
    runEnd = Math.max(runEnd, e.end);
  }
  const gapBetween = (a, b) => b[0].time - Math.max(...a.map((e) => e.end));
  // merge passages that are too short to hold "o i ... a"
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < passages.length; i++) {
      if (passages[i].length >= 3 || passages.length < 2) continue;
      const gp = i > 0 ? gapBetween(passages[i - 1], passages[i]) : Infinity;
      const gn = i < passages.length - 1 ? gapBetween(passages[i], passages[i + 1]) : Infinity;
      const toPrev = gp <= gn;
      const g = toPrev ? gp : gn;
      if (g > mergeBeats * secPerBeatAt(passages[i][0].time)) continue;
      if (toPrev) { passages[i - 1].push(...passages[i]); passages.splice(i, 1); }
      else { passages[i].push(...passages[i + 1]); passages.splice(i + 1, 1); }
      changed = true;
      break;
    }
  }
  return passages;
}

// Pick word lengths for one passage (DP). Returns e.g. [4, 3, 4].
export function planWords(passage, secPerBeatAt) {
  const n = passage.length;
  if (n < 3) return [n];
  const score = (endIdx) => {
    const e = passage[endIdx];
    const beat = secPerBeatAt(e.time);
    const len = Math.min(e.end - e.time, 2 * beat) / beat; // held length in beats
    const next = passage[endIdx + 1];
    const gap = next ? Math.max(0, Math.min(next.time - e.end, beat)) / beat : 0;
    return len + 1.5 * gap;
  };
  const best = new Array(n + 1).fill(-Infinity);
  const from = new Array(n + 1).fill(0);
  best[0] = 0;
  for (let k = 3; k <= n; k++) {
    for (const w of [3, 4, 5]) {
      if (k - w < 0 || best[k - w] === -Infinity) continue;
      const s = best[k - w] + score(k - 1) + WORD_BONUS[w];
      if (s > best[k] + 1e-9) { best[k] = s; from[k] = w; }
    }
  }
  const words = [];
  for (let k = n; k > 0; k -= from[k]) words.unshift(from[k]);
  return words;
}

function wordSyllables(len) {
  if (len === 1) return ['a'];
  if (len === 2) return ['o', 'a'];
  return WORDS[len];
}

/**
 * Assigns a syllable to every note of a track.
 * Each note gets: syl ('o' | 'i' | 'a'), sample ('o' | 'i' | 'i2' | 'a'),
 * passage (index), word (global index), event (global index) and wordStart (bool).
 */
export function assignSyllables(notes, secPerBeatAt, opts = {}) {
  const events = groupEvents(notes, opts.onsetTol);
  const passages = splitPassages(events, secPerBeatAt, opts);
  const out = [];
  let wordIdx = 0, eventIdx = 0;
  passages.forEach((passage, pi) => {
    const words = planWords(passage, secPerBeatAt);
    let i = 0;
    for (const w of words) {
      const syls = wordSyllables(w);
      let iCount = 0;
      syls.forEach((syl, j) => {
        const ev = passage[i + j];
        const sample = syl === 'i' ? (iCount++ % 2 ? 'i2' : 'i') : syl;
        for (const n of ev.notes) out.push({ ...n, syl, sample, passage: pi, word: wordIdx, event: eventIdx, wordStart: j === 0 });
        eventIdx++;
      });
      i += w;
      wordIdx++;
    }
  });
  return { notes: out, passages: passages.length, words: wordIdx };
}

// Keep only the highest note of each event (for "melody only" mode).
export function topLine(notes, onsetTol = 0.03) {
  return groupEvents(notes, onsetTol).map((e) => e.notes.reduce((a, b) => (b.midi > a.midi ? b : a)));
}
