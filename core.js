/* Fret Tutor core: music theory, pitch detection, grading and coaching.
   No DOM in this file, so it runs in the browser and under Node for tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FT = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- Theory ---------- */
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const OPEN_MIDI = [40, 45, 50, 55, 59, 64]; // low E to high e
  const STRING_NAMES = ['low E', 'A', 'D', 'G', 'B', 'high e'];
  const STRING_SHORT = ['E', 'A', 'D', 'G', 'B', 'e'];
  const MINOR_PENT = [0, 3, 5, 7, 10];

  const noteName = (midi) => NOTE_NAMES[((midi % 12) + 12) % 12];
  const octaveName = (midi) => noteName(midi) + (Math.floor(midi / 12) - 1);
  const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);
  const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

  /* Major and relative minor pentatonic share the same five shapes. The shapes
     are anchored on the minor root, so Shape 1 starts there on the low E string. */
  function scalePcs(rootPc, quality) {
    const minorRoot = quality === 'major' ? (rootPc + 9) % 12 : rootPc;
    return MINOR_PENT.map((i) => (minorRoot + i) % 12);
  }

  function nextScaleMidi(midi, pcs) {
    let m = midi + 1;
    while (!pcs.includes(((m % 12) + 12) % 12)) m++;
    return m;
  }

  /* A position is twelve consecutive scale notes, two on each string. */
  function shapeNotes(shape, rootPc, quality) {
    const pcs = scalePcs(rootPc, quality);
    const startPc = pcs[shape - 1];
    let startFret = 0;
    while ((40 + startFret) % 12 !== startPc) startFret++;

    const build = (fret) => {
      const out = [];
      let midi = 40 + fret;
      for (let s = 0; s < 6; s++) {
        for (let k = 0; k < 2; k++) {
          out.push({ string: s, fret: midi - OPEN_MIDI[s], midi, pc: midi % 12, isRoot: midi % 12 === rootPc, shape });
          midi = nextScaleMidi(midi, pcs);
        }
      }
      return out;
    };

    let notes = build(startFret);
    if (notes.some((n) => n.fret < 0)) notes = build(startFret + 12);
    assignFingers(notes);
    return notes;
  }

  /* Index finger sits on the fret most strings start from. A string that reaches
     lower or wider than that is fingered from its own lowest note. */
  function assignFingers(notes) {
    const lows = [];
    for (let s = 0; s < 6; s++) lows.push(Math.min(...notes.filter((n) => n.string === s).map((n) => n.fret)));
    const counts = {};
    lows.forEach((l) => (counts[l] = (counts[l] || 0) + 1));
    const base = +Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a - b)[0];
    notes.forEach((n) => {
      if (n.fret === 0) { n.finger = 0; return; }
      const low = lows[n.string];
      const f = low < base ? n.fret - low + 1 : n.fret - base + 1;
      n.finger = Math.max(1, Math.min(4, f));
    });
    notes.positionFret = base;
  }

  function dedupeAdjacent(seq) {
    return seq.filter((n, i) => i === 0 || n.midi !== seq[i - 1].midi);
  }

  /* ---------- Curriculum ---------- */
  const SHAPE_DRILLS = [
    { id: 'up', name: 'Walk up', pattern: 'up', how: 'Play each lit note in order, from the low E string to the high e. The next dot lights up once I hear the note, so take your time.' },
    { id: 'down', name: 'Walk down', pattern: 'down', how: 'Start on the highest note and come back down. Most players find this direction harder at first, so go slower than you think you need to.' },
    { id: 'click', name: 'Up and down to the click', pattern: 'updown', timed: true, bpm: 60, how: 'Play one note on each click, up the shape and back down. You get four clicks to count in. Timing is scored here.' },
    { id: 'memory', name: 'From memory', pattern: 'updown', hidden: true, how: 'Study the shape now. Once you start, only the root notes stay on screen, and you play the shape up and back down without the other dots.' },
    { id: 'find', name: 'Find the notes', pattern: 'find', hidden: true, how: 'I name a note and a string, you find it inside this shape. The dots stay hidden, which teaches you the note names and not just the pattern.' },
  ];
  const CONNECT_DRILLS = [
    { id: 'cross', name: 'Cross over', pattern: 'cross', how: 'Go up the first shape, move to the top of the next shape, and come back down it. Each shape shares notes with its neighbor, so look for the overlap.' },
    { id: 'crossclick', name: 'Cross over to the click', pattern: 'cross', timed: true, bpm: 60, how: 'The same route, one note per click. The position shift has to happen in time, so plan your hand move a beat early.' },
    { id: 'crossmem', name: 'Cross over from memory', pattern: 'cross', hidden: true, how: 'The same route with only the roots showing. If you get lost, find the nearest root and rebuild the shape around it.' },
  ];
  const RELAY_DRILLS = [
    { id: 'relay', name: 'Shape relay', pattern: 'relay', how: 'Climb the whole neck: Shape 1 up, 2 down, 3 up, 4 down, 5 up. Sixty notes, no click. This is the final test of how well the shapes connect.' },
  ];

  const STAGES = [
    { id: 's1', kind: 'shape', shape: 1, title: 'Shape 1', drills: SHAPE_DRILLS },
    { id: 's2', kind: 'shape', shape: 2, title: 'Shape 2', drills: SHAPE_DRILLS },
    { id: 'c12', kind: 'connect', shapes: [1, 2], title: 'Connect 1 + 2', drills: CONNECT_DRILLS },
    { id: 's3', kind: 'shape', shape: 3, title: 'Shape 3', drills: SHAPE_DRILLS },
    { id: 'c23', kind: 'connect', shapes: [2, 3], title: 'Connect 2 + 3', drills: CONNECT_DRILLS },
    { id: 's4', kind: 'shape', shape: 4, title: 'Shape 4', drills: SHAPE_DRILLS },
    { id: 'c34', kind: 'connect', shapes: [3, 4], title: 'Connect 3 + 4', drills: CONNECT_DRILLS },
    { id: 's5', kind: 'shape', shape: 5, title: 'Shape 5', drills: SHAPE_DRILLS },
    { id: 'c45', kind: 'connect', shapes: [4, 5], title: 'Connect 4 + 5', drills: CONNECT_DRILLS },
    { id: 'neck', kind: 'relay', shapes: [1, 2, 3, 4, 5], title: 'Whole neck', drills: RELAY_DRILLS },
  ];

  const getStage = (id) => STAGES.find((s) => s.id === id);
  const getDrill = (stage, id) => stage.drills.find((d) => d.id === id);
  const stageShapes = (stage) => (stage.kind === 'shape' ? [stage.shape] : stage.shapes);

  function allDrills() {
    const out = [];
    STAGES.forEach((stage) => stage.drills.forEach((drill) => out.push({ stage, drill, key: stage.id + '.' + drill.id })));
    return out;
  }

  function buildSequence(stage, drill, rootPc, quality, rng) {
    const r = rng || Math.random;
    const notes = stageShapes(stage).map((s) => shapeNotes(s, rootPc, quality));
    const first = notes[0];
    switch (drill.pattern) {
      case 'up': return first.slice();
      case 'down': return first.slice().reverse();
      case 'updown': return dedupeAdjacent(first.concat(first.slice().reverse()));
      case 'cross': return dedupeAdjacent(first.concat(notes[1].slice().reverse()));
      case 'relay': return dedupeAdjacent(notes.reduce((acc, ns, i) => acc.concat(i % 2 === 0 ? ns : ns.slice().reverse()), []));
      case 'find': {
        const out = [];
        let guard = 0;
        while (out.length < 8 && guard++ < 200) {
          const pick = first[Math.floor(r() * first.length)];
          if (out.includes(pick)) continue;
          if (out.length && out[out.length - 1].midi === pick.midi) continue;
          out.push(pick);
        }
        return out;
      }
    }
    return first.slice();
  }

  function stageTip(stage, rootPc, quality) {
    if (stage.kind === 'relay') return 'Keep your hand relaxed as you travel. Every shift lands on a note you already know from the shape below it.';
    const a = shapeNotes(stageShapes(stage)[0], rootPc, quality);
    const low = Math.min(...a.map((n) => n.fret));
    const high = Math.max(...a.map((n) => n.fret));
    if (stage.kind === 'connect') {
      return `Shape ${stage.shapes[0]} sits around frets ${low} to ${high}. Its top note on each string is the bottom note of Shape ${stage.shapes[1]}, so your hand only moves over by one note.`;
    }
    const roots = a.filter((n) => n.isRoot).map((n) => `${STRING_NAMES[n.string]} fret ${n.fret}`);
    const rootText = roots.length ? ` The big dots are the root, ${noteName(rootPc)}: ${roots.join(', ')}.` : '';
    const lowG = Math.min(...a.filter((n) => n.string === 3).map((n) => n.fret));
    const lowB = Math.min(...a.filter((n) => n.string === 4).map((n) => n.fret));
    const shift = lowB > lowG ? ' The pattern moves up one fret on the B string, which catches most people out.' : '';
    return `This shape covers frets ${low} to ${high}. Put your index finger at fret ${a.positionFret}.${rootText}${shift}`;
  }

  /* ---------- Pitch detection (YIN) ---------- */
  function decimate(x, factor) {
    if (factor <= 1) return x;
    const n = Math.floor(x.length / factor);
    const out = new Float32Array(n);
    const offset = x.length - n * factor; // keep the newest samples
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = 0; j < factor; j++) sum += x[offset + i * factor + j];
      out[i] = sum / factor;
    }
    return out;
  }

  function rms(x, from, to) {
    let s = 0;
    const a = from || 0;
    const b = to == null ? x.length : to;
    for (let i = a; i < b; i++) s += x[i] * x[i];
    return Math.sqrt(s / Math.max(1, b - a));
  }

  /* Returns the fundamental frequency and a 0 to 1 clarity value. */
  function detectPitch(input, sampleRate, opts) {
    const o = opts || {};
    const factor = Math.max(1, Math.round(sampleRate / 24000));
    const x = decimate(input, factor);
    const sr = sampleRate / factor;
    const tauMax = Math.min(Math.floor(sr / (o.fmin || 70)), Math.floor(x.length / 2));
    const tauMin = Math.max(2, Math.floor(sr / (o.fmax || 1300)));
    const W = Math.min(x.length - tauMax, Math.floor(sr * 0.045));
    if (W < 64) return { freq: 0, clarity: 0 };
    const offset = x.length - W - tauMax;
    const d = new Float32Array(tauMax + 1);
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let i = 0; i < W; i++) {
        const delta = x[offset + i] - x[offset + i + tau];
        sum += delta * delta;
      }
      d[tau] = sum;
    }
    const cmnd = new Float32Array(tauMax + 1);
    cmnd[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      running += d[tau];
      cmnd[tau] = running > 0 ? (d[tau] * tau) / running : 1;
    }
    const threshold = o.threshold || 0.15;
    let best = -1;
    for (let tau = tauMin; tau < tauMax; tau++) {
      if (cmnd[tau] < threshold) {
        while (tau + 1 < tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) {
      let min = Infinity;
      for (let tau = tauMin; tau < tauMax; tau++) {
        if (cmnd[tau] < min) { min = cmnd[tau]; best = tau; }
      }
    }
    if (best <= 0) return { freq: 0, clarity: 0 };
    const a = cmnd[best - 1];
    const b = cmnd[best];
    const c = best + 1 <= tauMax ? cmnd[best + 1] : b;
    const denom = 2 * (a - 2 * b + c);
    const shift = denom !== 0 ? (a - c) / denom : 0;
    const period = best + (Math.abs(shift) < 1 ? shift : 0);
    return { freq: sr / period, clarity: Math.max(0, Math.min(1, 1 - b)) };
  }

  /* Finds pick attacks from jumps in loudness, timed to about 5 ms, so timing
     scores do not inherit the delay of the pitch detector. */
  class OnsetDetector {
    constructor() { this.avg = 0; this.lastT = -1; this.lastOnset = -1; }
    process(x, sampleRate, tNow, gate) {
      const win = Math.round(sampleRate * 0.02);
      const hop = Math.round(sampleRate * 0.005);
      if (this.lastT < 0) { this.lastT = tNow; this.avg = rms(x, x.length - win, x.length); return null; }
      const fresh = Math.min(x.length - win, Math.round((tNow - this.lastT) * sampleRate));
      this.lastT = tNow;
      let found = null;
      const alpha = Math.min(1, (hop / sampleRate) / 0.06);
      for (let end = x.length - fresh + hop; end <= x.length; end += hop) {
        const r = rms(x, end - win, end);
        const t = tNow - (x.length - end) / sampleRate - 0.01;
        if (r > gate * 1.3 && r > this.avg * 1.7 && t - this.lastOnset > 0.09) {
          this.lastOnset = t;
          if (found == null) found = t;
        }
        this.avg += (r - this.avg) * alpha;
      }
      return found;
    }
  }

  /* Turns a stream of pitch frames into note events:
     'on' for a newly played note and 'hold' while it rings. */
  class NoteTracker {
    constructor(minFrames) {
      this.minFrames = minFrames || 3;
      this.reset();
    }
    reset() {
      this.cur = null; this.curT = -1; this.cand = null; this.count = 0;
      this.silent = 0; this.lastOnset = -1; this.usedOnset = -1; this.buf = [];
    }
    push(f) {
      if (f.onsetT != null) this.lastOnset = f.onsetT;
      const voiced = f.freq > 0 && f.clarity >= 0.8 && f.rms >= f.gate;
      if (!voiced) {
        if (++this.silent >= 4) { this.cur = null; this.cand = null; this.count = 0; }
        return null;
      }
      this.silent = 0;
      const exact = freqToMidi(f.freq);
      const midi = Math.round(exact);
      const cents = (exact - midi) * 100;
      if (midi === this.cand) { this.count++; } else { this.cand = midi; this.count = 1; this.buf = []; }
      this.buf.push(cents);
      if (this.buf.length > 8) this.buf.shift();
      if (this.count < this.minFrames) return null;
      const freshOnset = this.lastOnset > this.usedOnset && f.t - this.lastOnset < 0.35;
      if (midi !== this.cur || (freshOnset && f.t - this.curT > 0.2)) {
        const t = freshOnset ? this.lastOnset : f.t - 0.09;
        this.cur = midi; this.curT = t; this.usedOnset = this.lastOnset;
        return { type: 'on', midi, t, cents: median(this.buf) };
      }
      return { type: 'hold', midi, t: f.t, cents };
    }
  }

  /* Phone mics often lose the low fundamental, which reads as one octave up.
     Low targets accept that octave. */
  function matchesTarget(midi, target) {
    return midi === target || (target <= 52 && midi === target + 12);
  }

  /* ---------- Grading ---------- */
  function median(a) {
    if (!a.length) return 0;
    const s = a.slice().sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const STAR_LEVELS = [80, 90, 97];
  const starsFor = (score) => STAR_LEVELS.filter((l) => score >= l).length;

  function grade(session) {
    const { seq, results, wrong, timed, tap } = session;
    const total = seq.length;
    const hits = results.filter((r) => r.hit);
    const accuracy = clamp((hits.length / (total + wrong.length)) * 100, 0, 100);

    const noteCents = hits.filter((r) => r.cents.length).map((r) => median(r.cents));
    const meanCents = mean(noteCents);
    const meanAbsCents = mean(noteCents.map(Math.abs));
    const intonation = tap || !noteCents.length ? null : clamp(100 - Math.max(0, meanAbsCents - 8) * 2.5, 0, 100);

    let timing = null, meanDelta = null, jitter = null, flow = null, medianGap = null;
    if (timed) {
      const deltas = hits.map((r) => r.delta).filter((d) => d != null);
      if (deltas.length) {
        meanDelta = mean(deltas);
        jitter = Math.sqrt(mean(deltas.map((d) => (d - meanDelta) ** 2)));
        timing = mean(deltas.map((d) => clamp(100 - ((Math.abs(d) - 0.04) / 0.16) * 100, 0, 100)));
      } else timing = 0;
    } else {
      const times = results.map((r) => r.t).filter((t) => t != null);
      const gaps = times.slice(1).map((t, i) => t - times[i]);
      medianGap = gaps.length ? median(gaps) : null;
      flow = medianGap == null ? 0 : clamp(100 - Math.max(0, medianGap - 1.5) * 13, 40, 100);
    }

    const weights = timed ? [[accuracy, 0.5], [timing, 0.4], [intonation, 0.1]] : [[accuracy, 0.7], [flow, 0.2], [intonation, 0.1]];
    const used = weights.filter(([v]) => v != null);
    const sumW = used.reduce((s, [, w]) => s + w, 0);
    let score = used.reduce((s, [v, w]) => s + v * w, 0) / (sumW || 1);
    if (!hits.length) score = 0;
    score = Math.round(score);

    const perNote = results.map((r) => {
      if (!r.hit) return 'missed';
      const c = r.cents.length ? Math.abs(median(r.cents)) : 0;
      if (r.wrongs > 0 || c > 25 || (r.delta != null && Math.abs(r.delta) > 0.12)) return 'shaky';
      return 'clean';
    });

    return {
      score, stars: starsFor(score), pass: score >= STAR_LEVELS[0],
      accuracy: Math.round(accuracy),
      intonation: intonation == null ? null : Math.round(intonation),
      timing: timing == null ? null : Math.round(timing),
      flow: flow == null ? null : Math.round(flow),
      hits: hits.length, total, wrongCount: wrong.length, missed: total - hits.length,
      meanCents, meanAbsCents, meanDelta, jitter, medianGap, perNote, timed: !!timed, tap: !!tap,
    };
  }

  const describeNote = (n) => `${noteName(n.midi)} on the ${STRING_NAMES[n.string]} string, fret ${n.fret}`;

  function describeMiss(playedMidi, target) {
    const diff = playedMidi - target.midi;
    const size = Math.abs(diff);
    if (size === 12) return `That was ${noteName(playedMidi)} an octave ${diff > 0 ? 'above' : 'below'}. Find the one on the ${STRING_NAMES[target.string]} string.`;
    if (size <= 5) return `That was ${noteName(playedMidi)}, ${size === 1 ? 'one fret' : size + ' frets'} too ${diff > 0 ? 'high' : 'low'}.`;
    return `That was ${noteName(playedMidi)}. Check you are on the ${STRING_NAMES[target.string]} string.`;
  }

  /* Rule-based coach. Returns the most useful notes first, each tied to
     something measured in this attempt. */
  function coachNotes(session, report) {
    const notes = [];
    const add = (priority, tone, title, body, action) => notes.push({ priority, tone, title, body, action });
    const { seq, wrong, results } = session;

    if (wrong.length) {
      const tally = {};
      wrong.forEach((w) => {
        const k = w.idx + ':' + w.midi;
        tally[k] = tally[k] || { n: 0, idx: w.idx, midi: w.midi };
        tally[k].n++;
      });
      const worst = Object.values(tally).sort((a, b) => b.n - a.n)[0];
      const target = seq[worst.idx];
      if (target) {
        const fretGuess = worst.midi - OPEN_MIDI[target.string];
        const onString = fretGuess >= 0 && fretGuess <= 22 && Math.abs(fretGuess - target.fret) <= 5
          ? ` You played fret ${fretGuess} where the note is at fret ${target.fret}.` : '';
        add(wrong.length >= 3 ? 90 : 60, 'fix', `Watch ${noteName(target.midi)} on the ${STRING_NAMES[target.string]} string`,
          `It came out as ${noteName(worst.midi)} ${worst.n > 1 ? worst.n + ' times' : 'once'}.${onString} Play the two notes before it and this one, five times slowly.`);
      }
      const crossings = wrong.filter((w) => w.idx > 0 && seq[w.idx] && seq[w.idx].string !== seq[w.idx - 1].string);
      if (crossings.length >= 2 && crossings.length / wrong.length >= 0.5) {
        add(80, 'fix', 'Your slips come on string changes',
          `${crossings.length} of ${wrong.length} wrong notes came just as you moved to a new string. Look at the next string before you leave the current one.`);
      }
      const bString = wrong.filter((w) => seq[w.idx] && seq[w.idx].string === 4);
      if (bString.length >= 2 && bString.length / wrong.length >= 0.4) {
        add(85, 'fix', 'The B string is tripping you up',
          'The tuning between G and B is one fret narrower than between the other strings, so the pattern moves up a fret there. Practice just the G and B string notes for a minute.');
      }
    }

    if (report.timed && report.meanDelta != null) {
      const ms = Math.round(Math.abs(report.meanDelta) * 1000);
      if (report.meanDelta < -0.03) add(75, 'fix', 'You are rushing', `On average you played ${ms} ms ahead of the click. Try to place each note right on the click, and count "1 and 2 and" out loud.`);
      else if (report.meanDelta > 0.03) add(75, 'fix', 'You are dragging', `On average you played ${ms} ms behind the click. Move your fretting finger into place before the click, then pick on it.`);
      if (report.jitter > 0.07) add(65, 'fix', 'Your timing is uneven', `Your notes varied by about ${Math.round(report.jitter * 1000)} ms around the click. A slower tempo will help more than extra repetitions at this speed.`);
    }
    if (report.timed && report.missed > 0) {
      const firstMiss = results.findIndex((r) => !r.hit);
      const missedLate = results.slice(Math.floor(results.length * 0.5)).filter((r) => !r.hit).length;
      if (missedLate / report.missed >= 0.7) add(70, 'fix', 'You lost your place on the way back', `Most of the ${report.missed} missed notes came in the second half. Practice the turnaround at the top by itself.`);
      else if (firstMiss >= 0) add(55, 'fix', `${report.missed} notes went by without you`, `The first was ${describeNote(seq[firstMiss])}. If the click feels hard to keep up with, drop the tempo by 5 BPM.`);
    }

    if (!report.tap && report.intonation != null) {
      if (report.meanCents > 14) add(50, 'fix', 'Your notes are coming out sharp', `You averaged ${Math.round(report.meanCents)} cents above pitch. Check your tuning first. If it is good, ease your finger pressure, because pressing too hard bends the note up.`, 'tune');
      else if (report.meanCents < -14) add(50, 'fix', 'Your notes are coming out flat', `You averaged ${Math.round(-report.meanCents)} cents below pitch, which usually means the guitar needs tuning.`, 'tune');
      else if (report.meanAbsCents > 22) add(45, 'fix', 'Your pitch is varying', `Individual notes were about ${Math.round(report.meanAbsCents)} cents off in both directions. Place each finger right behind the fret and avoid pulling the string sideways.`);
    }

    if (!report.timed && results.length > 3) {
      const times = results.map((r) => r.t);
      let slowest = -1, slowestGap = 0;
      for (let i = 1; i < times.length; i++) {
        if (times[i] == null || times[i - 1] == null) continue;
        const gap = times[i] - times[i - 1];
        if (gap > slowestGap) { slowestGap = gap; slowest = i; }
      }
      if (slowest > 0 && report.medianGap != null && slowestGap > Math.max(2.5, report.medianGap * 2.5)) {
        add(40, 'fix', 'One note made you stop', `You took ${slowestGap.toFixed(1)} seconds to find ${describeNote(seq[slowest])}, against ${report.medianGap.toFixed(1)} seconds for a typical note.`);
      }
    }

    if (report.pass && !notes.some((n) => n.priority >= 70)) {
      if (report.score >= 97) add(30, 'good', 'That was close to flawless', 'Accurate and steady all the way through. This one is ready to move on from.');
      else if (report.wrongCount === 0) add(30, 'good', 'Every note was right', 'No wrong notes at all. Your score will rise further as your playing gets more even.');
      else add(30, 'good', 'You passed this drill', `You hit ${report.hits} of ${report.total} notes. Coming back to this one tomorrow will help it stick.`);
    }
    if (!report.hits) {
      notes.length = 0;
      add(100, 'fix', 'I did not hear any matching notes', 'Move the phone or laptop closer to the guitar, and make sure you are in tune. The level meter at the top should jump when you pick a string.', 'tune');
    }
    return notes.sort((a, b) => b.priority - a.priority).slice(0, 3);
  }

  /* ---------- Progress ---------- */
  function nextBpm(bpm, score) {
    if (score >= 90) return clamp(bpm + 5, 40, 160);
    if (score < 70) return clamp(bpm - 5, 40, 160);
    return bpm;
  }

  const isPassed = (progress, key) => !!(progress[key] && progress[key].best >= STAR_LEVELS[0]);

  function nextDrill(progress) {
    return allDrills().find((d) => !isPassed(progress, d.key)) || null;
  }

  /* Oldest low-scoring drill you have passed but not touched for two days. */
  function reviewDrill(progress, now) {
    const twoDays = 2 * 864e5;
    const items = allDrills().filter((d) => isPassed(progress, d.key) && now - (progress[d.key].lastAt || 0) > twoDays && progress[d.key].stars < 3);
    items.sort((a, b) => progress[a.key].lastScore - progress[b.key].lastScore);
    return items[0] || null;
  }

  function overallPercent(progress) {
    const list = allDrills();
    return Math.round((list.filter((d) => isPassed(progress, d.key)).length / list.length) * 100);
  }

  function dayStreak(seconds, today) {
    let streak = 0;
    const d = new Date(today);
    const fmt = (x) => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
    if (!seconds[fmt(d)]) d.setDate(d.getDate() - 1); // today not practiced yet does not break a streak
    while (seconds[fmt(d)]) { streak++; d.setDate(d.getDate() - 1); }
    return streak;
  }

  return {
    NOTE_NAMES, OPEN_MIDI, STRING_NAMES, STRING_SHORT, STAGES, STAR_LEVELS,
    noteName, octaveName, freqToMidi, midiToFreq, scalePcs, shapeNotes, buildSequence, stageTip,
    getStage, getDrill, stageShapes, allDrills,
    detectPitch, rms, median, OnsetDetector, NoteTracker, matchesTarget,
    grade, coachNotes, describeNote, describeMiss, starsFor, nextBpm, isPassed, nextDrill, reviewDrill, overallPercent, dayStreak,
  };
});
