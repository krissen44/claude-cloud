// v37 (competition): abilities recharge 2 rounds, a guard halves damage "through a guard", hot streak (tougher ranked
// rivals + more XP) on page and referee alike, old replays keep the old rules
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHmac } from "node:crypto";
import { loadEngine } from "../../fight-engine.js";
const S = process.argv[2], D = S + "/dataV37", PORT = 3988, U = "http://127.0.0.1:" + PORT;
fs.rmSync(D, {recursive: true, force: true}); fs.mkdirSync(D + "/saves", {recursive: true}); fs.writeFileSync(D + "/session.secret", "testsecret");
const tok = a => { const b0 = Buffer.from(JSON.stringify({a, exp: 2e9})).toString("base64url"); return b0 + "." + createHmac("sha256", "testsecret").update(b0).digest("base64url"); };
const ME = "rTutoria1P1ayerXXXXXXXXXXXXXXX";
const wkOf = d => { const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); };
const NOW = wkOf(new Date());
fs.writeFileSync(D + "/store.json", JSON.stringify({players: {}, weekly: {}, holdings: {}, profiles: {[ME]: {name: "TutorMe"}}, blobs: {
  ["fair:" + NOW]: {[ME]: {xp: 300, wins: 10, losses: 0, cur: 10, streak: 10, base: {xp: 0, wins: 0}, fights: 10, rounds: 80, throws: 10, desync: 0, started: 10, ghosts: 0, runs: {}, at: Date.now()}}}}));
const srv = spawn("node", [new URL("./tut-mock.mjs", import.meta.url).pathname], {env: {...process.env, PORT: String(PORT), DATA_DIR: D, ISSUER: "rI", TAXON: "369"}, stdio: "ignore"});
const bye = c => { try { srv.kill(); } catch (e) {} process.exit(c); };
setTimeout(() => { console.log("TIMEOUT"); bye(1); }, 200000);
process.on("unhandledRejection", e => { console.log("ERR", e && e.stack || e); bye(1); });
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + m); };

// --- the engine (server copy)
const ENG = loadEngine(new URL("../../public/index.html", import.meta.url).pathname);
const html = fs.readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
const DATA = JSON.parse(html.slice(html.indexOf("const DATA = ") + 13, html.indexOf("\n", html.indexOf("const DATA = "))).replace(/;\s*$/, ""));
const dog = (id, extra) => ({id, name: id, rarity: "Common", set: null, setMatch: 0, unknown: [], traits: [...extra]});
const A = dog("a", ["overlay-lightning"]), B = dog("b", []);
let st = ENG.start(A, 1, B, 1);
st.P.energy = 9;
let r = ENG.round(st, "ab0", "bite", 1); st = r.state;
ok(st.P.cd === 2, "after a cast the ability recharges (cd " + st.P.cd + ")");
const hpB = st.E.hp; r = ENG.round(st, "ab0", "taunt", 2); st = r.state;
ok(st.E.hp >= hpB - 0 && st.P.energy >= 1, "next round: the ability is not ready — the move becomes a guard (no damage to B)");
r = ENG.round(st, "ab0", "taunt", 3); st = r.state; const e3 = st.P.energy;
r = ENG.round(st, "ab0", "taunt", 4);
ok(r.state.P.energy < e3 + 1 && r.state.P.cd === 2, "two rounds later it casts again");
// a guard halves Lightning: compare the same seed guarded / not guarded
let s1 = ENG.start(A, 1, B, 1); s1.P.energy = 9;
const open1 = ENG.round(s1, "ab0", "taunt", 77).state, guard1 = ENG.round(s1, "ab0", "guard", 77).state;
const dOpen = s1.E.hp - open1.E.hp - 0, dGuard = s1.E.hp - guard1.E.hp;
ok(dGuard > 0 && dGuard < dOpen, `a guard halves Lightning (open ${dOpen} incl. nothing else, guarded ${dGuard})`);
ok(/a guard halves it/.test(DATA.traits.find(t => t.id === "overlay-lightning").text), "trait text says so");

// --- the referee: a hot streak (10 verified wins) → rival +2 levels band and +4 health
await new Promise(r => setTimeout(r, 1800));
const call = async (who, path, body) => (await fetch(U + "/api" + path, {method: body ? "POST" : "GET", headers: {authorization: "Bearer " + tok(who), "content-type": "application/json"}, body: body && JSON.stringify(body)})).json();
const k = (await call(ME, "/me/kennel")).nfts;
const f = await call(ME, "/fight/start", {kind: "ranked", dog: k[0].nft_id, opp: {token: 1500}, lvl: 1, oppLvl: 4});
ok(f.heat === 2 && f.lvl.E === 4, `hot streak on the referee: heat ${f.heat}, rival bond ${f.lvl && f.lvl.E} (band 1…2+2)`);
const f2 = await call(ME, "/fight/start", {kind: "arena", dog: k[0].nft_id, opp: {token: 1501}, lvl: 1, oppLvl: 1, run: "x", stage: 0});
ok(!f2.heat, "arena fights are not heated");

// --- the page: hot streak fight verified by the server, old replays under old rules
const br = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const p = await br.newPage({viewport: {width: 1280, height: 900}}); const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.route(u => !u.href.startsWith(U), r => r.abort());
await p.goto(U + "/"); await p.evaluate(([t, a]) => localStorage.setItem("ba_session", JSON.stringify({token: t, account: a})), [tok(ME), ME]);
await p.goto(U + "/"); await p.waitForFunction(() => OWNED && OWNED.length >= 2 && !WALLET.loading, null, {timeout: 30000});
const pf = await p.evaluate(async () => {
  SAVE.data.streak = 10; SAVE.data.tickets = 5;
  const a = OWNED.find(f => !f.legendary), b = DATA.fighters[1]; SAVE.spend(); startFight(a, b, true);
  const base = build(b, E.lvl, null).maxHp, heatHp = E.maxHp - base;
  await VF.wait; const on = VF.on;
  for (let i = 0; i < 12 && !over; i++){ await go({type: ['bite','guard','taunt'][i % 3]}); const t = Date.now(); while ((busy || VF.busy) && Date.now() - t < 9000) await new Promise(r => setTimeout(r, 50)); }
  return {heat: E.heat, heatHp, on, desync: VF.fid && !VF.on && !over, over, log: document.body.innerText.includes('Hot streak')};
});
ok(pf.heat === 2 && pf.heatHp === 4 && pf.on, "page: the hot rival has +4 health and the referee agrees " + JSON.stringify(pf));
ok(pf.over, "the fight runs to the end");
const old = await p.evaluate(() => [repRules({rounds: [{a: 'bite', b: 'bite', r: []}]}), repRules({rounds: [{a: 'bite', b: 'bite', r: []}], rules: 2}), repRules({})]);
ok(JSON.stringify(old) === "[1,2,2]", "old replays play under the old rules, new ones and exhibitions under the new " + JSON.stringify(old));
ok(!errs.length, "no page errors " + errs.join(" | "));
await br.close(); console.log(fails ? fails + " FAILED" : "ALL PASS"); bye(fails ? 1 : 0);
