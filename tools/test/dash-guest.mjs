// Scrappy Dash for guests (owner, 2 Nov): no wallet → a device id, a name after the run, the run is replayed and counts
// in the rankings marked GUEST; names follow the player-name rules and never take a registered player's or another
// guest's name; 3 new guest ids per address and day; guests never take a prize place. Then the page without sign-in.
// Usage: node tools/test/dash-guest.mjs <outdir>
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { loadDash } from "../../fight-engine.js";
const S = process.argv[2], D = S + "/dataGuest", PORT = 3997, U = "http://127.0.0.1:" + PORT;
fs.rmSync(D, {recursive: true, force: true}); fs.mkdirSync(D, {recursive: true}); fs.mkdirSync(S + "/shots", {recursive: true});
fs.writeFileSync(D + "/session.secret", "testsecret");
const day = k => new Date(Date.now() + k * 864e5).toISOString().slice(0, 10);
const P1 = "rRiva1OneXXXXXXXXXXXXXXXXXXXXX", G0 = "00000000000000aa";
const T0 = Date.now() - 2 * 864e5;
fs.writeFileSync(D + "/store.json", JSON.stringify({players: {}, weekly: {}, holdings: {}, profiles: {[P1]: {name: "MoonPup", updated: 1}}, blobs: {
  // day 1 of the Advent: a guest flew the best run, a player the second best → the prize goes to the player
  ["dashday:" + day(-2)]: {["g:" + G0]: {best: 9000, runs: 2, at: T0}, [P1]: {best: 700, runs: 1, at: T0 + 1}},
  dashguests: {[G0]: {name: "NightFlyer", at: T0}}}}));
const srv = spawn("node", [new URL("./tut-mock.mjs", import.meta.url).pathname], {env: {...process.env, PORT: String(PORT), DATA_DIR: D, ISSUER: "rI", TAXON: "369", ADMIN_KEY: "adm",
  DASH_ADVENT: day(-2), DASH_OPEN_ROCKET: day(-30), DASH_OPEN_SLEIGH: day(-2)}, stdio: "ignore"});
const bye = c => { try { srv.kill(); } catch {} process.exit(c); };
setTimeout(() => { console.log("TIMEOUT"); bye(1); }, 200000);
process.on("unhandledRejection", e => { console.log("ERR", e && e.stack || e); bye(1); });
process.on("uncaughtException", e => { console.log("ERR", e && e.stack || e); bye(1); });
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
await new Promise(r => setTimeout(r, 1800));
const post = async (path, body, ip = "10.0.0.1") => { const r = await fetch(U + "/api" + path, {method: "POST", headers: {"content-type": "text/plain", "x-forwarded-for": ip}, body: JSON.stringify(body)}); return {status: r.status, ...(await r.json())}; };
const get = async path => (await fetch(U + "/api" + path)).json();
const SIM = loadDash(new URL("../../public/index.html", import.meta.url).pathname);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const GA = "1111111111111111";
ok((await post("/public/dash/start", {guest: "nope"})).error === "bad_guest", "a bad guest id is refused");
let r = await post("/public/dash/start", {guest: GA, skin: "sleigh", dog: {name: "Pixel Scrappy #8", token: 8}});
ok(/^[0-9a-f]{18}$/.test(r.id) && r.seed >= 0 && !r.test, "a guest gets a run id + seed");
let sim = SIM.replay(r.seed, 480, 110, [], 100000); await sleep(sim.ticks * 1000 / 60 + 300);
const end = name => post("/public/dash/end", {id: r.id, score: sim.score, ticks: sim.ticks, w: 480, inp: [], guest: GA, name});
ok((await end("")).error === "bad_name", "no name → refused (the run is kept)");
ok((await end("moonpup")).error === "name_taken", "a registered player's name is taken (any case)");
ok((await end("nightflyer")).error === "name_taken", "another guest's name is taken");
ok((await end("rABCDEFGHJK")).error === "bad_name", "no wallet look-alikes");
let e = await end("SnowFan");
ok(e.ok && e.score === sim.score && e.rank >= 1, "a good name books the replayed run: " + JSON.stringify({score: e.score, rank: e.rank, total: e.total}));
ok((await end("SnowFan")).error === "no_run", "the run counts once");
let b = await get("/dash/board?skin=sleigh&guest=" + GA);
const row = b.today.top.find(x => x.name === "SnowFan");
ok(row && row.guest && row.you && b.today.mine.best === sim.score, "board: guest row marked GUEST, and 'you' for that device");
let pub = await get("/public/dash?skin=sleigh");
ok(pub.today.top.some(x => x.name === "SnowFan" && x.guest && !x.you), "the public board shows the guest without wallet data");
// limits: 3 new guest ids per address and day (GA was the 1st)
const ids = ["2222222222222222", "3333333333333333", "4444444444444444"];
const st = [];
for (const id of ids) st.push((await post("/public/dash/start", {guest: id, skin: "sleigh"})).status);
ok(st[0] === 200 && st[1] === 200 && st[2] === 429, "the 4th new guest id from one address is slowed down: " + st.join(","));
ok((await post("/public/dash/start", {guest: GA, skin: "sleigh"})).status === 200, "a known guest can always fly again");
// prizes: a guest's best run of a day does not take the prize
const ad = await get("/admin/dash?key=adm");
const d1 = (ad.results || []).find(x => x.key === "dash-" + day(-2));
ok(d1 && d1.winners[0] && d1.winners[0].name === "MoonPup", "day 1: the guest flew best, the prize place goes to the best wallet player (" + (d1 && d1.winners.map(w => w.name)) + ")");
const cal = (await get("/public/dash?skin=sleigh")).advent.days[0];
ok(cal.winner && cal.winner.name === "MoonPup", "the calendar names the best wallet player as the day's winner");
// rocket guests too, on the rocket board
r = await post("/public/dash/start", {guest: GA, skin: "rocket"}); sim = SIM.replay(r.seed, 480, 110, [], 100000); await sleep(sim.ticks * 1000 / 60 + 300);
e = await post("/public/dash/end", {id: r.id, score: sim.score, ticks: sim.ticks, w: 480, inp: [], guest: GA, name: "SnowFan"});
ok(e.ok && (await get("/public/dash?skin=rocket")).today.top.some(x => x.name === "SnowFan" && x.guest), "Rocket Dash takes guests too");

