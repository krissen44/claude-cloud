// Background cut-out check: demo dogs composed onto known backgrounds (solid, gold rays, rays + Matrix Rain streaks,
// bone pattern, night sky), scaled to 1152 px like the collection, cut out by the page's cutout() — counts background
// pixels left over and dog pixels lost. OLD=<old index.html> compares with an older cutout().
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
const S = process.argv[2], PORT = 3979, OLD = process.env.OLD;
fs.mkdirSync(S + "/shots", {recursive: true});
const srv = spawn("node", [new URL("./live.mjs", import.meta.url).pathname], {env: {...process.env, PORT: String(PORT), DATA_DIR: S + "/dataCut", ISSUER: "rI", TAXON: "369"}, stdio: "ignore"});
const bye = c => { try { srv.kill(); } catch {} process.exit(c); };
setTimeout(() => { console.log("TIMEOUT"); bye(1); }, 120000);
await new Promise(r => setTimeout(r, 2500));
const br = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const p = await br.newPage({viewport: {width: 1200, height: 900}}); const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.route(u => !u.href.startsWith("http://127.0.0.1"), r => r.abort());
await p.goto(`http://127.0.0.1:${PORT}/`); await p.waitForTimeout(800);
if (OLD) { const src = fs.readFileSync(OLD, "utf8"); const fn = src.slice(src.indexOf("function cutout(bitmap, patterned){"), src.indexOf("/* When the server is rate limited")); await p.evaluate(fn => { window.cutoutOld = new Function(fn + "; return cutout;")(); }, fn); }
const res = await p.evaluate(async (hasOld) => {
  const N = 96, load = src => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = src; });
  const BGS = {
    solid: (x) => { x.fillStyle = '#f6c9a8'; x.fillRect(0, 0, N, N); },
    rays: (x) => { for (let k = 0; k < 24; k++){ x.fillStyle = k % 2 ? '#f5c242' : '#e9a92a'; x.beginPath(); x.moveTo(48, 44);
        x.arc(48, 44, 120, k / 24 * Math.PI * 2, (k + 1) / 24 * Math.PI * 2); x.fill(); } },
    bones: (x) => { x.fillStyle = '#9fc7e8'; x.fillRect(0, 0, N, N); x.fillStyle = '#e8f2fb'; for (let y = 2; y < N; y += 12) for (let xx = (y / 12 % 2) * 6; xx < N; xx += 12){ x.fillRect(xx, y, 6, 2); x.fillRect(xx - 1, y - 1, 2, 4); x.fillRect(xx + 5, y - 1, 2, 4); } },
    night: (x) => { x.fillStyle = '#141a3c'; x.fillRect(0, 0, N, N); x.fillStyle = '#fff6c0'; for (let k = 0; k < 60; k++) x.fillRect((k * 37) % N, (k * 53) % N, 1, 1); },
  };
  const rain = (x) => { for (let col = 3; col < N; col += 7){ x.fillStyle = col % 2 ? '#2bd14a' : '#7dff8e'; for (let y = (col * 5) % 9; y < N; y += 9) x.fillRect(col, y, 1, 6); } };
  const cases = [['solid'], ['rays'], ['rays', true], ['bones'], ['night'], ['night', true]];
  const out = []; const dogs = DATA.fighters.filter(f => !f.legendary).concat(DATA.fighters.filter(f => f.legendary).slice(0, 6));
  const shots = [];
  for (const [bgName, withRain] of cases){
    let left = 0, lost = 0, leftO = 0, lostO = 0, dogPx = 0;
    for (const f of dogs){
      const img = await load(f.img);
      const c = document.createElement('canvas'); c.width = c.height = N; const x = c.getContext('2d'); x.imageSmoothingEnabled = false;
      BGS[bgName](x); x.drawImage(img, 0, 0, N, N); if (withRain) rain(x);
      const m = document.createElement('canvas'); m.width = m.height = N; const mx = m.getContext('2d'); mx.drawImage(img, 0, 0, N, N);
      const alpha = mx.getImageData(0, 0, N, N).data;
      const big = document.createElement('canvas'); big.width = big.height = 1152; const bx = big.getContext('2d'); bx.imageSmoothingEnabled = false; bx.drawImage(c, 0, 0, 1152, 1152);
      const bmp = await createImageBitmap(big);
      const run = async fn => { const u = fn(bmp, ['rays', 'bones', 'night'].includes(bgName)); const r = await load(u); const k = document.createElement('canvas'); k.width = k.height = N; k.getContext('2d').drawImage(r, 0, 0); return {d: k.getContext('2d').getImageData(0, 0, N, N).data, u}; };
      const nw = await run(cutout), od = hasOld ? await run(cutoutOld) : null;
      for (let i = 0; i < N * N; i++){
        const dog = alpha[i * 4 + 3] > 128; if (dog) dogPx++;
        if (!dog && nw.d[i * 4 + 3] > 0) left++; if (dog && nw.d[i * 4 + 3] === 0) lost++;
        if (od){ if (!dog && od.d[i * 4 + 3] > 0) leftO++; if (dog && od.d[i * 4 + 3] === 0) lostO++; }
      }
      if (f === dogs[0] || f === dogs[dogs.length - 1]) shots.push({c: bgName + (withRain ? '+rain' : ''), src: c.toDataURL(), nw: nw.u, od: od && od.u});
    }
    out.push({bg: bgName + (withRain ? '+rain' : ''), dogs: dogs.length, leftNew: left, lostNew: lost, leftOld: leftO, lostOld: lostO, dogPx});
  }
  window.__shots = shots;
  return out;
}, !!OLD);
for (const r of res) console.log(r.bg.padEnd(11), `bg left over: new ${r.leftNew}${OLD ? ' / old ' + r.leftOld : ''}  ·  dog pixels lost: new ${r.lostNew}${OLD ? ' / old ' + r.lostOld : ''}  (of ${r.dogPx})`);
// a sheet: source | old | new
await p.evaluate(() => { document.body.innerHTML = '<div id="sh" style="background:#334;display:grid;grid-template-columns:repeat(3,200px);gap:6px;padding:6px">' +
  __shots.map(s => `<img src="${s.src}" style="width:200px;image-rendering:pixelated"><img src="${s.od || ''}" style="width:200px;image-rendering:pixelated;background:#556"><img src="${s.nw}" style="width:200px;image-rendering:pixelated;background:#556">`).join('') + '</div>'; });
await p.waitForTimeout(400); await (await p.$("#sh")).screenshot({path: S + "/shots/cutout.png"});
console.log("errors:", errs.length ? errs : "none");
await br.close(); bye(0);
