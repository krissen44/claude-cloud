// Screenshots of the whole Dash for the owner: locked looks with the countdown, test mode, Rocket rankings (no
// calendar), Sleigh with a running Advent calendar (closed + opened box, overall ranking), a result card and the website.
// Usage: node tools/test/dash-preview.mjs <outdir>   (CHROMIUM=… optional)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHmac } from "node:crypto";
const S = process.argv[2]; fs.mkdirSync(S + "/preview", {recursive: true});
const tok = a => { const b0 = Buffer.from(JSON.stringify({a, exp: 2e9})).toString("base64url"); return b0 + "." + createHmac("sha256", "testsecret").update(b0).digest("base64url"); };
const ME = "rTutoria1P1ayerXXXXXXXXXXXXXXX";
const day = k => new Date(Date.now() + k * 864e5).toISOString().slice(0, 10);
const weekOf = (d = new Date()) => { const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); };
// players with names; "rI" = team wallet (shown with TEAM, never a winner)
const P = {[ME]: "Krissen", rRiva1OneXXXXXXXXXXXXXXXXXXXXX: "MoonPup", rDashCXXXXXXXXXXXXXXXXXXXXXXXX: "SleighQueen", rPlayer4XXXXXXXXXXXXXXXXXXXXXX: "BarkVader",
  rPlayer5XXXXXXXXXXXXXXXXXXXXXX: "XRPup", rPlayer6XXXXXXXXXXXXXXXXXXXXXX: "Snowball", rPlayer7XXXXXXXXXXXXXXXXXXXXXX: "Doge_Dash", rPlayer8XXXXXXXXXXXXXXXXXXXXXX: "Biscuit"};
const accts = Object.keys(P);
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const board = (n, lo, hi, t0) => Object.fromEntries(accts.slice(0, n).map((a, i) => [a, {best: Math.round(lo + rnd() * (hi - lo)), runs: 1 + Math.floor(rnd() * 9), at: t0 + i,
  dog: {name: "Pixel Scrappy #" + (100 + i * 37), token: 100 + i * 37}}]));
// the owner's prize plan: day 1–23 Commons, day 24 Rare, overall Epic / Rare / Rare / Uncommon / Uncommon
const DAYS = [54, 71, 244, 298, 333, 405, 437, 495, 513, 529, 764, 1055, 1139, 1161, 1365, 1377, 1435, 1602, 1648, 1706, 1754, 1827, 1842, 2908];
function store(dir, from){
  const blobs = {};
  const now = Date.now();
  for (let k = -5; k <= 0; k++){ blobs["dashday:" + day(k)] = board(k === 0 ? 6 : 8, 900, 6400, now + k * 864e5); blobs["rdashday:" + day(k)] = board(k === 0 ? 5 : 7, 700, 5200, now + k * 864e5); }
  blobs["dashday:" + day(0)].rI = {best: 9999, runs: 3, at: now};
  blobs["dash:" + weekOf()] = board(8, 3000, 7400, now - 3e5); blobs["rdash:" + weekOf()] = board(7, 2500, 6100, now - 3e5);
  blobs["dashplan:" + from] = Object.fromEntries([...DAYS.map((t, i) => ["dash-" + new Date(Date.parse(from) + i * 864e5).toISOString().slice(0, 10), {nftId: "0008" + t, token: t, rarity: i === 23 ? "Rare" : "Common"}]),
    ...[[3756, "Epic"], [1017, "Rare"], [2317, "Rare"], [206, "Uncommon"], [698, "Uncommon"]].map(([t, r], i) => ["grand-" + (i + 1), {nftId: "0009" + t, token: t, rarity: r}])]);
  fs.rmSync(dir, {recursive: true, force: true}); fs.mkdirSync(dir, {recursive: true}); fs.writeFileSync(dir + "/session.secret", "testsecret");
  fs.writeFileSync(dir + "/store.json", JSON.stringify({players: {}, weekly: {}, holdings: {}, profiles: Object.fromEntries(Object.entries(P).map(([a, name]) => [a, {name, updated: 1}])), blobs}));
}
const servers = [];
function serve(port, env, dir){
  store(dir, env.DASH_ADVENT || "2026-12-01");
  const s = spawn("node", [new URL("./tut-mock.mjs", import.meta.url).pathname], {env: {...process.env, PORT: String(port), DATA_DIR: dir, ISSUER: "rI", TAXON: "369", ...env}, stdio: "ignore"});
  servers.push(s); return "http://127.0.0.1:" + port;
}
const bye = c => { for (const s of servers) try { s.kill(); } catch {} process.exit(c); };
setTimeout(() => { console.log("TIMEOUT"); bye(1); }, 240000);
// LIVE: both looks open, the Advent calendar on day 6. NOW: the real opening days (locked, countdown).
const LIVE = serve(3991, {DASH_ADVENT: day(-5), DASH_OPEN_ROCKET: day(-30), DASH_OPEN_SLEIGH: day(-5)}, S + "/prevLive");
const NOW = serve(3992, {}, S + "/prevNow");
await new Promise(r => setTimeout(r, 2200));
const br = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const errs = [];
async function page(U, vp, path, pre){
  const p = await (await br.newContext({viewport: vp, deviceScaleFactor: vp.width < 500 ? 2 : 1})).newPage();
  p.on("pageerror", e => errs.push(e.message));
  await p.route(u => !u.href.startsWith("http://127.0.0.1"), r => r.abort());
  await p.goto(U + "/"); await p.evaluate(([t, a, pre]) => { localStorage.clear(); localStorage.setItem("ba_session", JSON.stringify({token: t, account: a})); for (const [k, v] of Object.entries(pre || {})) localStorage.setItem(k, JSON.stringify(v)); }, [tok(ME), ME, pre]);
  await p.goto(U + path); await p.waitForFunction(() => OWNED && OWNED.length && !WALLET.loading && DASH.board && DASH.board.skin === dashTheme(), null, {timeout: 30000});
  await p.evaluate(() => document.querySelectorAll(".achtoast,.toast").forEach(e => e.remove()));
  await p.waitForTimeout(900);
  return p;
}
const shot = (p, n, full = true) => p.screenshot({path: `${S}/preview/${n}.png`, fullPage: full});
const desk = {width: 1000, height: 900}, phone = {width: 390, height: 844};

