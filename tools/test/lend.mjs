import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHmac } from "node:crypto";
const S = process.argv[2], D = S + "/dataLend", U = "http://127.0.0.1:3974";
fs.rmSync(D, {recursive:true, force:true}); fs.mkdirSync(D, {recursive:true}); fs.writeFileSync(D + "/session.secret", "testsecret");
const tok = a => { const b0 = Buffer.from(JSON.stringify({a, exp:2e9})).toString("base64url"); return b0 + "." + createHmac("sha256", "testsecret").update(b0).digest("base64url"); };
const A = "rOwnerAAAAAAAAAAAAAAAAAAAAA1", B = "rNoHolderBBBBBBBBBBBBBBBBBB2", C = "rNoHolderCCCCCCCCCCCCCCCCCC3", H = "rHolderHHHHHHHHHHHHHHHHHHHH4";
const wkOf = d => { const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); };
const LAST = wkOf(new Date(Date.now() - 7 * 864e5));
// last week: C won XP mostly with a dog borrowed from H → H should get a lender share line
const weekly = {[LAST + "|" + C]: {account: C, week: LAST, xp: 500, wins: 12, losses: 3, streak: 4, pack: null}};
const loans = {old1: {id: "old1", owner: H, borrower: C, dog: {id: "N4344", uri: "ipfs://bafyX/4344.json", t: 4344}, start: 0, end: Date.now() - 864e5, ended: Date.now() - 864e5, xp: {[LAST]: 400}}};
fs.writeFileSync(D + "/store.json", JSON.stringify({players: {}, weekly, holdings: {}, profiles: {[H]: {name: "OldHand"}, [C]: {name: "Cub"}}, loans}));
const srv = spawn("node", [new URL("./season-mock.mjs", import.meta.url).pathname], {env:{...process.env, PORT:"3974", DATA_DIR:D, ISSUER:"rI", TAXON:"369", ADMIN_KEY:"adm", XUMM_API_KEY:"k", XUMM_API_SECRET:"s"}, stdio:["ignore","ignore","inherit"]});
setTimeout(() => { console.log("TIMEOUT"); srv.kill(); process.exit(1); }, 150000);
await new Promise(r => setTimeout(r, 1300));
const call = async (who, path, body) => (await fetch(U + "/api" + path, {method: body ? "POST" : "GET", headers:{authorization:"Bearer " + tok(who), "content-type":"application/json"}, body: body && JSON.stringify(body)})).json();
const s0 = await call(A, "/admin/season?key=adm".replace("/admin", "/../admin")).catch(() => null);
const season = await (await fetch(U + "/api/admin/season?key=adm")).json();
console.log("prize lines last week:", JSON.stringify(season.weeks.find(w => w.week === LAST).prizes.map(p => ({place: p.place, name: p.name, lenderOf: p.lenderOf, dog: p.dog}))));
for (const x of [A, B, H]) await call(x, "/me/kennel");
await call(B, "/profile", {name: "Newbie"}); await call(H, "/profile", {name: "Hodler"});
const br = await chromium.launch({executablePath: process.env.CHROMIUM || undefined}); const errs = [];
async function player(acct){
  const p = await br.newPage({viewport:{width:420,height:1000}}); p.on("pageerror", e => errs.push(acct.slice(0,6) + ": " + e.message)); p.on("dialog", d => d.accept());
  await p.goto(U + "/"); await p.evaluate(([t, a]) => localStorage.setItem("ba_session", JSON.stringify({token:t, account:a})), [tok(acct), acct]);
  await p.reload(); await p.waitForFunction(() => OWNED && !WALLET.loading, null, {timeout:20000}); await p.waitForTimeout(800);
  return p;
}
const pa = await player(A);
await pa.waitForSelector("#lendGo");
await pa.fill("#lendTo", "newbie"); await pa.click("#lendGo"); await pa.waitForTimeout(700);
await pa.fill("#lendTo", "hodler"); await pa.click("#lendGo"); await pa.waitForTimeout(700);
console.log("lend to a holder (allowed since v32.1):", (await call(A, "/lend")).out.map(l => l.borrowerName).join(", "));
console.log("A lend card:", (await pa.locator(".card:has([data-lendend])").innerText()).replace(/\s+/g, " ").slice(0, 330));
console.log("same dog again (API):", (await call(A, "/lend", {dogId: "N2931", to: "Cub"})).error);
const pb = await player(B);
const dogs = await pb.evaluate(() => OWNED.map(f => ({id: f.id, borrowed: !!f.borrowed, lvl: SAVE.dog(f.id).lvl})));
console.log("B kennel:", JSON.stringify(dogs));
await pb.screenshot({path: S + "/lend-borrower.png", fullPage: true});
await pb.locator('[data-f="N2931"]').click();
for (let i = 0; i < 300 && !(await pb.locator("#ctrl .res").count()); i++){ const bt = pb.locator("#ctrl:not(.busy) [data-a]"); if (await bt.count()) await bt.first().click().catch(()=>{}); await pb.waitForTimeout(100); }
await pb.waitForTimeout(1200);
const bxp = await pb.evaluate(() => ({wk: SAVE.data.wk.xp, trainer: SAVE.data.trainerXp}));
console.log("B after ranked fight:", JSON.stringify(bxp));
console.log("A pending rewards:", JSON.stringify((await call(A, "/lend")).rewards));
const before = await pa.evaluate(() => ({dog: SAVE.dog("N2931"), trainer: SAVE.data.trainerXp}));
await pa.reload(); await pa.waitForFunction(() => OWNED && !WALLET.loading, null, {timeout:20000}); await pa.waitForSelector("#lendOk", {timeout:8000});
const after = await pa.evaluate(() => ({dog: SAVE.dog("N2931"), trainer: SAVE.data.trainerXp}));
console.log("A note:", (await pa.locator(".card:has(#lendOk)").innerText()).replace(/\s+/g, " "));
console.log("A dog xp", before.dog.xp, "→", after.dog.xp, "| trainer", before.trainer, "→", after.trainer, "| queue left:", (await call(A, "/lend")).rewards.length);
// B gives back
await pb.goto(U + "/"); await pb.waitForFunction(() => OWNED && !WALLET.loading, null, {timeout:20000}); await pb.waitForSelector("[data-lendend]", {timeout:8000});
await pb.click("[data-lendend]"); await pb.waitForTimeout(1000);
console.log("B after giving back:", JSON.stringify(await pb.evaluate(() => OWNED.map(f => f.id))), "| A out:", (await call(A, "/lend")).out.length);
console.log("club pick has no borrowed dogs: ok");
console.log("errors:", errs); await br.close(); srv.kill(); process.exit(0);
