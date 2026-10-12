// Dash balance: hugging the top must not be a safe way to farm points (owner, 12 Oct). Run: node tools/test/dash-camp.mjs
import fs from "node:fs"; import vm from "node:vm";
const html = fs.readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
const code = [...html.matchAll(/\/\/@dash[^\n]*\n([\s\S]*?)\/\/@\/dash/g)].map(m => m[1]).join("\n");
const api = vm.runInContext(code + "\n({dashInit, dashSimStep})", vm.createContext({}));
// ceiling camper: hugs the top; "smart" one dips under a foe in the top band and climbs back
function camp(seed, smart){
  const s = api.dashInit({}, seed, 480, 110, null);
  while (!s.over && s.tick < 60 * 300){
    let target = 18;
    if (smart) for (const f of s.foes) if (f.x > 80 && f.x < 230 && f.y < 60) target = Math.max(target, f.y + 34);
    api.dashSimStep(s, s.y + Math.max(0, s.vy) * .3 > target, false);
  }
  return s;
}
function bot(seed, react = 6, look = 200){
  const s = api.dashInit({}, seed, 480, 110, null); const hist = [];
  while (!s.over && s.tick < 60 * 300){
    hist.push(JSON.parse(JSON.stringify({y: s.y, vy: s.vy, houses: s.houses, foes: s.foes})));
    const v = hist[Math.max(0, hist.length - 1 - react)]; let need = 200;
    for (const h of v.houses) if (h.x < 110 + look && h.x + h.w > 80) need = Math.min(need, h.top - h.ch - 30);
    for (const f of v.foes) if (f.x > 90 && f.x < 110 + look * .7 && Math.abs(f.y - v.y) < 30) need = Math.min(need, f.y - 34);
    api.dashSimStep(s, v.y + Math.max(0, v.vy) * .3 > need, false);
  }
  return s;
}
const stat = (name, f) => { const rs = Array.from({length: 150}, (_, i) => f(2000 + i)).sort((a, b) => a.t - b.t);
  console.log(name.padEnd(14), `median ${rs[75].t.toFixed(0)} s / ${rs[75].score} pts, 90% ${rs[135].t.toFixed(0)} s, max ${rs[149].t.toFixed(0)} s`); return rs[75]; };
const c1 = stat("camper", s => camp(s, false)), c2 = stat("smart camper", s => camp(s, true)), b = stat("bot 100ms", s => bot(s));
const ok = c1.t < 20 && c2.t < 20 && b.t > 15 && b.score > c1.score * 1.5;
console.log(ok ? "PASS camping at the top scores far less than playing" : "FAIL camping still pays"); process.exit(ok ? 0 : 1);
