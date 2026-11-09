/* Fret Tutor UI: audio, drill engine and rendering. Logic lives in core.js. */
(function () {
  'use strict';
  const FT = window.FT;
  const $ = (id) => document.getElementById(id);

  /* ---------- Saved state ---------- */
  const STORE_KEY = 'fret-tutor-v1';
  const defaults = () => ({ root: 9, quality: 'major', display: 'fingers', progress: {}, history: [], seconds: {}, stage: null, drill: null, micId: null });
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? Object.assign(defaults(), JSON.parse(raw)) : defaults();
    } catch (e) { return defaults(); }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* private mode: progress lasts this visit only */ }
  }
  const state = load();
  const dayKey = (d) => { const x = d || new Date(); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };

  const ui = { view: 'practice', stage: null, drill: null, session: null, tap: false, demo: null, flash: null, explorerShapes: [1], bpmOverride: {} };

  function selectInitial() {
    const next = FT.nextDrill(state.progress) || FT.allDrills()[0];
    ui.stage = FT.getStage(state.stage) || next.stage;
    ui.drill = (state.drill && FT.getDrill(ui.stage, state.drill)) || (ui.stage === next.stage ? next.drill : ui.stage.drills[0]);
  }
  const drillKey = () => ui.stage.id + '.' + ui.drill.id;
  const keyLabel = () => `${FT.NOTE_NAMES[state.root]} ${state.quality} pentatonic`;
  const currentBpm = () => {
    const k = drillKey();
    return ui.bpmOverride[k] || (state.progress[k] && state.progress[k].bpm) || ui.drill.bpm || 60;
  };

  /* ---------- Audio ---------- */
  const audio = { ctx: null, stream: null, analyser: null, buf: null, timer: null, gate: 0.004, calib: [], calibUntil: 0, onset: new FT.OnsetDetector(), tracker: new FT.NoteTracker(3), ignoreUntil: 0, plucks: {}, noise: null, inLat: 0, tuneMidi: null };

  function getCtx() {
    if (!audio.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      audio.ctx = new AC({ latencyHint: 'interactive' });
    }
    if (audio.ctx.state !== 'running') audio.ctx.resume().catch(() => {});
    return audio.ctx;
  }
  const outLatency = () => (audio.ctx ? audio.ctx.outputLatency || audio.ctx.baseLatency || 0 : 0);

  async function enableMic() {
    if (audio.stream) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const e = new Error('insecure'); e.name = 'InsecureContext'; throw e;
    }
    const ctx = getCtx();
    const constraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: state.micId ? Object.assign({ deviceId: { exact: state.micId } }, constraints) : constraints, video: false,
      });
    } catch (err) {
      // The saved mic was unplugged: fall back to the system default.
      if (!state.micId || !/NotFound|Overconstrained|NotReadable/.test(err.name)) throw err;
      state.micId = null; save();
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
    }
    if (audio.stream) { stream.getTracks().forEach((t) => t.stop()); return; } // a second click won the race
    audio.stream = stream;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = ctx.sampleRate > 50000 ? 8192 : 4096;
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser);
    const sink = ctx.createGain(); // older Safari only runs nodes that reach the output
    sink.gain.value = 0;
    analyser.connect(sink); sink.connect(ctx.destination);
    audio.analyser = analyser;
    audio.source = source;
    audio.sink = sink;
    audio.buf = new Float32Array(analyser.fftSize);
    audio.calib = [];
    audio.calibUntil = ctx.currentTime + 0.5;
    audio.onset = new FT.OnsetDetector();
    audio.tracker.reset();
    audio.timer = setInterval(listenTick, 30);
    const settings = stream.getAudioTracks()[0].getSettings ? stream.getAudioTracks()[0].getSettings() : {};
    audio.inLat = settings.latency || 0;
    stream.getAudioTracks()[0].addEventListener('ended', disableMic);
    audio.liveId = settings.deviceId || null;
    updateMicUi();
    refreshMics();
  }

  /* Microphone picker. Browsers hide device names until the mic has been allowed once. */
  async function refreshMics() {
    const sel = $('micSel');
    if (!sel) return;
    let mics = [];
    try {
      mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    } catch (e) { /* not supported here */ }
    const named = mics.some((d) => d.label);
    const current = state.micId || audio.liveId || '';
    sel.innerHTML = '';
    const add = (value, text) => {
      const o = document.createElement('option');
      o.value = value; o.textContent = text;
      sel.appendChild(o);
    };
    if (!named) add('', mics.length ? 'Default microphone' : 'No microphone found');
    else mics.forEach((d, i) => add(d.deviceId, d.label || `Microphone ${i + 1}`));
    if (named && current && [...sel.options].some((o) => o.value === current)) sel.value = current;
    sel.disabled = !named || mics.length < 2;
    $('micHint').textContent = !mics.length ? 'Connect a microphone, then turn on the mic.'
      : !named ? 'Turn on the mic once, and the browser will list all your microphones here.'
      : mics.length < 2 ? 'This is the only microphone this browser can see.'
      : 'Pick a mic, then pluck a string. The meter at the top should jump. Your choice is remembered.';
  }

  async function switchMic(id) {
    state.micId = id || null;
    save();
    if (!audio.stream) { refreshMics(); return; }
    if (ui.session) stopSession();
    disableMic();
    try { await enableMic(); renderTunerIdle(); }
    catch (err) { updateMicUi(true); $('tuneStatus').textContent = micErrorMessage(err); refreshMics(); }
  }

  function disableMic() {
    if (audio.timer) clearInterval(audio.timer);
    audio.timer = null;
    if (audio.stream) audio.stream.getTracks().forEach((t) => t.stop());
    if (audio.source) audio.source.disconnect();
    if (audio.sink) audio.sink.disconnect();
    audio.stream = audio.analyser = audio.source = audio.sink = null;
    audio.liveId = null;
    $('micLevel').style.transform = 'scaleX(0)';
    updateMicUi();
    renderTunerIdle();
  }

  function updateMicUi(errored) {
    const on = !!audio.stream;
    const btn = $('micBtn');
    btn.classList.toggle('on', on);
    btn.classList.toggle('err', !!errored);
    btn.setAttribute('aria-pressed', String(on));
    $('micLabel').textContent = on ? 'Listening' : errored ? 'Mic blocked' : 'Mic off';
    $('tuneMic').hidden = on;
  }

  function micErrorMessage(err) {
    switch (err && err.name) {
      case 'InsecureContext': return 'This browser only allows the mic on secure pages. Open the page from an https:// address, or from localhost on this computer.';
      case 'NotAllowedError': case 'SecurityError': return 'Mic access is blocked. Allow the microphone for this page in your browser settings, then try again.';
      case 'NotFoundError': case 'OverconstrainedError': return 'No microphone was found on this device. Connect one, then try again.';
      case 'NotReadableError': return 'Another app is using the microphone. Close it, then try again.';
      default: return 'The microphone could not start. Reload the page and try again.';
    }
  }

  /* Runs about 33 times a second while the mic is on. */
  function listenTick() {
    const { ctx, analyser, buf } = audio;
    if (!analyser) return;
    analyser.getFloatTimeDomainData(buf);
    const t = ctx.currentTime;
    const sr = ctx.sampleRate;
    const level = FT.rms(buf, buf.length - Math.round(sr * 0.04), buf.length);
    $('micLevel').style.transform = `scaleX(${Math.min(1, Math.sqrt(level) * 2.4)})`;

    if (t < audio.calibUntil) { audio.calib.push(level); return; }
    if (audio.calib.length) {
      audio.gate = Math.max(0.003, FT.median(audio.calib) * 2.5);
      audio.calib = [];
    }

    const onsetT = audio.onset.process(buf, sr, t, audio.gate);
    if (t < audio.ignoreUntil) { audio.tracker.reset(); return; }

    let pitch = { freq: 0, clarity: 0 };
    if (level >= audio.gate) pitch = FT.detectPitch(buf, sr);
    if (ui.view === 'tune') updateTuner(pitch, level);

    const ev = audio.tracker.push({ t, rms: level, freq: pitch.freq, clarity: pitch.clarity, gate: audio.gate, onsetT });
    if (!ev) return;
    showHeard(ev.midi, ev.cents);
    if (ui.session && !ui.session.finished) handleNote(ui.session, ev);
  }

  /* Plucked string synth for the demo, reference notes and tap mode. */
  function pluckBuffer(midi) {
    if (audio.plucks[midi]) return audio.plucks[midi];
    const ctx = getCtx();
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * 1.3);
    const buffer = ctx.createBuffer(1, len, sr);
    const out = buffer.getChannelData(0);
    const N = Math.max(2, Math.round(sr / FT.midiToFreq(midi) - 0.5));
    for (let i = 0; i < N && i < len; i++) out[i] = Math.random() * 2 - 1;
    for (let i = N + 1; i < len; i++) out[i] = 0.995 * 0.5 * (out[i - N] + out[i - N - 1]);
    audio.plucks[midi] = buffer;
    return buffer;
  }
  function playPluck(midi, when) {
    const ctx = getCtx();
    const src = ctx.createBufferSource();
    src.buffer = pluckBuffer(midi);
    const gain = ctx.createGain();
    gain.gain.value = 0.5;
    src.connect(gain); gain.connect(ctx.destination);
    src.start(when || 0);
  }
  /* A short noise tick. It carries no pitch, so the mic cannot read it as a note. */
  function playClick(when, accent) {
    const ctx = getCtx();
    if (!audio.noise) {
      const len = Math.floor(ctx.sampleRate * 0.012);
      audio.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = audio.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    }
    const src = ctx.createBufferSource();
    src.buffer = audio.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass'; filter.frequency.value = 1800;
    const gain = ctx.createGain();
    gain.gain.value = accent ? 0.5 : 0.28;
    src.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
    src.start(when);
  }

  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && navigator.wakeLock && !wakeLock) wakeLock = await navigator.wakeLock.request('screen');
      if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) { wakeLock = null; }
  }

  /* ---------- Neck drawing ---------- */
  const NECK = { W: 360, left: 46, right: 26, head: 24, open: 46 };
  const stringX = (s) => NECK.left + (s * (NECK.W - NECK.left - NECK.right)) / 5;
  const INLAYS = [3, 5, 7, 9, 15, 17, 19, 21];

  function neckGeometry(from, to, rowH, hasOpen) {
    const first = Math.max(1, from);
    const openH = hasOpen ? NECK.open : 0;
    const top = NECK.head + openH;
    return {
      first, to, rowH, hasOpen, top,
      H: top + (to - first + 1) * rowH + 8,
      y: (fret) => (fret === 0 ? NECK.head + NECK.open / 2 : top + (fret - first + 0.5) * rowH),
    };
  }

  /* dots: {string, fret, cls, root, label} */
  function renderNeck(el, opts) {
    const { from, to, dots, tappable } = opts;
    const hasOpen = from === 0 || dots.some((d) => d.fret === 0);
    const rowH = opts.rowH || 64;
    const g = neckGeometry(from, to, rowH, hasOpen);
    const W = NECK.W;
    const boardL = stringX(0) - 16, boardR = stringX(5) + 16;
    const parts = [];
    parts.push(`<svg viewBox="0 0 ${W} ${g.H}" preserveAspectRatio="xMidYMin meet" role="img" aria-label="${opts.label || 'Guitar neck'}">`);
    parts.push(`<rect class="wood" x="${boardL}" y="${g.top}" width="${boardR - boardL}" height="${g.H - g.top - 8}" rx="2"/>`);
    for (let i = 0; i < 7; i++) {
      const x = boardL + 10 + i * ((boardR - boardL - 20) / 6) + (i % 2 ? 7 : -3);
      parts.push(`<line class="wood-grain" x1="${x}" x2="${x + (i % 3) - 1}" y1="${g.top}" y2="${g.H - 8}"/>`);
    }
    for (let f = g.first; f <= to; f++) {
      const yc = g.y(f);
      if (INLAYS.includes(f)) parts.push(`<circle class="inlay" cx="${(boardL + boardR) / 2}" cy="${yc}" r="5"/>`);
      if (f === 12 || f === 24) {
        parts.push(`<circle class="inlay" cx="${stringX(1) + 14}" cy="${yc}" r="5"/><circle class="inlay" cx="${stringX(4) - 14}" cy="${yc}" r="5"/>`);
      }
      const marked = INLAYS.includes(f) || f === 12;
      parts.push(`<text class="fretnum${marked ? ' mark' : ''}" x="16" y="${yc + 4}">${f}</text>`);
      const yb = g.top + (f - g.first + 1) * rowH;
      parts.push(`<line class="fretline" x1="${boardL}" x2="${boardR}" y1="${yb}" y2="${yb}"/>`);
    }
    if (g.first === 1) parts.push(`<line class="nutline" x1="${boardL}" x2="${boardR}" y1="${g.top}" y2="${g.top}"/>`);
    else parts.push(`<line class="fretline" x1="${boardL}" x2="${boardR}" y1="${g.top}" y2="${g.top}"/>`);
    for (let s = 0; s < 6; s++) {
      const x = stringX(s);
      parts.push(`<line class="stringline" x1="${x}" x2="${x}" y1="${g.top - (hasOpen ? NECK.open : 0)}" y2="${g.H - 8}" stroke-width="${(2.6 - s * 0.34).toFixed(2)}"/>`);
      parts.push(`<text class="stringname" x="${x}" y="15">${FT.STRING_SHORT[s]}</text>`);
    }
    if (tappable) {
      const cw = stringX(1) - stringX(0);
      for (let s = 0; s < 6; s++) {
        for (let f = hasOpen ? 0 : g.first; f <= to; f++) {
          const h = f === 0 ? NECK.open : rowH;
          parts.push(`<rect class="cell" data-s="${s}" data-f="${f}" x="${stringX(s) - cw / 2}" y="${g.y(f) - h / 2}" width="${cw}" height="${h}"/>`);
        }
      }
    }
    let targetY = null;
    dots.forEach((d) => {
      const x = stringX(d.string), y = g.y(d.fret);
      const base = d.root ? 18 : 13.5;
      const r = d.cls === 'g-target' ? base + 2 : base;
      if (d.cls === 'g-target') targetY = y;
      parts.push(`<g class="${d.cls || ''}" pointer-events="none"><circle class="halo" cx="${x}" cy="${y}" r="${r + 6}"/><circle class="dot" cx="${x}" cy="${y}" r="${r}"/>`);
      if (d.label != null && d.label !== '') {
        const small = String(d.label).length > 1;
        parts.push(`<text class="dot-label" x="${x}" y="${y}"${small ? ' style="font-size:13px"' : ''}>${d.label}</text>`);
      }
      parts.push('</g>');
    });
    parts.push('</svg>');
    el.innerHTML = parts.join('');
    el.classList.toggle('tall', !!opts.tall);
    if (opts.tall && targetY != null) {
      const svg = el.firstChild;
      el.scrollTop = (targetY / g.H) * svg.getBoundingClientRect().height - el.clientHeight / 2;
    }
  }

  const labelFor = (n) => {
    if (state.display === 'notes') return FT.noteName(n.midi);
    if (state.display === 'fingers') return n.finger === 0 ? 'O' : n.finger;
    return '';
  };

  function neckRange(seq) {
    const frets = seq.map((n) => n.fret);
    const min = Math.min(...frets), max = Math.max(...frets);
    return { from: min === 0 ? 0 : Math.max(1, min - 1), to: Math.min(24, max + 1) };
  }

  /* ---------- Practice view ---------- */
  function practiceSeq() {
    return FT.buildSequence(ui.stage, ui.drill.pattern === 'find' ? { pattern: 'up' } : ui.drill, state.root, state.quality);
  }

  function uniqueNotes(seq) {
    const seen = new Map();
    seq.forEach((n) => { const k = n.string + ':' + n.fret; if (!seen.has(k)) seen.set(k, n); });
    return [...seen.values()];
  }

  function renderPracticeNeck() {
    const s = ui.session;
    const demo = ui.demo;
    const seq = s ? s.seq : demo ? demo.seq : practiceSeq();
    const fullShape = s && s.drill.pattern === 'find' ? FT.shapeNotes(ui.stage.shape, state.root, state.quality) : seq;
    const range = neckRange(fullShape);
    const dots = [];
    const idx = s ? s.idx : demo ? demo.idx : -1;
    const hide = s && s.drill.hidden;
    const posKey = (n) => n && n.string + ':' + n.fret;
    const targetKey = idx >= 0 ? posKey(seq[idx]) : null;
    const nextKey = idx >= 0 && !hide ? posKey(seq[idx + 1]) : null;
    const doneKeys = new Set(seq.slice(0, Math.max(0, idx)).map(posKey));

    uniqueNotes(fullShape).forEach((n) => {
      const k = posKey(n);
      let cls = '';
      if (idx >= 0) {
        if (k === targetKey && !hide) cls = 'g-target';
        else if (doneKeys.has(k)) cls = 'g-done';
        else if (k === nextKey) cls = 'g-next';
        else if (hide && !n.isRoot) return; // hidden until played
      }
      const showLabel = idx < 0 || cls === 'g-target' || cls === 'g-done' || !hide;
      dots.push({ string: n.string, fret: n.fret, root: n.isRoot, cls, label: showLabel ? labelFor(n) : '' });
    });
    if (ui.flash) {
      const existing = dots.find((d) => d.string === ui.flash.string && d.fret === ui.flash.fret);
      if (existing) existing.cls = ui.flash.cls;
      else if (ui.flash.fret >= range.from && ui.flash.fret <= range.to) dots.push({ string: ui.flash.string, fret: ui.flash.fret, cls: ui.flash.cls, label: ui.flash.label });
    }
    const rows = range.to - Math.max(1, range.from) + 1;
    renderNeck($('neck'), {
      from: range.from, to: range.to, dots, tall: rows > 9, tappable: !!(s && s.tap), label: `${ui.stage.title} in ${keyLabel()}`,
    });
  }

  function flash(string, fret, cls, label, ms) {
    ui.flash = { string, fret, cls, label };
    renderPracticeNeck();
    clearTimeout(ui.flashTimer);
    ui.flashTimer = setTimeout(() => { ui.flash = null; if (ui.view === 'practice') renderPracticeNeck(); }, ms || 350);
  }

  function renderStageSelect() {
    const sel = $('stageSel');
    sel.innerHTML = FT.STAGES.map((st) => {
      const passed = st.drills.filter((d) => FT.isPassed(state.progress, st.id + '.' + d.id)).length;
      return `<option value="${st.id}">${st.title} (${passed}/${st.drills.length})</option>`;
    }).join('');
    sel.value = ui.stage.id;
  }

  function starsHtml(n) {
    return `<span class="stars" role="img" aria-label="${n} of 3 stars">${'★'.repeat(n)}<i>${'★'.repeat(3 - n)}</i></span>`;
  }

  function drillButton(stage, drill, i, nextKey, withStage) {
    const key = stage.id + '.' + drill.id;
    const p = state.progress[key];
    const passed = FT.isPassed(state.progress, key);
    const isNext = key === nextKey;
    const active = stage === ui.stage && drill === ui.drill && !withStage;
    return `<button type="button" role="listitem" class="drill${active ? ' active' : ''}${passed ? ' passed' : ''}${isNext ? ' next' : ''}" data-stage="${stage.id}" data-drill="${drill.id}">
      <span class="drill-mark" aria-hidden="true">${passed ? '✓' : i + 1}</span>
      <span>${drill.name}${isNext ? ' <span class="visually-next" style="color:var(--cyan);font-size:13px">next</span>' : ''}</span>
      ${p ? starsHtml(p.stars) : '<span></span>'}
    </button>`;
  }

  function renderLesson() {
    renderStageSelect();
    const next = FT.nextDrill(state.progress);
    const nextKey = next ? next.key : null;
    $('drillList').innerHTML = ui.stage.drills.map((d, i) => drillButton(ui.stage, d, i, nextKey)).join('');
    const active = $('drillList').querySelector('.active');
    if (active && $('drillList').scrollWidth > $('drillList').clientWidth) {
      $('drillList').scrollLeft = active.offsetLeft - 16;
    }
    $('howText').textContent = ui.drill.how;
    $('tempo').hidden = !ui.drill.timed;
    $('bpmVal').textContent = currentBpm();
    $('tapToggle').textContent = ui.tap ? 'Tap mode is on. Use the mic instead' : 'No guitar nearby? Tap the notes on screen';
    renderCoach();
    renderDisplaySeg();
  }

  function renderDisplaySeg() {
    document.querySelectorAll('[data-display]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.display === state.display)));
  }

  function planButton(item, caption) {
    const p = state.progress[item.key];
    return `<button type="button" class="plan-btn" data-stage="${item.stage.id}" data-drill="${item.drill.id}">
      <span>${item.stage.title}: ${item.drill.name}<small>${caption}</small></span>
      ${p ? starsHtml(p.stars) : ''}
    </button>`;
  }

  function renderCoach() {
    const next = FT.nextDrill(state.progress);
    const review = FT.reviewDrill(state.progress, Date.now());
    const k = drillKey();
    const p = state.progress[k];
    const parts = [];

    parts.push('<div class="coach-card"><h3>Your plan today</h3>');
    parts.push('<p class="how">Tune up first. Short daily sessions beat one long weekly one.</p>');
    if (review) parts.push(planButton(review, 'Review: you last played this a few days ago'));
    if (next) parts.push(planButton(next, FT.isPassed(state.progress, next.key) ? '' : state.progress[next.key] ? `Best so far ${state.progress[next.key].best}. Score 80 to pass` : 'Score 80 to pass'));
    else parts.push('<p>You have passed every drill in this key. Change the key at the top and try it somewhere new.</p>');
    parts.push('</div>');

    parts.push(`<div class="coach-card"><h3>About this ${ui.stage.kind === 'shape' ? 'shape' : ui.stage.kind === 'connect' ? 'connection' : 'run'}</h3><p class="how">${FT.stageTip(ui.stage, state.root, state.quality)}</p></div>`);

    if (p && p.lastNote) {
      parts.push(`<div class="coach-card"><h3>Last time you played this</h3><p>You scored ${p.lastScore}. ${p.lastNote.title}.</p><p class="how">${p.lastNote.body}</p></div>`);
    }
    $('coach').innerHTML = parts.join('');
  }

  function selectDrill(stageId, drillId) {
    if (ui.session) stopSession();
    stopDemo();
    ui.stage = FT.getStage(stageId);
    ui.drill = FT.getDrill(ui.stage, drillId) || ui.stage.drills[0];
    state.stage = ui.stage.id; state.drill = ui.drill.id; save();
    hideNotice();
    renderLesson();
    renderPracticeNeck();
  }

  /* ---------- Drill engine ---------- */
  function showNotice(message, allowTap) {
    const n = $('micNotice');
    n.hidden = false;
    n.innerHTML = '';
    const p = document.createElement('div');
    p.textContent = message;
    n.appendChild(p);
    if (allowTap) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn small';
      b.textContent = 'Tap the notes instead';
      b.addEventListener('click', () => { ui.tap = true; hideNotice(); renderLesson(); startDrill(); });
      n.appendChild(b);
    }
  }
  function hideNotice() { $('micNotice').hidden = true; }

  async function startDrill() {
    if (ui.session || ui.starting) return; // a double tap while the mic prompt is open
    stopDemo();
    getCtx();
    hideNotice();
    if (!ui.tap) {
      ui.starting = true;
      try { await enableMic(); }
      catch (err) {
        updateMicUi(true);
        showNotice(micErrorMessage(err) + ' You can also tap notes on screen, but those runs do not count toward your progress.', true);
        return;
      }
      finally { ui.starting = false; }
    }
    const seq = FT.buildSequence(ui.stage, ui.drill, state.root, state.quality);
    const ctx = audio.ctx;
    const timed = !!ui.drill.timed;
    const bpm = currentBpm();
    const beat = 60 / bpm;
    const s = {
      stage: ui.stage, drill: ui.drill, seq, idx: 0, timed, bpm, beat, tap: ui.tap,
      results: seq.map(() => ({ hit: false, cents: [], delta: null, t: null, wrongs: 0 })),
      wrong: [], startedAt: ctx.currentTime, lastHitT: -1, prevMidi: null, pending: null, lastWrong: null,
      lastSound: ctx.currentTime, finished: false, lastHitIdx: -1,
    };
    audio.tracker.reset();
    ui.session = s;
    ui.flash = null;
    document.body.classList.add('playing');
    $('hud').hidden = false;
    $('startBtn').hidden = true;
    $('demoBtn').hidden = true;
    $('tapToggle').hidden = true;
    $('stopBtn').hidden = false;
    $('hudMsg').textContent = ''; $('hudMsg').className = 'hud-msg';
    $('hudHeard').textContent = '–';
    $('hudNeedle').style.opacity = 0;
    keepAwake(true);

    if (timed) {
      s.t0 = ctx.currentTime + 0.25 + 4 * beat;
      s.nextClick = -4;
      s.expected = seq.map((_, i) => s.t0 + i * beat);
      s.endT = s.t0 + seq.length * beat;
      s.timer = setInterval(() => timedTick(s), 25);
      $('hudMsg').textContent = 'Count in, then one note on each click.';
    } else if (!ui.tap) {
      s.quietTimer = setInterval(() => {
        const r = audio.ctx.currentTime;
        if (r - s.lastSound > 10 && !s.finished) {
          $('hudMsg').textContent = 'I cannot hear you yet. Move the mic closer to the guitar and check the meter at the top moves when you play.';
          $('hudMsg').className = 'hud-msg';
          s.lastSound = r;
        }
      }, 1000);
    }
    updateHud();
    renderPracticeNeck();
  }

  function timedTick(s) {
    if (s.finished) return;
    const ctx = audio.ctx;
    const now = ctx.currentTime;
    while (s.t0 + s.nextClick * s.beat < now + 0.15 && s.t0 + s.nextClick * s.beat < s.endT) {
      const when = s.t0 + s.nextClick * s.beat;
      playClick(when, s.nextClick < 0 || s.nextClick % 4 === 0);
      s.nextClick++;
    }
    const heard = now - outLatency();
    const countEl = $('countIn');
    if (heard < s.t0) {
      const n = Math.ceil((s.t0 - heard) / s.beat);
      countEl.hidden = false;
      countEl.textContent = Math.min(4, Math.max(1, n));
    } else countEl.hidden = true;

    if (heard >= s.t0) {
      const idx = Math.min(s.seq.length - 1, Math.floor((heard - s.t0 + s.beat / 2) / s.beat));
      if (idx !== s.idx) { s.idx = idx; updateHud(); renderPracticeNeck(); }
    }
    if (heard >= s.endT + 0.25) finishSession(s);
  }

  /* Handles a played note. In timed drills it matches against the beat grid. */
  function handleNote(s, ev) {
    s.lastSound = ev.t;
    if (ev.type === 'hold') {
      if (s.lastHitIdx >= 0 && FT.matchesTarget(ev.midi, s.seq[s.lastHitIdx].midi)) {
        const c = s.results[s.lastHitIdx].cents;
        if (c.length < 12) c.push(ev.cents);
      }
      if (s.pending && s.pending.midi === ev.midi) {
        s.pending.frames++;
        if (s.pending.frames >= 2) commitWrong(s, s.pending);
      }
      return;
    }
    if (s.timed) return handleTimedNote(s, ev);

    const target = s.seq[s.idx];
    if (!target) return;
    if (FT.matchesTarget(ev.midi, target.midi)) {
      s.pending = null;
      markHit(s, s.idx, ev, null);
      s.idx++;
      if (s.idx >= s.seq.length) { updateHud(); setTimeout(() => finishSession(s), s.tap ? 200 : 450); }
      else updateHud();
      renderPracticeNeck();
      return;
    }
    // The last note can still be ringing, and its octave can briefly read through.
    if (!ev.tap && s.prevMidi != null && (ev.midi === s.prevMidi || Math.abs(ev.midi - s.prevMidi) === 12)) return;
    if (ev.tap) commitWrong(s, { midi: ev.midi, idx: s.idx, t: ev.t, frames: 2 });
    else s.pending = { midi: ev.midi, idx: s.idx, t: ev.t, frames: 0 };
  }

  function handleTimedNote(s, ev) {
    const t = ev.t - (ev.tap ? 0 : audio.inLat) - outLatency();
    const win = Math.max(0.18, 0.45 * s.beat);
    let bestIdx = -1, bestDist = Infinity, nearIdx = -1, nearDist = Infinity;
    s.expected.forEach((T, i) => {
      const dist = Math.abs(T - t);
      if (dist > win || s.results[i].hit) return;
      if (dist < nearDist) { nearDist = dist; nearIdx = i; }
      if (FT.matchesTarget(ev.midi, s.seq[i].midi) && dist < bestDist) { bestDist = dist; bestIdx = i; }
    });
    if (bestIdx >= 0) {
      s.pending = null;
      markHit(s, bestIdx, ev, t - s.expected[bestIdx]);
      const delta = Math.round((t - s.expected[bestIdx]) * 1000);
      $('hudMsg').textContent = Math.abs(delta) <= 40 ? 'On the click' : delta < 0 ? `${-delta} ms early` : `${delta} ms late`;
      $('hudMsg').className = Math.abs(delta) <= 80 ? 'hud-msg good' : 'hud-msg';
      updateHud();
      return;
    }
    if (nearIdx < 0) return;
    if (!ev.tap && s.prevMidi != null && (ev.midi === s.prevMidi || Math.abs(ev.midi - s.prevMidi) === 12)) return;
    if (ev.tap) commitWrong(s, { midi: ev.midi, idx: nearIdx, t: ev.t, frames: 2 });
    else s.pending = { midi: ev.midi, idx: nearIdx, t: ev.t, frames: 0 };
  }

  function markHit(s, idx, ev, delta) {
    const r = s.results[idx];
    r.hit = true; r.t = ev.t; r.delta = delta;
    if (ev.cents != null && !ev.tap) r.cents.push(ev.cents);
    s.lastHitT = ev.t;
    s.prevMidi = ev.midi;
    s.lastHitIdx = idx;
    const n = s.seq[idx];
    if (s.drill.hidden || s.timed) flash(n.string, n.fret, 'g-hit', labelFor(n), 220);
    if (!s.timed) { $('hudMsg').textContent = ''; }
  }

  function commitWrong(s, w) {
    s.pending = null;
    const target = s.seq[w.idx];
    if (!target) return;
    if (s.lastWrong && s.lastWrong.midi === w.midi && w.t - s.lastWrong.t < 0.4) return;
    s.lastWrong = { midi: w.midi, t: w.t };
    s.wrong.push({ idx: w.idx, midi: w.midi, t: w.t });
    s.results[w.idx].wrongs++;
    $('hudMsg').textContent = FT.describeMiss(w.midi, target);
    $('hudMsg').className = 'hud-msg bad';
    const f = w.midi - FT.OPEN_MIDI[target.string];
    flash(target.string, f >= 0 && f <= 24 ? f : target.fret, 'g-wrong', '×', 600);
  }

  function showHeard(midi, cents) {
    if (!ui.session) return;
    $('hudHeard').textContent = FT.noteName(midi);
    const needle = $('hudNeedle');
    needle.style.opacity = 1;
    needle.style.transform = `translateX(${Math.max(-36, Math.min(36, cents * 0.72))}px)`;
    needle.style.background = Math.abs(cents) <= 15 ? 'var(--good)' : Math.abs(cents) <= 30 ? 'var(--warn)' : 'var(--bad)';
  }

  function updateHud() {
    const s = ui.session;
    if (!s) return;
    const target = s.seq[Math.min(s.idx, s.seq.length - 1)];
    const memory = s.drill.hidden && s.drill.pattern !== 'find';
    $('hudNote').textContent = memory ? `Note ${Math.min(s.idx + 1, s.seq.length)}` : FT.noteName(target.midi);
    if (s.drill.pattern === 'find') $('hudSub').textContent = `On the ${FT.STRING_NAMES[target.string]} string`;
    else if (memory) $('hudSub').textContent = `of ${s.seq.length}. Only the roots are showing`;
    else $('hudSub').textContent = `${FT.STRING_NAMES[target.string]} string · fret ${target.fret}${target.finger ? ' · finger ' + target.finger : ' · open'}`;
    const done = s.timed ? s.idx : s.results.filter((r) => r.hit).length;
    $('hudBar').style.width = (done / s.seq.length) * 100 + '%';
  }

  function endPlayUi() {
    document.body.classList.remove('playing');
    $('hud').hidden = true;
    $('startBtn').hidden = false;
    $('demoBtn').hidden = false;
    $('tapToggle').hidden = false;
    $('stopBtn').hidden = true;
    $('countIn').hidden = true;
    keepAwake(false);
  }

  function clearSessionTimers(s) {
    if (s.timer) clearInterval(s.timer);
    if (s.quietTimer) clearInterval(s.quietTimer);
  }

  function stopSession() {
    const s = ui.session;
    if (!s) return;
    s.finished = true;
    clearSessionTimers(s);
    ui.session = null;
    endPlayUi();
    renderPracticeNeck();
  }

  function finishSession(s) {
    if (s.finished) return;
    s.finished = true;
    clearSessionTimers(s);
    const report = FT.grade(s);
    const notes = FT.coachNotes(s, report);
    const duration = audio.ctx.currentTime - s.startedAt;
    const key = s.stage.id + '.' + s.drill.id;
    let bpmNext = null;

    if (!s.tap) {
      const old = state.progress[key] || { best: 0, stars: 0, attempts: 0 };
      if (s.timed) bpmNext = FT.nextBpm(s.bpm, report.score);
      state.progress[key] = {
        best: Math.max(old.best, report.score),
        stars: Math.max(old.stars, report.stars),
        attempts: old.attempts + 1,
        lastScore: report.score,
        lastAt: Date.now(),
        bpm: bpmNext || old.bpm,
        lastNote: notes[0] && notes[0].tone === 'fix' ? { title: notes[0].title, body: notes[0].body } : null,
      };
      state.history.push({ at: Date.now(), key, score: report.score, stars: report.stars, root: state.root, quality: state.quality, bpm: s.timed ? s.bpm : null });
      if (state.history.length > 200) state.history.shift();
      const d = dayKey();
      state.seconds[d] = (state.seconds[d] || 0) + Math.round(duration);
      delete ui.bpmOverride[key];
      save();
    }
    ui.session = null;
    endPlayUi();
    renderLesson();
    renderPracticeNeck();
    showReport(s, report, notes, bpmNext);
  }

  /* ---------- Report ---------- */
  function metricHtml(name, value, detail) {
    if (value == null) return '';
    return `<div class="metric"><span>${name}</span><span class="metric-bar"><span style="width:${value}%"></span></span><span class="metric-val">${value}</span><span class="metric-detail">${detail}</span></div>`;
  }

  function showReport(s, r, notes, bpmNext) {
    const key = s.stage.id + '.' + s.drill.id;
    let action;
    const list = FT.allDrills();
    if (r.pass && !s.tap) {
      const idx = list.findIndex((d) => d.key === key);
      const after = list[idx + 1];
      const upcoming = FT.nextDrill(state.progress) || after;
      action = upcoming ? { label: `Next: ${upcoming.drill.name}`, stage: upcoming.stage.id, drill: upcoming.drill.id } : null;
    }
    const heading = s.tap ? 'Tap practice finished' : r.score >= 97 ? 'Excellent run' : r.pass ? 'Passed' : r.score >= 60 ? 'Getting there' : 'Keep working on this';

    const accDetail = `${r.hits} of ${r.total} notes${r.wrongCount ? `, ${r.wrongCount} wrong` : ', none wrong'}`;
    let pace = '';
    if (r.timed) {
      if (r.meanDelta != null) {
        const ms = Math.round(Math.abs(r.meanDelta) * 1000);
        pace = metricHtml('Timing', r.timing, `On average ${ms} ms ${r.meanDelta < 0 ? 'ahead of' : 'behind'} the click at ${s.bpm} BPM`);
      } else pace = metricHtml('Timing', 0, `No notes landed on the click at ${s.bpm} BPM`);
    } else {
      pace = metricHtml('Pace', r.flow, r.medianGap != null ? `About ${r.medianGap.toFixed(1)} seconds per note` : 'Too few notes to measure');
    }
    const pitch = r.intonation == null ? '' : metricHtml('Pitch', r.intonation, `Notes were about ${Math.round(r.meanAbsCents)} cents from true pitch`);

    const noteHtml = notes.map((n) => `<div class="note">
        <span class="note-mark ${n.tone}" aria-hidden="true">${n.tone === 'good' ? '✓' : '!'}</span>
        <div><h4>${n.title}</h4><p>${n.body}</p>${n.action === 'tune' ? '<button type="button" class="btn small" data-report="tune" style="margin-top:6px">Open the tuner</button>' : ''}</div>
      </div>`).join('');

    let extra = '';
    if (s.tap) extra = '<p class="how">This run used tap mode, so it was not added to your progress. Play it on your guitar with the mic on to count it.</p>';
    else if (bpmNext != null && bpmNext !== s.bpm) extra = `<p class="how">${bpmNext > s.bpm ? 'I raised the tempo' : 'I lowered the tempo'} to ${bpmNext} BPM for your next try.</p>`;

    $('reportBody').innerHTML = `
      <div class="report-head">
        <div class="score">${r.score}<small>/100</small></div>
        <div>
          <h2 id="reportTitle" class="report-title">${heading}</h2>
          <div class="how">${s.stage.title}: ${s.drill.name}</div>
          ${starsHtml(r.stars)}
        </div>
      </div>
      <div class="report-main">
        <div class="metrics">${metricHtml('Accuracy', r.accuracy, accDetail)}${pace}${pitch}</div>
        <div class="notes">${noteHtml}</div>
        ${extra}
      </div>
      <div class="report-neck">
        <div class="eyebrow">Note by note</div>
        <div id="reportNeck" class="neck"></div>
        <div class="legend">
          <span><i style="background:var(--good)"></i>Clean</span>
          <span><i style="background:var(--warn)"></i>! Needs work</span>
          <span><i style="border:2px solid var(--bad)"></i>× Missed</span>
        </div>
      </div>
      <div class="report-actions">
        ${action ? `<button type="button" class="btn primary" id="reportNext">${action.label}</button>` : ''}
        <button type="button" class="btn${action ? '' : ' primary'}" id="reportAgain">Try again</button>
        <button type="button" class="btn" id="reportClose">Close</button>
      </div>`;

    const rank = { clean: 0, shaky: 1, missed: 2 };
    const byPos = new Map();
    s.seq.forEach((n, i) => {
      const k = n.string + ':' + n.fret;
      const st = r.perNote[i];
      const cur = byPos.get(k);
      if (!cur || rank[st] > rank[cur.st]) byPos.set(k, { n, st });
    });
    const dots = [...byPos.values()].map(({ n, st }) => ({
      string: n.string, fret: n.fret, root: n.isRoot, cls: 'g-' + st,
      label: st === 'missed' ? '×' : st === 'shaky' ? '!' : FT.noteName(n.midi),
    }));
    const range = neckRange(s.seq);
    renderNeck($('reportNeck'), { from: range.from, to: range.to, dots, rowH: 56, label: 'Your result for each note' });

    $('report').hidden = false;
    const close = () => { $('report').hidden = true; };
    if (action) $('reportNext').addEventListener('click', () => { close(); selectDrill(action.stage, action.drill); });
    $('reportAgain').addEventListener('click', () => { close(); startDrill(); });
    $('reportClose').addEventListener('click', close);
    const tuneBtn = $('reportBody').querySelector('[data-report="tune"]');
    if (tuneBtn) tuneBtn.addEventListener('click', () => { close(); setView('tune'); });
    ($('reportNext') || $('reportAgain')).focus();
  }

  /* ---------- Hear it ---------- */
  function stopDemo() {
    if (!ui.demo) return;
    clearTimeout(ui.demo.timer);
    ui.demo = null;
    $('demoBtn').textContent = 'Hear it';
    audio.ignoreUntil = audio.ctx ? audio.ctx.currentTime + 0.6 : 0; // let the speaker ring out
    renderPracticeNeck();
  }
  function startDemo() {
    if (ui.demo) { stopDemo(); return; }
    const seq = FT.buildSequence(ui.stage, ui.drill.pattern === 'find' ? { pattern: 'updown' } : ui.drill, state.root, state.quality);
    const gap = ui.drill.timed ? 60 / currentBpm() : 0.42;
    ui.demo = { seq, idx: -1, timer: null };
    $('demoBtn').textContent = 'Stop playback';
    const step = () => {
      const d = ui.demo;
      if (!d) return;
      d.idx++;
      if (d.idx >= d.seq.length) { stopDemo(); return; }
      audio.ignoreUntil = getCtx().currentTime + gap + 0.7; // do not grade the speaker
      playPluck(d.seq[d.idx].midi);
      renderPracticeNeck();
      d.timer = setTimeout(step, gap * 1000);
    };
    step();
  }

  /* ---------- Progress view ---------- */
  function fmtTime(sec) {
    if (sec < 60) return Math.round(sec) + ' sec';
    const m = Math.round(sec / 60);
    return m < 60 ? m + ' min' : (m / 60).toFixed(1) + ' hr';
  }

  function chartHtml(items) {
    // Drawn at the panel's real width, so labels stay 12px on a phone.
    const W = Math.max(280, Math.min(860, $('view-path').clientWidth - 60)), H = 170, L = 30, R = 8, T = 10, B = 22;
    const y = (v) => T + (1 - v / 100) * (H - T - B);
    const slots = 14;
    const slot = (W - L - R) / slots;
    const barW = Math.min(30, slot - 2); // 2px surface gap between neighbors
    const out = [`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Scores of your last ${items.length} drills. The list below has the same numbers.">`];
    [0, 50, 100].forEach((v) => {
      out.push(`<line class="chart-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="chart-label" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`);
    });
    out.push(`<line class="chart-pass" x1="${L}" x2="${W - R}" y1="${y(80)}" y2="${y(80)}"/><text class="chart-label" x="${W - R}" y="${y(80) - 5}" text-anchor="end">Pass 80</text>`);
    items.forEach((h, i) => {
      const x = L + i * slot + (slot - barW) / 2;
      const top = y(Math.max(h.score, 1.5));
      const base = y(0);
      const rad = Math.min(4, (base - top) / 1.01, barW / 2);
      const info = FT.allDrills().find((d) => d.key === h.key);
      const name = info ? `${info.stage.title}: ${info.drill.name}` : h.key;
      out.push(`<g class="chart-col" data-tip="${name} scored ${h.score}" data-x="${(x + barW / 2) / W}" data-y="${top / H}">
        <path class="chart-bar" d="M${x} ${base}V${top + rad}Q${x} ${top} ${x + rad} ${top}H${x + barW - rad}Q${x + barW} ${top} ${x + barW} ${top + rad}V${base}Z"/>
        <rect class="chart-hit" x="${L + i * slot}" y="${T}" width="${slot}" height="${H - T - B}"/></g>`);
    });
    const oldest = new Date(items[0].at), newest = new Date(items[items.length - 1].at);
    const fmt = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    out.push(`<text class="chart-label" x="${L}" y="${H - 5}">${fmt(oldest)}</text>`);
    if (items.length > 3) out.push(`<text class="chart-label" x="${L + (items.length - 0.5) * slot}" y="${H - 5}" text-anchor="end">${fmt(newest)}</text>`);
    out.push('</svg>');
    return out.join('');
  }

  function renderPath() {
    const secs = Object.values(state.seconds).reduce((a, b) => a + b, 0);
    const streak = FT.dayStreak(state.seconds, new Date());
    const pct = FT.overallPercent(state.progress);
    const passed = FT.allDrills().filter((d) => FT.isPassed(state.progress, d.key)).length;
    const hist = state.history;
    const next = FT.nextDrill(state.progress);
    const recent = hist.slice(-14);
    const parts = [`<h1 class="page-title">Your progress</h1>
      <div class="stat-row">
        <div class="stat"><b>${pct}%</b><span>${passed} of ${FT.allDrills().length} drills passed</span></div>
        <div class="stat"><b>${streak}</b><span>day${streak === 1 ? '' : 's'} in a row</span></div>
        <div class="stat"><b>${fmtTime(secs)}</b><span>total practice</span></div>
        <div class="stat"><b>${hist.length}</b><span>drill${hist.length === 1 ? '' : 's'} played</span></div>
      </div>`];

    parts.push(`<div class="panel"><h2 class="section-title">Recent scores</h2>${recent.length
      ? `<div class="chart-wrap" id="chartWrap">${chartHtml(recent)}<div id="chartTip" class="chart-tip" hidden></div></div>`
      : '<p class="empty">Finish a drill with the mic on and your scores appear here.</p>'}</div>`);

    parts.push('<div class="panel"><h2 class="section-title" style="margin-bottom:10px">Your path</h2><div>');
    FT.STAGES.forEach((st) => {
      const done = st.drills.filter((d) => FT.isPassed(state.progress, st.id + '.' + d.id)).length;
      parts.push(`<div class="stage-row"><div class="stage-row-head"><h3>${st.title}</h3><span>${done} of ${st.drills.length} passed</span></div>
        <div class="drill-grid">${st.drills.map((d, i) => drillButton(st, d, i, next ? next.key : null, true)).join('')}</div></div>`);
    });
    parts.push('</div></div>');

    if (hist.length) {
      parts.push('<div class="panel"><h2 class="section-title" style="margin-bottom:6px">Session log</h2><div class="history">');
      hist.slice(-10).reverse().forEach((h) => {
        const info = FT.allDrills().find((d) => d.key === h.key);
        const d = new Date(h.at);
        parts.push(`<div class="history-row"><div>${info ? info.stage.title + ': ' + info.drill.name : h.key}
          <small>${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${FT.NOTE_NAMES[h.root]} ${h.quality}${h.bpm ? ', ' + h.bpm + ' BPM' : ''}</small></div>
          ${starsHtml(h.stars)}<b>${h.score}</b></div>`);
      });
      parts.push('</div></div>');
    }
    const view = $('view-path');
    view.innerHTML = parts.join('');
    view.querySelectorAll('.drill').forEach((b) => b.addEventListener('click', () => { setView('practice'); selectDrill(b.dataset.stage, b.dataset.drill); }));
    const wrap = $('chartWrap');
    if (wrap) {
      const tip = $('chartTip');
      const move = (e) => {
        const col = e.target.closest && e.target.closest('.chart-col');
        if (!col) { tip.hidden = true; return; }
        tip.hidden = false;
        tip.textContent = col.dataset.tip;
        const w = wrap.clientWidth;
        const half = tip.offsetWidth / 2;
        tip.style.left = Math.max(half, Math.min(w - half, col.dataset.x * w)) + 'px';
        tip.style.top = Math.max(tip.offsetHeight, col.dataset.y * wrap.clientHeight - 6) + 'px';
      };
      wrap.addEventListener('pointermove', move);
      wrap.addEventListener('pointerdown', move);
      wrap.addEventListener('pointerleave', () => { tip.hidden = true; });
    }
  }

  /* ---------- Neck explorer ---------- */
  function renderExplorer() {
    $('neckTitle').textContent = keyLabel();
    $('shapeChips').innerHTML = [1, 2, 3, 4, 5].map((n) => `<button type="button" class="chip" data-shape="${n}" aria-pressed="${ui.explorerShapes.includes(n)}" aria-label="Shape ${n}">${n}</button>`).join('') +
      `<button type="button" class="chip" data-shape="all" aria-pressed="${ui.explorerShapes.length === 5}">All</button>`;
    const seen = new Map();
    ui.explorerShapes.forEach((k) => {
      FT.shapeNotes(k, state.root, state.quality).forEach((n) => {
        [-12, 0, 12].forEach((oct) => {
          const fret = n.fret + oct;
          if (fret < 0 || fret > 22) return;
          const key = n.string + ':' + fret;
          if (!seen.has(key)) seen.set(key, Object.assign({}, n, { fret, midi: n.midi + oct }));
        });
      });
    });
    const notes = [...seen.values()];
    const dots = notes.map((n) => ({ string: n.string, fret: n.fret, root: n.isRoot, label: labelFor(n) }));
    const maxFret = Math.max(15, ...notes.map((n) => n.fret));
    renderNeck($('neckFull'), { from: 0, to: Math.min(22, maxFret), dots, rowH: 50, tappable: true, label: `Shapes ${ui.explorerShapes.join(', ')} in ${keyLabel()}` });
  }

  /* ---------- Tuner ---------- */
  function buildGauge() {
    const cx = 150, cy = 150, r = 120;
    const pt = (c) => { const a = (c / 50) * (Math.PI / 2.6); return [cx + r * Math.sin(a), cy - r * Math.cos(a)]; };
    const [x0, y0] = pt(-50), [x1, y1] = pt(50), [zx0, zy0] = pt(-5), [zx1, zy1] = pt(5);
    let ticks = '';
    [-50, -25, 25, 50].forEach((c) => {
      const [tx, ty] = pt(c);
      const lx = cx + (tx - cx) * 0.8, ly = cy + (ty - cy) * 0.8;
      ticks += `<text class="gauge-text" x="${lx}" y="${ly + 4}">${c > 0 ? '+' : ''}${c}</text>`;
    });
    $('gauge').innerHTML = `<path class="gauge-track" d="M${x0} ${y0}A${r} ${r} 0 0 1 ${x1} ${y1}"/>
      <path class="gauge-zone" d="M${zx0} ${zy0}A${r} ${r} 0 0 1 ${zx1} ${zy1}"/>${ticks}
      <line id="gaugeNeedle" class="gauge-needle" x1="150" y1="150" x2="150" y2="44"/>`;
    $('tuneStrings').innerHTML = FT.OPEN_MIDI.map((m, i) => `<button type="button" data-midi="${m}" data-i="${i}" aria-label="Play reference ${FT.STRING_NAMES[i]} string">${FT.STRING_SHORT[i]}<small>${FT.octaveName(m)}</small></button>`).join('');
  }

  function renderTunerIdle() {
    if (!$('tuneNote')) return;
    $('tuneNote').textContent = '–';
    $('tuneStatus').textContent = audio.stream ? 'Pick a string and let it ring' : 'Turn on the mic to start';
    $('tuneStatus').className = 'tune-status';
    const n = $('gaugeNeedle');
    if (n) n.style.transform = 'rotate(0deg)';
    document.querySelectorAll('#tuneStrings button').forEach((b) => b.classList.remove('near'));
    audio.tuneMidi = null;
  }

  function updateTuner(p, level) {
    if (!(p.freq > 0 && p.clarity >= 0.85 && level >= audio.gate)) {
      if (audio.tuneQuiet == null) audio.tuneQuiet = 0;
      if (++audio.tuneQuiet > 25) { renderTunerIdle(); audio.tuneQuiet = 0; }
      return;
    }
    audio.tuneQuiet = 0;
    const exact = FT.freqToMidi(p.freq);
    audio.tuneMidi = audio.tuneMidi == null || Math.abs(exact - audio.tuneMidi) > 1 ? exact : audio.tuneMidi + (exact - audio.tuneMidi) * 0.3;
    const smooth = audio.tuneMidi;
    let bestI = 0;
    FT.OPEN_MIDI.forEach((m, i) => { if (Math.abs(smooth - m) < Math.abs(smooth - FT.OPEN_MIDI[bestI])) bestI = i; });
    const nearString = Math.abs(smooth - FT.OPEN_MIDI[bestI]) <= 2.5;
    const ref = nearString ? FT.OPEN_MIDI[bestI] : Math.round(smooth);
    const cents = (smooth - ref) * 100;
    const shown = Math.max(-50, Math.min(50, cents));
    $('gaugeNeedle').style.transform = `rotate(${(shown / 50) * (180 / 2.6)}deg)`;
    $('tuneNote').textContent = FT.noteName(ref);
    const status = $('tuneStatus');
    const abs = Math.abs(cents);
    const c = Math.round(abs);
    if (abs <= 5) { status.textContent = 'In tune'; status.className = 'tune-status ok'; }
    else { status.textContent = cents < 0 ? `${c} cents flat. Tune up` : `${c} cents sharp. Tune down`; status.className = 'tune-status off'; }
    document.querySelectorAll('#tuneStrings button').forEach((b) => b.classList.toggle('near', nearString && +b.dataset.i === bestI));
  }

  /* ---------- Navigation and events ---------- */
  function setView(view) {
    if (ui.session && view !== 'practice') stopSession();
    if (view !== 'practice') stopDemo();
    ui.view = view;
    ['practice', 'path', 'neck', 'tune'].forEach((v) => { $('view-' + v).hidden = v !== view; });
    document.querySelectorAll('.tab').forEach((t) => {
      if (t.dataset.view === view) t.setAttribute('aria-current', 'page');
      else t.removeAttribute('aria-current');
    });
    if (view === 'practice') { renderLesson(); renderPracticeNeck(); }
    if (view === 'path') renderPath();
    if (view === 'neck') { renderDisplaySeg(); renderExplorer(); }
    if (view === 'tune') { renderTunerIdle(); refreshMics(); }
    document.querySelector('.main').scrollTop = 0;
  }

  function renderKeyBtn() { $('keyBtn').textContent = keyLabel(); }
  function renderKeySheet() {
    $('rootGrid').innerHTML = FT.NOTE_NAMES.map((n, i) => `<button type="button" data-root="${i}" aria-pressed="${i === state.root}">${n}</button>`).join('');
    document.querySelectorAll('#qualitySeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.q === state.quality)));
  }
  function keyChanged() {
    save();
    renderKeyBtn();
    renderKeySheet();
    if (ui.view === 'practice') { renderLesson(); renderPracticeNeck(); }
    if (ui.view === 'neck') renderExplorer();
  }

  function bind() {
    document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
    $('keyBtn').addEventListener('click', () => {
      if (ui.session) stopSession();
      renderKeySheet();
      $('keySheet').hidden = false;
      $('keyDone').focus();
    });
    $('keyDone').addEventListener('click', () => { $('keySheet').hidden = true; });
    $('keySheet').addEventListener('click', (e) => { if (e.target === $('keySheet')) $('keySheet').hidden = true; });
    $('rootGrid').addEventListener('click', (e) => {
      const b = e.target.closest('[data-root]');
      if (b) { state.root = +b.dataset.root; keyChanged(); }
    });
    $('qualitySeg').addEventListener('click', (e) => {
      const b = e.target.closest('[data-q]');
      if (b) { state.quality = b.dataset.q; keyChanged(); }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      $('keySheet').hidden = true;
      $('report').hidden = true;
    });

    $('micBtn').addEventListener('click', async () => {
      if (audio.stream) { if (ui.session) stopSession(); disableMic(); return; }
      try { await enableMic(); hideNotice(); renderTunerIdle(); }
      catch (err) { updateMicUi(true); if (ui.view === 'practice') showNotice(micErrorMessage(err), true); else $('tuneStatus').textContent = micErrorMessage(err); }
    });
    $('tuneMic').addEventListener('click', async () => {
      try { await enableMic(); renderTunerIdle(); }
      catch (err) { updateMicUi(true); $('tuneStatus').textContent = micErrorMessage(err); }
    });
    $('micSel').addEventListener('change', (e) => switchMic(e.target.value));
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', refreshMics);
    $('tuneStrings').addEventListener('click', (e) => {
      const b = e.target.closest('[data-midi]');
      if (!b) return;
      audio.ignoreUntil = getCtx().currentTime + 1.4;
      playPluck(+b.dataset.midi);
    });

    $('stageSel').addEventListener('change', (e) => {
      const st = FT.getStage(e.target.value);
      const next = st.drills.find((d) => !FT.isPassed(state.progress, st.id + '.' + d.id)) || st.drills[0];
      selectDrill(st.id, next.id);
    });
    const onDrillClick = (e) => {
      const b = e.target.closest('[data-drill]');
      if (b) selectDrill(b.dataset.stage, b.dataset.drill);
    };
    $('drillList').addEventListener('click', onDrillClick);
    $('coach').addEventListener('click', onDrillClick);

    $('startBtn').addEventListener('click', startDrill);
    $('stopBtn').addEventListener('click', stopSession);
    $('demoBtn').addEventListener('click', startDemo);
    $('tapToggle').addEventListener('click', () => { ui.tap = !ui.tap; hideNotice(); renderLesson(); });
    const stepBpm = (d) => {
      const v = Math.max(40, Math.min(160, currentBpm() + d));
      ui.bpmOverride[drillKey()] = v;
      $('bpmVal').textContent = v;
    };
    $('bpmDown').addEventListener('click', () => stepBpm(-5));
    $('bpmUp').addEventListener('click', () => stepBpm(5));
    document.querySelectorAll('.seg [data-display]').forEach((b) => b.addEventListener('click', () => {
      state.display = b.dataset.display;
      save();
      renderDisplaySeg();
      if (ui.view === 'practice') renderPracticeNeck(); else renderExplorer();
    }));

    // Tap mode on the practice neck
    $('neck').addEventListener('pointerdown', (e) => {
      const cell = e.target.closest && e.target.closest('.cell');
      const s = ui.session;
      if (!cell || !s || !s.tap || s.finished) return;
      e.preventDefault();
      const midi = FT.OPEN_MIDI[+cell.dataset.s] + +cell.dataset.f;
      playPluck(midi);
      showHeard(midi, 0);
      handleNote(s, { type: 'on', midi, t: audio.ctx.currentTime, cents: null, tap: true });
    });
    // Explorer: hear a note
    $('neckFull').addEventListener('pointerdown', (e) => {
      const cell = e.target.closest && e.target.closest('.cell');
      if (cell) playPluck(FT.OPEN_MIDI[+cell.dataset.s] + +cell.dataset.f);
    });
    $('shapeChips').addEventListener('click', (e) => {
      const b = e.target.closest('[data-shape]');
      if (!b) return;
      if (b.dataset.shape === 'all') ui.explorerShapes = ui.explorerShapes.length === 5 ? [1] : [1, 2, 3, 4, 5];
      else {
        const n = +b.dataset.shape;
        const has = ui.explorerShapes.includes(n);
        if (has && ui.explorerShapes.length > 1) ui.explorerShapes = ui.explorerShapes.filter((x) => x !== n);
        else if (!has) ui.explorerShapes = ui.explorerShapes.concat(n).sort();
      }
      renderExplorer();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (audio.ctx && audio.ctx.state !== 'running') audio.ctx.resume().catch(() => {});
      if (ui.session) { wakeLock = null; keepAwake(true); }
    });
  }

  /* ---------- Start ---------- */
  selectInitial();
  buildGauge();
  bind();
  renderKeyBtn();
  setView('practice');
})();