// the page without a wallet
const br = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const p = await br.newPage({viewport: {width: 1000, height: 900}}); const errs = []; p.on("pageerror", x => errs.push(x.message));
await p.route(u => !u.href.startsWith(U), x => x.abort());
await p.goto(U + "/"); await p.evaluate(() => { localStorage.clear(); localStorage.setItem("ba_dashskin", JSON.stringify("sleigh")); });
await p.goto(U + "/dash"); await p.waitForFunction(() => DASH.board && DASH.board.skin === "sleigh", null, {timeout: 20000});
const run = async () => {
  await p.click("#dashGo");
  await p.waitForFunction(() => DASH.g && DASH.g.runId && DASH.g.runSeed === DASH.g.seed, null, {timeout: 10000});
  await p.locator("#dashCv").dispatchEvent("pointerdown", {button: 0}); await p.locator("#dashCv").dispatchEvent("pointerup");
  await p.waitForFunction(() => DASH.g.state === "over", null, {timeout: 30000});
};
await run();
ok(await p.locator("#dashNameIn").isVisible(), "after the run a guest gets a name field");
await p.screenshot({path: S + "/shots/dash-guest-name.png"});
// typing must not fly the sleigh: the space key goes into the field
await p.fill("#dashNameIn", ""); await p.type("#dashNameIn", "Snow Rider");
ok(await p.inputValue("#dashNameIn") === "Snow Rider", "typing a name (with a space) doesn't trigger the game keys");
await p.fill("#dashNameIn", "MoonPup"); await p.click("#dashName button");
await p.waitForFunction(() => DASH.g.nameErr, null, {timeout: 10000});
ok((await p.locator(".dguest").innerText()).includes("taken"), "a taken name shows a message and the field stays");
await p.fill("#dashNameIn", "Snow Rider"); await p.click("#dashName button");
await p.waitForFunction(() => DASH.g.posted && DASH.g.posted.ok, null, {timeout: 10000});
ok((await p.locator(".dashcard").innerText()).includes("Snow Rider") && await p.evaluate(() => JSON.parse(localStorage.ba_guest_name)) === "Snow Rider", "saved: rank shown, the name is remembered");
await p.screenshot({path: S + "/shots/dash-guest-saved.png"});
await p.click("#dashAgain"); await p.waitForTimeout(300);
await p.locator("#dashCv").dispatchEvent("pointerdown", {button: 0}); await p.locator("#dashCv").dispatchEvent("pointerup");
await p.waitForFunction(() => DASH.g.state === "over" && DASH.g.posted, null, {timeout: 30000});
ok(await p.evaluate(() => DASH.g.posted.ok) && await p.locator("#dashNameIn").count() === 0, "the next run goes in by itself under the remembered name");
await p.click("#dashBack"); await p.waitForTimeout(800);
ok(await p.locator(".lb.you", {hasText: "Snow Rider"}).count() >= 1 && await p.locator(".lb", {hasText: "Snow Rider"}).first().locator(".tag", {hasText: "GUEST"}).count() === 1, "the hangar board shows the guest's row as 'you' with a GUEST tag");
ok(errs.length === 0, "no page errors " + errs.join(" | "));
await br.close(); console.log(fails ? fails + " FAILED" : "ALL PASS"); bye(fails ? 1 : 0);
