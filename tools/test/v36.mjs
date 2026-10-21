// v36 (Sunday package): boss alerts at 50/25 %, Hall of Fame, pack chat, welcome pack, comeback bonus, revenge,
// trait album, boss line in the kennel
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHmac } from "node:crypto";
const S = process.argv[2], D = S + "/dataV36", PORT = 3987, U = "http://127.0.0.1:" + PORT;
fs.rmSync(D, {recursive: true, force: true}); fs.mkdirSync(D + "/saves", {recursive: true}); fs.mkdirSync(S + "/shots", {recursive: true});
fs.writeFileSync(D + "/session.secret", "testsecret");
const tok = a => { const b0 = Buffer.from(JSON.stringify({a, exp: 2e9})).toString("base64url"); return b0 + "." + createHmac("sha256", "testsecret").update(b0).digest("base64url"); };
const ME = "rTutoria1P1ayerXXXXXXXXXXXXXXX", R1 = "rRiva1OneXXXXXXXXXXXXXXXXXXXXX", R2 = "rRiva1TwoXXXXXXXXXXXXXXXXXXXXX";
const wkOf = d => { const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); };
const NOW = wkOf(new Date()), LAST = wkOf(new Date(Date.now() - 7 * 864e5));
const row = (a, wk, xp, wins) => ({account: a, week: wk, xp, wins, losses: 2, streak: 2, pack: null});
const weekly = {}; for (const r of [row(R1, LAST, 600, 20), row(R2, LAST, 500, 15), row(ME, LAST, 400, 10)]) weekly[r.week + "|" + r.account] = r;
fs.writeFileSync(D + "/store.json", JSON.stringify({players: {}, weekly, holdings: {}, profiles: {[ME]: {name: "TutorMe"}, [R1]: {name: "Barkley"}, [R2]: {name: "PixelPaws"}}, blobs: {
  ["boss:" + NOW]: {week: NOW, n: 3, name: "The Revival", max: 4000, hp: 2001, dealt: 1999, by: {[R2]: 1995}, day: {}, down: null, killer: null}}}));
const log = fs.openSync(S + "/v36server.log", "w");
const srv = spawn("node", [new URL("./tut-mock.mjs", import.meta.url).pathname], {env: {...process.env, PORT: String(PORT), DATA_DIR: D, ISSUER: "rI", TAXON: "369",
  ADMIN_KEY: "adm", DISCORD_WEBHOOK: "https://discord.com/api/webhooks/1/general"}, stdio: ["ignore", log, log]});
const bye = c => { try { srv.kill(); } catch (e) {} process.exit(c); };
setTimeout(() => { console.log("TIMEOUT"); bye(1); }, 240000);
process.on("unhandledRejection", e => { console.log("ERR", e && e.stack || e); bye(1); });
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + m); };
await new Promise(r => setTimeout(r, 1800));
const call = async (who, path, body) => { const r = await fetch(U + "/api" + path, {method: body ? "POST" : "GET", headers: {authorization: "Bearer " + tok(who), "content-type": "application/json"}, body: body && JSON.stringify(body)}); return {status: r.status, ...(await r.json())}; };
const adm = async (path, body) => (await fetch(U + "/api" + path + (path.includes("?") ? "&" : "?") + "key=adm", body ? {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)} : {})).json();
const discordLog = () => { try { return fs.readFileSync(D + "/discord.log", "utf8"); } catch (e) { return ""; } };

// boss: a fight takes it below half → one alert (chat + Discord), not twice
const k = (await call(ME, "/me/kennel")).nfts;
const fight = async () => { const st = await call(ME, "/fight/start", {kind: "ranked", dog: k[0].nft_id, opp: {token: 1234 + Math.floor(Math.random() * 999)}, lvl: 1, oppLvl: 1});
  let rr, n = 0; do { rr = await call(ME, "/fight/round", {fid: st.fid, a: "bite", b: "taunt"}); n++; } while (!rr.over && n < 12); return rr; };
await fight(); await fight(); await new Promise(r => setTimeout(r, 800));
console.log("boss", JSON.stringify((({hp, max}) => ({hp, max}))(await (await fetch(U + "/api/public/boss")).json())));
ok((discordLog().match(/HALF health/g) || []).length === 1, "Discord gets the boss-at-half alert once");
ok((await call(ME, "/chat")).msgs.some(m => m.sys && /HALF health/.test(m.text)), "chat announces it too");

// Hall of Fame: last week frozen, podium + proof
await fetch(U + "/api/public/results");
const fame = await (await fetch(U + "/api/public/fame")).json();
const w0 = fame.weeks && fame.weeks[0];
ok(w0 && w0.week === LAST && w0.podium.map(p => p.name).join() === "Barkley,PixelPaws,TutorMe" && w0.sha256.length === 64, "hall of fame: " + JSON.stringify(w0 && w0.podium.map(p => p.name)));

