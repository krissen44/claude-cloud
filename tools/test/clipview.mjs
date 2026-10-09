// /clip?id=<replay> opened by a person (the Discord "Watch the fight" link): a play button starts the fight,
// it plays to the end card with "Watch again" / "Play Bark Arena". The Shorts recorder (webdriver) gets no button.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHmac } from "node:crypto";
const S = process.argv[2], D = S + "/dataClip", PORT = 3987, U = "http://127.0.0.1:" + PORT;
fs.rmSync(D, {recursive: true, force: true}); fs.mkdirSync(D, {recursive: true}); fs.writeFileSync(D + "/session.secret", "testsecret");
const tok = a => { const b0 = Buffer.from(JSON.stringify({a, exp: 2e9})).toString("base64url"); return b0 + "." + createHmac("sha256", "testsecret").update(b0).digest("base64url"); };
const ME = "rRiva1OneXXXXXXXXXXXXXXXXXXXXX";
const log = fs.openSync(S + "/clipserver.log", "w");
const srv = spawn("node", [new URL("./tut-mock.mjs", import.meta.url).pathname], {env: {...process.env, PORT: String(PORT), DATA_DIR: D, ISSUER: "rI", TAXON: "369"}, stdio: ["ignore", log, log]});
const bye = c => { try { srv.kill(); } catch (e) {} process.exit(c); };
setTimeout(() => { console.log("TIMEOUT"); bye(1); }, 240000);
process.on("unhandledRejection", e => { console.log("ERR", e && e.stack || e); bye(1); });
await new Promise(r => setTimeout(r, 1800));
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + m); };
const br = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
await fetch(U + "/api/me/kennel", {headers: {authorization: "Bearer " + tok(ME)}});
// a full seeded (v32 referee-style) fight, played with the page's own engine, uploaded as a replay
const p0 = await (await br.newContext()).newPage();
await p0.route(u => !u.href.startsWith("http://127.0.0.1"), r => r.abort());
await p0.goto(U + "/?demo=1");
const rep = await p0.evaluate(() => {
  const a = DATA.fighters.find(f => !f.legendary && f.rarity === "Common"), b = DATA.fighters.find(f => f.legendary);
  P = build(a, 3); E = build(b, 3); turn = 1; log = []; ev = []; over = false; simulating = true;
  const rounds = [];
  for (let i = 0; i < 12 && !over; i++){ const ea = ai(E, P, null), pa = ai(P, E, ea), seed = Math.floor(Math.random() * 2 ** 31);
    rounds.push({a: mvKey(P, pa), b: mvKey(E, ea), seed}); resolveSeeded(pa, ea, seed); }
  simulating = false;
  return {kind: "ranked", P: {def: a, lvl: 3}, E: {def: b, lvl: 3}, rounds, result: verdict() === "YOU WIN" ? "W" : verdict() === "YOU LOSE" ? "L" : "D"};
});
const up = await (await fetch(U + "/api/replay", {method: "POST", headers: {authorization: "Bearer " + tok(ME), "content-type": "application/json"}, body: JSON.stringify(rep)})).json();
up.id = (await (await fetch(U + "/api/public/replays")).json()).replays?.[0]?.id;
ok(up.kept && !!up.id, "seeded replay stored (" + rep.rounds.length + " rounds)");
// a person opens the link
const ctx = await br.newContext({viewport: {width: 450, height: 800}});
await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, "webdriver", {get: () => false}));
const p = await ctx.newPage(), errs = []; p.on("pageerror", e => errs.push(e.message));
await p.route(u => !u.href.startsWith("http://127.0.0.1"), r => r.abort());
await p.goto(U + "/clip?id=" + up.id);
await p.waitForSelector(".clipplay", {timeout: 30000});
ok(await p.evaluate(() => CLIP.state === "ready"), "a play button waits for the viewer");
await p.screenshot({path: S + "/shots/clip-play.png"});
await p.click(".clipplay");
await p.waitForFunction(() => CLIP.state === "playing", null, {timeout: 5000});
ok(await p.locator(".clipplay").count() === 0, "tap starts the fight");
await p.waitForFunction(() => CLIP.state === "done", null, {timeout: 150000});
ok(await p.evaluate(n => CLIP.rep.rounds.length === n && CLIP.rep.rounds[0].seed != null && turn > 1, rep.rounds.length), "the seeded replay played through (" + rep.rounds.length + " rounds)");
ok(await p.locator("#clipAgain").count() === 1 && await p.locator(".cebtn a[href*='barkarena']").count() === 1, "end card offers Watch again + Play");
await p.screenshot({path: S + "/shots/clip-end.png"});
ok(!errs.length, "no page errors " + JSON.stringify(errs));
// the Shorts recorder: no button, it calls CLIP.go() itself
const q = await (await br.newContext({viewport: {width: 450, height: 800}})).newPage();
await q.route(u => !u.href.startsWith("http://127.0.0.1"), r => r.abort());
await q.goto(U + "/clip?id=" + up.id);
await q.waitForFunction(() => CLIP.state === "ready", null, {timeout: 30000});
ok(await q.locator(".clipplay").count() === 0, "recorder (webdriver) sees no play button");
await q.evaluate(() => CLIP.go());
await q.waitForFunction(() => CLIP.state === "done", null, {timeout: 150000});
ok(await q.locator("#clipAgain").count() === 0, "recorder's end card has no buttons");
await br.close();
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
bye(fails ? 1 : 0);
