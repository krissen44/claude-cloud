// Bark Arena TV: a real ranked fight and a Club duel are recorded, then /tv replays them to the same end
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHmac } from "node:crypto";
const S = process.argv[2], D = S + "/dataTV", U = "http://127.0.0.1:3979";
fs.rmSync(D, {recursive:true, force:true}); fs.mkdirSync(D, {recursive:true}); fs.writeFileSync(D + "/session.secret", "testsecret");
const tok = a => { const b0 = Buffer.from(JSON.stringify({a, exp:2e9})).toString("base64url"); return b0 + "." + createHmac("sha256", "testsecret").update(b0).digest("base64url"); };
const A = "rAAAplayer111111111111111111", B = "rBBBplayer222222222222222222";
const srv = spawn("node", [new URL("./season-mock.mjs", import.meta.url).pathname], {env:{...process.env, PORT:"3979", DATA_DIR:D, ISSUER:"rI", TAXON:"369", ADMIN_KEY:"adm"}, stdio:["ignore","ignore","pipe"]});
setTimeout(() => { console.log("TIMEOUT"); srv.kill(); process.exit(1); }, 420000);
await new Promise(r => setTimeout(r, 1300));
const call = async (who, path, body) => { const r = await fetch(U + "/api" + path, {method: body ? "POST" : "GET", headers:{authorization:"Bearer " + tok(who), "content-type":"application/json"}, body: body && JSON.stringify(body)}); return {status: r.status, ...(await r.json())}; };
const ok = (c, m) => console.log((c ? "PASS " : "FAIL ") + m);
await call(A, "/profile", {name: "Alpha"}); await call(B, "/profile", {name: "BarkBoss"});
const br = await chromium.launch({executablePath: process.env.CHROMIUM || undefined, args: ["--autoplay-policy=no-user-gesture-required"]}); const errs = [];
const page = async (opts) => { const p = await br.newPage(opts); p.on("pageerror", e => errs.push(e.message)); p.on("dialog", d => d.accept());
  await p.route(u => !u.href.startsWith(U), rt => rt.abort()); return p; };

// 1. a ranked fight in the browser, moves picked at random
const pa = await page({viewport:{width:900,height:1000}});
await pa.goto(U + "/"); await pa.evaluate(([t, a]) => localStorage.setItem("ba_session", JSON.stringify({token:t, account:a})), [tok(A), A]);
await pa.reload(); await pa.waitForFunction(() => OWNED && !WALLET.loading, null, {timeout:20000}); await pa.waitForTimeout(600);
await pa.locator("[data-f]").first().click(); await pa.waitForSelector(".stage");
for (let i = 0; i < 300 && !(await pa.evaluate(() => over && !busy)); i++){
  const bts = pa.locator("#ctrl:not(.busy) button.act:not([disabled])");
  const n = await bts.count(); if (n) await bts.nth(Math.floor(Math.random() * n)).click().catch(() => {});
  await pa.waitForTimeout(250);
}
const live = await pa.evaluate(() => ({hp: [P.hp, E.hp], turn, v: verdict(), p: P.def.name, e: E.def.name}));
console.log("live ranked fight:", JSON.stringify(live));
await pa.waitForTimeout(800);

// 2. a Club duel over the API
const kA = await call(A, "/me/kennel"), kB = await call(B, "/me/kennel");
const d = (await call(A, "/club/create", {dogId: kA.nfts[0].nft_id, opponent: "BarkBoss"})).duel;
await call(B, "/club/join", {id: d.id, dogId: kB.nfts[1].nft_id});
const mv = ["bite", "guard", "taunt", "bite", "ab0"];
let st;
for (let i = 0; i < 12; i++){
  await call(A, "/club/move", {id: d.id, move: mv[i % 5]}); st = (await call(B, "/club/move", {id: d.id, move: mv[(i + 2) % 5]})).duel;
  if (st.status === "done") break;
}
console.log("club duel:", st.status, JSON.stringify(st.hp), JSON.stringify(st.result));

// 3. playlist + opt-out
let pl = await (await fetch(U + "/api/public/replays?n=10")).json();
ok(pl.total === 2 && pl.replays.some(r => r.kind === "ranked") && pl.replays.some(r => r.kind === "club"), "both fights in the playlist (" + pl.replays.map(r => r.kind).join(",") + ")");
const rk = pl.replays.find(r => r.kind === "ranked");
ok(rk.P.who === "Alpha" && rk.rounds.length >= 1 && rk.rounds.every(r => Array.isArray(r.r) || Number.isInteger(r.seed)), "ranked replay carries name, moves and dice (or the server's seeds)");
await call(B, "/tv", {off: true});
const d2 = (await call(A, "/club/create", {dogId: kA.nfts[0].nft_id, opponent: "BarkBoss"})).duel;
await call(B, "/club/join", {id: d2.id, dogId: kB.nfts[1].nft_id});
for (let i = 0; i < 12; i++){ await call(A, "/club/move", {id: d2.id, move: "bite"}); if ((await call(B, "/club/move", {id: d2.id, move: "taunt"})).duel.status === "done") break; }
ok((await (await fetch(U + "/api/public/replays")).json()).total === 2, "opted-out player's duel is not recorded");
const bad = await call(A, "/replay", {kind: "ranked", P: {def: {}}, E: {def: {}}, rounds: [{a: "rm -rf", b: "bite", r: [1]}]});
ok(bad.status === 400, "malformed replay rejected");
const img = await fetch(U + "/api/public/dogimg?t=2931"); ok(img.ok && /image/.test(img.headers.get("content-type")), "public dog image");

// 4. the TV replays both to exactly the same end
const tv = await page({viewport:{width:800,height:450}, deviceScaleFactor:1.6});
await tv.goto(U + "/tv");
const seen = {};
for (let k = 0; k < 2; k++){
  await tv.waitForSelector(".tvres", {timeout:150000});
  const r = await tv.evaluate(() => ({kind: document.querySelector('.tvtop span').textContent, hp: [P.hp, E.hp], p: P.def.name, e: E.def.name}));
  console.log("tv:", JSON.stringify(r));
  if (/Ranked/.test(r.kind)) seen.ranked = r; if (/Club/.test(r.kind)) seen.club = r;
  if (k === 0) await tv.screenshot({path: S + "/tv-result.png"});
  await tv.waitForSelector(".tvres", {state: "detached", timeout:20000});
  if (k === 0){ await tv.waitForTimeout(4500); await tv.screenshot({path: S + "/tv-fight.png"}); }
}
ok(seen.ranked && JSON.stringify(seen.ranked.hp) === JSON.stringify(live.hp), "TV replay of the ranked fight ends exactly like the live fight " + JSON.stringify(live.hp));
ok(seen.club && JSON.stringify(seen.club.hp) === JSON.stringify([st.hp.a, st.hp.b]), "TV replay of the Club duel ends like the server's duel " + JSON.stringify(st.hp));
// the ladder card comes after a few fights
await tv.evaluate(() => { TV.n = 3; });
await tv.waitForSelector(".tvboard", {timeout:150000}); await tv.screenshot({path: S + "/tv-board.png"});
ok(true, "ladder card shown");
console.log("page errors:", errs.length ? errs : "none");
await br.close(); srv.kill(); process.exit(0);
