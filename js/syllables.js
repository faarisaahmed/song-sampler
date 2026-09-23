// O-I-A syllable assignment.
//
// The rules (both styles):
//
//  1. Notes that start together (a chord) count as one event and share a syllable.
//  2. Events are split into PASSAGES wherever there's a rest of at least
//     `phraseGapBeats` beats. Passages shorter than 3 events join the
//     neighbor with the smaller gap if that gap is under `mergeBeats` beats.
//  3. Every passage starts "o i" and ends "a". Passages of 1 or 2 events that
//     couldn't be merged are sung "a" or "o a".
//
// CLASSIC style splits each passage into the words oia / oiia / oiiia,
// chosen by dynamic programming so each word's "a" lands on long notes.
//
// WILD style fills in the middle of each passage from a Markov chain built
// from real OIIA strings (see CORPUS), so you get things like "oiiaioiiiaia".
//  - Rules taken from the corpus: "o" is always followed by i or o, "a" by i
//    or o, and "a" always comes right after an "i". Runs are capped at ooo and iiii.
//  - The chain is conditioned on the passage ending in "a" (a backward pass
//    works out, for each spot, how likely each letter is to still reach a
//    final "a"), so every generated passage follows the rules exactly.
//  - Long notes and notes right before a small break lean toward "a".
//  - Randomness comes from a PRNG seeded by the notes themselves plus a
//    user-rerollable seed, so the same song always gets the same lyrics
//    until you hit reroll.
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

// ---------- wild style ----------

// Real sequences: the spinning-cat song, the plain loop, and user-given examples.
export const CORPUS = ['oiiaioiiiai', 'oiiaoiia', 'oiaioia', 'oiaooiaio', 'oiiaioiiiaioiia'];

// letter -> letter probabilities counted from CORPUS (no o->a, no a->a)
const TRANS = (() => {
  const c = { o: { o: 0, i: 0, a: 0 }, i: { o: 0, i: 0, a: 0 }, a: { o: 0, i: 0, a: 0 } };
  for (const w of CORPUS) for (let k = 1; k < w.length; k++) c[w[k - 1]][w[k]]++;
  const p = {};
  for (const [from, row] of Object.entries(c)) {
    const tot = row.o + row.i + row.a;
    p[from] = { o: row.o / tot, i: row.i / tot, a: row.a / tot };
  }
  return p;
})();
const MAX_RUN = { o: 3, i: 4, a: 1 };
// states are (letter, run length)
const STATES = [];
for (const l of ['o', 'i', 'a']) for (let r = 1; r <= MAX_RUN[l]; r++) STATES.push({ l, r });
const IDX = (l, r) => STATES.findIndex((st) => st.l === l && st.r === r);
const stepProb = (s, t) => {
  if (t.l === s.l ? t.r !== s.r + 1 : t.r !== 1) return 0;
  return TRANS[s.l][t.l];
};

// Next letter for open-ended playing (live keyboard): same chain, no fixed end.
export function nextWildLetter(history, rand = Math.random) {
  if (history.length === 0) return 'o';
  if (history.length === 1) return 'i';
  const last = history[history.length - 1];
  let run = 0;
  for (let k = history.length - 1; k >= 0 && history[k] === last; k--) run++;
  const opts = ['o', 'i', 'a'].filter((l) => l !== last || run < MAX_RUN[l]);
  const tot = opts.reduce((acc, l) => acc + TRANS[last][l], 0);
  let r = rand() * tot;
  for (const l of opts) if ((r -= TRANS[last][l]) <= 0) return l;
  return opts[opts.length - 1];
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashNotes(notes) {
  let h = 2166136261;
  for (const n of notes) {
    h = Math.imul(h ^ n.midi, 16777619);
    h = Math.imul(h ^ Math.round(n.time * 1000), 16777619);
  }
  return h >>> 0;
}

function wildPassage(passage, secPerBeatAt, rand) {
  const n = passage.length;
  if (n < 3) return wordSyllables(n);
  // how much each event "wants" to be an a
  const aWeight = passage.map((e, k) => {
    const beat = secPerBeatAt(e.time);
    const len = Math.min(e.end - e.time, 2 * beat) / beat;
    const next = passage[k + 1];
    const gap = next ? Math.max(0, Math.min(next.time - e.end, beat)) / beat : 0;
    return 0.4 + 0.8 * len + 1.5 * gap;
  });
  const w = (k, st) => (st.l === 'a' ? aWeight[k] : 1);
  const S = STATES.length;
  // backward pass: beta[k][s] ~ chance of finishing on "a" from state s at position k
  const beta = Array.from({ length: n }, () => new Float64Array(S));
  beta[n - 1][IDX('a', 1)] = 1;
  for (let k = n - 2; k >= 1; k--) {
    let mx = 0;
    for (let si = 0; si < S; si++) {
      let v = 0;
      for (let ti = 0; ti < S; ti++) {
        const p = stepProb(STATES[si], STATES[ti]);
        if (p) v += p * (k + 1 === n - 1 ? 1 : w(k + 1, STATES[ti])) * beta[k + 1][ti];
      }
      beta[k][si] = v;
      mx = Math.max(mx, v);
    }
    if (mx > 0) for (let si = 0; si < S; si++) beta[k][si] /= mx; // avoid underflow
  }
  // forward sampling from "o i"
  const out = ['o', 'i'];
  let cur = IDX('i', 1);
  for (let k = 2; k < n; k++) {
    const probs = STATES.map((st, ti) => stepProb(STATES[cur], st) * (k === n - 1 ? 1 : w(k, st)) * beta[k][ti]);
    const tot = probs.reduce((a, b) => a + b, 0);
    let r = rand() * tot, ti = 0;
    while (ti < S - 1 && (r -= probs[ti]) > 0) ti++;
    while (!probs[ti]) ti--; // guard against rounding at the end
    cur = ti;
    out.push(STATES[ti].l);
  }
  return out;
}

// ---------- shared ----------

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
  const wild = opts.style === 'wild';
  const rand = mulberry32(hashNotes(notes) ^ (opts.seed ?? 0));
  const out = [];
  let wordIdx = 0, eventIdx = 0;
  passages.forEach((passage, pi) => {
    // wild: the whole passage is one word; classic: oia / oiia / oiiia words
    const words = wild ? [wildPassage(passage, secPerBeatAt, rand)]
      : planWords(passage, secPerBeatAt).map(wordSyllables);
    let i = 0;
    for (const syls of words) {
      let iRun = 0;
      syls.forEach((syl, j) => {
        const ev = passage[i + j];
        iRun = syl === 'i' ? iRun + 1 : 0;
        const sample = syl === 'i' ? (iRun % 2 ? 'i' : 'i2') : syl;
        for (const n of ev.notes) out.push({ ...n, syl, sample, passage: pi, word: wordIdx, event: eventIdx, wordStart: j === 0 });
        eventIdx++;
      });
      i += syls.length;
      wordIdx++;
    }
  });
  return { notes: out, passages: passages.length, words: wordIdx };
}

// Keep only the highest note of each event (for "melody only" mode).
export function topLine(notes, onsetTol = 0.03) {
  return groupEvents(notes, onsetTol).map((e) => e.notes.reduce((a, b) => (b.midi > a.midi ? b : a)));
}
