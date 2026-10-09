// v32: server-refereed fights (fair play), bond paths, weekly boss, achievements, invites, starter dogs, Discord
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHmac } from "node:crypto";
const S = process.argv[2], D = S + "/dataV32", PORT = 3981, U = "http://127.0.0.1:" + PORT;
fs.rmSync(D, {recursive: true, force: true}); fs.mkdirSync(D, {recursive: true}); fs.writeFileSync(D + "/session.secret", "testsecret");
const tok = a => { const b0 = Buffer.from(JSON.stringify({a, exp: 2e9})).toString("base64url"); return b0 + "." + createHmac("sha256", "testsecret").update(b0).digest("base64url"); };
const ME = "rTutoria1P1ayerXXXXXXXXXXXXXXX", R1 = "rRiva1OneXXXXXXXXXXXXXXXXXXXXX", R2 = "rRiva1TwoXXXXXXXXXXXXXXXXXXXXX";
const NEW = "rNewbieNoDogXXXXXXXXXXXXXXXXX", FRIEND = "rFriendWithDogXXXXXXXXXXXXXXXX";
const wkOf = d => { const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); };
const NOW = wkOf(new Date()), LAST = wkOf(new Date(Date.now() - 7 * 864e5));
// last week: a starter-only trainer on top (no prize for them), this week's boss nearly down
const row = (a, wk, xp, wins) => ({account: a, week: wk, xp, wins, losses: 2, streak: 2, pack: null});
const weekly = {}; for (const r of [row(NEW, LAST, 900, 30), row(R1, LAST, 600, 20), row(R2, LAST, 500, 15), row(ME, LAST, 400, 10)]) weekly[r.week + "|" + r.account] = r;
const lastStart = Date.parse(LAST + "T00:00:00Z") + 864e5;
fs.writeFileSync(D + "/store.json", JSON.stringify({players: {}, weekly, holdings: {}, profiles: {}, blobs: {
  starters: {[NEW]: {dog: {id: "T4101", uri: "ipfs://bafyX/4101.json", t: 4101}, start: lastStart, end: lastStart + 7 * 864e5}},
  ["boss:" + NOW]: {week: NOW, n: 3, name: "The Revival", max: 4000, hp: 3, dealt: 3997, by: {[R2]: 3975}, day: {}, down: null, killer: null}}}));
const log = fs.openSync(S + "/v32server.log", "w");
const srv = spawn("node", [new URL("./tut-mock.mjs", import.meta.url).pathname], {env: {...process.env, PORT: String(PORT), DATA_DIR: D, ISSUER: "rI", TAXON: "369",
  ADMIN_KEY: "adm", FAIR_SINCE: "2026-01-05", DISCORD_WEBHOOK: "https://discord.com/api/webhooks/1/test"}, stdio: ["ignore", log, log]});
const bye = c => { try { srv.kill(); } catch (e) {} process.exit(c); };
setTimeout(() => { console.log("TIMEOUT"); bye(1); }, 600000);
process.on("unhandledRejection", e => { console.log("ERR", e && e.stack || e); bye(1); });
await new Promise(r => setTimeout(r, 1800));
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + m); };
const call = async (who, path, body) => {
  for (let i = 0; ; i++) {
    try { const r = await fetch(U + "/api" + path, {method: body ? "POST" : "GET", headers: {authorization: "Bearer " + tok(who), "content-type": "application/json"}, body: body && JSON.stringify(body)});
      return {status: r.status, ...(await r.json())}; }
    catch (e) { if (i > 4) throw e; await new Promise(r => setTimeout(r, 300)); }
  }
};
const adm = async (path, body) => (await fetch(U + "/api" + path + (path.includes("?") ? "&" : "?") + "key=adm", body ? {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)} : {})).json();
const discordLog = () => { try { return fs.readFileSync(D + "/discord.log", "utf8"); } catch (e) { return ""; } };
const fight = async (who, dogId, opp, moves) => {
  const st = await call(who, "/fight/start", {kind: "ranked", dog: dogId, opp: opp || {token: 1234}, lvl: 1, oppLvl: 1});
  if (!st.fid) return {st};
  let rr, n = 0;
  do { rr = await call(who, "/fight/round", {fid: st.fid, a: (moves || ["bite", "taunt", "guard"])[n % 3], b: "taunt"}); n++; } while (!rr.over && n < 12);
  return {st, rr};
};

