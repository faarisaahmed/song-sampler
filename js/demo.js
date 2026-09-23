// Built-in demo: Ode to Joy (Beethoven, public domain), melody + bass.
const BPM = 132;
const spb = 60 / BPM;
const N = { G2: 43, C3: 48, D3: 50, G3: 55, C4: 60, D4: 62, E4: 64, F4: 65, G4: 67 };

// [note, beats]
const line = (s) => s.split(' ').map((t) => { const [n, b] = t.split(':'); return [N[n], parseFloat(b)]; });
const A = 'E4:1 E4:1 F4:1 G4:1 G4:1 F4:1 E4:1 D4:1 C4:1 C4:1 D4:1 E4:1';
const melody = line(
  `${A} E4:1.5 D4:0.5 D4:2 ${A} D4:1.5 C4:0.5 C4:2 ` +
  'D4:1 D4:1 E4:1 C4:1 D4:1 E4:0.5 F4:0.5 E4:1 C4:1 D4:1 E4:0.5 F4:0.5 E4:1 D4:1 C4:1 D4:1 G3:2 ' +
  `${A} D4:1.5 C4:0.5 C4:2`
);
const bassBars = 'C G C G C G C GC G C G CG C G C GC'.match(/GC|CG|C|G/g);
const bass = bassBars.flatMap((b) => {
  if (b === 'GC') return [[N.G2, 2], [N.C3, 2]];
  if (b === 'CG') return [[N.C3, 2], [N.G2, 2]];
  return b === 'C' ? [[N.C3, 2], [N.G2, 2]] : [[N.G2, 2], [N.D3, 2]];
});

const toNotes = (seq, vel) => {
  let t = 0;
  return seq.map(([midi, beats]) => {
    const n = { midi, time: t * spb, duration: beats * spb * 0.92, velocity: vel, channel: 0 };
    t += beats;
    return n;
  });
};

export function demoSong() {
  const tracks = [
    { name: 'Melody', notes: toNotes(melody, 0.9), channel: 0, isDrums: false, program: 0 },
    { name: 'Bass', notes: toNotes(bass, 0.6), channel: 1, isDrums: false, program: 32 },
  ];
  const duration = Math.max(...tracks.flatMap((t) => t.notes.map((n) => n.time + n.duration)));
  return { tracks, duration, bpm: BPM, secPerBeatAt: () => spb, name: 'Ode to Joy (demo)' };
}
