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

  /* Written so NaN falls out at 0 rather than propagating: a broken
     number must never be able to buy score downstream of here. */
  function clamp01(v) { return v > 0 ? (v > 1 ? 1 : v) : 0; }

  /* h degrees (any), s/l 0–100 → {r,g,b} 0–255 */
  function hslToRgb(h, s, l) {
    h = Number(h);
    if (!isFinite(h)) h = 0; /* NaN/±Infinity % 360 is NaN, which would poison the channels */
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

  /* sRGB 0–255 → linear → XYZ (D65) → CIE Lab.
     lin() deliberately folds a junk CHANNEL to 0 rather than letting it
     propagate, but a missing colour OBJECT threw on `rgb.r` before it
     ever got there — so scoreScene, which maps every colour through
     here first, threw outright on a null entry instead of returning a
     number. The scoring layer's standing contract is that degenerate
     input comes back as a finite 0–100, never a throw. Fold a missing
     object to exactly where a missing channel already goes.
     (This is the no-throw floor, not a "no pick" semantic: a null reads
     as black. Genuinely ABSENT picks — a short pickRgbs array — still
     land on matchPicks' NO_PICK_DE branch and score 0, unchanged.
     Unreachable from onLock either way, which checks all three slots
     are filled before it scores anything.) */
  function rgbToLab(rgb) {
    function lin(c) {
      c = Number(c);
      if (!isFinite(c)) c = 0;
      c = (c < 0 ? 0 : c > 255 ? 255 : c) / 255;
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    if (!rgb) rgb = {};
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

  /* THE GRID'S OWN RESOLUTION IS THE ONLY HONEST YARDSTICK. The chip
     sheet steps 30° of hue per column, which on the saturated rows is
     ΔE ~37 between neighbouring cells — and the old score zeroed at ΔE 38.
     So the scoring window was exactly one cell wide: a player who READ THE
     SCENE CORRECTLY and tapped one square off scored 1 or 2 out of 100 for
     that role. That is an aiming slip priced as a colour mistake, and in a
     12-wide grid on a trackpad it is the common case, not the exception.
     Measure the miss in CELLS instead — dE divided by the mean distance
     between neighbouring chips — so one cell off costs the same on a
     saturated scene as on a muted one, and two cells off (a real misread)
     still collapses. */
  var ZERO_CELLS = 2.0;
  var FALLBACK_STEP = 20; /* used only if a caller omits the grid step */

  function cellsOff(dE, cellStep) {
    var step = (typeof cellStep === 'number' && isFinite(cellStep) && cellStep > 1)
      ? cellStep : FALLBACK_STEP;
    var c = dE / step;
    return isFinite(c) ? c : ZERO_CELLS;
  }

  function perMatchScore(dE, cellStep) {
    return 100 * clamp01(1 - cellsOff(dE, cellStep) / ZERO_CELLS);
  }

  /* Mean ΔE between neighbouring cells: the finest distinction the sheet
     can express, and therefore the unit a miss should be counted in. */
  function gridCellStep(chips, cols) {
    var rows = Math.floor(chips.length / cols), sum = 0, n = 0, r, c, i;
    for (r = 0; r < rows; r++) {
      for (c = 0; c < cols; c++) {
        i = r * cols + c;
        if (c + 1 < cols) { sum += deltaE(chips[i].lab, chips[i + 1].lab); n++; }
        if (r + 1 < rows) { sum += deltaE(chips[i].lab, chips[i + cols].lab); n++; }
      }
    }
    return n ? sum / n : FALLBACK_STEP;
  }

  /* The miss in plain words — and in the unit the player actually moves
     in. The ΔE number still rides along on the reveal rows for anyone who
     wants it, but the sentence a beginner acts on must not need one. */
  function matchWord(dE, cellStep) {
    if (!isFinite(dE)) return 'no pick';
    var c = cellsOff(dE, cellStep);
    if (c < 0.5) return 'spot on';
    if (c < 1.4) return 'one chip off';
    if (c < 2.4) return 'a couple of chips off';
    return 'well off';
  }

  /* A PLAIN NAME FOR A CHIP. A raw hex is true but says nothing a person
     can picture, and it was the WHOLE of a chip's accessible name — 48 of
     them, every one reading "chip #7f9fc4". Name the hue and the tone
     instead (the way mix-to-target names its base pigments) and keep the
     hex behind it for anyone who wants the exact value.
     How light and how colourful come from Lab, which is the perceptual
     read; only the hue NAME comes off the sRGB wheel, because that is the
     wheel people name colours on. Naming from the Lab hue angle instead
     puts pure red at 40°, i.e. calls it "orange".
     Pure: an {r,g,b} in, a string out, no DOM — and NaN-safe, because a
     broken channel must degrade to a wrong-but-speakable name rather than
     put "NaN" into a label. */
  var HUE_STOPS = [
    [15, 'red'], [45, 'orange'], [70, 'yellow'], [95, 'yellow-green'],
    [150, 'green'], [200, 'teal'], [255, 'blue'], [290, 'violet'],
    [335, 'magenta'], [360, 'red'],
  ];
  function colourName(rgb) {
    function ch(v) { v = Number(v); return isFinite(v) ? (v < 0 ? 0 : v > 255 ? 255 : v) : 0; }
    if (!rgb) rgb = {};
    var r = ch(rgb.r), g = ch(rgb.g), b = ch(rgb.b);
    var lab = rgbToLab({ r: r, g: g, b: b });
    var C = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
    if (!isFinite(C)) C = 0;
    var L = isFinite(lab.L) ? lab.L : 50;
    var tone = L >= 66 ? 'light ' : (L <= 42 ? 'dark ' : '');
    if (C < 6) return tone ? tone + 'grey' : 'mid grey';
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0;
    if (d > 0) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    h = ((h % 360) + 360) % 360;
    var name = 'red', i;
    for (i = 0; i < HUE_STOPS.length; i++) {
      if (h < HUE_STOPS[i][0]) { name = HUE_STOPS[i][1]; break; }
    }
    return tone + (C < 20 ? 'muted ' : '') + name;
  }

  var SAMEY_DE = 14; /* below this the three picks are one colour, not a palette */

  /* Assign the 3 picks to [dominant, secondary, accent] by brute-forcing
     all 6 permutations and keeping the best weighted total (accent bonus
     included) — greedy nearest-first could under-credit a good trio when
     one pick sat between two clusters. */
  var PERMS3 = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  var NO_PICK_DE = 200; /* a missing pick scores 0 but stays a printable number */
  function matchPicks(trueLabs, pickLabs, cellStep) {
    var best = null, bestTotal = -Infinity, p, i, perm, m, total, d;
    for (p = 0; p < PERMS3.length; p++) {
      perm = PERMS3[p];
      m = [];
      total = 0;
      for (i = 0; i < trueLabs.length; i++) {
        /* onLock only ever hands us three picks; the guard keeps the pure
           function total for callers (and tests) that do not. */
        d = pickLabs[perm[i]] ? deltaE(trueLabs[i], pickLabs[perm[i]]) : NO_PICK_DE;
        m.push({ pick: perm[i], dE: d });
        total += (MATCH_WEIGHTS[i] || 0) * perMatchScore(d, cellStep);
      }
      if (m.length > 2 && m[2].dE < 20) total += 6; /* same bonus scoreScene grants */
      if (total > bestTotal) { bestTotal = total; best = m; }
    }
    return best;
  }

  /* trueRgbs = [dominant, secondary, accent] cluster centres,
     pickRgbs = the player's 3 picks, cellStep = this scene's grid
     resolution (mean ΔE between neighbouring chips).
     → { score 0–100, matches[{pick,dE,per}], samey, bonus } */
  function scoreScene(trueRgbs, pickRgbs, cellStep) {
    var trueLabs = [], pickLabs = [], i;
    for (i = 0; i < trueRgbs.length; i++) trueLabs.push(rgbToLab(trueRgbs[i]));
    for (i = 0; i < pickRgbs.length; i++) pickLabs.push(rgbToLab(pickRgbs[i]));
    var matches = matchPicks(trueLabs, pickLabs, cellStep);
    var base = 0;
    for (i = 0; i < matches.length; i++) {
      matches[i].per = perMatchScore(matches[i].dE, cellStep);
      base += (MATCH_WEIGHTS[i] || 0) * matches[i].per;
    }
    /* three near-identical picks hedge instead of reading the scene.
       The UI now blocks locking those in (with a sentence saying why),
       so this is a floor for direct callers rather than a trap. */
    var samey = maxPairwiseDE(pickLabs) < SAMEY_DE;
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
    var pal = null, best = null, bestSep = -1, sep;
    var attempt, h0, flip, sat, secOff, accOff, wd, ws, wa, minorTotal, total, twoMinors, m1;
    for (attempt = 0; attempt < 120; attempt++) {
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
         a perfect pick clear of the samey penalty, so 100 is reachable).
         Track the widest-separated attempt so a failed run still returns
         the best palette seen, never just the last roll of the dice. */
      sep = Math.min(
        deltaE(pal[0].lab, pal[1].lab),
        deltaE(pal[0].lab, pal[2].lab),
        deltaE(pal[1].lab, pal[2].lab)
      );
      if (sep > bestSep) { bestSep = sep; best = pal; }
      if (sep >= 24) break;
    }
    return best;
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

    var chips = makeChips(pal, d);
    return { pal: pal, ops: ops, chips: chips, cellStep: gridCellStep(chips, HUE_COLS) };
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
    /* decoys: a planted answer can sit visibly off its row's tone, so a
       grid-hunter could spot it by irregularity alone. Give a handful of
       random non-planted cells the same kind of displacement — now an
       off-tone chip proves nothing; only reading the scene does. */
    var decoys = 6, guard = 0, di, dr;
    while (decoys > 0 && guard < 200) {
      guard++;
      di = Math.floor(rand(0, chips.length));
      if (di >= chips.length || chips[di].planted) continue;
      dr = Math.floor(di / HUE_COLS);
      rgb = hslToRgb(
        hueOff + (di % HUE_COLS) * (360 / HUE_COLS) + rand(-8, 8),
        TONES[dr].s * TONE_SAT_SCALE[d] + rand(-16, 16),
        TONES[dr].l + rand(-13, 13)
      );
      chips[di] = { rgb: rgb, lab: rgbToLab(rgb), planted: false };
      decoys--;
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
  var btnRound = document.getElementById('btnRound');

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

  /* The three roles, named in words a beginner already owns. The trade
     terms (dominant / secondary / accent) are what the reveal strip
     teaches — they are not asked for before anything has shown them. */
  var SLOT_NAMES = ['biggest area', 'second colour', 'small loud one'];

  function baseHint() {
    return 'scene ' + (sceneIdx + 1) + ' of ' + SCENES_PER_ROUND +
      ' — tap 3 chips: the colour covering the biggest area, the second' +
      ' one, and the small loud note. any order. retap to undo.';
  }

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
  /* The canvas is a role="img", so its label is the ONLY thing said about
     it — and "Palette Pick drill area" said nothing true: not which scene
     it is, not that it is a painting, not that the answer strip has
     appeared over it. (It also carried tabindex="0": a focus stop with no
     keyboard behaviour behind it, sitting between the HUD and the picker.
     Removed — there is nothing there to operate.) */
  function labelCanvas() {
    canvas.setAttribute('aria-label', 'scene ' + (sceneIdx + 1) + ' of ' + SCENES_PER_ROUND +
      ' — a painted landscape; its colours are what you read' +
      (state === 'pick' ? '' : ' · the true palette is now taped across the bottom of it'));
  }

  function draw() {
    var c = inks();
    ctx.clearRect(0, 0, W, H);
    labelCanvas();
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

  /* the true weighted palette, taped over the scene after locking in;
     role initials (D / S / A / m) let the strip map onto the reveal rows */
  var ROLE_LETTER = { dominant: 'D', secondary: 'S', accent: 'A', minor: 'm' };
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
      var segW = Math.max(1, w - 2);
      ctx.fillStyle = rgbCss(scene.pal[i].rgb);
      ctx.fillRect(x, y, segW, h);
      if (segW >= 16) {
        /* Ink by segment lightness — but L* 52 is exactly where the two
           inks tie, and they only reach 4.0:1 there, under AA. So the
           glyph is also haloed in the opposite ink: the letter is then
           read against that halo (~14:1) rather than against whatever
           colour the palette happened to roll, in either theme. */
        var lightSeg = scene.pal[i].lab.L > 52;
        var letter = ROLE_LETTER[scene.pal[i].role] || 'm';
        var lx = x + segW / 2, ly = y + h / 2 + 1;
        ctx.font = '700 12px ui-monospace, Menlo, Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = lightSeg ? '#FDFAF1' : '#221D16';
        ctx.strokeText(letter, lx, ly);
        ctx.fillStyle = lightSeg ? '#221D16' : '#FDFAF1';
        ctx.fillText(letter, lx, ly);
      }
      x += w;
    }
  }

  /* ---- picker UI ---- */
  function buildSlots() {
    slotsEl.innerHTML = '';
    slotEls = [];
    for (var i = 0; i < 3; i++) {
      var cell = document.createElement('div');
      cell.className = 'slot-cell';
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'slot';
      b.textContent = String(i + 1);
      b.dataset.idx = String(i);
      b.addEventListener('click', onSlot);
      /* the role is named UNDER the square, on the first screen, instead
         of only being decoded by the reveal after the score is banked */
      var cap = document.createElement('span');
      cap.className = 'slot-cap';
      cap.textContent = SLOT_NAMES[i];
      cell.appendChild(b);
      cell.appendChild(cap);
      slotsEl.appendChild(cell);
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
      /* "tap" is wrong for the half of the room on a keyboard, and the
         pressed state already says whether it is picked. The ordinal is
         the only orientation there is inside a 48-cell sheet that
         rewraps from 12 columns down to 4, and the colour name is the
         part a person can actually picture. */
      b.setAttribute('aria-label', 'chip ' + (i + 1) + ' of ' + scene.chips.length +
        ', ' + colourName(scene.chips[i].rgb) + ', ' + rgbHex(scene.chips[i].rgb));
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
        el.setAttribute('aria-label', 'pick ' + (i + 1) + ', ' + SLOT_NAMES[i] + ': ' +
          colourName(p.rgb) + ', ' + rgbHex(p.rgb) + ' — press to clear');
      } else {
        el.classList.remove('filled');
        el.style.background = '';
        el.setAttribute('aria-label', 'pick ' + (i + 1) + ', ' + SLOT_NAMES[i] + ' — empty');
      }
    }
    for (i = 0; i < chipEls.length; i++) {
      chipEls[i].setAttribute('aria-pressed', pickIndexOfChip(i) !== -1 ? 'true' : 'false');
    }
    if (filled < 3) {
      btnLock.disabled = true;
      return;
    }
    /* Three near-identical picks used to lock in fine and then get docked
       28% in silence. Say it BEFORE the score instead — a beginner
       hedging on three bits of sky is making a judgement error the drill
       exists to correct, not a rule violation to be fined for. */
    var samey = maxPairwiseDE([
      rgbToLab(picks[0].rgb), rgbToLab(picks[1].rgb), rgbToLab(picks[2].rgb),
    ]) < SAMEY_DE;
    btnLock.disabled = samey;
    if (state === 'pick') {
      hint.textContent = samey
        ? 'those three are nearly the same colour — a scene needs a big quiet area, a second colour, and one small loud note. swap one out.'
        : 'happy with the trio? lock it in.';
    }
  }

  function onChip(ev) {
    if (state !== 'pick') return;
    var idx = parseInt(ev.currentTarget.dataset.idx, 10);
    var pi = pickIndexOfChip(idx);
    if (pi !== -1) { /* retap a picked chip = unpick it */
      picks[pi] = null;
      hint.textContent = baseHint();
      syncPicker();
      return;
    }
    var s = firstEmptySlot();
    if (s === -1) { showToast('all 3 slots full — retap a chip or a slot to clear'); return; }
    picks[s] = { chip: idx, rgb: scene.chips[idx].rgb };
    syncPicker();
  }

  function onSlot(ev) {
    if (state !== 'pick') return;
    var i = parseInt(ev.currentTarget.dataset.idx, 10);
    if (!picks[i]) return;
    picks[i] = null;
    hint.textContent = baseHint();
    syncPicker();
  }

  /* ---- reveal ---- */
  function renderReveal(res) {
    /* Unhide FIRST. This panel is the drill's whole payload and it is a
       live region — but it was filled while still `hidden`, i.e. inside a
       subtree the accessibility tree does not carry, and un-hiding it
       afterwards is not a content change. Every row of it announced
       nothing at all. Show, then fill. */
    revealEl.hidden = false;
    revealEl.innerHTML = '';
    var i, cl, m, row, bar, lab, sw, de, note;
    var title = document.createElement('p');
    title.className = 'reveal-title';
    title.textContent = 'scene ' + (sceneIdx + 1) + ': ' + Math.round(res.score) + '/100';
    revealEl.appendChild(title);
    var legend = document.createElement('p');
    legend.className = 'rv-note';
    legend.textContent = 'each bar: true colour, your pick butted on its right · ringed chips above were the answers' +
      (sceneIdx === 0 ? ' · ΔE = how far apart the eye reads two colours — under 8 is a very close match' : '');
    revealEl.appendChild(legend);
    var pair;
    for (i = 0; i < 3; i++) {
      cl = scene.pal[i];
      m = res.matches[i];
      row = document.createElement('div');
      row.className = 'rv-row';
      /* true colour and your pick butted edge to edge — subtle misses
         only read when the two fields actually touch */
      pair = document.createElement('span');
      pair.className = 'rv-pair';
      bar = document.createElement('span');
      bar.className = 'rv-bar';
      bar.style.background = rgbCss(cl.rgb);
      bar.style.width = Math.max(24, Math.round(cl.weight * 260)) + 'px';
      bar.title = 'true ' + cl.role;
      pair.appendChild(bar);
      sw = document.createElement('span');
      sw.className = 'rv-swatch';
      sw.style.background = rgbCss(picks[m.pick].rgb);
      sw.title = 'your pick';
      pair.appendChild(sw);
      row.appendChild(pair);
      lab = document.createElement('span');
      lab.className = 'rv-label';
      lab.textContent = SLOT_NAMES[i] + ' (' + cl.role + ') · ' + Math.round(cl.weight * 100) + '%';
      row.appendChild(lab);
      de = document.createElement('span');
      de.className = 'rv-de';
      de.textContent = matchWord(m.dE, scene.cellStep) + ' — ' + Math.round(m.per) + '/100 · ΔE ' + Math.round(m.dE);
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
  }

  /* Every arrow in this family's markup is wrapped in an aria-hidden
     span, because it is decoration — but the primary button relabels
     itself from JS with textContent, which dropped the glyph straight
     into the accessible name: "next scene right arrow". Rebuild the
     label the way the markup does it. */
  function setBtnLabel(btn, text, glyph) {
    btn.innerHTML = '';
    btn.appendChild(document.createTextNode(glyph ? text + ' ' : text));
    if (glyph) {
      var g = document.createElement('span');
      g.setAttribute('aria-hidden', 'true');
      g.textContent = glyph;
      btn.appendChild(g);
    }
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
    setBtnLabel(btnLock, 'lock it in');
    hint.textContent = baseHint();
    draw();
  }

  /* mid-round the button throws the round away — say so before it does */
  function setRoundBtnLabel(inProgress) {
    btnRound.innerHTML = (inProgress ? 'restart round ' : 'new round ') + '<span aria-hidden="true">↻</span>';
  }

  function newRound() {
    /* Scene 3's reveal is on screen and all three scenes are scored: the
       round is FINISHED, it just has not been banked yet — the player has
       to press the primary button once more for that. Pressing "new
       round" there instead used to throw the whole round away, silently,
       with the score sitting right in front of them. Flush it first.
       finishRound() flips state to 'done', which this guard tests, so it
       can never double-report (the same guard the sibling drills keep). */
    if (state === 'reveal' && sceneScores.length >= SCENES_PER_ROUND) finishRound();
    round += 1;
    sceneIdx = 0;
    sceneScores = [];
    hudRound.textContent = String(round);
    hudScore.textContent = '–';
    setRoundBtnLabel(true);
    startScene();
  }

  function onLock() {
    if (state === 'pick') {
      if (firstEmptySlot() !== -1) return;
      var res = scoreScene(
        [scene.pal[0].rgb, scene.pal[1].rgb, scene.pal[2].rgb],
        [picks[0].rgb, picks[1].rgb, picks[2].rgb],
        scene.cellStep
      );
      sceneScores.push(res.score);
      state = 'reveal';
      /* keep the grid on screen and ring the three true chips — spatial
         "you were two cells off" feedback that carries to the next scene */
      for (var ci = 0; ci < chipEls.length; ci++) {
        if (scene.chips[ci].planted) chipEls[ci].classList.add('rv-true');
        chipEls[ci].disabled = true;
      }
      renderReveal(res);
      draw();
      hint.textContent = matchWord(res.matches[0].dE, scene.cellStep) + ' on the biggest area · ' +
        matchWord(res.matches[1].dE, scene.cellStep) + ' on the second · ' +
        matchWord(res.matches[2].dE, scene.cellStep) + ' on the small loud one.';
      if (sceneIdx < SCENES_PER_ROUND - 1) setBtnLabel(btnLock, 'next scene', '→');
      else setBtnLabel(btnLock, 'finish round');
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
    setBtnLabel(btnLock, 'round done');
    btnLock.disabled = true;
    setRoundBtnLabel(false);
    showToast((res.isNewBest ? 'new best! ' : 'score ') + res.score + ' / 100', res.isNewBest);
  }

  var toastTimer = null;
  function showToast(msg, celebrate) {
    /* Unhide BEFORE filling. A live region that is mutated while it is
       still `hidden` is mutated inside a subtree the accessibility tree
       does not carry, and un-hiding it afterwards is not itself a content
       change — so the round score announced to nobody. Show it first,
       then write into it, and the announcement actually happens. */
    toast.hidden = false;
    toast.innerHTML = '';
    var s = document.createElement('span');
    s.className = celebrate ? 'toast-accent' : '';
    s.textContent = msg;
    toast.appendChild(s);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 2200);
  }

  /* ---- chrome wiring ---- */
  /* The one primary button changes job in place (lock it in → next scene
     →), so the second click of an accidental double-click fires the NEW
     action: it starts the next scene and takes the ringed true chips, the
     ΔE rows and the palette strip with it before they can be read. Ignore
     a repeat that arrives inside the guard window. */
  var ACTION_GUARD_MS = 250;
  var actionAt = 0;
  btnLock.addEventListener('click', function () {
    var now = Date.now();
    if (now - actionAt < ACTION_GUARD_MS) return;
    actionAt = now;
    onLock();
  });
  btnRound.addEventListener('click', newRound);

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
