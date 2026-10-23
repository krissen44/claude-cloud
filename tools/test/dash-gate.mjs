// Dash opening days (owner, 23 Oct): Rocket Dash from 1 Nov 2026, Sleigh Dash from 1 Dec. The tab is always there; a
// locked look is blurred with a tester code field. Players are refused before the day; a tester code (DASH_TEST_CODE)
// or a team wallet flies it, replayed but never booked. The website shows its Dash section from 1 Nov.
// (Run before 1 Nov 2026 — afterwards the rocket checks flip.)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHmac } from "node:crypto";
import { loadDash } from "../../fight-engine.js";
const S = process.argv[2], D = S + "/dataDashGate", PORT = 3985, U = "http://127.0.0.1:" + PORT, CODE = "elf-test-42";
fs.rmSync(D, {recursive: true, force: true}); fs.mkdirSync(D, {recursive: true}); fs.writeFileSync(D + "/session.secret", "testsecret");
const tok = a => { const b0 = Buffer.from(JSON.stringify({a, exp: 2e9})).toString("base64url"); return b0 + "." + createHmac("sha256", "testsecret").update(b0).digest("base64url"); };
const B = "rTutoria1P1ayerXXXXXXXXXXXXXXX";
const srv = spawn("node", [new URL("./tut-mock.mjs", import.meta.url).pathname], {env: {...process.env, PORT: String(PORT), DATA_DIR: D, ISSUER: "rI", TAXON: "369", DASH_TEST_CODE: CODE}, stdio: "ignore"});
const bye = c => { try { srv.kill(); } catch {} process.exit(c); };
setTimeout(() => bye(1), 120000);
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
await new Promise(r => setTimeout(r, 1800));
const call = async (who, path, body) => { const r = await fetch(U + "/api" + path, {method: body ? "POST" : "GET", headers: {...(who ? {authorization: "Bearer " + tok(who)} : {}), "content-type": "application/json"}, body: body && JSON.stringify(body)}); return {status: r.status, j: await r.json()}; };
const before = Date.now() < Date.parse("2026-11-01T00:00:00Z");
let r = await call(B, "/dash/start", {skin: "rocket"});
ok(before ? r.status === 403 && r.j.error === "not_open" && r.j.opens === "2026-11-01" : r.status === 200, "rocket before 1 Nov is refused for a player: " + JSON.stringify(r.j));
r = await call(B, "/dash/start", {skin: "sleigh"});
ok(r.status === 403 && r.j.opens === "2026-12-01", "sleigh before 1 Dec is refused: " + JSON.stringify(r.j));
r = await call(B, "/dash/start", {skin: "sleigh", code: "wrong-code1"});
ok(r.status === 403, "a wrong code does not open it");
ok((await call(null, "/public/dash/code", {code: "nope"})).status === 403 && (await call(null, "/public/dash/code", {code: CODE})).j.ok === true, "code check: wrong → 403, right → ok");
r = await call("rI", "/dash/start", {skin: "sleigh"});
ok(r.status === 200 && r.j.test === true, "a team wallet may test it (test run)");
r = await call(B, "/dash/start", {skin: "sleigh", code: CODE});
ok(r.status === 200 && r.j.test === true && r.j.theme === "sleigh", "a player with the tester code gets a test run");
{ const sim = loadDash(new URL("../../public/index.html", import.meta.url).pathname).replay(r.j.seed, 480, 110, [], 100000);
  await new Promise(res => setTimeout(res, sim.ticks * 1000 / 60 + 300));
  const e = await call(B, "/dash/end", {id: r.j.id, score: sim.score, ticks: sim.ticks, w: 480, inp: []});
  const bd = await call(B, "/dash/board");
  ok(e.j.ok && e.j.test && e.j.score === sim.score && !bd.j.today.top.length && bd.j.opens.rocket === "2026-11-01" && bd.j.opens.sleigh === "2026-12-01", "the test run is replayed but not booked; board says the opening days " + JSON.stringify(e.j)); }
{ const bd = await call(null, "/public/dash");
  ok(bd.j.advent.grandPrizes.length === 5 && bd.j.advent.grandPrizes.every(g => !g.token && g.rarity), "overall prizes: rarity only"); }