// ---------------------------------------------------------------- the referee
const k = (await call(ME, "/me/kennel")).nfts;
for (const [a, n] of [[R1, "Barkley"], [R2, "PixelPaws"], [FRIEND, "Buddy"]]) { await call(a, "/me/kennel"); await call(a, "/profile", {name: n}); }
await call(ME, "/profile", {name: "TutorMe"});
const dog = k[0];
const f1 = await fight(ME, dog.nft_id);
ok(f1.st.fid && f1.st.hp.P > 0, "ranked fight opens on the server (" + JSON.stringify(f1.st.hp) + ")");
ok(f1.rr.over && ["YOU WIN", "YOU LOSE", "DRAW"].includes(f1.rr.verdict), "the server ends the fight: " + f1.rr.verdict);
ok(f1.rr.boss && f1.rr.boss.fell, "that fight brought the nearly-dead boss down");
const bad = await call(ME, "/fight/start", {kind: "ranked", dog: "000800009999", opp: {token: 1234}, lvl: 1});
ok(bad.error === "not_your_dog", "someone else's dog is refused");
const badOpp = await call(ME, "/fight/start", {kind: "ranked", dog: dog.nft_id, opp: {token: 99999}, lvl: 1});
ok(badOpp.error === "bad_rival", "a made-up rival is refused");
await call(ME, "/stats", {wins: 40, xp: 5000, streak: 30, losses: 0});
const m2 = (await adm("/admin/fair")).players.find(p => p.account === ME);
ok(m2 && m2.xp <= m2.vxp + 60 && m2.wins <= m2.vwins + 2, `claimed 5000 XP is capped to the verified ${m2 && m2.vxp} (+60) → ${m2 && m2.xp}`);
ok(m2 && m2.flag === "posted more than verified", "admin sees the flag: " + (m2 && m2.flag));
const gh = await call(ME, "/fight/ghost", {squad: [{id: dog.nft_id, lvl: 1}], opps: [{token: 300, lvl: 1}, {token: 301, lvl: 2}, {legendary: 4, lvl: 3}]});
ok(Array.isArray(gh.lines) && gh.lines.length >= 1, "ghost tournament runs on the server: won " + gh.won);

// ---------------------------------------------------------------- boss down
await new Promise(r => setTimeout(r, 300));
const boss = await (await fetch(U + "/api/public/boss")).json();
ok(boss.down && boss.killer === "TutorMe", `boss is down, final blow by ${boss.killer}`);
const bR2 = await call(R2, "/bonus");
ok(bR2.n === 3, "everyone who hit the boss gets +3 ranked fights (R2: " + bR2.n + ")");
ok(/weekly boss is down/i.test(discordLog()), "Discord got the boss post");
const chat = await call(R1, "/chat?since=0");
ok(chat.msgs.some(m => m.sys && /boss .* is DOWN/.test(m.text)), "chat announces the fallen boss");
const achMe = await call(ME, "/ach");
ok(achMe.ach && achMe.ach.bossfall, "final blow badge from the server");

// ---------------------------------------------------------------- achievements
const ap = await call(R1, "/ach", {ids: ["first", "podium", "nonsense"]});
ok(ap.ach.first && !ap.ach.podium && !ap.ach.nonsense, "page can report badges, not the server-only ones");
const lad = await call(ME, "/ladder");
ok((lad.xp || []).some(x => x.ach >= 1), "ladder rows carry the badge count");

// ---------------------------------------------------------------- starter dog
const ln = await call(NEW, "/lend");
// NEW had a starter last week (seeded): it has ended → no new one, "went home"
ok(ln.starter && ln.starter.had && !ln.starter.active && !(ln.in || []).length, "a used-up starter dog is not handed out again");
const NEW2 = "rSecondNewbieXXXXXXXXXXXXXXXXX";
const l2 = await call(NEW2, "/lend");
const sd = (l2.in || []).find(x => x.starter);
ok(sd && sd.dog && sd.dog.t > 20 && sd.ownerName === "the Scrappy team", "a new player without a dog gets a treasury starter (#" + (sd && sd.dog.t) + ")");
const fs1 = await fight(NEW2, sd.dog.id);
ok(fs1.rr && fs1.rr.over, "the starter dog fights refereed fights");

