/* ============================================================
   game.js — Palette Pick. Each scene is painted from a KNOWN
   weighted palette (4–5 colour clusters, dabbed on with jitter),
   so the drill has exact ground truth: the player picks the 3
   chips that carry the scene and the picks are matched to the
   true clusters in Lab and scored by ΔE.
   Pure scoring math sits on top; canvas/DOM code below it.
   ============================================================ */
(function () {
  'use strict';

  var SLUG = 'palette-pick';
  var SCENES_PER_ROUND = 3;
  var HUE_COLS = 12;
  var TONE_ROWS = 4;
  var ASPECT = 0.52; /* canvas height / width — fixed, so normalized geometry survives resizes */
  var MATCH_WEIGHTS = [0.45, 0.33, 0.22];

  /* ============================================================
     pure colour + scoring math (no DOM, no canvas — unit-testable)
     ============================================================ */

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  /* h degrees (any), s/l 0–100 → {r,g,b} 0–255 */
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = clamp01(s / 100);
    l = clamp01(l / 100);
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = l - c / 2, r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return {
      r: Math.round((r + m) * 255),
      g: Math.round((g + m) * 255),
      b: Math.round((b + m) * 255),
    };
  }

  /* sRGB 0–255 → linear → XYZ (D65) → CIE Lab */
  function rgbToLab(rgb) {
    function lin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    var r = lin(rgb.r), g = lin(rgb.g), b = lin(rgb.b);
    var X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
    var Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    var Z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
    function f(t) { return t > 0.008856 ? Math.pow(t, 1 / 3) : 7.787 * t + 16 / 116; }
    var fx = f(X), fy = f(Y), fz = f(Z);
    return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
  }

  /* CIE76 */
  function deltaE(p, q) {
    var dL = p.L - q.L, da = p.a - q.a, db = p.b - q.b;
    return Math.sqrt(dL * dL + da * da + db * db);
  }

  function maxPairwiseDE(labs) {
    var m = 0, i, j, d;
    for (i = 0; i < labs.length; i++) {
      for (j = i + 1; j < labs.length; j++) {
        d = deltaE(labs[i], labs[j]);
        if (d > m) m = d;
      }
    }
    return m;
  }

  function perMatchScore(dE) { return 100 * clamp01(1 - dE / 38); }

  /* True clusters in weight order (dominant → secondary → accent)
     greedily take the nearest unused player pick. */
  function matchPicks(trueLabs, pickLabs) {
    var used = [], out = [], i, j, bi, bd, d;
    for (i = 0; i < trueLabs.length; i++) {
      bi = -1; bd = Infinity;
      for (j = 0; j < pickLabs.length; j++) {
        if (used[j]) continue;
        d = deltaE(trueLabs[i], pickLabs[j]);
        if (d < bd) { bd = d; bi = j; }
      }
      used[bi] = true;
      out.push({ pick: bi, dE: bd });
    }
    return out;
  }

  /* trueRgbs = [dominant, secondary, accent] cluster centres,
     pickRgbs = the player's 3 picks.
     → { score 0–100, matches[{pick,dE,per}], samey, bonus } */
  function scoreScene(trueRgbs, pickRgbs) {
    var trueLabs = [], pickLabs = [], i;
    for (i = 0; i < trueRgbs.length; i++) trueLabs.push(rgbToLab(trueRgbs[i]));
    for (i = 0; i < pickRgbs.length; i++) pickLabs.push(rgbToLab(pickRgbs[i]));
    var matches = matchPicks(trueLabs, pickLabs);
    var base = 0;
    for (i = 0; i < matches.length; i++) {
      matches[i].per = perMatchScore(matches[i].dE);
      base += (MATCH_WEIGHTS[i] || 0) * matches[i].per;
    }
    /* three near-identical picks hedge instead of reading the scene */
    var samey = maxPairwiseDE(pickLabs) < 14;
    if (samey) base *= 0.72;
    var bonus = (matches.length > 2 && matches[2].dE < 20) ? 6 : 0;
    var score = base + bonus;
    if (!isFinite(score)) score = 0;
    return { score: Math.max(0, Math.min(100, score)), matches: matches, samey: samey, bonus: bonus };
  }

  function roundScore(sceneScores) {
    var sum = 0, i;
    for (i = 0; i < sceneScores.length; i++) sum += sceneScores[i];
    return sceneScores.length ? sum / sceneScores.length : 0;
  }

  /* ============================================================
     palette + scene generation
     ============================================================ */

  function rand(lo, hi) { return lo + Math.random() * (hi - lo); }

  function rgbCss(c) { return 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')'; }

  function rgbHex(c) {
    function h2(v) { v = v.toString(16); return v.length < 2 ? '0' + v : v; }
    return '#' + h2(c.r) + h2(c.g) + h2(c.b);
  }

  /* per-scene difficulty: bold flats → subtle low-chroma */
  var SAT_BASE = [64, 46, 28];
  var ACC_SAT_LIFT = [24, 20, 15];
  var JITTER = [
    { h: 5, s: 7, l: 5 },
    { h: 7, s: 8, l: 6 },
    { h: 10, s: 9, l: 8 },
  ];
  var TONES = [
    { s: 66, l: 64 },
    { s: 60, l: 44 },
    { s: 34, l: 62 },
    { s: 30, l: 34 },
  ];
  var TONE_SAT_SCALE = [1, 0.9, 0.75];

  function makeCluster(role, h, s, l, weight) {
    var rgb = hslToRgb(h, s, l);
    return { role: role, h: h, s: s, l: l, rgb: rgb, lab: rgbToLab(rgb), weight: weight };
  }

  function makePalette(d) {
    var pal = null, attempt, h0, flip, sat, secOff, accOff, wd, ws, wa, minorTotal, total, twoMinors, m1;
    for (attempt = 0; attempt < 24; attempt++) {
      h0 = rand(0, 360);
      flip = Math.random() < 0.5 ? -1 : 1;
      sat = SAT_BASE[d] + rand(-5, 5);
      secOff = (d === 2) ? rand(35, 75) : rand(70, 160); /* subtle scenes go analogous */
      accOff = rand(140, 220);
      wd = rand(0.45, 0.55);
      ws = rand(0.25, 0.35);
      wa = rand(0.08, 0.12);
      minorTotal = Math.max(0.06, 1 - wd - ws - wa);
      total = wd + ws + wa + minorTotal;
      pal = [
        makeCluster('dominant', h0, sat + rand(-5, 5), rand(58, 72), wd / total),
        makeCluster('secondary', h0 + flip * secOff, sat * rand(0.8, 1.1), rand(36, 52), ws / total),
        makeCluster('accent', h0 + flip * accOff, Math.min(88, sat + ACC_SAT_LIFT[d] + rand(0, 8)), rand(48, 64), wa / total),
      ];
      twoMinors = Math.random() < 0.4;
      m1 = twoMinors ? minorTotal * 0.6 : minorTotal;
      pal.push(makeCluster('minor', h0 + rand(-35, 35), sat * 0.45, rand(16, 30), m1 / total));
      if (twoMinors) {
        pal.push(makeCluster('minor', h0 + flip * secOff + rand(-20, 20), sat * 0.55, rand(68, 80), (minorTotal * 0.4) / total));
      }
      /* the three scored clusters must stay tellable-apart (also keeps
         a perfect pick clear of the samey penalty, so 100 is reachable) */
      if (deltaE(pal[0].lab, pal[1].lab) >= 24 &&
          deltaE(pal[0].lab, pal[2].lab) >= 24 &&
          deltaE(pal[1].lab, pal[2].lab) >= 24) break;
    }
    return pal;
  }

  function jitterCss(cl, jit) {
    return rgbCss(hslToRgb(cl.h + rand(-jit.h, jit.h), cl.s + rand(-jit.s, jit.s), cl.l + rand(-jit.l, jit.l)));
  }

  function dabOp(xx, yy, wLo, wHi, hLo, hHi, css) {
    var w = rand(wLo, wHi), h = rand(hLo, hHi);
    return { t: 'rect', x: xx - w / 2, y: yy - h / 2, w: w, h: h, c: css };
  }

  /* All geometry normalized: x/w as fractions of canvas width,
     y/h as fractions of canvas height; the aspect is fixed. */
  function makeScene(d) {
    var pal = makePalette(d);
    var jit = JITTER[d];
    var dom = pal[0], sec = pal[1], acc = pal[2];
    var minors = pal.slice(3);
    var ops = [];
    var i, x, y, n, tries, mc;

    var horizon = Math.min(0.62, Math.max(0.42, dom.weight + 0.06));
    var minorW = 0;
    for (i = 0; i < minors.length; i++) minorW += minors[i].weight;
    var fgH = Math.min(0.2, Math.max(0.08, minorW + 0.03));
    var amp = rand(0.07, 0.13);
    var freq = rand(0.9, 1.7), ph = rand(0, Math.PI * 2);
    function ridgeY(xx) { return horizon - amp * (0.5 + 0.5 * Math.sin(Math.PI * 2 * xx * freq + ph)); }

    /* sky: dominant base coat everywhere, lower layers cover the rest */
    ops.push({ t: 'rect', x: 0, y: 0, w: 1, h: 1, c: rgbCss(dom.rgb) });
    for (i = 0; i < 110; i++) {
      ops.push(dabOp(rand(0, 1), rand(0, horizon), 0.035, 0.085, 0.02, 0.038, jitterCss(dom, jit)));
    }

    /* accent object: sun in the sky or a bush on the foreground */
    var isSun = Math.random() < 0.55;
    var rFrac = Math.sqrt(acc.weight / Math.PI) * 0.62 * Math.sqrt(ASPECT); /* fraction of W */
    var rH = rFrac / ASPECT;
    var ax, ay, k, rr, th;
    function accentOps() {
      ops.push({ t: 'circle', x: ax, y: ay, r: rFrac, c: rgbCss(acc.rgb) });
      for (k = 0; k < 26; k++) {
        rr = rFrac * Math.sqrt(Math.random()) * 0.9;
        th = rand(0, Math.PI * 2);
        ops.push(dabOp(ax + rr * Math.cos(th), ay + (rr * Math.sin(th)) / ASPECT, 0.014, 0.032, 0.014, 0.03, jitterCss(acc, jit)));
      }
    }
    if (isSun) {
      ax = rand(0.16, 0.84);
      ay = rand(rH + 0.03, Math.max(rH + 0.05, horizon - amp - rH * 0.3));
      accentOps(); /* before the hill — a low sun sets behind the ridge */
    }

    /* back hill: secondary */
    var ridgePts = [];
    for (i = 0; i <= 24; i++) { x = i / 24; ridgePts.push({ x: x, y: ridgeY(x) }); }
    ridgePts.push({ x: 1, y: 1 });
    ridgePts.push({ x: 0, y: 1 });
    ops.push({ t: 'poly', pts: ridgePts, c: rgbCss(sec.rgb) });
    n = 0; tries = 0;
    while (n < 90 && tries < 900) {
      tries++;
      x = rand(0, 1);
      y = rand(horizon - amp, 1 - fgH);
      if (y > ridgeY(x) + 0.01) {
        ops.push(dabOp(x, y, 0.035, 0.085, 0.02, 0.038, jitterCss(sec, jit)));
        n++;
      }
    }

    /* foreground band: minor cluster(s) */
    ops.push({ t: 'rect', x: 0, y: 1 - fgH, w: 1, h: fgH, c: rgbCss(minors[0].rgb) });
    for (i = 0; i < 46; i++) {
      mc = minors[(minors.length > 1 && Math.random() < 0.4) ? 1 : 0];
      ops.push(dabOp(rand(0, 1), rand(1 - fgH, 1), 0.03, 0.07, 0.016, 0.03, jitterCss(mc, jit)));
    }

    if (!isSun) {
      ax = rand(0.16, 0.84);
      ay = 1 - fgH - rH * 0.35;
      accentOps();
    }

    /* accent flecks — glints near the horizon or blooms on the band */
    var fy = isSun ? horizon : 1 - fgH;
    for (i = 0; i < 9; i++) {
      ops.push(dabOp(rand(0.05, 0.95), fy + rand(-0.04, 0.05), 0.012, 0.03, 0.012, 0.026, jitterCss(acc, jit)));
    }

    return { pal: pal, ops: ops, chips: makeChips(pal, d) };
  }

  /* 48 chips: 12 hues × 4 tones, with the three true cluster centres
     planted in their nearest cells so a perfect read scores 100. */
  function makeChips(pal, d) {
    var chips = [], hueOff = rand(0, 30), r, c, rgb, cl, bi, bd, dd;
    for (r = 0; r < TONE_ROWS; r++) {
      for (c = 0; c < HUE_COLS; c++) {
        rgb = hslToRgb(
          hueOff + c * (360 / HUE_COLS),
          TONES[r].s * TONE_SAT_SCALE[d] + rand(-3, 3),
          TONES[r].l + rand(-3, 3)
        );
        chips.push({ rgb: rgb, lab: rgbToLab(rgb), planted: false });
      }
    }
    for (r = 0; r < 3; r++) {
      cl = pal[r];
      bi = -1; bd = Infinity;
      for (c = 0; c < chips.length; c++) {
        if (chips[c].planted) continue;
        dd = deltaE(cl.lab, chips[c].lab);
        if (dd < bd) { bd = dd; bi = c; }
      }
      chips[bi] = { rgb: cl.rgb, lab: cl.lab, planted: true };
    }
    return chips;
  }

  /* ============================================================
     canvas + DOM
     ============================================================ */

  var canvas = document.getElementById('gameCanvas');
  var ctx = canvas.getContext('2d');
  var hint = document.getElementById('hint');
  var toast = document.getElementById('toast');
  var hudRound = document.getElementById('hudRound');
  var hudScore = document.getElementById('hudScore');
  var hudBest = document.getElementById('hudBest');
  var slotsEl = document.getElementById('slots');
  var chipsEl = document.getElementById('chips');
  var revealEl = document.getElementById('reveal');
  var btnLock = document.getElementById('btnLock');

  ArtDaily.init({ slug: SLUG });

  /* ---- theme-aware inks (re-read on every repaint) ---- */
  function inks() {
    var cs = getComputedStyle(document.documentElement);
    return {
      card: cs.getPropertyValue('--card').trim(),
      accent: cs.getPropertyValue('--game-accent').trim() || cs.getPropertyValue('--sky').trim(),
    };
  }

  /* ---- crisp canvas at any devicePixelRatio; height tracks width ---- */
  var W = 0, H = 0;
  function fitCanvas() {
    var rect = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(rect.width));
    H = Math.round(W * ASPECT);
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ---- state ---- */
  var round = 0, sceneIdx = 0, sceneScores = [], scene = null, state = 'pick';
  var picks = [null, null, null];
  var slotEls = [], chipEls = [];

  function pickIndexOfChip(chipIdx) {
    for (var i = 0; i < picks.length; i++) {
      if (picks[i] && picks[i].chip === chipIdx) return i;
    }
    return -1;
  }

  function firstEmptySlot() {
    for (var i = 0; i < picks.length; i++) if (!picks[i]) return i;
    return -1;
  }

  /* ---- painting ---- */
  function draw() {
    var c = inks();
    ctx.clearRect(0, 0, W, H);
    if (!scene) return;
    var i, j, op;
    for (i = 0; i < scene.ops.length; i++) {
      op = scene.ops[i];
      ctx.fillStyle = op.c;
      if (op.t === 'rect') {
        ctx.fillRect(op.x * W, op.y * H, op.w * W, op.h * H);
      } else if (op.t === 'circle') {
        ctx.beginPath();
        ctx.arc(op.x * W, op.y * H, op.r * W, 0, Math.PI * 2);
        ctx.fill();
      } else if (op.t === 'poly') {
        ctx.beginPath();
        ctx.moveTo(op.pts[0].x * W, op.pts[0].y * H);
        for (j = 1; j < op.pts.length; j++) ctx.lineTo(op.pts[j].x * W, op.pts[j].y * H);
        ctx.closePath();
        ctx.fill();
      }
    }
    if (state !== 'pick') drawPaletteStrip(c);
  }

  /* the true weighted palette, taped over the scene after locking in */
  function drawPaletteStrip(c) {
    var pad = 10, h = 24;
    var x = pad, y = H - h - pad, wAvail = W - pad * 2;
    ctx.fillStyle = c.card;
    ctx.fillRect(x - 4, y - 4, wAvail + 8, h + 8);
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(x - 4, y - 4, wAvail + 8, h + 8);
    for (var i = 0; i < scene.pal.length; i++) {
      var w = scene.pal[i].weight * wAvail;
      ctx.fillStyle = rgbCss(scene.pal[i].rgb);
      ctx.fillRect(x, y, Math.max(1, w - 2), h);
      x += w;
    }
  }

  /* ---- picker UI ---- */
  function buildSlots() {
    slotsEl.innerHTML = '';
    slotEls = [];
    for (var i = 0; i < 3; i++) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'slot';
      b.textContent = String(i + 1);
      b.dataset.idx = String(i);
      b.addEventListener('click', onSlot);
      slotsEl.appendChild(b);
      slotEls.push(b);
    }
  }

  function renderChips() {
    chipsEl.innerHTML = '';
    chipEls = [];
    for (var i = 0; i < scene.chips.length; i++) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.style.background = rgbCss(scene.chips[i].rgb);
      b.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-label', 'chip ' + rgbHex(scene.chips[i].rgb));
      b.dataset.idx = String(i);
      b.addEventListener('click', onChip);
      chipsEl.appendChild(b);
      chipEls.push(b);
    }
  }

  function syncPicker() {
    var filled = 0, i, el, p;
    for (i = 0; i < 3; i++) {
      el = slotEls[i];
      p = picks[i];
      if (p) {
        filled++;
        el.classList.add('filled');
        el.style.background = rgbCss(p.rgb);
        el.setAttribute('aria-label', 'pick ' + (i + 1) + ': ' + rgbHex(p.rgb) + ' — tap to clear');
      } else {
        el.classList.remove('filled');
        el.style.background = '';
        el.setAttribute('aria-label', 'pick ' + (i + 1) + ' — empty');
      }
    }
    for (i = 0; i < chipEls.length; i++) {
      chipEls[i].setAttribute('aria-pressed', pickIndexOfChip(i) !== -1 ? 'true' : 'false');
    }
    btnLock.disabled = filled < 3;
    if (state === 'pick' && filled === 3) hint.textContent = 'happy with the trio? lock it in.';
  }

  function onChip(ev) {
    if (state !== 'pick') return;
    var idx = parseInt(ev.currentTarget.dataset.idx, 10);
    if (pickIndexOfChip(idx) !== -1) return;
    var s = firstEmptySlot();
    if (s === -1) { showToast('all 3 slots full — tap one to clear it'); return; }
    picks[s] = { chip: idx, rgb: scene.chips[idx].rgb };
    syncPicker();
  }

  function onSlot(ev) {
    if (state !== 'pick') return;
    var i = parseInt(ev.currentTarget.dataset.idx, 10);
    if (!picks[i]) return;
    picks[i] = null;
    hint.textContent = 'scene ' + (sceneIdx + 1) + ' of ' + SCENES_PER_ROUND + ' — tap the 3 chips that carry it.';
    syncPicker();
  }

  /* ---- reveal ---- */
  function renderReveal(res) {
    revealEl.innerHTML = '';
    var i, cl, m, row, bar, lab, sw, de, note;
    var title = document.createElement('p');
    title.className = 'reveal-title';
    title.textContent = 'scene ' + (sceneIdx + 1) + ': ' + Math.round(res.score) + '/100';
    revealEl.appendChild(title);
    for (i = 0; i < 3; i++) {
      cl = scene.pal[i];
      m = res.matches[i];
      row = document.createElement('div');
      row.className = 'rv-row';
      bar = document.createElement('span');
      bar.className = 'rv-bar';
      bar.style.background = rgbCss(cl.rgb);
      bar.style.width = Math.max(24, Math.round(cl.weight * 260)) + 'px';
      row.appendChild(bar);
      lab = document.createElement('span');
      lab.className = 'rv-label';
      lab.textContent = cl.role + ' · ' + Math.round(cl.weight * 100) + '%';
      row.appendChild(lab);
      sw = document.createElement('span');
      sw.className = 'rv-swatch';
      sw.style.background = rgbCss(picks[m.pick].rgb);
      sw.title = 'your pick';
      row.appendChild(sw);
      de = document.createElement('span');
      de.className = 'rv-de';
      de.textContent = 'ΔE ' + Math.round(m.dE) + ' → ' + Math.round(m.per) + '/100';
      row.appendChild(de);
      revealEl.appendChild(row);
    }
    for (i = 3; i < scene.pal.length; i++) {
      cl = scene.pal[i];
      row = document.createElement('div');
      row.className = 'rv-row';
      bar = document.createElement('span');
      bar.className = 'rv-bar';
      bar.style.background = rgbCss(cl.rgb);
      bar.style.width = Math.max(24, Math.round(cl.weight * 260)) + 'px';
      row.appendChild(bar);
      lab = document.createElement('span');
      lab.className = 'rv-label';
      lab.textContent = 'minor · ' + Math.round(cl.weight * 100) + '%';
      row.appendChild(lab);
      revealEl.appendChild(row);
    }
    if (res.samey) {
      note = document.createElement('p');
      note.className = 'rv-note';
      note.textContent = 'three near-identical picks — score ×0.72';
      revealEl.appendChild(note);
    }
    if (res.bonus) {
      note = document.createElement('p');
      note.className = 'rv-note';
      note.textContent = 'accent spotted — +' + res.bonus;
      revealEl.appendChild(note);
    }
    revealEl.hidden = false;
  }

  /* ---- flow ---- */
  function startScene() {
    scene = makeScene(sceneIdx);
    picks = [null, null, null];
    state = 'pick';
    revealEl.hidden = true;
    chipsEl.hidden = false;
    renderChips();
    syncPicker();
    btnLock.textContent = 'lock it in';
    hint.textContent = 'scene ' + (sceneIdx + 1) + ' of ' + SCENES_PER_ROUND + ' — tap the 3 chips that carry it.';
    draw();
  }

  function newRound() {
    round += 1;
    sceneIdx = 0;
    sceneScores = [];
    hudRound.textContent = String(round);
    hudScore.textContent = '–';
    startScene();
  }

  function onLock() {
    if (state === 'pick') {
      if (firstEmptySlot() !== -1) return;
      var res = scoreScene(
        [scene.pal[0].rgb, scene.pal[1].rgb, scene.pal[2].rgb],
        [picks[0].rgb, picks[1].rgb, picks[2].rgb]
      );
      sceneScores.push(res.score);
      state = 'reveal';
      chipsEl.hidden = true;
      renderReveal(res);
      draw();
      hint.textContent = 'dominant ΔE ' + Math.round(res.matches[0].dE) +
        ' · secondary ΔE ' + Math.round(res.matches[1].dE) +
        ' · accent ΔE ' + Math.round(res.matches[2].dE);
      btnLock.textContent = (sceneIdx < SCENES_PER_ROUND - 1) ? 'next scene →' : 'finish round';
      btnLock.disabled = false;
      return;
    }
    if (state === 'reveal') {
      if (sceneIdx < SCENES_PER_ROUND - 1) {
        sceneIdx += 1;
        startScene();
      } else {
        finishRound();
      }
    }
  }

  function finishRound() {
    state = 'done';
    var res = ArtDaily.report(roundScore(sceneScores));
    hudScore.textContent = String(res.score);
    hudBest.textContent = res.best === null ? '–' : String(res.best);
    hint.textContent = 'round done — press “new round” to go again.';
    btnLock.textContent = 'round done';
    btnLock.disabled = true;
    showToast((res.isNewBest ? 'new best! ' : 'score ') + res.score + ' / 100', res.isNewBest);
  }

  var toastTimer = null;
  function showToast(msg, celebrate) {
    toast.innerHTML = '';
    var s = document.createElement('span');
    s.className = celebrate ? 'toast-accent' : '';
    s.textContent = msg;
    toast.appendChild(s);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 2200);
  }

  /* ---- chrome wiring ---- */
  btnLock.addEventListener('click', onLock);
  document.getElementById('btnRound').addEventListener('click', newRound);

  var btnHow = document.getElementById('btnHow');
  var howTo = document.getElementById('howTo');
  btnHow.addEventListener('click', function () {
    howTo.hidden = !howTo.hidden;
    btnHow.setAttribute('aria-expanded', String(!howTo.hidden));
  });

  ArtDaily.onTheme(draw);
  window.addEventListener('resize', function () { fitCanvas(); draw(); });

  /* ---- boot ---- */
  buildSlots();
  fitCanvas();
  var best = ArtDaily.best();
  hudBest.textContent = best === null ? '–' : String(best);
  newRound();
})();