// 1 + 2: locked looks with the countdown (real dates)
let p = await page(NOW, desk, "/dash", {ba_dashskin: "rocket"}); await shot(p, "01-rocket-gesperrt");
await p.click('[data-dskin="sleigh"]'); await p.waitForFunction(() => DASH.board.skin === "sleigh"); await p.waitForTimeout(600); await shot(p, "02-sleigh-gesperrt");
// 3: tester code → test mode
await p.fill("#dashCode", "scrappy589"); await p.click(".dcode button"); await p.waitForSelector(".dtest"); await p.waitForTimeout(400); await shot(p, "03-sleigh-testmodus");
p = await page(NOW, phone, "/dash", {ba_dashskin: "rocket"}); await shot(p, "04-rocket-gesperrt-handy", false);

// 5: Rocket open — rankings only
p = await page(LIVE, desk, "/dash", {ba_dashskin: "rocket"}); await shot(p, "05-rocket-offen-rangliste");
// 6 + 7: Sleigh open — Advent day 6, today's box closed, then opened
p = await page(LIVE, desk, "/dash", {ba_dashskin: "sleigh"}); await shot(p, "06-sleigh-advent-box-zu");
await p.click(".adoor.today.box"); await p.waitForTimeout(1100); await shot(p, "07-sleigh-advent-box-offen");
// 8: a run and its result card
await p.click("#dashGo"); await p.waitForFunction(() => DASH.g && DASH.g.runId && DASH.g.runSeed === DASH.g.seed, null, {timeout: 10000});
await p.locator("#dashCv").dispatchEvent("pointerdown", {button: 0}); await p.locator("#dashCv").dispatchEvent("pointerup");
await p.evaluate(() => { window.__h = setInterval(() => { const G = DASH.g; if (G && G.state === "run") G.want = G.y > 150; }, 16); });
await p.waitForTimeout(5000); await shot(p, "08-sleigh-im-flug", false);
await p.evaluate(() => { clearInterval(window.__h); DASH.g.want = false; DASH.g.shield = false; DASH.g.blink = 0; });
await p.waitForFunction(() => DASH.g && DASH.g.state === "over" && DASH.g.posted, null, {timeout: 20000}); await p.waitForTimeout(500);
await shot(p, "09-ergebnis", false);
p = await page(LIVE, phone, "/dash", {ba_dashskin: "sleigh"}); await shot(p, "10-sleigh-advent-handy");

// 11 + 12: the website (game API from the LIVE server; dates set in the browser)
for (const [n, when] of [["11-website-november-rocket", "2026-11-15T12:00:00Z"], ["12-website-dezember-sleigh", "2026-12-06T12:00:00Z"]]){
  const w = await (await br.newContext({viewport: {width: 1100, height: 900}})).newPage();
  w.on("pageerror", e => errs.push("site: " + e.message));
  await w.clock.install({time: new Date(when)});
  const pass = async (r, url) => { try { const x = await fetch(url, {method: r.request().method(), body: r.request().postData() || undefined});
    await r.fulfill({status: x.status, headers: {"content-type": x.headers.get("content-type") || "application/octet-stream", "access-control-allow-origin": "*"}, body: Buffer.from(await x.arrayBuffer())}); } catch { await r.abort(); } };
  await w.route(u => u.protocol !== "file:" || /\/pixelscrappy\/nfts\//.test(u.href), r => {
    const u = r.request().url(), m = u.match(/\/pixelscrappy\/nfts\/(\d+)\.png/);
    if (u.startsWith("https://game.scrappyxrp.fun/api/")) return pass(r, u.replace("https://game.scrappyxrp.fun", LIVE));
    if (m) return pass(r, LIVE + "/api/public/dogimg?t=" + m[1]);
    return r.abort();
  });
  await w.goto("file://" + new URL("../../website/barkarena/index.html", import.meta.url).pathname + "#dash");
  await w.clock.runFor(3000); await w.waitForTimeout(1500);
  await w.evaluate(() => document.querySelectorAll("header, nav, .nav, .topbar").forEach(e => { if (getComputedStyle(e).position === "fixed" || getComputedStyle(e).position === "sticky") e.style.display = "none"; }));
  await w.locator("#dash").screenshot({path: `${S}/preview/${n}.png`});
}
console.log(errs.length ? "page errors: " + errs.join(" | ") : "no page errors");
await br.close(); bye(0);
