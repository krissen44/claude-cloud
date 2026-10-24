// Scrappy Dash test pilots on the real simulation (the //@dash section of public/index.html):
//  · "casual"   — reacts to what it sees with ~100 ms delay, never drops gifts (like dash-camp.mjs's bot)
//  · "stomper"  — casual, but lets itself fall onto a foe just ahead and below (stomp, v39.2)
//  · "human"    — the planner with only 0.5 s of look-ahead, checked every 150 ms (a good player's reflexes)
//  · "planner"  — every 100 ms tries hold/let go × drop/no drop, plays each 1.5 s ahead with a few altitude plans and
//                 keeps the best (it can see the seeded future, so it is stronger than any human)
// Usage: node tools/test/dash-ai.mjs [runs=10] [seed=7000]
import fs from "node:fs"; import vm from "node:vm";
const RUNS = +(process.argv[2] || 10), SEED0 = +(process.argv[3] || 7000);
const html = fs.readFileSync(process.env.HTML || new URL("../../public/index.html", import.meta.url), "utf8");
let code = [...html.matchAll(/\/\/@dash[^\n]*\n([\s\S]*?)\/\/@\/dash/g)].map(m => m[1]).join("\n");
// a copyable generator with the very same numbers (its state lives on the function), so a run can be cloned
code = code.replace(/function dashRng\(seed\)\{[\s\S]*?\n\}/, `function dashRng(seed){
  const st = {a: seed >>> 0};
  const f = () => { st.a = (st.a + 0x6D2B79F5) | 0; let t = Math.imul(st.a ^ (st.a >>> 15), 1 | st.a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  f.st = st; return f;
}`);
const api = vm.runInContext(code + "\n({dashInit, dashSimStep, dashRng, DASH_TICK, DASH_MAX_TICKS})", vm.createContext({}));
const clone = s => { const r = s.rnd, ev = s.ev, inp = s._inp; s.rnd = null; s.ev = null; s._inp = null; const c = structuredClone(s); s.rnd = r; s.ev = ev; s._inp = inp;
  c.rnd = api.dashRng(0); c.rnd.st.a = r.st.a; return c; };
const W = 480, PX = 110, CAP = 60 * 60 * 6;                  // stop a run after 6 minutes

function casual(seed){
  const s = api.dashInit({}, seed, W, PX, null), hist = [];
  while (!s.over && s.tick < CAP){
    hist.push({y: s.y, vy: s.vy, houses: s.houses.map(h => ({x: h.x, w: h.w, top: h.top, ch: h.ch})), foes: s.foes.map(f => ({x: f.x, y: f.y}))});
    const v = hist[Math.max(0, hist.length - 7)]; let need = 200;
    for (const h of v.houses) if (h.x < PX + 200 && h.x + h.w > 80) need = Math.min(need, h.top - h.ch - 30);
    for (const f of v.foes) if (f.x > 90 && f.x < PX + 140 && Math.abs(f.y - v.y) < 30) need = Math.min(need, f.y - 34);
    api.dashSimStep(s, v.y + Math.max(0, v.vy) * .3 > need, false);
  }
  return s;
}
// like casual, but it lets itself drop onto a foe just ahead and a little below (the v39.2 stomp)
function stomper(seed){
  const s = api.dashInit({}, seed, W, PX, null), hist = [];
  while (!s.over && s.tick < CAP){
    hist.push({y: s.y, vy: s.vy, houses: s.houses.map(h => ({x: h.x, w: h.w, top: h.top, ch: h.ch})), foes: s.foes.map(f => ({x: f.x, y: f.y}))});
    const v = hist[Math.max(0, hist.length - 7)]; let need = 200, prey = false;
    for (const h of v.houses) if (h.x < PX + 200 && h.x + h.w > 80) need = Math.min(need, h.top - h.ch - 30);
    for (const f of v.foes) if (f.x > 90 && f.x < PX + 140){
      if (f.x < PX + 70 && f.y - v.y > 8 && f.y - v.y < 45) prey = true;
      else if (Math.abs(f.y - v.y) < 30) need = Math.min(need, f.y - 34);
    }
    api.dashSimStep(s, !prey && v.y + Math.max(0, v.vy) * .3 > need, false);
  }
  return s;
}
// rollout: hold to keep near a target height
function rollout(s, target, n){
  for (let i = 0; i < n && !s.over; i++) api.dashSimStep(s, s.y + Math.max(0, s.vy) * .12 > target, false);
  return s;
}
const value = s => (s.over ? -1e6 + s.tick * 50 : 0) + s.score;
function planner(seed, step = 6, ahead = 90){
  const s = api.dashInit({}, seed, W, PX, null); s._inp = []; s._h = false;
  while (!s.over && s.tick < CAP){
    let best = null, bestV = -Infinity;
    for (const hold of [true, false]) for (const drop of s.ammo > 0 ? [false, true] : [false]){
      let v = -Infinity;
      for (const target of [60, 110, 160, 210]){
        const c = clone(s);
        for (let i = 0; i < step && !c.over; i++) api.dashSimStep(c, hold, drop && i === 0);
        rollout(c, target, ahead);
        v = Math.max(v, value(c));
      }
      if (drop) v -= 3;                               // only drop when it pays
      if (v > bestV){ bestV = v; best = {hold, drop}; }
    }
    for (let i = 0; i < step && !s.over; i++){
      const next = s.tick + 1;                         // record inputs like the page does
      if (best.hold !== s._h){ s._inp.push(next, best.hold ? 1 : 0); s._h = best.hold; }
      if (best.drop && i === 0) s._inp.push(next, 2);
      api.dashSimStep(s, best.hold, best.drop && i === 0);
    }
  }
  return s;
}
// the original simulation (real closure generator, as the server runs it) replays the planner's inputs
const orig = vm.runInContext([...html.matchAll(/\/\/@dash[^\n]*\n([\s\S]*?)\/\/@\/dash/g)].map(m => m[1]).join("\n") + "\n({dashReplay})", vm.createContext({}));
let replayOk = 0, replayN = 0;
const fmt = s => ({score: s.score, sec: Math.round(s.tick / 60), gifts: s.delivered, coins: s.coinsN, stomps: s.stomps || 0});
for (const [name, fn] of [["casual", casual], ["stomper", stomper], ["human", seed => planner(seed, 9, 30)], ...(process.env.NOPLAN ? [] : [["planner", planner]])]){
  const rs = []; const t0 = Date.now();
  for (let i = 0; i < RUNS; i++){ const r = fn(SEED0 + i); rs.push(fmt(r));
    if (r._inp && r.over){ replayN++; const rp = orig.dashReplay(SEED0 + i, W, PX, r._inp); if (rp.score === r.score && rp.ticks === r.tick) replayOk++; } }
  rs.sort((a, b) => a.score - b.score);
  const med = rs[rs.length >> 1], best = rs[rs.length - 1], avg = Math.round(rs.reduce((a, r) => a + r.score, 0) / rs.length);
  console.log(`${name.padEnd(8)} ${RUNS} runs · median ${med.score} pts (${med.sec} s, ${med.gifts} gifts) · average ${avg} · best ${best.score} (${best.sec} s, ${best.gifts} gifts, ${best.coins} coins, ${best.stomps} stomps) · worst ${rs[0].score}  [${((Date.now() - t0) / 1000).toFixed(1)} s]`);
}
if (replayN) console.log(`replay check: ${replayOk} of ${replayN} planner runs replay to the same score on the original simulation (= the server would book them)`);
