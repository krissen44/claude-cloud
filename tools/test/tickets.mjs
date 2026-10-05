// Daily tickets: a new holder gets the starting 5 + the full grant for all dogs; nobody gets a grant twice
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHmac } from "node:crypto";
const S = process.argv[2], D = S + "/dataTix", U = "http://127.0.0.1:3984";
fs.rmSync(D, {recursive:true, force:true}); fs.mkdirSync(D + "/saves", {recursive:true}); fs.writeFileSync(D + "/session.secret", "testsecret");
// an old player (played since week 1) and his save — must not show up in the bonus scan
const OLD = "rVETplayer11111111111111111111";
fs.writeFileSync(D + "/store.json", JSON.stringify({players: {}, holdings: {[OLD]: {tokens: [1, 2, 3], dogs: [], updated: 1}},
  weekly: {["2026-09-21|" + OLD]: {account: OLD, week: "2026-09-21", wins: 3, losses: 1, xp: 100, streak: 1}}, profiles: {}}));
fs.writeFileSync(D + "/saves/" + OLD + ".json", JSON.stringify({data: {v: 1}, updated: 1}));
const tok = a => { const b0 = Buffer.from(JSON.stringify({a, exp:2e9})).toString("base64url"); return b0 + "." + createHmac("sha256", "testsecret").update(b0).digest("base64url"); };
const srv = spawn("node", [new URL("./live.mjs", import.meta.url).pathname], {env:{...process.env, PORT:"3984", DATA_DIR:D, ISSUER:"rI", TAXON:"369", ADMIN_KEY:"adm"}, stdio:"ignore"});
setTimeout(() => { console.log("TIMEOUT"); srv.kill(); process.exit(1); }, 120000);
await new Promise(r => setTimeout(r, 1200));
const ok = (c, m) => console.log((c ? "PASS " : "FAIL ") + m);
const br = await chromium.launch({executablePath: process.env.CHROMIUM || undefined}); const errs = [];
const today = new Date().toISOString().slice(0, 10);
async function open(acct, save){
  const p = await br.newPage(); p.on("pageerror", e => errs.push(e.message));
  await p.route(u => !u.href.startsWith(U), r => r.abort());
  await p.goto(U + "/");
  await p.evaluate(([t, a, s]) => { localStorage.clear(); localStorage.setItem("ba_session", JSON.stringify({token:t, account:a}));
    if (s) localStorage.setItem("ba_save_v1:" + a, JSON.stringify(s)); }, [tok(acct), acct, save]);
  await p.reload(); await p.waitForFunction(() => OWNED && !WALLET.loading, null, {timeout:20000}); await p.waitForTimeout(500);
  return p;
}
const tix = p => p.evaluate(() => ({t: SAVE.data.tickets, grant: SAVE.grant()}));
// 1. brand-new holder of 3 dogs: 5 starting + 5 + 1 per extra dog (2) = 12
let p = await open("rNEWplayer11111111111111111111");
let r = await tix(p); ok(r.t === 12 && r.grant === 7, `new holder of 3 dogs: ${r.t} tickets, grant ${r.grant} (want 12 / 7)`);
// reload: no second top-up
await p.reload(); await p.waitForFunction(() => OWNED && !WALLET.loading, null, {timeout:20000}); await p.waitForTimeout(500);
r = await tix(p); ok(r.t === 12, `after a reload still ${r.t}`);
// 2. a player hit by the bug: today's grant was counted with 1 dog, 4 tickets left → topped up by 2
const base = {v:1, dogs:{N2931:{xp:22,lvl:1,w:0,l:1}}, trainerXp:11, streak:0, best:0, day:today, quests:[], fights:1, tickets:4, pack:null, pending:null,
  week: (d => { const t = new Date(d); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); })(Date.now()),
  wk:{wins:0,losses:1,xp:11,streak:0}, lastWk:{wins:0,xp:0,streak:0}, arena:{squad:[],signed:'',best:0,runs:0,last:null}, club:{w:0,l:0,d:0,dog:null}, today:null};
p = await open("rBUGplayer11111111111111111111", base);
r = await tix(p); ok(r.t === 6, `bugged player: ${r.t} tickets (want 4 + 2 = 6)`);
// 3. an existing player whose dogs were all known: nothing extra
p = await open("rOLDplayer11111111111111111111", {...base, dogs:{N2931:{xp:0,lvl:1,w:0,l:0}, N4344:{xp:0,lvl:1,w:0,l:0}, N3821:{xp:0,lvl:1,w:0,l:0}}, tickets:7});
r = await tix(p); ok(r.t === 7, `regular player: ${r.t} tickets (want 7, unchanged)`);
// --- bonus for the players hit by the day-one bug
await new Promise(r => setTimeout(r, 4000));                  // cloud saves of the new players land on the server
const adm = (p, b) => fetch(U + "/api/admin/" + p + (p.includes("?") ? "&" : "?") + "key=adm", b ? {method: "POST", body: JSON.stringify(b)} : {}).then(r => r.json());
const scan = await adm("tickets/scan?since=2026-09-28");
console.log("scan:", scan.players.map(x => x.name + " held " + x.held + " → " + x.missed).join(" · "));
ok(!scan.players.some(x => x.account === OLD) && scan.players.some(x => x.account === "rNEWplayer11111111111111111111"), "scan lists new holders, not old players");
const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
let g = await adm("tickets/grant", {grants: [{account: "rBUGplayer11111111111111111111", n: 7}], from: today});
ok(g.granted === 1, "granted (from today, for the test)");
g = await adm("tickets/grant", {grants: [{account: "rOLDplayer11111111111111111111", n: 5}]});
ok(g.from === tomorrow, "default start is tomorrow (" + g.from + ")");
p = await open("rBUGplayer11111111111111111111", {...base, tickets: 6, grantDay: {day: today, n: 7}});
await p.waitForFunction(() => WALLET.bonusNote, null, {timeout: 8000}).catch(() => {});
r = await tix(p); const note = await p.evaluate(() => WALLET.bonusNote);
ok(r.t === 13 && /\+7 ranked fights/.test(note || ""), `bonus collected: ${r.t} tickets, note "${note}"`);
await p.screenshot({path: S + "/bonus-note.png"});
await p.reload(); await p.waitForFunction(() => OWNED && !WALLET.loading, null, {timeout:20000}); await p.waitForTimeout(1500);
r = await tix(p); ok(r.t === 13, `collected only once (${r.t})`);
p = await open("rOLDplayer11111111111111111111", {...base, dogs:{N2931:{xp:0,lvl:1,w:0,l:0}, N4344:{xp:0,lvl:1,w:0,l:0}, N3821:{xp:0,lvl:1,w:0,l:0}}, tickets:7, grantDay: {day: today, n: 7}});
await p.waitForTimeout(1500); r = await tix(p); ok(r.t === 7, `a bonus from tomorrow is not paid today (${r.t})`);
console.log("page errors:", errs.length ? errs : "none");
await br.close(); srv.kill(); process.exit(0);