// pack chat: only members read it, the admin sees and deletes it
await call(ME, "/pack", {action: "join", id: "moon"}); await call(R2, "/pack", {action: "join", id: "moon"});
let r = await call(ME, "/chat", {text: "Moon pack, hit the boss tonight!", ch: "pack"});
ok(r.ok, "pack message sent");
ok((await call(R2, "/chat?ch=pack")).msgs.some(m => /Moon pack/.test(m.text)), "a pack mate reads it");
const r1 = await call(R1, "/chat?ch=pack");
ok(r1.pack === null && !r1.msgs.length && !(await call(R1, "/chat")).msgs.some(m => /Moon pack/.test(m.text)), "others see nothing (no pack, not in the main room)");
ok((await call(R1, "/chat", {text: "hi", ch: "pack"})).error === "no_pack", "no pack → no pack channel");
let ac = await adm("/admin/chat");
const pm = (ac.packs.moon || [])[0];
ok(pm && /Moon pack/.test(pm.text), "admin sees the pack message");
ac = await adm("/admin/chat/del", {id: pm.id, ch: "moon"});
ok(!(ac.packs.moon || []).length, "admin deletes it");

// the page: welcome pack, album, boss line, comeback, revenge
const br = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const p = await br.newPage({viewport: {width: 1280, height: 900}}); const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.addInitScript(() => localStorage.setItem("ba_fold", JSON.stringify({album: true})));
await p.route(u => !u.href.startsWith(U), r => r.abort());
const NEWB = ME;
await p.goto(U + "/"); await p.evaluate(([t, a]) => localStorage.setItem("ba_session", JSON.stringify({token: t, account: a})), [tok(NEWB), NEWB]);
await p.goto(U + "/"); await p.waitForFunction(() => OWNED && OWNED.length >= 2 && !WALLET.loading, null, {timeout: 30000});
await p.waitForTimeout(1500);
ok(await p.locator(".welcome").count() === 1, "a new player sees the welcome pack");
ok(await p.locator("#bossMini").count() === 1, "boss line in the kennel");
const g = await p.evaluate(() => { const f = OWNED.find(x => !x.legendary && x.traits.length); const before = SAVE.dog(f.id).xp + SAVE.dog(f.id).lvl * 1000;
  const r = SAVE.award(f.id, true, 30, true); return {r, n: Object.keys(SAVE.data.album).length, traits: f.traits.length}; });
ok(g.r.welcome === 30, "welcome pack doubles bond XP (+30 extra)");
ok(g.r.album && g.r.album.n === g.traits && g.n === g.traits, `album took the dog's ${g.traits} traits`);
const pay = await p.evaluate(async () => { WALLET.name = "Newbie"; SAVE.data.fights = 3; SAVE.data.pack = "bone"; const t = SAVE.data.tickets; menu(); return [SAVE.data.tickets - t, !!SAVE.data.welcome.paid]; });
ok(pay[0] === 3 && pay[1], "checklist done → +3 ranked fights " + JSON.stringify(pay));
const set = await p.evaluate(() => { const l = 'ground_item'; const all = DATA.traits.filter(x => x.layer === l);
  all.slice(1).forEach(x => SAVE.data.album[x.id] = '2026-01-01'); const f = OWNED.find(x => !x.legendary); f.traits = [...f.traits, all[0].id];
  const t = SAVE.data.tickets; const r = SAVE.award(f.id, false, 12, true); return [r.album && r.album.sets, SAVE.data.tickets - t]; });
ok(set[0] && set[0].includes("Ground item") && set[1] === 2, "a full layer pays +2 ranked fights " + JSON.stringify(set));
await p.evaluate(() => menu()); await p.waitForTimeout(400);
await p.screenshot({path: S + "/shots/v36-kennel.png", fullPage: true});
const back = await p.evaluate(() => { SAVE.data.lastFight = Date.now() - 8 * 864e5; const t = SAVE.data.tickets; welcomeCheck(); const a = SAVE.data.tickets - t; welcomeCheck(); return [a, SAVE.data.tickets - t, !!WALLET.comebackNote]; });
ok(back[0] === 5 && back[1] === 5 && back[2], "comeback after 8 days: +5 once " + JSON.stringify(back));
// revenge after a ranked loss: same rival
const rv = await p.evaluate(async () => { const a = OWNED[0], b = DATA.fighters[3]; SAVE.data.tickets = 5; startFight(a, b, true, 1);
  over = true; P.hp = 1; E.hp = 20; renderControls(); const btn = document.getElementById('revenge'); if (!btn) return null; btn.click(); return [E.def.name === b.name, SAVE.data.tickets]; });
ok(rv && rv[0] && rv[1] === 4, "revenge button: same rival, costs a ticket " + JSON.stringify(rv));
ok(!errs.length, "no page errors " + errs.join(" | "));
await br.close(); console.log(fails ? fails + " FAILED" : "ALL PASS"); bye(fails ? 1 : 0);
