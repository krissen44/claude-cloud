// Share card (PnL style): week card from the kennel, last-week card from the recap, win card after a fight
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHmac } from "node:crypto";
const S = process.argv[2], D = S + "/dataCard", PORT = 3986, U = "http://127.0.0.1:" + PORT;
fs.rmSync(D, {recursive: true, force: true}); fs.mkdirSync(D + "/saves", {recursive: true}); fs.mkdirSync(S + "/shots", {recursive: true});
fs.writeFileSync(D + "/session.secret", "testsecret");
const tok = a => { const b0 = Buffer.from(JSON.stringify({a, exp: 2e9})).toString("base64url"); return b0 + "." + createHmac("sha256", "testsecret").update(b0).digest("base64url"); };
const A = "rTutoria1P1ayerXXXXXXXXXXXXXXX";
const d = new Date(), wk = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (d.getUTCDay() + 6) % 7)).toISOString().slice(0, 10);
fs.writeFileSync(D + "/store.json", JSON.stringify({players: {}, holdings: {}, profiles: {[A]: {name: "WoofMaster"}},
  weekly: {[wk + "|" + A]: {account: A, week: wk, wins: 42, losses: 6, xp: 1240, streak: 12, updated: Date.now()},
           [wk + "|rOther"]: {account: "rOther", week: wk, wins: 50, losses: 3, xp: 1500, streak: 9, updated: Date.now()}}, blobs: {}}));
const srv = spawn("node", [new URL("./tut-mock.mjs", import.meta.url).pathname], {env: {...process.env, PORT: String(PORT), DATA_DIR: D, ISSUER: "rI", TAXON: "369"}, stdio: "ignore"});
const bye = c => { try { srv.kill(); } catch {} process.exit(c); };
setTimeout(() => { console.log("TIMEOUT"); bye(1); }, 120000);
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
await new Promise(r => setTimeout(r, 1800));
const br = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const p = await br.newPage({viewport: {width: 1280, height: 860}}); const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.route(u => !u.href.startsWith(U), r => r.abort());
const FONT = process.env.PS2P;      // optional: Press Start 2P woff2 so the card looks as it does live
if (FONT){ await p.route(/fonts\.googleapis\.com/, r => r.fulfill({contentType: "text/css", body: "@font-face{font-family:'Press Start 2P';src:url(https://fonts.gstatic.com/ps.woff2) format('woff2')}"}));
  await p.route(/fonts\.gstatic\.com/, r => r.fulfill({contentType: "font/woff2", body: fs.readFileSync(FONT)})); }
await p.goto(U + "/"); await p.evaluate(([t, a]) => localStorage.setItem("ba_session", JSON.stringify({token: t, account: a})), [tok(A), A]);
await p.goto(U + "/"); await p.waitForFunction(() => OWNED && OWNED.length >= 2 && !WALLET.loading, null, {timeout: 30000});
await p.evaluate(() => { SAVE.data.wk = {wins: 42, losses: 6, xp: 1240, streak: 12}; SAVE.data.lastWk = {wins: 30, losses: 9, xp: 900, streak: 7}; SAVE.data.recapWeek = lastWeekKey(); document.querySelectorAll(".recap").forEach(e => e.remove()); menu(); });
await p.click("#cardWeek"); await p.waitForSelector(".cardimg", {timeout: 15000});
const png = async name => { const u = await p.getAttribute(".cardimg", "src"); fs.writeFileSync(S + "/shots/" + name, Buffer.from(u.split(",")[1], "base64")); return u.length; };
ok(await png("card-week.png") > 20000, "week card drawn (PNG)");
const txt = await p.getAttribute(".cardimg", "alt");
ok(/\+1240 XP · 42–6 · 88% wins · #2/.test(txt) && /ref=WoofMaster/.test(txt), "card text: " + txt);
await p.screenshot({path: S + "/shots/card-modal.png"});
await p.click("#cardClose");
// last week from the recap
await p.evaluate(() => shareCard('last', {rank: {rank: 3, of: 28}})); await p.waitForSelector(".cardimg");
ok(await png("card-last.png") > 20000, "last-week card drawn"); await p.click("#cardClose");
// a win
await p.evaluate(() => { const a = OWNED[0], b = OWNED[1]; P = build(a, 7, null); E = build(b, 7, null); E.hp = 0; P.hp = 11; shareCard('win', {xp: 40}); });
await p.waitForSelector(".cardimg"); ok(await png("card-win.png") > 20000, "win card drawn");
ok(!errs.length, "no page errors " + errs.join(" | "));
await br.close(); bye(fails ? 1 : 0);
