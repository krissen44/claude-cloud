// v35: bond up to 20 (new perks), rival bond band checked by the referee, arena rivals = every player of the week
// (alternating owners, team out), expanded + weekly achievements, week results without scrolling
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHmac } from "node:crypto";
import { loadEngine } from "../../fight-engine.js";
const S = process.argv[2], D = S + "/dataV35", PORT = 3984, U = "http://127.0.0.1:" + PORT;
fs.rmSync(D, {recursive: true, force: true}); fs.mkdirSync(D + "/saves", {recursive: true}); fs.writeFileSync(D + "/session.secret", "testsecret");
const tok = a => { const b0 = Buffer.from(JSON.stringify({a, exp: 2e9})).toString("base64url"); return b0 + "." + createHmac("sha256", "testsecret").update(b0).digest("base64url"); };
const A = "rTutoria1P1ayerXXXXXXXXXXXXXXX", R1 = "rRiva1OneXXXXXXXXXXXXXXXXXXXXX", R2 = "rRiva1TwoXXXXXXXXXXXXXXXXXXXXX", R3 = "rRiva1ThreeXXXXXXXXXXXXXXXXXXX";
const id = t => "000800" + String(t).padStart(6, "0"), dog = t => ({t, id: id(t), uri: `ipfs://bafyX/${t}.json`});
const d = new Date(), wk = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (d.getUTCDay() + 6) % 7)).toISOString().slice(0, 10);
fs.writeFileSync(D + "/store.json", JSON.stringify({players: {}, holdings: {
    [R1]: {tokens: [3101, 3102, 3103], dogs: [dog(3101), dog(3102), dog(3103)], updated: Date.now()},             // active (kennel this week)
    [R2]: {tokens: [12, 3201], dogs: [dog(12), dog(3201)], updated: Date.now() - 30 * 864e5},                     // active (fought this week)
    [R3]: {tokens: [3301, 3302], dogs: [dog(3301), dog(3302)], updated: Date.now() - 30 * 864e5},                 // not seen this week
    rI: {tokens: [4101, 4102], dogs: [dog(4101), dog(4102)], updated: Date.now()}},                               // the issuer = team
  weekly: {[wk + "|" + R2]: {account: R2, week: wk, wins: 3, losses: 1, xp: 100, streak: 2, updated: Date.now()}},
  profiles: {[R1]: {name: "RivalOne"}, [R2]: {name: "RivalTwo"}, [R3]: {name: "RivalThree"}}, blobs: {}}));
fs.writeFileSync(D + "/saves/" + A + ".json", JSON.stringify({data: {v: 1, updatedAt: Date.now() + 6e4, dogs: {[id(2723)]: {lvl: 12, xp: 10, w: 40, l: 9}, [id(2715)]: {lvl: 5, xp: 0, w: 3, l: 2}}}, updated: Date.now()}));
const srv = spawn("node", [new URL("./tut-mock.mjs", import.meta.url).pathname], {env: {...process.env, PORT: String(PORT), DATA_DIR: D, ISSUER: "rI", TAXON: "369"}, stdio: "ignore"});
const bye = c => { try { srv.kill(); } catch {} process.exit(c); };
setTimeout(() => { console.log("TIMEOUT"); bye(1); }, 200000);
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
await new Promise(r => setTimeout(r, 1800));
const call = async (who, path, body) => (await fetch(U + "/api" + path, {method: body ? "POST" : "GET", headers: {authorization: "Bearer " + tok(who), "content-type": "application/json"}, body: body && JSON.stringify(body)})).json();

// the engine: bond 20, new perks
const ENG = loadEngine(new URL("../../public/index.html", import.meta.url).pathname);
const def = {id: "x", name: "Test", rarity: "Common", traits: [], unknown: [], set: null, setMatch: 0};
const hp = l => ENG.start(def, l, def, 1).P.maxHp;
ok(hp(12) - hp(10) === 1 && hp(16) - hp(10) === 3 && hp(20) - hp(10) === 5, `bond perks: max health 10→${hp(10)}, 12→${hp(12)}, 16→${hp(16)}, 20→${hp(20)}`);
const st14 = ENG.start(def, 14, def, 1), st18 = ENG.start(def, 18, def, 1), st17 = ENG.start(def, 17, def, 1);
ok(st14.P.windHeal === 5 && ENG.start(def, 13, def, 1).P.windHeal === 3 && st18.P.energy === st17.P.energy + 1, "Deep Breath at 14 (Second Wind heals 5), +1 energy at 18");

// the arena: every player of the week, a different owner each pick, no team, nobody unseen
let r = await call(A, "/arena/rivals");
const owners = new Set(r.rivals.map(x => x.owner));
ok(owners.has("RivalOne") && owners.has("RivalTwo") && !owners.has("RivalThree") && ![...owners].some(o => /^rI/.test(o)) && r.players === 2,
  `arena rivals from this week's players only: ${[...owners].join(", ")} (${r.rivals.length} dogs)`);
