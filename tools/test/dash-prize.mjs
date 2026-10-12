// Advent Dash prizes end to end: a finished day is frozen, the admin offers a treasury Scrappy (Xaman, mocked),
// the winner sees it in /prizes with its label and accepts it; the piece leaves the treasury list.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHmac } from "node:crypto";
const S = process.argv[2], D = S + "/dataDashPrize", U = "http://127.0.0.1:3973";
fs.rmSync(D, {recursive: true, force: true}); fs.mkdirSync(D, {recursive: true}); fs.writeFileSync(D + "/session.secret", "testsecret");
const tok = a => { const b0 = Buffer.from(JSON.stringify({a, exp: 2e9})).toString("base64url"); return b0 + "." + createHmac("sha256", "testsecret").update(b0).digest("base64url"); };
const acc = n => "rPlayer" + String(n).padStart(21, "0");
const day = k => new Date(Date.now() + k * 864e5).toISOString().slice(0, 10);
const T0 = Date.now() - 2 * 864e5;
fs.writeFileSync(D + "/store.json", JSON.stringify({players: {}, weekly: {}, holdings: {}, profiles: {[acc(1)]: {name: "Dasher"}}, blobs: {
  ["dashday:" + day(-2)]: {[acc(1)]: {best: 2000, runs: 4, at: T0}, [acc(2)]: {best: 900, runs: 1, at: T0 + 1}},
  ["dashday:" + day(-1)]: {[acc(2)]: {best: 1800, runs: 2, at: T0 + 864e5}}}}));
const srv = spawn("node", [new URL("./season-mock.mjs", import.meta.url).pathname], {env: {...process.env, PORT: "3973", DATA_DIR: D, ISSUER: "rI", TAXON: "369", ADMIN_KEY: "adm", XUMM_API_KEY: "k", XUMM_API_SECRET: "s", DASH_ADVENT: day(-2), DASH_DAY_PRIZE: "a Pixel Scrappy"}, stdio: ["ignore", "ignore", "inherit"]});
const bye = c => { try { srv.kill(); } catch (e) {} process.exit(c); };
await new Promise(r => setTimeout(r, 1500));
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + m); };
const get = async (path, who) => (await fetch(U + "/api" + path, {headers: who ? {authorization: "Bearer " + tok(who)} : {}})).json();
const post = async (path, body, who) => (await fetch(U + "/api" + path, {method: "POST", headers: {"content-type": "application/json", ...(who ? {authorization: "Bearer " + tok(who)} : {})}, body: JSON.stringify(body)})).json();
let s = await get("/admin/season?key=adm");
const free0 = s.treasury.map(n => n.nftId);
let d = await get("/admin/dash?key=adm");
const r1 = d.results.find(x => x.key === "dash-" + day(-2));
ok(r1 && r1.winners[0].name === "Dasher" && r1.winners[0].score === 2000, "day 1 frozen, winner Dasher 2000");
ok(d.advent.on && d.advent.n === 3, "season day 3");
const pz = await post("/admin/dash/prize?key=adm", {key: r1.key, place: "1", nftId: free0[0]});
ok(!!pz.uuid, "Xaman offer payload for the day winner");
await get("/admin/xaman?key=adm&uuid=" + pz.uuid);
ok((await post("/admin/dash/prize?key=adm", {key: r1.key, place: "1", nftId: free0[1]})).error === "already_offered", "the same prize can't go out twice");
const mine = (await get("/prizes", acc(1))).prizes;
ok(mine.length === 1 && mine[0].week === r1.key && /Advent Dash day 1/.test(mine[0].label), "winner sees it: " + JSON.stringify(mine[0]));
ok((await get("/prizes", acc(2))).prizes.length === 0, "the runner-up has no prize for day 1");
ok((await post("/prizes/claim", {week: r1.key, place: "1"}, acc(2))).error === "no_prize", "nobody else can claim it");
const c = await post("/prizes/claim", {week: r1.key, place: "1"}, acc(1));
ok(!!c.uuid, "winner gets the accept payload");
const st = await get("/prizes/status?uuid=" + c.uuid, acc(1));
ok(st.state === "signed", "accepted");
ok((await get("/prizes", acc(1))).prizes[0].status === "claimed", "prize claimed");
s = await get("/admin/season?key=adm");
ok(!s.treasury.some(n => n.nftId === free0[0]), "the piece is no longer offered as free treasury");
d = await get("/admin/dash?key=adm");
ok(d.results.find(x => x.key === r1.key).winners[0].status === "claimed", "admin shows it claimed");
// a finished season: the overall top 5, each place with the rarity it's promised (Epic, Rare, Rare, Uncommon, Uncommon)
srv.kill(); await new Promise(r => setTimeout(r, 500));
const D2 = S + "/dataDashGrand"; fs.rmSync(D2, {recursive: true, force: true}); fs.mkdirSync(D2, {recursive: true}); fs.writeFileSync(D2 + "/session.secret", "testsecret");
const blobs = {};
for (let k = 0; k < 24; k++) { const m = {}; for (let n = 1; n <= 7; n++) m[acc(n)] = {best: 100 * n + k, runs: 1, at: k * 1000 + n}; m.rI = {best: 99999, runs: 1, at: 1}; blobs["dashday:" + day(-40 + k)] = m; }
fs.writeFileSync(D2 + "/store.json", JSON.stringify({players: {}, weekly: {}, holdings: {}, profiles: {}, blobs}));
const srv2 = spawn("node", [new URL("./season-mock.mjs", import.meta.url).pathname], {env: {...process.env, PORT: "3973", DATA_DIR: D2, ISSUER: "rI", TAXON: "369", ADMIN_KEY: "adm", XUMM_API_KEY: "k", XUMM_API_SECRET: "s", DASH_ADVENT: day(-40)}, stdio: ["ignore", "ignore", "inherit"]});
await new Promise(r => setTimeout(r, 1500));
d = await get("/admin/dash?key=adm");
const g = d.results.find(x => x.grand);
ok(d.advent.done && g && g.winners.length === 5, "season over: overall top 5 frozen");
ok(g.winners.map(w => w.want).join(",") === "Epic,Rare,Rare,Uncommon,Uncommon", "prizes by place: " + g.winners.map(w => w.place + "=" + w.want).join(" "));
ok(g.winners[0].account === acc(7) && g.winners[4].account === acc(3) && !g.winners.some(w => w.account === "rI"), "ranked by daily bests added up, team skipped: 1st " + g.winners[0].score);
const pub = await get("/public/dash");
ok(pub.advent.grand.join(",") === "Epic,Rare,Rare,Uncommon,Uncommon" && pub.advent.overall.top.length >= 5, "the game and website get the prize list");
srv2.kill();
console.log(fails ? fails + " FAILED" : "ALL PASS");
process.exit(fails ? 1 : 0);
