// /clip cold open: decisive round first, rewind, lead-up, the same round again — 10–14 s, short hook, no end card for the recorder
import { chromium } from "playwright";
import { spawn } from "node:child_process";
const S = process.argv[2];
const srv = spawn("node", [new URL("./live.mjs", import.meta.url).pathname], {env:{...process.env, PORT:"3983", DATA_DIR:S+"/dataClip", ISSUER:"rI", TAXON:"369"}, stdio:"ignore"});
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const bye = c => { try { srv.kill(); } catch(e){} process.exit(c); };
setTimeout(() => bye(1), 280000); process.on("uncaughtException", e => { console.log("ERR", e.message); bye(1); });
await new Promise(r => setTimeout(r, 1200));
const br = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const runs = [["ghost=1", "exhibition"], ["ghost=1&v=tt", "TikTok cut"], ["ghost=1&fmt=leg&leg=8", "Legendary spotlight"], ["ghost=1&fmt=boss&boss=17", "boss"], ["ghost=1&avoid=vs,nobody,hp,who", "avoid list"]];
const lens = [];
for (const [q, name] of runs){
  const p = await br.newPage({viewport: {width: 450, height: 800}}); const errs = [];
  p.on("pageerror", e => errs.push(e.message));
  await p.route(u => !u.href.startsWith("http://127.0.0.1"), r => r.abort());
  await p.goto("http://127.0.0.1:3983/clip?" + q);
  await p.waitForFunction(() => CLIP.state === "ready", null, {timeout: 30000});
  const info = await p.evaluate(() => ({hook: CLIP.hook, id: CLIP.hookId, hooks: CLIP.hooks, rounds: CLIP.stats.rounds, w: CLIP.stats.w, P: CLIP.rep.P.def.name, E: CLIP.rep.E.def.name}));
  const t0 = Date.now();
  await p.evaluate(() => CLIP.go());
  await p.waitForTimeout(700); if (name === "exhibition") await p.screenshot({path: S + "/shots/clip-open.png"});
  await p.waitForSelector(".cliprw", {timeout: 15000}); if (name === "exhibition") await p.screenshot({path: S + "/shots/clip-rewind.png"});
  await p.waitForFunction(() => CLIP.state === "done", null, {timeout: 60000, polling: 100});
  const sec = (Date.now() - t0) / 1000; lens.push(sec);
  if (name === "exhibition") await p.screenshot({path: S + "/shots/clip-end.png"});
  const words = info.hook.replace(/[^\p{L}\p{N}' ]/gu, " ").trim().split(/\s+/).filter(Boolean).length;
  console.log(`${name}: ${sec.toFixed(1)} s, ${info.rounds} rounds, hook "${info.hook}" (${info.id}) of [${info.hooks}] · ${info.P} vs ${info.E}`);
  ok(words <= 5 && !/bond|mythic|epic/i.test(info.hook), `${name}: hook has ≤ 5 plain words`);
  ok(await p.locator(".clipend").count() === 0 && await p.locator(".clipask.on").count() === 1, `${name}: no end card for the recorder, the question shows at the end`);
  if (q.includes("avoid")) ok(!["vs", "nobody", "hp", "who"].includes(info.id), "avoided hook ids are skipped");
  if (q.includes("leg=8")) ok(/#8 /.test(info.P), "spotlight on Legendary #8");
  if (q.includes("boss=17")) ok(/#17 /.test(info.E) && /BOSS/.test(info.hook), "small dog against boss #17");
  ok(errs.length === 0, `${name}: no page errors ${errs.join(" | ")}`);
  await p.close();
}
ok(lens.every(s => s >= 8 && s <= 15.5), "lengths 8–15.5 s: " + lens.map(s => s.toFixed(1)).join(", "));
// a person opening the link still gets the play button and the end card with buttons
const ctx = await br.newContext({viewport: {width: 450, height: 800}});
await ctx.addInitScript(() => Object.defineProperty(navigator, "webdriver", {get: () => false}));
const v = await ctx.newPage(); await v.route(u => !u.href.startsWith("http://127.0.0.1"), r => r.abort());
await v.goto("http://127.0.0.1:3983/clip?ghost=1"); await v.click(".clipplay");
await v.waitForFunction(() => CLIP.state === "done", null, {timeout: 60000});
ok(await v.locator("#clipAgain").count() === 1, "a viewer gets Watch again / Play at the end");
await br.close(); console.log(fails ? fails + " FAILED" : "ALL PASS"); bye(fails ? 1 : 0);
