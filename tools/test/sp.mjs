import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
const S = process.argv[2];
fs.mkdirSync(S + "/sp", {recursive: true});
const srv = spawn("node", [new URL("./live.mjs", import.meta.url).pathname], {env:{...process.env, PORT:"3980", DATA_DIR:S+"/dataAnim", ISSUER:"rI", TAXON:"369"}, stdio:"ignore"});
const bye = (c) => { try { srv.kill(); } catch(e){} process.exit(c); };
setTimeout(() => { console.log("TIMEOUT"); bye(1); }, 280000);
process.on("uncaughtException", e => { console.log("ERR", e.message); bye(1); });
await new Promise(r => setTimeout(r, 1200));
const br = await chromium.launch({executablePath: process.env.CHROMIUM || undefined}); const errs = [];
const p = await br.newPage({viewport:{width:760,height:900}}); p.on("pageerror", e => errs.push(e.message));
await p.route(u => !u.href.startsWith("http://127.0.0.1"), r => r.abort());
const shot = async (path) => { const b = await p.evaluate(() => { const r = document.querySelector(".stage").getBoundingClientRect(); return {x:r.x, y:r.y + scrollY, width:r.width, height:r.height}; }); await p.screenshot({path, clip:b, fullPage:true}); };
p.on("console", m => { if (m.type() === "error" && /REJ/.test(m.text())) errs.push(m.text()); });
await p.goto("http://127.0.0.1:3980/"); await p.waitForTimeout(400);
await p.evaluate(() => { addEventListener("unhandledrejection", e => console.error("REJ " + (e.reason && e.reason.stack || e.reason))); S.unlock(); });
const cases = [["L1","first-light"],["L6","charge"],["L8","moonshot"],["L10","laser red"],["L3","rekindle"],["L2","validate"],["L4","hold"],["L5","dip"],
  ["L7","crash"],["L9","splash"],["L15","transmute"],["L17","horizon"],["L19","rays"],["L20","double"],
  ["T:eyes-laser-green","laser green"],["T:overlay-lightning","lightning"],["T:eyes-matrix-glasses","matrix"],["T:headwear-open-brain","hex"]];
console.log("legendary ids:", (await p.evaluate(() => DATA.fighters.filter(f => /^L/.test(f.id)).map(f => f.id).join(","))).slice(0, 90));
for (const [id, label] of cases){
  const ok = await p.evaluate((id) => {
    arenaRun = null; clubMode = false;
    const base = DATA.fighters.find(f => f.rarity === 'Common') || DATA.fighters[3];
    const me = id.startsWith("T:") ? {id:"t"+id, name:"Test " + id.slice(2), rarity: /laser|brain/.test(id) ? "Mythic" : "Rare", traits:[id.slice(2)], img: base.img}
                                   : DATA.fighters.find(f => f.id === id);
    if (!me) return "missing";
    startFight(me, base, false, 5);
    return P.actives.length ? P.actives[0].id : "no active";
  }, id);
  await p.waitForFunction(() => !busy, null, {timeout: 8000});
  if (ok === "missing" || ok === "no active"){ console.log(label, "→", ok); continue; }
  await p.evaluate(() => { P.energy = 9; P.hp = P.maxHp; E.hp = E.maxHp = 40; setBars(); resolve({type:'ability', a:P.actives[0]}, {type:'taunt'}); play(); });
  const name = label.replace(/\s+/g, "-");
  await p.waitForTimeout(1250); await shot(`${S}/sp/${name}-a.png`);
  await p.waitForTimeout(260); await shot(`${S}/sp/${name}-b.png`);
  await p.waitForFunction(() => !busy, null, {timeout: 15000});
  console.log(label, "→", ok);
}
const commons = await p.evaluate(() => DATA.fighters.filter(f => f.rarity === 'Common').map(f => f.id));
await p.evaluate((c) => { startFight(DATA.fighters.find(f => f.id === c[0]), DATA.fighters.find(f => f.id === (c[1] || c[0])), false, 5); }, commons);
await p.waitForFunction(() => !busy, null, {timeout: 8000});
await p.evaluate(() => { E.hp = E.maxHp = 40; resolve({type:'bite'}, {type:'taunt'}); play(); });
for (const ms of [250, 180, 160]){ await p.waitForTimeout(ms); await shot(`${S}/sp/bite-${ms}.png`); }
await p.waitForFunction(() => !busy, null, {timeout: 15000});
await p.evaluate(() => { startFight(DATA.fighters.find(f => f.id === "L16"), DATA.fighters.find(f => f.id === "L12"), false, 5); });
await p.waitForTimeout(600); await shot(`${S}/sp/intro-a.png`);
await p.waitForFunction(() => !busy, null, {timeout: 8000}); await p.waitForTimeout(200);
await shot(`${S}/sp/intro-aura.png`);
const myth = await p.evaluate(() => { const m = DATA.fighters.find(f => f.rarity === 'Mythic'); if (m) startFight(DATA.fighters.find(f => f.rarity === 'Common'), m, false, 5); return m && m.name; });
await p.waitForTimeout(650); await shot(`${S}/sp/intro-myth.png`);
await p.waitForFunction(() => !busy, null, {timeout: 8000});
console.log("mythic demo:", myth, "| errors:", errs); await br.close(); bye(0);
