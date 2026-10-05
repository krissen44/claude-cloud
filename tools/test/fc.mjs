import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHmac } from "node:crypto";
const S = process.argv[2], D = S + "/dataFC", U = "http://127.0.0.1:3971";
fs.rmSync(D, {recursive:true, force:true}); fs.mkdirSync(D, {recursive:true}); fs.writeFileSync(D + "/session.secret", "testsecret");
const tok = a => { const b0 = Buffer.from(JSON.stringify({a, exp:2e9})).toString("base64url"); return b0 + "." + createHmac("sha256", "testsecret").update(b0).digest("base64url"); };
const A = "rAAAplayer111111111111111111", B = "rBBBplayer222222222222222222", C = "rCCCplayer333333333333333333";
const srv = spawn("node", [new URL("./live.mjs", import.meta.url).pathname], {env:{...process.env, PORT:"3971", DATA_DIR:D, ISSUER:"rI", TAXON:"369"}, stdio:["ignore","ignore","inherit"]});
await new Promise(r => setTimeout(r, 1200));
const call = async (who, path, body) => (await fetch(U + "/api" + path, {method: body ? "POST" : "GET", headers:{authorization:"Bearer " + tok(who), "content-type":"application/json"}, body: body && JSON.stringify(body)})).json();
await call(B, "/profile", {name:"BarkBoss"}); await call(A, "/profile", {name:"Alpha"});
const br = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const errs = [];
async function player(acct, url){
  const ctx = await br.newContext({viewport:{width:420,height:900}});
  const p = await ctx.newPage(); p.on("pageerror", e => errs.push(acct.slice(0,4) + ": " + e.message)); p.on("dialog", d => d.accept());
  await p.goto(U + "/"); await p.evaluate(([t, a]) => localStorage.setItem("ba_session", JSON.stringify({token:t, account:a})), [tok(acct), acct]);
  await p.goto(url || U + "/"); await p.waitForFunction(() => OWNED && !WALLET.loading, null, {timeout:20000});
  return p;
}
const pa = await player(A), pb = await player(B);
await pa.click('[data-t="club"]'); await pa.locator("[data-fcdog]").first().click();
await pa.fill("#scName", "barkboss"); await pa.click("#scByName");
await pa.waitForSelector("text=Waiting for");
console.log("A:", (await pa.locator("#scList").innerText()).replace(/\s+/g," ").slice(0,160));
await pb.click('[data-t="club"]'); await pb.locator("[data-fcdog]").first().click();
await pb.waitForSelector("[data-scjoin]", {timeout:8000});
console.log("B inbox:", (await pb.locator("#scList").innerText()).replace(/\s+/g," ").slice(0,160));
await pb.screenshot({path: S + "/fc-inbox.png"});
await pb.click("[data-scjoin]");
await Promise.all([pa.waitForSelector(".stage", {timeout:10000}), pb.waitForSelector(".stage", {timeout:10000})]);
console.log("both in the ring. A side", await pa.evaluate(() => CLUB.side), "B side", await pb.evaluate(() => CLUB.side));
const moves = ["bite","guard","taunt","bite","bite","taunt","guard","bite","taunt","bite"];
let shot = false;
for (let i = 0; i < 400; i++){
  const done = (await pa.locator("#ctrl .res").count()) && (await pb.locator("#ctrl .res").count());
  if (done) break;
  for (const [p, off] of [[pa,0],[pb,1]]){
    const t = await p.evaluate(() => turn);
    const bt = p.locator(`#ctrl:not(.busy) [data-fc="${moves[(t + off) % moves.length]}"]:not([disabled])`);
    if (await bt.count()) await bt.click().catch(() => {});
  }
  if (!shot && i > 20){ shot = true; await pa.screenshot({path: S + "/fc-fight.png"}); }
  await pa.waitForTimeout(150);
}
const fin = async p => p.evaluate(() => ({side: CLUB.side, hp: [P.hp, E.hp], turn, res: document.querySelector('#ctrl .res')?.innerText.replace(/\s+/g,' ')}));
const fa = await fin(pa), fb = await fin(pb);
const sv = (await call(A, "/club/me")).record, sb = (await call(B, "/club/me")).record;
console.log("A:", JSON.stringify(fa)); console.log("B:", JSON.stringify(fb));
console.log("same fight on both screens:", JSON.stringify(fa.hp) === JSON.stringify(fb.hp), "| records", JSON.stringify(sv), JSON.stringify(sb));
await pb.screenshot({path: S + "/fc-end.png"});
// invite link + give up
await pa.click("#fcBack"); await pa.waitForSelector("#scInvite"); await pa.click("#scInvite");
await pa.waitForSelector("input.sclink"); const link = await pa.locator("input.sclink").inputValue();
console.log("link:", link);
const pc = await player(C, link);
await pc.waitForSelector("[data-scjoin]", {timeout:8000});
console.log("C opened link → tab:", await pc.evaluate(() => tab), "| url now:", pc.url());
await pc.locator("[data-fcdog]").first().click(); await pc.waitForSelector("[data-scjoin]:not([disabled])"); await pc.click("[data-scjoin]");
await Promise.all([pa.waitForSelector(".stage", {timeout:10000}), pc.waitForSelector(".stage", {timeout:10000})]);
await pa.waitForSelector("#scQuit"); await pa.click("#scQuit");
await pc.waitForSelector("#ctrl .res", {timeout:10000});
console.log("C after A gave up:", (await pc.locator("#ctrl .res").innerText()).replace(/\s+/g," "));
console.log("A:", (await pa.locator("#ctrl .res").innerText()).replace(/\s+/g," "));
console.log("errors:", errs); await br.close(); srv.kill();
