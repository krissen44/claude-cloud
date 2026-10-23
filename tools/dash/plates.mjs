// Paints the Scrappy Dash background plates (pixel art, 1 px = 1 game pixel) into public/art/dash-*.png:
//   dash-<skin>-sky.png  480×300  the sky (sleigh: night, aurora, moon · rocket: nebula, galaxy, ringed planet)
//   dash-<skin>-far.png  480×150  far layer, tiles sideways (snowy mountains + pine forest · lunar ridges)
//   dash-<skin>-mid.png  480×170  mid layer, tiles sideways (old town with church · moon base domes and antennas)
// Seeded, so every run paints the same pictures. Owners may replace them with their own art of the same size.
// Usage: node tools/dash/plates.mjs [outdir]   (needs Playwright's Chromium; CHROMIUM=path optional)
import { chromium } from "../test/node_modules/playwright/index.mjs";
import fs from "node:fs";
const OUT = process.argv[2] || new URL("../../public/art/", import.meta.url).pathname;

const painter = () => {
  // ---------- helpers ----------
  const rng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + .5) / 16);
  const bay = (x, y) => BAYER[(y & 3) * 4 + (x & 3)];
  const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  function canvas(w, h){ const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.imageSmoothingEnabled = false; const im = x.createImageData(w, h); return {c, x, im, w, h, d: im.data}; }
  const put = (P, x, y, col, a = 255) => {
    x |= 0; y |= 0; if (x < 0 || y < 0 || x >= P.w || y >= P.h) return;
    const i = (y * P.w + x) * 4;
    if (a >= 255){ P.d[i] = col[0]; P.d[i + 1] = col[1]; P.d[i + 2] = col[2]; P.d[i + 3] = 255; return; }
    const k = a / 255, ia = P.d[i + 3] / 255, oa = k + ia * (1 - k);
    for (let j = 0; j < 3; j++) P.d[i + j] = Math.round((col[j] * k + P.d[i + j] * ia * (1 - k)) / (oa || 1));
    P.d[i + 3] = Math.round(oa * 255);
  };
  const get = (P, x, y) => { const i = (y * P.w + x) * 4; return [P.d[i], P.d[i + 1], P.d[i + 2], P.d[i + 3]]; };
  // a vertical gradient through a palette, with ordered dithering between neighbouring colours (real pixel-art banding)
  function ditherGrad(P, pal, y0, y1, x0 = 0, x1 = P.w){
    const cols = pal.map(hex);
    for (let y = y0; y < y1; y++){
      const t = (y - y0) / Math.max(1, y1 - y0 - 1) * (cols.length - 1), k = Math.min(cols.length - 2, Math.floor(t)), f = t - k;
      for (let x = x0; x < x1; x++) put(P, x, y, f > bay(x, y) ? cols[k + 1] : cols[k]);
    }
  }
  // tileable 1-D noise for ridges
  function ridge(w, seed, oct, amp){
    const r = rng(seed), out = new Float32Array(w);
    for (let o = 0; o < oct; o++){
      const n = 2 << o, pts = Array.from({length: n}, () => r() * 2 - 1), a = amp / (1 << o);
      for (let x = 0; x < w; x++){ const p = x / w * n, i = Math.floor(p), f = p - i, s = f * f * (3 - 2 * f);
        out[x] += (pts[i % n] * (1 - s) + pts[(i + 1) % n] * s) * a; }
    }
    return out;
  }
  // 2-D value noise, tileable in x
  function noise2(w, h, seed, cell){
    const r = rng(seed), gw = Math.ceil(w / cell), gh = Math.ceil(h / cell) + 2, g = Array.from({length: gw * gh}, () => r());
    const at = (i, j) => g[((j % gh) * gw) + (i % gw)];
    return (x, y) => { const fx = x / cell, fy = y / cell, i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j, su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
      return (at(i, j) * (1 - su) + at(i + 1, j) * su) * (1 - sv) + (at(i, j + 1) * (1 - su) + at(i + 1, j + 1) * su) * sv; };
  }
  const png = P => { P.x.putImageData(P.im, 0, 0); return P.c.toDataURL('image/png'); };

  // ---------- SLEIGH: night sky ----------
  function sleighSky(){
    const P = canvas(480, 300), r = rng(11);
    ditherGrad(P, ['#060b1f', '#0a1430', '#0f1d44', '#16295a', '#1f3870', '#2c4a86'], 0, 300);
    // aurora: soft curtains, brightest along a wavy line, fading up and down (dithered alpha)
    const AG = hex('#5dffb0'), AV = hex('#8b6cff'), n = noise2(480, 300, 5, 24);
    for (let x = 0; x < 480; x++){
      const base = 70 + Math.sin(x / 61) * 16 + Math.sin(x / 23 + 1) * 6, len = 46 + Math.sin(x / 37) * 14 + n(x, 0) * 20;
      for (let y = Math.max(0, Math.floor(base - len)); y < base + 14; y++){
        const up = y < base ? 1 - (base - y) / len : 1 - (y - base) / 14;
        let a = Math.pow(Math.max(0, up), 1.6) * (.35 + .65 * n(x, y * .3)) * (.6 + .4 * Math.sin(x / 9 + n(x, 7) * 6) ** 2);
        if (a * .9 < bay(x, y) * .55) continue;
        const col = mix(AG, AV, Math.min(1, Math.max(0, (base - y) / len * 1.3)));
        put(P, x, y, col, Math.min(150, 40 + a * 150));
      }
    }
    // milky dust + stars
    const dust = noise2(480, 300, 9, 40);
    for (let i = 0; i < 2600; i++){ const x = r() * 480 | 0, y = r() * 200 | 0, d = dust(x, y); if (d > .55 && r() < (d - .55) * 3) put(P, x, y, hex('#9fb6ff'), 70); }
    for (let i = 0; i < 170; i++){
      const x = r() * 480 | 0, y = r() * 210 | 0, b = r();
      const col = b > .92 ? hex('#ffe9b0') : b > .8 ? hex('#cfe0ff') : hex('#ffffff');
      put(P, x, y, col, b > .5 ? 255 : 140);
      if (b > .965){ for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) put(P, x + dx, y + dy, col, 150); for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) put(P, x + dx, y + dy, col, 60); }
    }
    // the moon: shaded disc with craters, a dithered halo, rim light
    const mx = 416, my = 54, R = 21;
    for (let y = -64; y <= 64; y++) for (let x = -64; x <= 64; x++){
      const d = Math.hypot(x, y); if (d <= R || d > 64) continue;
      const a = Math.pow(1 - (d - R) / (64 - R), 2.2); if (a > bay(mx + x, my + y) * 1.1) put(P, mx + x, my + y, hex('#fff2c2'), 26 + a * 90);
    }
    const MOON = [hex('#fffbe6'), hex('#f6ecc4'), hex('#e6d6a2'), hex('#cdb985')];
    for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++){
      const d = Math.hypot(x, y); if (d > R + .3) continue;
      const lit = (-x * .55 - y * .45) / R;                       // light from the upper left
      let k = lit > .35 ? 0 : lit > -.1 ? 1 : lit > -.45 ? 2 : 3; if (d > R - 1.2) k = Math.min(3, k + 1);
      if (k < 3 && (lit * 4 % 1) < bay(x, y) * .3) k++;
      put(P, mx + x, my + y, MOON[k]);
    }
    for (const [cx, cy, cr] of [[-7, -5, 4], [6, 6, 3], [-2, 10, 2], [9, -8, 2], [-11, 6, 2], [2, -12, 1.5]]){
      for (let y = -cr - 1; y <= cr + 1; y++) for (let x = -cr - 1; x <= cr + 1; x++){
        const d = Math.hypot(x, y); if (d > cr + .4) continue;
        const px = mx + cx + x, py = my + cy + y; if (Math.hypot(cx + x, cy + y) > R - 1) continue;
        put(P, px, py, d > cr - .8 && (x + y) > 0 ? MOON[0] : MOON[Math.min(3, 2 + (x + y < -1 ? 1 : 0))]);
      }
    }
    return png(P);
  }
  // ---------- SLEIGH: far mountains + pine forest (tileable) ----------
  // a range of jagged peaks (min of tilted triangles + noise), moonlight from the right: lit right flanks, snow caps
  function peaks(seed, n, base, hMin, hMax, wMin, wMax){
    const r = rng(seed), top = new Float32Array(480).fill(base), side = new Int8Array(480), jag = ridge(480, seed + 1, 5, 3);
    for (let k = 0; k < n; k++){
      const px = r() * 480, hp = hMin + r() * (hMax - hMin), sl = hp / (wMin + r() * (wMax - wMin)), sr = sl * (.7 + r() * .6);
      for (let x = 0; x < 480; x++){ for (const off of [-480, 0, 480]){ const dx = x - (px + off), y = base - hp + Math.abs(dx) * (dx < 0 ? sl : sr);
        if (y < top[x]){ top[x] = y; side[x] = dx < 0 ? -1 : 1; } } }
    }
    for (let x = 0; x < 480; x++) top[x] += jag[x];
    return {top, side};
  }
  function sleighFar(){
    const P = canvas(480, 150), H = 150, r = rng(21);
    const A = peaks(3, 9, 118, 40, 92, 26, 60), B = peaks(8, 12, 132, 18, 48, 18, 40);
    const rockL = ['#26386a', '#2d4278', '#3a5290'].map(hex), rockD = ['#1a2750', '#1e2d5a', '#22335f'].map(hex);
    const snowL = ['#e8f0ff', '#cfdcf8'].map(hex), snowD = ['#9cb0dd', '#7f95c8'].map(hex);
    const range = (R, snowLine, dark) => { for (let x = 0; x < 480; x++){
      const t = Math.round(R.top[x]), lit = R.side[x] > 0;
      for (let y = t; y < H; y++){
        const depth = y - t, snowy = y < snowLine + Math.sin(x * .7) * 3 + (lit ? 4 : 0) && depth < 26;
        let col;
        if (snowy){ col = lit ? snowL[depth < 2 || bay(x, y) < .35 ? 0 : 1] : snowD[depth < 2 ? 0 : 1]; if (!lit && depth > 4 && bay(x, y) > .6) col = rockD[2]; }
        else { const pal = lit ? rockL : rockD, k = depth < 6 ? 2 : depth < 18 ? (bay(x, y) < .5 ? 2 : 1) : (bay(x, y) < .3 ? 1 : 0); col = dark ? mix(pal[k], [10, 16, 36], .35) : pal[k]; }
        put(P, x, y, col);
      }
    } };
    range(A, 52, false); range(B, 96, true);
    // haze band in the valley
    for (let y = 108; y < 134; y++) for (let x = 0; x < 480; x++) if (bay(x, y) < (y - 108) / 26 * .45) put(P, x, y, hex('#2a3b70'), 90);
    // pine forest along the bottom: little firs with snow on the branches (wrapping)
    const PINE = hex('#0d172e'), PINE2 = hex('#132140'), PS = hex('#c9d8f2');
    for (let i = 0; i < 170; i++){
      const x0 = Math.floor(r() * 480), hgt = 10 + Math.floor(r() * 18), base = 138 + Math.floor(r() * 8), w = Math.round(hgt * .42);
      for (let y = 0; y < hgt; y++){
        const half = Math.round((y / hgt) * w + (y % 4 === 3 ? 1 : 0));
        for (let dx = -half; dx <= half; dx++){
          const x = ((x0 + dx) % 480 + 480) % 480, py = base - hgt + y, edge = y % 4 === 0 && Math.abs(dx) >= half - 1;
          put(P, x, py, edge && dx > 0 ? PS : (dx < 0 ? PINE : PINE2));
        }
      }
      put(P, x0, base - hgt - 1, PS);
    }
    for (let x = 0; x < 480; x++) for (let y = 144; y < H; y++) put(P, x, y, hex(y < 146 ? '#a9bde3' : '#7d93c4'));
    return png(P);
  }
  // ---------- SLEIGH: the old town (tileable) ----------
  function sleighMid(){
    const P = canvas(480, 170), H = 170, r = rng(31);
    const WALL = [hex('#1b2547'), hex('#202b52'), hex('#18213f')], ROOF = hex('#121a35'), SNOW = [hex('#dfe9fb'), hex('#b2c3e6'), hex('#8a9fcf')];
    const WIN = [hex('#ffd66e'), hex('#ffb84a'), hex('#ffe9a8')];
    const shape = []; let x = 0;
    while (x < 480){                                // gabled houses of different widths and heights, a church now and then
      const church = shape.length === 4 || shape.length === 13;
      const w = church ? 36 : 22 + Math.floor(r() * 22), h = church ? 64 : 34 + Math.floor(r() * 40);
      shape.push({x, w, h, church, roof: church ? 30 : 10 + Math.floor(r() * 12), wall: WALL[Math.floor(r() * 3)], seed: r() * 1e9 | 0});
      x += w - (church ? 0 : Math.floor(r() * 4));
    }
    const last = shape[shape.length - 1]; last.w = 480 - last.x + 2;   // closes the loop so the strip tiles
    for (const s of shape){
      const rr = rng(s.seed), base = H - 4, top = base - s.h;
      for (let y = top; y < base; y++) for (let dx = 0; dx < s.w; dx++){       // wall with a darker right side
        const col = dx > s.w - 4 ? mix(s.wall, [8, 12, 26], .35) : s.wall;
        put(P, (s.x + dx) % 480, y, col);
      }
      // steep gable roof with snow on the left (moon) side
      const peak = s.x + s.w / 2;
      for (let y = 0; y < s.roof; y++){
        const half = Math.round((y + 1) / s.roof * (s.w / 2 + 2));
        for (let dx = -half; dx <= half; dx++){
          const px = Math.round(peak + dx), py = top - s.roof + y, rim = Math.abs(dx) >= half - 1;
          put(P, (px + 480) % 480, py, rim ? SNOW[dx < 0 ? 0 : 2] : (dx < 0 && bay(px, py) < .6 ? SNOW[1] : ROOF));
        }
      }
      if (s.church){                                 // spire with a cross and a lit clock
        const sx = Math.round(peak);
        for (let y = 0; y < 34; y++){ const half = Math.max(0, Math.round((y / 34) * 5)); for (let dx = -half; dx <= half; dx++) put(P, sx + dx, top - s.roof - 34 + y, dx < 0 ? SNOW[1] : ROOF); }
        for (let y = -6; y < 0; y++) put(P, sx, top - s.roof - 34 + y, hex('#ffd66e')); for (let dx = -2; dx <= 2; dx++) put(P, sx + dx, top - s.roof - 38, hex('#ffd66e'));
        for (let y = -3; y <= 3; y++) for (let dx = -3; dx <= 3; dx++) if (dx * dx + y * y <= 9) put(P, sx + dx, top + 8 + y, hex(dx * dx + y * y >= 7 ? '#3a2a10' : '#fff1c4'));
        put(P, sx, top + 6, hex('#3a2a10')); put(P, sx + 1, top + 8, hex('#3a2a10'));
        for (let y = top + 20; y < top + 40; y++) for (let dx = -4; dx <= 4; dx++) if (y > top + 22 || Math.abs(dx) < 3) put(P, sx + dx, y, WIN[1], 230);   // the rose window / door glow
      }
      // chimney on most houses
      if (!s.church && rr() < .75){ const cx = s.x + 4 + Math.floor(rr() * (s.w - 10)), ct = top - Math.round(s.roof * .55) - 6; for (let y = ct; y < top; y++) for (let dx = 0; dx < 4; dx++) put(P, (cx + dx) % 480, y, dx === 0 ? hex('#2b3a66') : ROOF); for (let dx = -1; dx < 5; dx++) put(P, (cx + dx) % 480, ct - 1, SNOW[0]); }
      // little windows: most lit, warm glow around them
      if (!s.church) for (let wy = top + 6; wy < base - 8; wy += 10) for (let wx = s.x + 4; wx < s.x + s.w - 6; wx += 7){
        if (rr() < .3) continue;
        const col = WIN[Math.floor(rr() * 3)];
        for (let gy = -2; gy < 7; gy++) for (let gx = -2; gx < 6; gx++) if (bay(wx + gx, wy + gy) < .3) put(P, (wx + gx) % 480, wy + gy, col, 40);
        for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 3; gx++) put(P, (wx + gx) % 480, wy + gy, gy === 2 ? mix(col, [60, 30, 10], .5) : col);
        put(P, (wx + 3) % 480, wy, hex('#0c1228'));
      }
    }
    // snowy ground and a few fir trees with lights in front
    for (let x2 = 0; x2 < 480; x2++) for (let y = H - 6; y < H; y++) put(P, x2, y, SNOW[y < H - 4 ? 1 : 2]);
    const BUL = ['#ff5a5a', '#ffd54f', '#5dd56f', '#4fc3f7'].map(hex);
    for (let i = 0; i < 9; i++){
      const x0 = Math.floor(r() * 480), hgt = 18 + Math.floor(r() * 12);
      for (let y = 0; y < hgt; y++){ const half = Math.round(y / hgt * 6 + (y % 3 === 2 ? 1 : 0)); for (let dx = -half; dx <= half; dx++) put(P, ((x0 + dx) % 480 + 480) % 480, H - 6 - hgt + y, hex(dx < 0 && y % 3 === 0 ? '#cfdcf3' : '#0c1730')); }
      for (let k = 0; k < 6; k++){ const yy = 4 + Math.floor(r() * (hgt - 6)), half = Math.round(yy / hgt * 5); put(P, ((x0 - half + Math.floor(r() * half * 2)) % 480 + 480) % 480, H - 6 - hgt + yy, BUL[k % 4]); }
      put(P, x0, H - 7 - hgt, hex('#ffe680'));
    }
    return png(P);
  }

  // ---------- ROCKET: space ----------
  function rocketSky(){
    const P = canvas(480, 300), r = rng(41);
    ditherGrad(P, ['#03030a', '#060716', '#0b0b24', '#141235', '#1d1747', '#271c55'], 0, 300);
    const n1 = noise2(480, 300, 3, 60), n2 = noise2(480, 300, 4, 22);         // nebula: violet and teal clouds
    for (let y = 0; y < 300; y++) for (let x = 0; x < 480; x++){
      const v = n1(x, y) * .7 + n2(x, y) * .3, t = n1(x + 200, y + 50);
      const a = Math.max(0, v - .48) * 2.4; if (a < bay(x, y) * .9) continue;
      put(P, x, y, t > .5 ? hex('#b04bd6') : hex('#2ec4c4'), Math.min(110, a * 120));
      if (a > .7 && bay(x, y) < .2) put(P, x, y, hex('#ffd1f5'), 60);
    }
    for (let i = 0; i < 260; i++){ const x = r() * 480 | 0, y = r() * 300 | 0, b = r(); put(P, x, y, hex(b > .9 ? '#ffe7b0' : b > .75 ? '#bfe3ff' : '#ffffff'), b > .4 ? 255 : 130);
      if (b > .97){ for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) put(P, x + dx, y + dy, hex('#ffffff'), 140); } }
    // a small spiral galaxy
    const gx = 150, gy = 70;
    for (let i = 0; i < 900; i++){ const arm = i % 2, t = r() * 4.2, rad = t * 6 + r() * 3, a = t + arm * Math.PI; put(P, gx + Math.cos(a) * rad * 1.6, gy + Math.sin(a) * rad * .7, hex(rad < 6 ? '#fff4d6' : '#c9b5ff'), rad < 6 ? 200 : 90); }
    // a ringed planet (back ring, ball, front ring)
    const px = 84, py = 128, pr = 18, PL = ['#f2b27a', '#d8875a', '#a85d45', '#6e3a33'].map(hex);
    const ring = (front) => { for (let a = 0; a < Math.PI * 2; a += .004){ const rx = Math.cos(a) * 34, ry = Math.sin(a) * 8; if ((ry > 0) !== front) continue;
      for (let k = 0; k < 3; k++) put(P, px + rx * (1 + k * .06), py + ry * (1 + k * .06) - 2, hex(k === 1 ? '#f7e0b0' : '#c9a77a'), 220); } };
    ring(false);
    for (let y = -pr; y <= pr; y++) for (let x = -pr; x <= pr; x++){ const d = Math.hypot(x, y); if (d > pr) continue;
      const lit = (-x * .6 - y * .4) / pr, band = Math.sin((y + x * .2) * .7) > .4; let k = lit > .3 ? 0 : lit > -.15 ? 1 : lit > -.5 ? 2 : 3; if (band && k < 3) k++; if (d > pr - 1) k = Math.min(3, k + 1); put(P, px + x, py + y, PL[k]); }
    ring(true);
    return png(P);
  }
  function rocketFar(){
    const P = canvas(480, 150), H = 150, r = rng(51);
    const A = peaks(14, 7, 104, 16, 44, 40, 90), G = ['#23263a', '#2c3048', '#3a3f5a', '#4f5675', '#6a7294'].map(hex);
    for (let x = 0; x < 480; x++){
      const t = Math.round(A.top[x]), lit = A.side[x] > 0;
      for (let y = t; y < H; y++){
        const depth = y - t; let k = depth < 2 ? (lit ? 4 : 3) : lit ? (depth < 10 ? 3 : 2) : (depth < 10 ? 1 : 0);
        if (y > 112) k = Math.max(1, Math.min(2, k)); if (bay(x, y) < .12 && k > 0) k--;
        put(P, x, y, G[k]);
      }
    }
    for (let i = 0; i < 30; i++){                     // craters on the plain: dark bowl, lit far rim, shadowed near rim
      const cx = Math.floor(r() * 480), cy = 116 + Math.floor(r() * 30), cr = 3 + Math.floor(r() * 9);
      for (let y = -cr; y <= cr; y++) for (let x = -cr * 2; x <= cr * 2; x++){ const d = Math.hypot(x / 2, y); if (d > cr) continue;
        const px = ((cx + x) % 480 + 480) % 480, py = cy + Math.round(y * .45), rim = d > cr - 1.3;
        put(P, px, py, rim ? G[y < 0 ? 4 : 1] : (x > cr * .6 ? G[2] : G[0])); }
    }
    for (let i = 0; i < 300; i++){ const x = r() * 480 | 0, y = 112 + r() * 38 | 0; put(P, x, y, G[r() < .5 ? 3 : 0]); }
    return png(P);
  }
  function rocketMid(){
    const P = canvas(480, 170), H = 170, r = rng(61);
    const M = ['#1d2236', '#252b44', '#2f3653', '#3c4466'].map(hex), GLOW = hex('#6ff3ff'), RED = hex('#ff5a5a');
    for (let x = 0; x < 480; x++) for (let y = H - 10; y < H; y++) put(P, x, y, M[y < H - 8 ? 3 : 1]);
    let x = 0;
    while (x < 470){
      const kind = Math.floor(r() * 4), w = kind === 0 ? 40 + Math.floor(r() * 20) : 24 + Math.floor(r() * 26), base = H - 10;
      if (kind === 0){                                // dome with a lit ring of windows
        const R = w / 2; for (let y = -R; y <= 0; y++) for (let dx = -R; dx <= R; dx++){ const d = Math.hypot(dx, y * 1.25); if (d > R) continue;
          put(P, x + R + dx, base + y, d > R - 1.5 ? M[3] : M[dx < -R / 3 ? 2 : 1]); }
        for (let a = .3; a < Math.PI - .3; a += .32) put(P, x + R + Math.cos(a) * (R - 5), base - Math.sin(a) * (R - 5) * .8, GLOW);
      } else if (kind === 1){                         // habitat block with portholes
        const h = 24 + Math.floor(r() * 24); for (let y = base - h; y < base; y++) for (let dx = 0; dx < w; dx++) put(P, x + dx, y, dx === 0 || y === base - h ? M[3] : (dx > w - 4 ? M[0] : M[1]));
        for (let wy = base - h + 6; wy < base - 4; wy += 8) for (let wx = x + 4; wx < x + w - 5; wx += 8) { put(P, wx, wy, GLOW); put(P, wx + 1, wy, GLOW); put(P, wx, wy + 1, GLOW); put(P, wx + 1, wy + 1, hex('#bffaff')); }
      } else if (kind === 2){                         // antenna mast with a dish
        const h = 50 + Math.floor(r() * 40), mx = x + Math.floor(w / 2);
        for (let y = base - h; y < base; y++){ put(P, mx, y, M[3]); if (y % 6 === 0) for (let dx = -2; dx <= 2; dx++) put(P, mx + dx, y, M[2]); }
        put(P, mx, base - h - 1, RED); put(P, mx, base - h - 2, RED);
        for (let a = -1.2; a < 1.2; a += .05) for (let k = 0; k < 2; k++) put(P, mx - 6 + Math.cos(a) * (8 - k), base - h + 14 + Math.sin(a) * (8 - k), M[3 - k]);
      } else {                                        // solar panel field
        for (let p = 0; p < 3; p++){ const px = x + p * 9; for (let y = base - 12; y < base - 4; y++) for (let dx = 0; dx < 7; dx++) put(P, px + dx + Math.floor((base - y) / 3), y, (dx + y) % 3 ? hex('#2a4d8a') : hex('#4f7fd0')); for (let y = base - 4; y < base; y++) put(P, px + 3, y, M[3]); }
      }
      // a pressurised tube to the next building
      const tx = x + w, tl = 3 + Math.floor(r() * 6); for (let dx = 0; dx < tl; dx++) for (let y = base - 7; y < base - 3; y++) put(P, tx + dx, y, y === base - 7 ? M[3] : M[1]);
      x += w + tl;
    }
    return png(P);
  }
  return {'dash-sleigh-sky': sleighSky(), 'dash-sleigh-far': sleighFar(), 'dash-sleigh-mid': sleighMid(),
          'dash-rocket-sky': rocketSky(), 'dash-rocket-far': rocketFar(), 'dash-rocket-mid': rocketMid()};
};

const br = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const p = await br.newPage();
const out = await p.evaluate(`(${painter.toString()})()`);
await br.close();
for (const [name, url] of Object.entries(out)) {
  const buf = Buffer.from(url.split(",")[1], "base64");
  fs.writeFileSync(OUT + name + ".png", buf);
  console.log(name + ".png", buf.length, "bytes");
}