ok(r.rivals[0].owner !== r.rivals[1].owner, "the list alternates owners");

// the referee: rival bond band (bond 12 → 12…14, bond 5 → 4…6)
await call(A, "/me/kennel?fresh=1");
let f = await call(A, "/fight/start", {kind: "ranked", dog: id(2723), lvl: 12, opp: {token: 3501}, oppLvl: 14});
ok(f.lvl && f.lvl.P === 12 && f.lvl.E === 14, "bond 12 may meet a bond-14 rival: " + JSON.stringify(f.lvl));
f = await call(A, "/fight/start", {kind: "ranked", dog: id(2723), lvl: 12, opp: {token: 3502}, oppLvl: 9});
ok(f.lvl && f.lvl.E === 12, "…but never one below its own bond (asked 9, got " + (f.lvl && f.lvl.E) + ")");
f = await call(A, "/fight/start", {kind: "ranked", dog: id(2715), lvl: 5, opp: {token: 3503}, oppLvl: 8});
ok(f.lvl && f.lvl.E === 6, "bond 5 stays matched ±1 (asked 8, got " + (f.lvl && f.lvl.E) + ")");

// achievements: new tiers + weekly badges (this week's only)
r = await call(A, "/ach", {ids: ["bond20", `wk:${wk}:win10`, "wk:2026-01-05:win10", `wk:${wk}:nope`]});
ok(r.ach.bond20 && r.ach[`wk:${wk}:win10`] && !r.ach["wk:2026-01-05:win10"] && !r.ach[`wk:${wk}:nope`], "server keeps new tiers and this week's badges, drops old or unknown ones");

// the page
const br = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const p = await br.newPage({viewport: {width: 1280, height: 800}}); const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.addInitScript(() => localStorage.setItem("ba_fold", JSON.stringify({ach: true})));
await p.route(u => !u.href.startsWith(U), r => r.abort());
await p.goto(U + "/"); await p.evaluate(([t, a]) => localStorage.setItem("ba_session", JSON.stringify({token: t, account: a})), [tok(A), A]);
await p.goto(U + "/"); await p.waitForFunction(() => OWNED && OWNED.length >= 4 && !WALLET.loading, null, {timeout: 30000});
await p.waitForTimeout(1500);
const lv = await p.evaluate(() => [BOND.maxLevel, OWNED.map(f => f.id + ":" + SAVE.dog(f.id).lvl).join(" "), SAVE.data.updatedAt]); console.log(JSON.stringify(lv));
ok(lv[0] === 20 && lv[1].includes("000800002723:12"), "the page runs bonds up to 20 (#2723 at 12)");
ok(await p.locator(".wkb").count() === 3, "three weekly badges in the achievements");
const got = await p.evaluate(() => { SAVE.data.wk.streak = 9; for (let i = 0; i < 45; i++) weeklyTrack({win: true, ranked: true, rarer: true, legendary: true, ko: true, low: false, lost: 0, abil: 1, final: true, boss: true});
  return weeklyThis().map(w => achHave(weeklyId(SAVE.weekOf(), w.c))); });
ok(got.every(Boolean), "fights count towards this week's challenges and earn the badges: " + JSON.stringify(got));
await p.waitForTimeout(800);
const srvAch = await call(A, "/ach", undefined);
ok(Object.keys(srvAch.ach).filter(k => k.startsWith("wk:" + wk)).length >= 3, "the badges reach the server (count on the ladder)");
await p.evaluate(() => { menu(); }); await p.waitForTimeout(500);
await p.screenshot({path: S + "/shots/v35-ach.png", fullPage: true});
// rivals: a bond-12 dog meets a rival at 12…14, a rarer one more often
const band = await p.evaluate(() => [rivalBand(12), rivalBand(5), rivalBand(19)]);
ok(JSON.stringify(band) === "[[12,14],[4,6],[19,20]]", "page band = server band " + JSON.stringify(band));
// week results fit the screen
await p.evaluate(() => showWeekRecap()); await p.waitForSelector(".recap .wkres", {timeout: 10000}); await p.waitForTimeout(600);
const fit = await p.evaluate(() => { const c = document.querySelector(".recap .card"); return {h: c.scrollHeight, vh: innerHeight, w: c.clientWidth}; });
ok(fit.h <= fit.vh - 16 && fit.w > 900, `week results without scrolling on 1280×800: ${fit.w}×${fit.h}`);
await p.screenshot({path: S + "/shots/v35-week.png"});
ok(errs.length === 0, "no page errors " + errs.join(" | "));
await br.close(); console.log(fails ? fails + " FAILED" : "ALL PASS"); bye(fails ? 1 : 0);