// ---------------------------------------------------------------- week close: prizes skip starter-only players, Discord post
const season = await adm("/admin/season");
const wk = season.weeks.find(w => w.week === LAST);
ok(wk && !wk.prizes.some(p => p.account === NEW) && wk.prizes[0].account === R1, "last week's prizes skip the starter-only trainer (1st: " + (wk && wk.prizes[0].name) + ")");
ok(/week of .* is final/i.test(discordLog()), "Discord got the week results");

// ---------------------------------------------------------------- invites
let rf = await call(FRIEND, "/ref", {name: "barkley"});
ok(rf.ok && rf.by === "Barkley", "a new player links up with the friend who invited them");
rf = await call(ME, "/ref", {name: "Barkley"});
ok(rf.error === "not_new", "players who already fought can't be 'invited'");
const fk = (await call(FRIEND, "/me/kennel")).nfts;
for (let i = 0; i < 5; i++) await fight(FRIEND, fk[0].nft_id);
await call(FRIEND, "/stats", {wins: 5, losses: 0, xp: 150, streak: 5});
const bR1 = await call(R1, "/bonus"), bF = await call(FRIEND, "/bonus");
ok(bR1.n === 3 && bF.n === 3, `after 5 fights with their own dog both get +3 (inviter ${bR1.n}, friend ${bF.n})`);
const info = await call(R1, "/ref");
ok(info.invited === 1 && info.joined === 1, "inviter sees 1 invited, 1 joined");
ok((await call(R1, "/ach")).ach.recruiter, "Recruiter badge for the inviter");

// ---------------------------------------------------------------- Discord: open Club challenge
const kR1 = (await call(R1, "/me/kennel")).nfts;
await call(R1, "/club/create", {dogId: kR1[0].nft_id, open: true});
ok(/Open Fight Club challenge/.test(discordLog()), "Discord got the open Club challenge");

// ---------------------------------------------------------------- Discord: highlights + clip of the day
const def = (t, rarity, leg) => ({id: "x" + t, token: t, name: "Pixel Scrappy #" + t, rarity, legendary: leg || null, traits: []});
const rp = await call(R1, "/replay", {kind: "ranked", P: {def: def(3101, "Common"), lvl: 2}, E: {def: def(8, "Legendary", "8"), lvl: 2},
  rounds: [{a: "bite", b: "taunt", r: [1, 2, 3]}], result: "W"});
