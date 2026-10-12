// Scrappy Dash: API (run ids, clock + score checks, weekly board) and the game in the browser (both skins)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHmac } from "node:crypto";
const S = process.argv[2], D = S + "/dataDash", PORT = 3987, U = "http://127.0.0.1:" + PORT;
fs.rmSync(D, {recursive: true, force: true}); fs.mkdirSync(D, {recursive: true}); fs.mkdirSync(S + "/shots", {recursive: true});
fs.writeFileSync(D + "/session.secret", "testsecret");
const tok = a => { const b0 = Buffer.from(JSON.stringify({a, exp: 2e9})).toString("base64url"); return b0 + "." + createHmac("sha256", "testsecret").update(b0).digest("base64url"); };
const A = "rRiva1OneXXXXXXXXXXXXXXXXXXXXX", B = "rTutoria1P1ayerXXXXXXXXXXXXXXX";
const log = fs.openSync(S + "/dashserver.log", "w");
const srv = spawn("node", [new URL("./tut-mock.mjs", import.meta.url).pathname], {env: {...process.env, PORT: String(PORT), DATA_DIR: D, ISSUER: "rI", TAXON: "369"}, stdio: ["ignore", log, log]});
const bye = c => { try { srv.kill(); } catch (e) {} process.exit(c); };
setTimeout(() => { console.log("TIMEOUT"); bye(1); }, 240000);
process.on("uncaughtException", e => { console.log("ERR", e && e.stack || e); bye(1); });
process.on("unhandledRejection", e => { console.log("ERR", e && e.stack || e); bye(1); });
await new Promise(r => setTimeout(r, 1800));
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + m); };
const call = async (who, path, body) => { const r = await fetch(U + "/api" + path, {method: body ? "POST" : "GET", headers: who ? {authorization: "Bearer " + tok(who), "content-type": "application/json"} : {}, body: body && JSON.stringify(body)}); return {status: r.status, ...(await r.json())}; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- API
let r = await call(A, "/dash/start", {dog: {name: "Pixel Scrappy #77", token: 77}});
ok(/^[0-9a-f]{18}$/.test(r.id) && r.theme === "sleigh", "run id + theme " + r.theme);
await sleep(2200);
let e = await call(A, "/dash/end", {id: r.id, score: 99999, ms: 2000});
ok(e.error === "bad_score", "a score faster than possible is refused");
r = await call(A, "/dash/start", {dog: {name: "x", token: 77}}); await sleep(1500);
ok((await call(A, "/dash/end", {id: r.id, score: 100, ms: 60000})).error === "bad_time", "a run longer than the clock is refused");
r = await call(A, "/dash/start", {}); await sleep(2100);
ok((await call(B, "/dash/end", {id: r.id, score: 100, ms: 2000})).error === "no_run", "someone else's run id is refused");
r = await call(A, "/dash/start", {dog: {name: "Pixel Scrappy #77", token: 77}}); await sleep(2100);
e = await call(A, "/dash/end", {id: r.id, score: 420, ms: 2000, gifts: 3});
ok(e.ok && e.pb && e.best === 420 && e.rank === 1, "a fair run lands on the board");
ok((await call(A, "/dash/end", {id: r.id, score: 420, ms: 2000})).error === "no_run", "a run id counts once");
r = await call(B, "/dash/start", {}); await sleep(2100);
await call(B, "/profile", {name: "Dasher"});
e = await call(B, "/dash/end", {id: r.id, score: 300, ms: 2000});
ok(e.ok && e.rank === 2 && e.players === 2, "second player is #2");
let bd = await call(B, "/dash/board");
ok(bd.top.length === 2 && bd.top[0].score === 420 && bd.top[1].name === "Dasher" && bd.top[1].you && bd.mine.rank === 2, "board: top + mine");
bd = await call(null, "/public/dash");
ok(bd.top.length === 2 && !JSON.stringify(bd).includes("rRiva1"), "public board without wallets");

// --- browser
const br = await chromium.launch({executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"});
const page = async (vp, path) => {
  const p = await (await br.newContext({viewport: vp, hasTouch: vp.width < 500})).newPage();
  p.errs = []; p.on("pageerror", x => p.errs.push(x.message));
  await p.route(u => !u.href.startsWith("http://127.0.0.1"), r => r.abort());
  await p.goto(U + "/"); await p.evaluate(([t, a]) => localStorage.setItem("ba_session", JSON.stringify({token: t, account: a})), [tok(A), A]);
  await p.goto(U + path); await p.waitForFunction(() => OWNED && OWNED.length && !WALLET.loading && DASH.board, null, {timeout: 30000});
  await p.waitForTimeout(500);
  return p;
};
const p = await page({width: 1000, height: 900}, "/dash");
ok(await p.locator(".dashhero").count() === 1 && await p.locator("[data-dashdog]").count() >= 3, "/dash opens the Dash tab with the pilots");
await p.screenshot({path: S + "/shots/dash-hangar.png", fullPage: true});
// a little autopilot: climb over what's ahead, drop gifts with a lead
const bot = () => {
  const G = DASH.g; if (!G || G.state !== "run") return;
  let need = 200;
  for (const h of G.houses) if (h.x < DASH_PX + 130 && h.x + h.w > DASH_PX - 30) need = Math.min(need, h.top - h.ch - 30);
  for (const f of G.foes) if (f.x > DASH_PX - 20 && f.x < DASH_PX + 90 && Math.abs(f.y - G.y) < 30) need = Math.min(need, f.y - 34);
  G.hold = G.y + Math.max(0, G.vy) * .3 > need;
  for (const h of G.houses) if (h.wants && !h.done && !h.aimed){
    const ct = h.top - h.ch, t = Math.sqrt(2 * Math.max(1, ct - G.y) / 900), lead = G.v * t, mid = h.x + h.cx + 9;
    if (Math.abs(mid - DASH_PX - lead) < 6){ h.aimed = true; dashDrop(G); }
  }
};
await p.click("#dashGo");
await p.waitForTimeout(400);
ok(await p.evaluate(() => DASH.g && DASH.g.state === "ready"), "ready screen");
await p.screenshot({path: S + "/shots/dash-ready.png"});
await p.locator("#dashCv").dispatchEvent("pointerdown", {button: 0}); await p.locator("#dashCv").dispatchEvent("pointerup");
ok(await p.evaluate(() => DASH.g.state === "run" && DASH.g.ammo === 3), "tap starts the run without dropping a gift");
await p.evaluate(b => { window.__bot = setInterval(eval(b), 16); }, "(" + bot.toString() + ")");
await p.waitForTimeout(6000);
await p.screenshot({path: S + "/shots/dash-sleigh.png"});
await p.waitForTimeout(6000);
const mid = await p.evaluate(() => ({s: DASH.g.score, st: DASH.g.state, del: DASH.g.delivered, t: DASH.g.t}));
console.log("after 12 s:", JSON.stringify(mid));
ok(mid.s > 100, "score grows (" + Math.floor(mid.s) + ", " + mid.del + " delivered)");
await p.screenshot({path: S + "/shots/dash-sleigh2.png"});
// crash it
await p.evaluate(() => { clearInterval(window.__bot); const G = DASH.g; if (G.state === "run"){ G.shield = false; G.blink = 0; G.hold = false; G.y = DASH_H; } });
await p.waitForFunction(() => DASH.g && DASH.g.state === "over" && DASH.g.posted, null, {timeout: 10000});
const post = await p.evaluate(() => DASH.g.posted);
ok(post.ok && post.rank >= 1, "run posted to the board: #" + post.rank + " best " + post.best);
ok(await p.locator("#dashAgain").count() === 1, "game over card with Again");
await p.screenshot({path: S + "/shots/dash-over.png"});
const xp = await p.evaluate(() => ({xp: DASH.g.xp, day: SAVE.data.dash.xp}));
ok(xp.xp > 0 && xp.day === xp.xp, "bond XP for the dog: " + xp.xp);
await p.waitForTimeout(800);
await p.click("#dashAgain");
const ag = await p.evaluate(() => ({st: DASH.g.state, s: DASH.g.score, a: DASH.g.ammo}));
ok(ag.st === "run" && ag.s < 5 && ag.a === 3, "Again starts a fresh run " + JSON.stringify(ag));
await p.click("#dashQuit");
ok(await p.evaluate(() => !DASH.g && tab === "dash") && await p.locator(".dashhero").count() === 1, "back to the hangar");
ok(p.errs.length === 0, "no page errors " + p.errs.join(" | "));
// rocket skin + phone
const q = await page({width: 390, height: 844}, "/dash?dash=rocket");
await q.screenshot({path: S + "/shots/dash-rocket-hangar.png", fullPage: true});
await q.click("#dashGo"); await q.waitForTimeout(300);
await q.locator("#dashCv").dispatchEvent("pointerdown", {button: 0}); await q.locator("#dashCv").dispatchEvent("pointerup");
await q.evaluate(b => { window.__bot = setInterval(eval(b), 16); }, "(" + bot.toString() + ")");
await q.waitForTimeout(9000);
await q.screenshot({path: S + "/shots/dash-rocket.png"});
ok(await q.evaluate(() => DASH.g.th === "rocket"), "rocket skin");
ok(q.errs.length === 0, "no page errors (rocket) " + q.errs.join(" | "));
await br.close();
console.log(fails ? fails + " FAILED" : "ALL PASS");
bye(fails ? 1 : 0);
