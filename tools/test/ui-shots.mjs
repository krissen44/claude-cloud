// Screenshots of the menu screens for UI work: a wallet with 12 Scrappys, desktop + phone, every tab
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHmac } from "node:crypto";
const S = process.argv[2], OUT = process.argv[3] || S + "/ui", D = S + "/dataUi", PORT = 3986, U = "http://127.0.0.1:" + PORT;
fs.rmSync(D, {recursive: true, force: true}); fs.mkdirSync(D, {recursive: true}); fs.mkdirSync(OUT, {recursive: true});
fs.writeFileSync(D + "/session.secret", "testsecret");
const A = "rUiShotsXXXXXXXXXXXXXXXXXXXXXX";
fs.writeFileSync(S + "/hold-ui.json", JSON.stringify({[A]: [2723, 2715, 2724, 8, 2719, 2721, 3501, 3502, 3503, 3504, 3505, 17]}));
// 30 players with a week of fights, names and packs, so the ladder and the packs have something to show
{ const d = new Date(), day = (d.getUTCDay() + 6) % 7, wk = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
  const weekly = {}, profiles = {}, packs = {}, ids = ["ledger", "moon", "bone", "static"];
  for (let i = 0; i < 30; i++){ const a = "rLadder" + String(i).padStart(2, "0") + "XXXXXXXXXXXXXXXXXXXXX".slice(0, 21), w = Math.round(140 / (i + 1)) + (i % 5), l = (i * 7) % 23;
    weekly[wk + "|" + a] = {account: a, week: wk, wins: w, losses: l, xp: w * 30 + l * 12, streak: (i * 3) % 17, pack: i < 24 ? ids[i % 4] : null, updated: Date.now()};
    if (i % 3) profiles[a] = {name: ["Bark", "Woof", "Chomp", "Rex", "Pixel", "Nova", "Taco"][i % 7] + i};
    if (i < 24) packs[a] = {pack: ids[i % 4], week: wk, lockWeek: wk}; }
  weekly[wk + "|" + A] = {account: A, week: wk, wins: 12, losses: 5, xp: 420, streak: 3, pack: "moon", updated: Date.now()}; packs[A] = {pack: "moon", week: wk, lockWeek: wk};
  fs.writeFileSync(D + "/store.json", JSON.stringify({players: {}, weekly, holdings: {}, packs, profiles, blobs: {}})); }
const tok = a => { const b0 = Buffer.from(JSON.stringify({a, exp: 2e9})).toString("base64url"); return b0 + "." + createHmac("sha256", "testsecret").update(b0).digest("base64url"); };
const srv = spawn("node", [new URL("./tut-mock.mjs", import.meta.url).pathname], {env: {...process.env, PORT: String(PORT), DATA_DIR: D, ISSUER: "rI", TAXON: "369", HOLD_FILE: S + "/hold-ui.json"}, stdio: "ignore"});
const bye = c => { try { srv.kill(); } catch {} process.exit(c); };
setTimeout(() => bye(1), 240000);
await new Promise(r => setTimeout(r, 1800));
const br = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const errs = [];
for (const [vw, vh, tag] of [[1100, 900, "desk"], [390, 844, "phone"]]) {
  const p = await br.newPage({viewport: {width: vw, height: vh}});
  p.on("pageerror", e => errs.push(tag + ": " + e.message));
  await p.route(u => !u.href.startsWith(U), r => r.abort());
  await p.goto(U + "/"); await p.evaluate(([t, a]) => localStorage.setItem("ba_session", JSON.stringify({token: t, account: a})), [tok(A), A]);
  await p.goto(U + "/"); await p.waitForFunction(() => OWNED && OWNED.length >= 10 && !WALLET.loading, null, {timeout: 40000});
  await p.evaluate(() => { for (const [i, f] of OWNED.entries()) { const d = SAVE.dog(f.id); d.lvl = 1 + (i * 7) % 10; d.xp = 20 + i * 5; d.w = i * 3; d.l = i; } SAVE.save(); menu(); });
  await p.waitForTimeout(1200);
  await p.screenshot({path: `${OUT}/${tag}-kennel.png`, fullPage: true});
  const h = await p.evaluate(() => document.documentElement.scrollHeight);
  console.log(tag, "kennel page height", h);
  if (process.env.EXTRA) { await p.evaluate(process.env.EXTRA); await p.waitForTimeout(700); await p.screenshot({path: `${OUT}/${tag}-extra.png`}); }
  for (const t of (process.env.TABS || "").split(",").filter(Boolean)) {
    await p.evaluate(t => { tab = t; menu(); if (t === "packs") loadPacks(); if (t === "ladder") fillLadder(); }, t); await p.waitForTimeout(1500);
    if (t === "ladder") {
      const L = await p.evaluate(() => ({rows: document.querySelectorAll(".lrow").length, scroll: (b => b.scrollHeight > b.clientHeight)(document.getElementById("lbox")), you: !!document.querySelector(".lrow.you")}));
      console.log((L.rows === 31 && L.scroll && L.you ? "PASS" : "FAIL") + ` ${tag}: ladder lists all 31 active players in a scrolling box, you highlighted`);
      await p.click('[data-lsort="rate"]'); const top = await p.locator(".lrow").first().innerText();
      console.log((/100%/.test(top) ? "PASS" : "FAIL") + ` ${tag}: sort by win % → ${top.replace(/\s+/g, " ")}`);
    }
    if (t === "packs") {
      await p.locator('[data-pkopen="moon"]').click(); await p.waitForTimeout(300);
      const n = await p.locator("#pkd table:not(.pst) tr").count();
      console.log((n === 8 ? "PASS" : "FAIL") + ` ${tag}: tapping Moon Diggers shows its ${n - 1} members`);
      await p.click("[data-pkclose]"); console.log((await p.locator("#pkd").count() === 0 ? "PASS" : "FAIL") + ` ${tag}: closes again`);
    }
    if (t === "packs" && process.env.PKOPEN) { await p.evaluate(k => { PKOPEN = k; menu(); }, process.env.PKOPEN); await p.waitForTimeout(500); }
    await p.screenshot({path: `${OUT}/${tag}-${t}.png`, fullPage: true});
  }
  await p.close();
}
console.log("errors:", errs.length ? errs : "none");
await br.close(); bye(0);