const br = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const p = await br.newPage({viewport: {width: 1000, height: 900}}); const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.route(u => !u.href.startsWith(U), r => r.abort());
await p.goto(U + "/"); await p.evaluate(([t, a]) => localStorage.setItem("ba_session", JSON.stringify({token: t, account: a})), [tok(B), B]);
await p.goto(U + "/dash"); await p.waitForFunction(() => OWNED && OWNED.length && !WALLET.loading && DASH.board, null, {timeout: 30000}); await p.waitForTimeout(300);
ok(await p.evaluate(() => tab) === "dash" && await p.locator('.tabs [data-t="dash"]').count() === 1, "the Dash tab is there, /dash opens it");
ok(await p.locator(".dskins button").count() === 2 && await p.locator(".dskins button.shut").count() === (before ? 2 : 1), "two looks to pick, locked ones marked");
await p.click('[data-dskin="sleigh"]');
ok(await p.locator(".dashhero.locked .dlock").isVisible() && await p.locator("#dashGo").isDisabled() && (await p.locator(".dlock").innerText()).includes("1 Dec"), "sleigh: blurred with a lock, opens 1 Dec, no play");
await p.screenshot({path: S + "/shots/dash-locked-sleigh.png", fullPage: true});
await p.fill("#dashCode", "wrong"); await p.click(".dcode button"); await p.waitForTimeout(500);
ok((await p.locator("#dashCodeMsg").innerText()).includes("Wrong"), "wrong code → message");
await p.fill("#dashCode", CODE); await p.click(".dcode button"); await p.waitForTimeout(600);
ok(await p.locator(".dashhero.locked").count() === 0 && await p.locator(".dtest").isVisible() && await p.locator("#dashGo").isEnabled(), "right code → test mode, PLAY enabled");
await p.screenshot({path: S + "/shots/dash-testmode.png", fullPage: true});
await p.click("#dashGo"); await p.waitForFunction(() => DASH.g && DASH.g.runId && DASH.g.test, null, {timeout: 10000});
ok(true, "a test run starts with a server seed");
await p.evaluate(() => dashQuit()); await p.click("#dashTestOff"); await p.waitForTimeout(300);
ok(await p.locator(".dashhero.locked").count() === 1, "leaving test mode locks it again");
await p.click('[data-dskin="rocket"]');
ok(before ? (await p.locator(".dlock").innerText()).includes("1 Nov") : await p.locator(".dashhero.locked").count() === 0, "rocket: locked until 1 Nov");
await p.setViewportSize({width: 390, height: 844}); await p.screenshot({path: S + "/shots/dash-locked-rocket-phone.png", fullPage: true});
const w = await br.newPage(); await w.route(u => !u.href.startsWith("file:"), r => r.abort());
await w.goto("file://" + new URL("../../website/barkarena/index.html", import.meta.url).pathname); await w.waitForTimeout(500);
ok(before ? await w.locator("#dash").isHidden() && await w.locator("#dashToc").isHidden() : await w.locator("#dash").isVisible(), "website: Dash section hidden until 1 Nov");
await w.goto("file://" + new URL("../../website/barkarena/index.html", import.meta.url).pathname + "?dash=1"); await w.waitForTimeout(500);
ok(await w.locator("#dash").isVisible() && (await w.locator("#dashH").innerText()).includes("Rocket"), "website preview: Rocket Dash leads before December");
ok(errs.length === 0, "no page errors " + errs.join(" | "));
await br.close(); console.log(fails ? fails + " FAILED" : "ALL PASS"); bye(fails ? 1 : 0);
