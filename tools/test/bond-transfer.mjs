// The bond travels with the NFT: a dog trained in wallet A and sent to wallet B shows up in B's kennel with A's bond
// level, XP, record and bond paths — also for dogs that changed hands before the registry existed (found in old saves).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHmac } from "node:crypto";
const S = process.argv[2], D = S + "/dataBond", PORT = 3989, U = "http://127.0.0.1:" + PORT, HF = S + "/hold.json";
fs.rmSync(D, {recursive: true, force: true}); fs.mkdirSync(D + "/saves", {recursive: true}); fs.mkdirSync(S + "/shots", {recursive: true});
fs.writeFileSync(D + "/session.secret", "testsecret");
const tok = a => { const b0 = Buffer.from(JSON.stringify({a, exp: 2e9})).toString("base64url"); return b0 + "." + createHmac("sha256", "testsecret").update(b0).digest("base64url"); };
const A = "rBondSellerXXXXXXXXXXXXXXXXXXX", B = "rBondBuyerXXXXXXXXXXXXXXXXXXXX", OLD = "rBondOldOwnerXXXXXXXXXXXXXXXXX";
const id = t => "000800" + String(t).padStart(6, "0");
const hold = h => fs.writeFileSync(HF, JSON.stringify(h));
hold({[A]: [3615, 3616], [B]: [3700], [OLD]: []});
// a dog that changed hands before the registry existed: its old owner's save still has the training
fs.writeFileSync(D + "/saves/" + OLD + ".json", JSON.stringify({data: {v: 1, dogs: {[id(3800)]: {lvl: 4, xp: 30, w: 12, l: 5}}}, updated: Date.now() - 864e5}));
const log = fs.openSync(S + "/bondserver.log", "w");
const srv = spawn("node", [new URL("./tut-mock.mjs", import.meta.url).pathname], {env: {...process.env, PORT: String(PORT), DATA_DIR: D, ISSUER: "rI", TAXON: "369", HOLD_FILE: HF}, stdio: ["ignore", log, log]});
const bye = c => { try { srv.kill(); } catch (e) {} process.exit(c); };
setTimeout(() => { console.log("TIMEOUT"); bye(1); }, 180000);
process.on("unhandledRejection", e => { console.log("ERR", e && e.stack || e); bye(1); });
process.on("uncaughtException", e => { console.log("ERR", e && e.stack || e); bye(1); });
await new Promise(r => setTimeout(r, 1800));
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + m); };
const call = async (who, path, body) => { const r = await fetch(U + "/api" + path, {method: body ? "POST" : "GET", headers: {authorization: "Bearer " + tok(who), "content-type": "application/json"}, body: body && JSON.stringify(body)}); return {status: r.status, ...(await r.json())}; };
// A trains #3615 to bond 6 (a cloud save), then sends it to B
await call(A, "/me/kennel?fresh=1");
await call(A, "/save", {data: {v: 1, dogs: {[id(3615)]: {lvl: 6, xp: 40, w: 30, l: 8, path: {4: "b", 8: "a"}}, [id(3616)]: {lvl: 2, xp: 5, w: 3, l: 1}}}});
let k = await call(A, "/me/kennel?fresh=1");
ok(!k.carry, "the trainer gets nothing carried (it's their own training)");
hold({[A]: [3616], [B]: [3700, 3615, 3800], [OLD]: []});
k = await call(B, "/me/kennel?fresh=1");
ok(k.carry && k.carry[id(3615)] && k.carry[id(3615)].lvl === 6 && k.carry[id(3615)].xp === 40 && k.carry[id(3615)].path[4] === "b", "B's kennel carries #3615 at bond 6 (+XP, record, paths): " + JSON.stringify(k.carry && k.carry[id(3615)]));
ok(k.carry && k.carry[id(3800)] && k.carry[id(3800)].lvl === 4, "a dog that changed hands before the update: found in the old owner's save (bond 4)");
ok(!k.carry[id(3700)], "B's own untrained dog has nothing to carry");
// a fresh save from B (before adopting) must not erase the carried bond
await call(B, "/save", {data: {v: 1, dogs: {[id(3615)]: {lvl: 1, xp: 0, w: 0, l: 0}}}});
k = await call(B, "/me/kennel?fresh=1");
ok(k.carry && k.carry[id(3615)] && k.carry[id(3615)].lvl === 6, "a fresh bond-1 save from the new holder doesn't wipe the carried bond");
// A's old save can't overwrite it any more (A no longer holds the dog)
await call(A, "/save", {data: {v: 1, dogs: {[id(3615)]: {lvl: 9, xp: 0, w: 0, l: 0}}}});
k = await call(B, "/me/kennel?fresh=1");
ok(k.carry[id(3615)].lvl === 6, "the old owner can't change a dog they no longer hold");
// in the browser: B signs in and sees bond 6 + a note
const br = await chromium.launch({executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"});
const p = await (await br.newContext({viewport: {width: 1000, height: 900}})).newPage();
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.route(u => !u.href.startsWith("http://127.0.0.1"), r => r.abort());
await p.goto(U + "/"); await p.evaluate(([t, a]) => localStorage.setItem("ba_session", JSON.stringify({token: t, account: a})), [tok(B), B]);
await p.goto(U + "/"); await p.waitForFunction(() => OWNED && OWNED.length >= 3 && !WALLET.loading, null, {timeout: 30000});
await p.waitForTimeout(500);
const v = await p.evaluate(ids => ids.map(i => SAVE.dog(i)), [id(3615), id(3800), id(3700)]);
ok(v[0].lvl === 6 && v[0].xp === 40 && v[0].w === 30 && v[0].path && v[0].path[4] === "b", "B's game adopts bond 6, XP, record and bond path for #3615");
ok(v[1].lvl === 4 && v[2].lvl === 1, "#3800 bond 4 from the old save, #3700 stays bond 1");
ok(await p.locator("text=Bond carried over").count() === 1, "a note tells B the training came along");
await p.screenshot({path: S + "/shots/bond-carry.png", fullPage: true});
// the adopted bond is saved to B's cloud save and becomes B's record in the registry
await p.waitForTimeout(4500);
k = await call(B, "/me/kennel?fresh=1");
ok(!k.carry || !k.carry[id(3615)], "after B saved, the dog's training is B's (nothing left to carry)");
const reg = JSON.parse(fs.readFileSync(D + "/store.json", "utf8")).blobs.bonds;
ok(reg[id(3615)].by === B && reg[id(3615)].lvl === 6, "registry: #3615 bond 6, trained by B now");
ok(errs.length === 0, "no page errors " + errs.join(" | "));
await br.close();
console.log(fails ? fails + " FAILED" : "ALL PASS");
bye(fails ? 1 : 0);
