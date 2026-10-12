// Scrappy Dash: run ids + seeds, server replay of every run (fakes refused), daily / weekly / Advent overall rankings,
// frozen Advent days for the prizes, and the game in the browser (bot runs on desktop + phone width, both skins)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHmac } from "node:crypto";
import { loadDash } from "../../fight-engine.js";
const S = process.argv[2], D = S + "/dataDash", PORT = 3987, U = "http://127.0.0.1:" + PORT;
fs.rmSync(D, {recursive: true, force: true}); fs.mkdirSync(D, {recursive: true}); fs.mkdirSync(S + "/shots", {recursive: true});
fs.writeFileSync(D + "/session.secret", "testsecret");
const tok = a => { const b0 = Buffer.from(JSON.stringify({a, exp: 2e9})).toString("base64url"); return b0 + "." + createHmac("sha256", "testsecret").update(b0).digest("base64url"); };
const A = "rRiva1OneXXXXXXXXXXXXXXXXXXXXX", B = "rTutoria1P1ayerXXXXXXXXXXXXXXX", C = "rDashCXXXXXXXXXXXXXXXXXXXXXXXX";
const day = k => new Date(Date.now() + k * 864e5).toISOString().slice(0, 10);
// Advent started two days ago: today is day 3; days 1 and 2 already have runs (the issuer "rI" = team, never a winner)
const T0 = Date.now() - 2 * 864e5;
fs.writeFileSync(D + "/store.json", JSON.stringify({players: {}, weekly: {}, holdings: {}, blobs: {
  ["dashday:" + day(-2)]: {rI: {best: 9000, runs: 1, at: T0}, [B]: {best: 1200, runs: 3, at: T0 + 1}, [C]: {best: 800, runs: 1, at: T0 + 2}},
  ["dashday:" + day(-1)]: {[C]: {best: 1500, runs: 2, at: T0 + 864e5}, [B]: {best: 700, runs: 1, at: T0 + 864e5 + 1}},
  ["dashday:" + day(0)]: {[C]: {best: 60, runs: 1, at: Date.now() - 1000}, [B]: {best: 140, runs: 1, at: Date.now() - 900}}}}));