ok(rp.kept, "replay kept");
ok(/Upset!.*Barkley's Common #3101 beat a Legendary #8 \*To The Moon\*[\s\S]*clip\?id=/.test(discordLog()), "Discord gets the upset with a watch link");
const day = new Date().toISOString().slice(0, 10), up = async (n, body) => (await fetch(U + "/api/admin/clips/upload?key=adm&name=" + n, {method: "PUT", body})).json();
await up(day + "-1.mp4", Buffer.alloc(200000, 1)); await up(day + "-1-tt.mp4", Buffer.alloc(100000, 1));
await up(day + "-1.json", JSON.stringify({hook: "Common beats a Legendary ⚡", line: "Barkley's #3101 took down #8", question: "Who's next?"}));
await new Promise(r => setTimeout(r, 500));
ok(/Fight of the day:\*\* Common beats a Legendary[\s\S]*\[file bark-arena-\d{4}-\d{2}-\d{2}-1\.mp4 200000 bytes\]/.test(discordLog()), "the clip of the day goes to Discord as a video");
await up(day + "-2.mp4", Buffer.alloc(1000, 1)); await up(day + "-2.json", JSON.stringify({hook: "second"}));
await new Promise(r => setTimeout(r, 300));
ok(!/Fight of the day:\*\* second/.test(discordLog()), "only one clip a day");

// ---------------------------------------------------------------- browser
const br = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const ctx = await br.newContext({viewport: {width: 1100, height: 900}});
const p = await ctx.newPage(); const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.route(u => !u.href.startsWith("http://127.0.0.1"), r => r.abort());
// the admin page's script compiles and shows the fair-play card
await p.goto(U + "/admin?key=adm"); await p.waitForTimeout(2500);
ok(await p.locator("#fair table").count() === 1, "admin: fair-play table renders");
await p.goto(U + "/?ref=Barkley");
await p.evaluate(([t, a]) => localStorage.setItem("ba_session", JSON.stringify({token: t, account: a})), [tok(ME), ME]);
await p.goto(U + "/"); await p.waitForFunction(() => typeof OWNED !== "undefined" && OWNED && OWNED.length >= 4 && !WALLET.loading, null, {timeout: 60000});
await p.waitForTimeout(1500);
ok(await p.evaluate(() => lsGet('ba_ref') === 'Barkley'), "?ref= is remembered");
ok(await p.locator("summary", {hasText: "ACHIEVEMENTS"}).count() === 1, "achievements card in the kennel");
ok(await p.locator("#refLink").count() === 1, "invite card with the link");
ok(await p.evaluate(() => achHave('bossfall')), "server badge (final blow) shows in the page");
// bond path
await p.evaluate(() => { const id = OWNED[0].id; SAVE.dog(id).lvl = 4; SAVE.save(); menu(); });
ok(await p.locator("[data-path]").count() === 2, "bond path card shows two choices at bond 4");
await p.click('[data-path$="|4|b"]');
ok(await p.evaluate(() => SAVE.dog(OWNED[0].id).path[4] === "b"), "path b chosen");
await p.click(".pick > button:first-child");
await p.waitForFunction(() => document.querySelector("#ctrl .acts"), null, {timeout: 15000});
await p.waitForFunction(() => !VF.wait, null, {timeout: 10000});
ok(await p.evaluate(() => VF.on && !!VF.fid), "page fight is refereed (VF on)");
ok(await p.evaluate(() => P.snap === true), "path b → Iron Guard active in the fight (server built the same dog)");
for (let i = 0; i < 12; i++) {
  if (await p.evaluate(() => over)) break;
  await p.waitForFunction(() => !busy && !VF.busy, null, {timeout: 20000});
  if (await p.evaluate(() => over)) break;
  await p.click(`#ctrl [data-a="${["bite", "taunt", "guard"][i % 3]}"]`);
  await p.waitForTimeout(150);
}
await p.waitForFunction(() => over && !busy, null, {timeout: 30000});
await p.waitForTimeout(800);
const m3 = (await adm("/admin/fair")).players.find(x => x.account === ME);
ok(m3 && m3.desync === 0, "no desync between page and server (" + JSON.stringify(m3 && {fights: m3.fights, desync: m3.desync}) + ")");
// arena: boss card + ghost run on the server
await p.evaluate(() => { arenaRun = null; tab = "arena"; SAVE.data.arena.squad = OWNED.slice(0, 2).map(f => f.id); SAVE.signUp(false); menu(); bossLoad(true); });
await p.waitForTimeout(1500);
ok(await p.locator("#bossCard").count() === 1, "boss card in the arena tab");
const g0 = (await adm("/admin/fair")).players.find(x => x.account === ME);
await p.click("#runArena"); await p.waitForTimeout(2500);
const g1 = (await adm("/admin/fair")).players.find(x => x.account === ME);
ok(g1.ghosts === g0.ghosts + 1, "the page's ghost tournament ran on the server");
// a live arena fight
await p.evaluate(() => { SAVE.signUp(true); menu(); });
await p.click("#runArena");
await p.waitForFunction(() => document.querySelector("#ctrl .acts") && arenaRun, null, {timeout: 15000});
await p.waitForFunction(() => !VF.wait, null, {timeout: 10000});
ok(await p.evaluate(() => VF.on), "live arena fight is refereed");
for (let i = 0; i < 12; i++) {
  if (await p.evaluate(() => over)) break;
  await p.waitForFunction(() => !busy && !VF.busy, null, {timeout: 20000});
  if (await p.evaluate(() => over)) break;
  await p.click(`#ctrl [data-a="${["bite", "guard", "taunt"][i % 3]}"]`);
  await p.waitForTimeout(150);
}
await p.waitForFunction(() => over && !busy, null, {timeout: 30000});
await p.waitForTimeout(600);
const g2 = (await adm("/admin/fair")).players.find(x => x.account === ME);
ok(g2.desync === 0 && g2.fights === g1.fights + 1, "arena fight booked, still no desync");
// achievements toast after a win: force-check
await p.evaluate(() => { SAVE.data.best = 5; achScan(); });
ok(await p.locator("#achToast > div").count() >= 1, "achievement toast shows");
console.log("  errors:", errs);
ok(!errs.length, "no page errors");
await br.close();
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
bye(fails ? 1 : 0);
