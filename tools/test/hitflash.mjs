// hit flash: a white silhouette over the dog that is removed again; the sprite's own filter never changes
import { chromium } from "playwright";
import { spawn } from "node:child_process";
const S = process.argv[2];
const srv = spawn("node", [new URL("./live.mjs", import.meta.url).pathname], {env:{...process.env, PORT:"3982", DATA_DIR:S+"/dataHit", ISSUER:"rI", TAXON:"369"}, stdio:"ignore"});
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const bye = c => { try { srv.kill(); } catch(e){} process.exit(c); };
setTimeout(() => bye(1), 90000); process.on("uncaughtException", e => { console.log("ERR", e.message); bye(1); });
await new Promise(r => setTimeout(r, 1200));
const br = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
for (const vp of [{width:760,height:900}, {width:390,height:844}]) {
  const p = await br.newPage({viewport: vp}); const errs = [];
  p.on("pageerror", e => errs.push(e.message));
  await p.route(u => !u.href.startsWith("http://127.0.0.1"), r => r.abort());
  await p.goto("http://127.0.0.1:3982/"); await p.waitForTimeout(400);
  await p.evaluate(() => { const c = DATA.fighters.filter(f => f.rarity === 'Common'); startFight(c[0], c[1], false, 5); });
  await p.waitForFunction(() => !busy, null, {timeout: 8000});
  const before = await p.evaluate(() => ['l','r'].map(s => getComputedStyle(fighterEl(s).querySelector('img')).filter));
  await p.evaluate(() => { anim('l', 'hurt', 320); anim('r', 'hurt', 320); });
  await p.waitForTimeout(60);
  const mid = await p.evaluate(() => ['l','r'].map(s => { const el = fighterEl(s), w = el.querySelector('.hitw'), i = el.querySelector('img');
    if (!w) return null; const a = w.getBoundingClientRect(), b = i.getBoundingClientRect();
    return {op: +getComputedStyle(w).opacity, dx: Math.abs(a.left - b.left), dy: Math.abs(a.top - b.top), dw: Math.abs(a.width - b.width), mask: getComputedStyle(w).webkitMaskImage || getComputedStyle(w).maskImage, filt: getComputedStyle(i).filter}; }));
  ok(mid.every(m => m && m.op > .5 && m.dx < 8 && m.dy < 8 && m.dw < 2 && /url\(/.test(m.mask)), vp.width + ": white silhouette over both dogs, aligned with the sprite");
  ok(mid.every((m, i) => m.filt === before[i]), vp.width + ": the sprite's filter is untouched during the flash");
  await p.screenshot({path: S + "/shots/hitflash-" + vp.width + ".png"});
  await p.waitForTimeout(600);
  const after = await p.evaluate(() => ['l','r'].map(s => ({n: fighterEl(s).querySelectorAll('.hitw').length, f: getComputedStyle(fighterEl(s).querySelector('img')).filter})));
  ok(after.every((a, i) => a.n === 0 && a.f === before[i]), vp.width + ": silhouette removed, sprite filter as before");
  await p.evaluate(() => { for (let i = 0; i < 6; i++) setTimeout(() => anim('r', 'hurt', 320), i * 40); });
  await p.waitForTimeout(800);
  ok(await p.evaluate(() => fighterEl('r').querySelectorAll('.hitw').length) === 0, vp.width + ": rapid hits leave nothing behind");
  ok(errs.length === 0, vp.width + ": no page errors " + errs.join(" | "));
  await p.close();
}
await br.close(); console.log(fails ? fails + " FAILED" : "ALL PASS"); bye(fails ? 1 : 0);