const log = fs.openSync(S + "/dashserver.log", "w");
const srv = spawn("node", [new URL("./tut-mock.mjs", import.meta.url).pathname], {env: {...process.env, PORT: String(PORT), DATA_DIR: D, ISSUER: "rI", TAXON: "369", ADMIN_KEY: "adm", DASH_ADVENT: day(-2)}, stdio: ["ignore", log, log]});
const bye = c => { try { srv.kill(); } catch (e) {} process.exit(c); };
setTimeout(() => { console.log("TIMEOUT"); bye(1); }, 300000);
process.on("uncaughtException", e => { console.log("ERR", e && e.stack || e); bye(1); });
process.on("unhandledRejection", e => { console.log("ERR", e && e.stack || e); bye(1); });
await new Promise(r => setTimeout(r, 1800));
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + m); };
const call = async (who, path, body) => { const r = await fetch(U + "/api" + path, {method: body ? "POST" : "GET", headers: who ? {authorization: "Bearer " + tok(who), "content-type": "application/json"} : {}, body: body && JSON.stringify(body)}); return {status: r.status, ...(await r.json())}; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DASHSIM = loadDash(new URL("../../public/index.html", import.meta.url).pathname);

// --- API: every run is replayed
let r = await call(A, "/dash/start", {dog: {name: "Pixel Scrappy #77", token: 77}});
ok(/^[0-9a-f]{18}$/.test(r.id) && Number.isInteger(r.seed) && r.theme === "sleigh", "run id + seed " + r.seed);
let sim = DASHSIM.replay(r.seed, 480, 110, [], 100000);     // no input: falls onto a roof
await sleep(sim.ticks * 1000 / 60 + 300);
{ const x = await call(A, "/dash/end", {id: r.id, score: sim.score + 300, ticks: sim.ticks, w: 480, inp: []}); ok(x.error === "desync", "a faked score does not survive the replay"); }
r = await call(A, "/dash/start", {}); sim = DASHSIM.replay(r.seed, 480, 110, [], 100000);
ok((await call(A, "/dash/end", {id: r.id, score: 100, ticks: 600, w: 480, inp: []})).error === "bad_time", "a run longer than the time since its start is refused");
r = await call(A, "/dash/start", {});
ok((await call(A, "/dash/end", {id: r.id, score: 5, ticks: 60, w: 480, inp: [1, 7]})).error === "bad_input", "bad input codes are refused");
r = await call(A, "/dash/start", {}); await sleep(600);
ok((await call(B, "/dash/end", {id: r.id, score: 5, ticks: 30, w: 480, inp: []})).error === "no_run", "someone else's run id is refused");
// the Scrappy bonus: only for a dog the player holds, by rarity
await call(A, "/me/kennel");
const own = await call(A, "/dash/start", {dogId: "000800003101"}), notOwn = await call(A, "/dash/start", {dogId: "000800004999"});
ok(own.bonus >= 5 && own.bonus <= 10 && own.rarity && notOwn.bonus === 0, `own Scrappy bonus +${own.bonus} % (${own.rarity}), someone else's dog +${notOwn.bonus} %`);
// a played run: climb for 20 ticks, then fall — with the own dog, booked with the bonus
r = await call(A, "/dash/start", {dogId: "000800003101", dog: {name: "Pixel Scrappy #3101", token: 3101}});
const inp = [1, 1, 21, 0];
sim = DASHSIM.replay(r.seed, 480, 110, [1, 1, 21, 0], 100000);
await sleep(sim.ticks * 1000 / 60 + 300);
let e = await call(A, "/dash/end", {id: r.id, score: sim.score, ticks: sim.ticks, w: 480, inp: [1, 1, 20, 0]});
ok(e.ok && e.raw === sim.score && e.score === Math.floor(sim.score * (100 + r.bonus) / 100) && e.rank >= 1 && e.total != null, `a replayed run lands on today's board: ${e.raw} + ${e.bonus} % = ${e.score} #${e.rank}, Advent total ${e.total} #${e.totalRank}`);
ok((await call(A, "/dash/end", {id: r.id, score: sim.score, ticks: sim.ticks, w: 480, inp: [1, 1, 20, 0]})).error === "no_run", "a run id counts once");
// boards
let bd = await call(B, "/dash/board");
ok(bd.today.top.length === 3 && bd.today.mine.best === 140, "today's ranking + mine");
ok(bd.advent.on && bd.advent.n === 3 && bd.advent.days.length === 24 && bd.advent.days[2].state === "today", "Advent: day 3 of 24");
ok(bd.advent.days[0].winner && bd.advent.days[0].winner.score === 1200 && bd.advent.days[1].winner.score === 1500, "day winners skip the team wallet (day 1: 1200, not the issuer's 9000)");
ok(bd.advent.overall.top[0].score === 9000 + 0 && bd.advent.overall.mine.total === 1200 + 700 + 140 && bd.advent.overall.mine.days === 3, "overall = daily bests added up (B: " + bd.advent.overall.mine.total + ")");
bd = await call(null, "/public/dash");
ok(bd.today.top.length >= 3 && !JSON.stringify(bd).includes("rRiva1") && !JSON.stringify(bd).includes(B), "public board without wallets");
// admin: frozen days, winners, prize validation
const adm = await (await fetch(U + "/api/admin/dash?key=adm")).json();
const d1 = adm.results.find(x => x.key === "dash-" + day(-2)), d2 = adm.results.find(x => x.key === "dash-" + day(-1)), d3 = adm.results.find(x => x.key === "dash-" + day(0));
ok(d1 && d1.winners && d1.winners[0].account === B && d1.winners[0].score === 1200, "day 1 frozen: winner B (team skipped)");
ok(d2 && d2.winners[0].account === C && d3 && d3.open, "day 2 frozen (C), today still running");
const pz = await (await fetch(U + "/api/admin/dash/prize?key=adm", {method: "POST", body: JSON.stringify({key: d1.key, place: "1", nftId: "nope"})})).json();
ok(pz.error === "not_in_treasury", "prize needs a treasury piece (" + pz.error + ")");

// --- browser
const br = await chromium.launch({executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"});
const page = async (vp, path, who) => {
  const p = await (await br.newContext({viewport: vp, hasTouch: vp.width < 500})).newPage();
  p.errs = []; p.on("pageerror", x => p.errs.push(x.message));
  await p.route(u => !u.href.startsWith("http://127.0.0.1"), r => r.abort());
  await p.goto(U + "/"); await p.evaluate(([t, a]) => localStorage.setItem("ba_session", JSON.stringify({token: t, account: a})), [tok(who || A), who || A]);
  await p.goto(U + path); await p.waitForFunction(() => OWNED && OWNED.length && !WALLET.loading && DASH.board, null, {timeout: 30000});
  await p.waitForTimeout(500);
  return p;
};
// a little autopilot: climb over what's ahead, drop gifts with a lead
const bot = () => {
  const G = DASH.g; if (!G || G.state !== "run") return;
  let need = 200;
  for (const h of G.houses) if (h.x < DASH_PX + 130 && h.x + h.w > DASH_PX - 30) need = Math.min(need, h.top - h.ch - 30);
  for (const f of G.foes) if (f.x > DASH_PX - 20 && f.x < DASH_PX + 90 && Math.abs(f.y - G.y) < 30) need = Math.min(need, f.y - 34);
  G.want = G.y + Math.max(0, G.vy) * .3 > need;
  for (const h of G.houses) if (h.wants && !h.done && !h.aimed){
    const ct = h.top - h.ch, t = Math.sqrt(2 * Math.max(1, ct - G.y) / 900), lead = G.v * t, mid = h.x + h.cx + 9;
    if (Math.abs(mid - DASH_PX - lead) < 6){ h.aimed = true; G.pendingDrop = true; }
  }
};
const startRun = async p => {
  await p.click("#dashGo");
  await p.waitForFunction(() => DASH.g && DASH.g.runId && DASH.g.runSeed === DASH.g.seed, null, {timeout: 10000});
  await p.locator("#dashCv").dispatchEvent("pointerdown", {button: 0}); await p.locator("#dashCv").dispatchEvent("pointerup");
  await p.evaluate(b => { window.__bot = setInterval(eval(b), 16); }, "(" + bot.toString() + ")");
};
const crash = p => p.evaluate(() => { clearInterval(window.__bot); const G = DASH.g; if (G.state === "run"){ G.shield = false; G.blink = 0; G.want = false; } });
const p = await page({width: 1000, height: 900}, "/dash");
ok(await p.locator(".dashhero").count() === 1 && await p.locator(".adoor").count() === 24 && await p.locator(".adoor.today").count() === 1, "hangar with the Advent calendar (24 doors, today glowing)");
await p.screenshot({path: S + "/shots/dash-hangar.png", fullPage: true});
await startRun(p);
ok(await p.evaluate(() => DASH.g.state === "run" && DASH.g.ammo === 3), "tap starts the run without dropping a gift");
await p.waitForTimeout(6000);
await p.screenshot({path: S + "/shots/dash-sleigh.png"});
await p.waitForTimeout(8000);
const mid = await p.evaluate(() => ({s: DASH.g.score, del: DASH.g.delivered, t: DASH.g.t, inp: DASH.g.inp.length / 2, passed: DASH.g.passedN}));
console.log("after 14 s:", JSON.stringify(mid));
ok(mid.s > 200 && mid.inp > 10, `bot run: ${mid.s} points, ${mid.del} delivered, ${mid.inp} inputs, passed ${mid.passed} on today's board`);
await crash(p);
await p.waitForFunction(() => DASH.g && DASH.g.state === "over" && DASH.g.posted, null, {timeout: 20000});
let post = await p.evaluate(() => DASH.g.posted);
const fin = await p.evaluate(() => ({raw: DASH.g.score, bonus: DASH.g.bonus, shown: dashFinal(DASH.g)}));
ok(post.ok && post.raw === fin.raw && post.bonus === fin.bonus && fin.bonus > 0 && post.score === fin.shown, "the server replayed the browser run: " + JSON.stringify(post) + " page " + JSON.stringify(fin));
ok(await p.locator("#dashAgain").count() === 1, "result card with Again");
await p.screenshot({path: S + "/shots/dash-over.png"});
const xp = await p.evaluate(() => ({xp: DASH.g.xp, day: SAVE.data.dash.xp, can: dashCanPost(), bor: !!DASH.g.dog.borrowed, own: OWNED.some(f => f.id === DASH.g.dog.id), dog: DASH.g.dog.id, ids: OWNED.map(f => f.id + (f.borrowed ? "b" : "")), score: DASH.g.score}));

ok(xp.xp > 0 && xp.day === xp.xp, "bond XP for the dog: " + xp.xp);
await p.waitForFunction(() => DASH.g.next, null, {timeout: 10000});
await p.waitForTimeout(800);
await p.click("#dashAgain");
const ag = await p.evaluate(() => ({st: DASH.g.state, s: DASH.g.score, a: DASH.g.ammo, id: !!DASH.g.runId, seeded: DASH.g.runSeed === DASH.g.seed}));
ok(ag.st === "run" && ag.s < 5 && ag.a === 3 && ag.id && ag.seeded, "Again starts a fresh run with the prefetched seed " + JSON.stringify(ag));
// a tampered run: points added in the page
await p.evaluate(b => { window.__bot = setInterval(eval(b), 16); }, "(" + bot.toString() + ")");
await p.waitForTimeout(3000);
await p.evaluate(() => { DASH.g.score += 5000; });
await crash(p);
await p.waitForFunction(() => DASH.g && DASH.g.state === "over" && DASH.g.posted, null, {timeout: 20000});
post = await p.evaluate(() => DASH.g.posted);
ok(post.error === "desync", "points added in the page are refused (" + post.error + ")");
await p.click("#dashBack");
ok(await p.evaluate(() => !DASH.g && tab === "dash") && await p.locator(".dashhero").count() === 1, "back to the hangar");
await p.screenshot({path: S + "/shots/dash-hangar2.png", fullPage: true});
ok(p.errs.length === 0, "no page errors " + p.errs.join(" | "));
// hugging the top is no safe lane: snow owls sweep the sky, the run ends quickly — and the server agrees
await p.click("#dashGo");
await p.waitForFunction(() => DASH.g && DASH.g.runId && DASH.g.runSeed === DASH.g.seed, null, {timeout: 10000});
await p.locator("#dashCv").dispatchEvent("pointerdown", {button: 0}); await p.locator("#dashCv").dispatchEvent("pointerup");
await p.evaluate(() => { window.__bot = setInterval(() => { const G = DASH.g; if (G && G.state === "run") G.want = G.y > 18; }, 16); });
await p.waitForFunction(() => DASH.g && DASH.g.foes.some(f => f.sky && f.x < DASH_W - 40), null, {timeout: 20000});
await p.screenshot({path: S + "/shots/dash-skyhawk.png"});
await p.waitForFunction(() => DASH.g && DASH.g.state === "over" && DASH.g.posted, null, {timeout: 40000});
const camp = await p.evaluate(() => ({t: DASH.g.t, posted: DASH.g.posted}));
await p.evaluate(() => clearInterval(window.__bot));
ok(camp.t < 25 && camp.posted.ok, `camping at the top ends after ${camp.t.toFixed(1)} s, replayed by the server (${camp.posted.raw})`);
await p.click("#dashBack");
// phone width (340 field) + rocket skin: the replay matches there too
const q = await page({width: 390, height: 844}, "/dash?dash=rocket", B);
await q.screenshot({path: S + "/shots/dash-rocket-hangar.png", fullPage: true});
await startRun(q);
await q.waitForTimeout(9000);
await q.screenshot({path: S + "/shots/dash-rocket.png"});
await crash(q);
await q.waitForFunction(() => DASH.g && DASH.g.state === "over" && DASH.g.posted, null, {timeout: 20000});
post = await q.evaluate(() => DASH.g.posted);
ok(q.evaluate && post.ok, "phone-width run replayed too: " + JSON.stringify(post));
ok(await q.evaluate(() => DASH.g.th === "rocket" && DASH_W === 340), "rocket skin, 340 field");
ok(q.errs.length === 0, "no page errors (phone) " + q.errs.join(" | "));
await br.close();
console.log(fails ? fails + " FAILED" : "ALL PASS");
bye(fails ? 1 : 0);
