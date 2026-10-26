// ~30 s update promo (9:16, 1080×1920) recorded from the real game on the mock server: kennel with bond 20, weekly
// badges, share card, a ranked fight with recharge + hot streak, a montage of the new arenas, Scrappy Dash with the
// Advent calendar. Big captions on top, chiptune bed. Writes <dir>/bark-arena-update.mp4.
// Usage: node tools/test/promo.mjs <dir> [ffmpeg]   (CHROMIUM=… optional)
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import { createHmac } from "node:crypto";
const OUT = process.argv[2], FF = process.argv[3] || "ffmpeg";
const D = OUT + "/promodata", V = OUT + "/promovid", PORT = 3996, U = `http://127.0.0.1:${PORT}`;
for (const d of [D, V]) { fs.rmSync(d, {recursive: true, force: true}); fs.mkdirSync(d, {recursive: true}); }
fs.writeFileSync(D + "/session.secret", "testsecret");
const tok = a => { const b0 = Buffer.from(JSON.stringify({a, exp: 2e9})).toString("base64url"); return b0 + "." + createHmac("sha256", "testsecret").update(b0).digest("base64url"); };
const ME = "rTutoria1P1ayerXXXXXXXXXXXXXXX";
const day = k => new Date(Date.now() + k * 864e5).toISOString().slice(0, 10);
// the Dash boards + the owner's Advent prize plan, so the calendar and rankings are full
const names = {[ME]: "Krissen", rRiva1OneXXXXXXXXXXXXXXXXXXXXX: "MoonPup", rDashCXXXXXXXXXXXXXXXXXXXXXXXX: "SleighQueen", rPlayer4XXXXXXXXXXXXXXXXXXXXXX: "BarkVader",
  rPlayer5XXXXXXXXXXXXXXXXXXXXXX: "XRPup", rPlayer6XXXXXXXXXXXXXXXXXXXXXX: "Snowball"};
let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const board = (lo, hi, t0) => Object.fromEntries(Object.keys(names).map((a, i) => [a, {best: Math.round(lo + rnd() * (hi - lo)), runs: 3, at: t0 + i, dog: {name: "Pixel Scrappy #" + (120 + i * 41), token: 120 + i * 41}}]));
const DAYS = [54, 71, 244, 298, 333, 405, 437, 495, 513, 529, 764, 1055, 1139, 1161, 1365, 1377, 1435, 1602, 1648, 1706, 1754, 1827, 1842, 2908];
const blobs = {}, from = day(-5);
for (let k = -5; k <= 0; k++) blobs["dashday:" + day(k)] = board(900, 6400, Date.now() + k * 864e5);
blobs["dashplan:" + from] = Object.fromEntries([...DAYS.map((t, i) => ["dash-" + new Date(Date.parse(from) + i * 864e5).toISOString().slice(0, 10), {nftId: "0008" + t, token: t, rarity: i === 23 ? "Rare" : "Common"}]),
  ...[[3756, "Epic"], [1017, "Rare"], [2317, "Rare"], [206, "Uncommon"], [698, "Uncommon"]].map(([t, r], i) => ["grand-" + (i + 1), {nftId: "0009" + t, token: t, rarity: r}])]);
fs.writeFileSync(D + "/store.json", JSON.stringify({players: {}, weekly: {}, holdings: {}, profiles: Object.fromEntries(Object.entries(names).map(([a, name]) => [a, {name, updated: 1}])), blobs}));
const srv = spawn("node", [new URL("./tut-mock.mjs", import.meta.url).pathname], {env: {...process.env, PORT: String(PORT), DATA_DIR: D, ISSUER: "rI", TAXON: "369",
  DASH_ADVENT: from, DASH_OPEN_ROCKET: day(-30), DASH_OPEN_SLEIGH: from}, stdio: "ignore"});
const bye = c => { try { srv.kill(); } catch {} process.exit(c); };
setTimeout(() => { console.log("TIMEOUT"); bye(1); }, 300000);
process.on("unhandledRejection", e => { console.log("ERR", e && e.stack || e); bye(1); });
await new Promise(r => setTimeout(r, 2000));

const br = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const ctx = await br.newContext({viewport: {width: 450, height: 800}, deviceScaleFactor: 2.4, hasTouch: false});
// the overlay: a big title + a pill under it at the top, a full-screen card for intro and outro
await ctx.addInitScript(() => {
  const css = `
  #pmTop{position:fixed;left:0;right:0;top:0;z-index:2147483000;padding:22px 16px 18px;text-align:center;pointer-events:none;
    background:linear-gradient(180deg,rgba(6,10,24,.94) 0%,rgba(6,10,24,.86) 70%,rgba(6,10,24,0) 100%);opacity:0;transform:translateY(-14px);transition:opacity .25s,transform .25s}
  #pmTop.on{opacity:1;transform:none}
  #pmTop .t{font:900 31px/1.12 system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;letter-spacing:-.01em;text-shadow:0 3px 0 rgba(0,0,0,.45)}
  #pmTop .s{display:inline-block;margin-top:10px;font:800 16px/1.25 system-ui,sans-serif;color:#0e1726;background:#ffd54a;padding:7px 14px;border-radius:999px;box-shadow:0 3px 0 #8a5a00}
  #pmCard{position:fixed;inset:0;z-index:2147483001;display:grid;place-items:center;text-align:center;opacity:0;transition:opacity .3s;pointer-events:none;
    background:radial-gradient(ellipse at 50% 40%,#2a86d8 0%,#12407a 55%,#081428 100%);color:#fff;font-family:system-ui,sans-serif;padding:0 26px}
  #pmCard.on{opacity:1}
  #pmCard .k{font:800 15px system-ui;color:#9fd2ff;letter-spacing:.2em}
  #pmCard .t{font:900 50px/1.05 system-ui;color:#ffd54a;text-shadow:0 0 22px #ff9d00,4px 4px 0 #7a4a00;margin-top:14px}
  #pmCard .s{font:800 21px/1.35 system-ui;color:#dbeeff;margin-top:16px}
  #pmCard .u{font:900 21px system-ui;margin-top:22px;color:#0e1726;background:#ffd54a;padding:12px 22px;border-radius:999px;display:inline-block;box-shadow:0 5px 0 #7a4a00}
  #pmCard .dogs{display:flex;justify-content:center;gap:10px;margin-bottom:18px}
  #pmCard .dogs img{width:110px;height:110px;image-rendering:pixelated;animation:pmhop 1s ease-in-out infinite}
  #pmCard .dogs img:nth-child(2){animation-delay:.15s}#pmCard .dogs img:nth-child(3){animation-delay:.3s}
  #pmCard .pop{animation:pmpop .5s cubic-bezier(.2,1.4,.4,1) both}#pmCard .pop2{animation:pmpop .5s .15s cubic-bezier(.2,1.4,.4,1) both}#pmCard .pop3{animation:pmpop .5s .3s cubic-bezier(.2,1.4,.4,1) both}
  #pmCard ul{list-style:none;padding:0;margin:18px 0 0;font:800 19px/1.55 system-ui;color:#fff;text-align:left;display:inline-block}
  @keyframes pmpop{from{transform:scale(.4);opacity:0}to{transform:none;opacity:1}}
  @keyframes pmhop{50%{transform:translateY(-12px)}}
  .chatbtn,#chatBtn,.chat-fab{display:none!important}`;
  const add = () => {
    if (document.getElementById("pmTop")) return;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
    document.body.insertAdjacentHTML("beforeend", `<div id="pmTop"><div class="t"></div><div class="s"></div></div><div id="pmCard"></div>`);
    window.__pm = {
      top(t, s){ const e = document.getElementById("pmTop"); if (t){ e.querySelector(".t").innerHTML = t; const ss = e.querySelector(".s"); ss.innerHTML = s || ""; ss.style.display = s ? "" : "none";
        e.classList.remove("on"); void e.offsetWidth; } e.classList.toggle("on", !!t); },
      card(h){ const c = document.getElementById("pmCard"); if (h) c.innerHTML = h; c.classList.toggle("on", !!h); },
    };
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add); else add();
});
const p = await ctx.newPage(); const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.route(u => !u.href.startsWith("http://127.0.0.1"), r => r.abort());
const wait = ms => p.waitForTimeout(ms);
const pm = (fn, ...a) => p.evaluate(([fn, a]) => window.__pm[fn](...a), [fn, a]);
await p.goto(U + "/"); await p.evaluate(([t, a]) => { localStorage.clear(); localStorage.setItem("ba_session", JSON.stringify({token: t, account: a})); localStorage.setItem("ba_dashskin", JSON.stringify("sleigh")); }, [tok(ME), ME]);
await p.goto(U + "/"); await p.waitForFunction(() => OWNED && OWNED.length && !WALLET.loading, null, {timeout: 30000});
// a trained dog: bond 20 on the open dog, a hot streak, weekly badge progress, some album pages
await p.evaluate(() => {
  const R = ROSTER(), d = R[0]; kSel = d.id; lsSet('ba_ksel', d.id);
  const g = SAVE.dog(d.id); g.lvl = 20; g.xp = 0; g.w = 214; g.l = 31;
  SAVE.data.streak = 12; SAVE.data.bestStreak = Math.max(SAVE.data.bestStreak || 0, 12);
  SAVE.data.trainerXp = 6300; Object.assign(SAVE.data.wk, {wins: 38, losses: 5, xp: 1240, streak: 12}); SAVE.data.lastWk = {xp: 860, wins: 27, losses: 9};
  SAVE.save(); document.querySelectorAll(".achtoast,.toast,.recap").forEach(e => e.remove()); menu();
});
await wait(1500);
await p.evaluate(() => document.querySelectorAll(".achtoast,.toast,.recap").forEach(e => e.remove()));
const DOG = await p.evaluate(() => ROSTER().slice(0, 3).map(f => f.img));

const cdp = await ctx.newCDPSession(p); const frames = []; let fn = 0;
cdp.on("Page.screencastFrame", async f => {
  const file = `${V}/f${String(fn++).padStart(6, "0")}.jpg`;
  fs.writeFileSync(file, Buffer.from(f.data, "base64")); frames.push({t: f.metadata.timestamp * 1000, file});
  try { await cdp.send("Page.screencastFrameAck", {sessionId: f.sessionId}); } catch {}
});
await cdp.send("Page.startScreencast", {format: "jpeg", quality: 92, maxWidth: 1080, maxHeight: 1920, everyNthFrame: 1});
await wait(300);
const tStart = Date.now();

// 1) intro
await pm("card", `<div><div class="dogs pop">${DOG.map(s => `<img src="${s}">`).join("")}</div><div class="k pop">BARK ARENA</div>
  <div class="t pop2">BIG<br>UPDATE</div><div class="s pop3">Everything new in 30 seconds 🐾</div></div>`);
await wait(2200); await pm("card", "");
// 2) kennel: new look, bond 20
await pm("top", "💪 BOND UP TO 20", "New perks · tougher rivals");
await wait(2800);
// 3) weekly badges + trait album
await p.evaluate(() => { const d = document.querySelector('details[data-fold="ach"]'); if (d){ d.open = true; d.closest(".card").scrollIntoView({behavior: "smooth", block: "start"}); } });
await pm("top", "🏅 3 WEEKLY BADGES", "+ Trait Album · 30 achievements");
await wait(2700);
// 4) share card
await p.evaluate(() => window.scrollTo({top: 0}));
await p.evaluate(() => shareCard('week'));
await p.waitForSelector(".cardbox", {timeout: 8000}).catch(() => {});
await pm("top", "📸 SHARE YOUR WEEK", "Trading-card style · invite link built in");
await wait(2700);
await p.evaluate(() => { document.querySelectorAll(".cardbox,.modal,.cardwrap").forEach(e => e.remove()); menu(); });
// 5) a ranked fight: recharge + hot streak
await p.evaluate(() => { const b = document.querySelector(".kfight"); if (b) b.click(); });
await p.waitForFunction(() => document.querySelector(".stage") && document.querySelector("#ctrl .acts"), null, {timeout: 15000});
await p.evaluate(() => window.scrollTo({top: 0}));
await pm("top", "⚔️ FAIRER FIGHTS", "Abilities recharge · Guard halves beams");
const idle = () => p.waitForFunction(() => typeof busy !== "undefined" && !busy && !(typeof VF !== "undefined" && VF.busy), null, {timeout: 15000}).catch(() => {});
const move = async m => { await idle(); if (await p.evaluate(() => over)) return;
  if (m === "ab" && await p.evaluate(() => !!P.actives[0] && abReady(P, P.actives[0]))) await p.click('[data-ab="0"]').catch(() => {});
  else await p.click(`[data-a="${m === "ab" ? "taunt" : m}"]`).catch(() => {}); };
await move("taunt"); await wait(1400);
await move("ab"); await wait(1600);
await pm("top", "🔥 HOT STREAK", "5 wins in a row: tougher rivals, +XP");
await move("guard"); await wait(1700);
await move("bite"); await wait(1100);
// 6) the new arenas
await pm("top", "🎨 12 NEW PIXEL ARENAS", "Weather · snappier moves · glowing Legendaries");
for (const sc of ["snow", "night", "beach", "rain", "blossom", "desert"]){
  await p.evaluate(sc => { const pl = document.querySelector(".stage .plate"); if (pl) pl.style.backgroundImage = `url('${SCENE_ART[sc]}')`; }, sc);
  await wait(430);
}
// 7) Scrappy Dash
await p.evaluate(() => { try { if (typeof vfAbort === "function") vfAbort(); } catch {} over = true; busy = false; DASH.skin = 'sleigh'; tab = 'dash'; menu(); dashLoad(); window.scrollTo({top: 0}); });
await p.waitForFunction(() => DASH.board && DASH.board.skin === "sleigh", null, {timeout: 10000}).catch(() => {});
await pm("top", "🛷 SCRAPPY DASH", "🚀 Rocket from Nov 1 · 🛷 Sleigh from Dec 1");
await wait(2300);
await p.evaluate(() => { const a = document.querySelector(".card.advent"); if (a) a.scrollIntoView({behavior: "smooth", block: "start"}); });
await pm("top", "🎄 WIN A PIXEL SCRAPPY", "Every day of the Advent calendar");
await wait(2400);
await p.evaluate(() => window.scrollTo({top: 0}));
await p.evaluate(() => document.getElementById("dashGo").click());
await p.waitForFunction(() => DASH.g && DASH.g.state === "ready", null, {timeout: 8000}).catch(() => {});
await p.locator("#dashCv").dispatchEvent("pointerdown", {button: 0}); await p.locator("#dashCv").dispatchEvent("pointerup");
await p.evaluate(() => { window.__bot = setInterval(() => { const G = DASH.g; if (!G || G.state !== "run") return;
  let need = 200; for (const h of G.houses) if (h.x < DASH_PX + 130 && h.x + h.w > DASH_PX - 30) need = Math.min(need, h.top - h.ch - 30);
  for (const f of G.foes) if (f.x > DASH_PX - 20 && f.x < DASH_PX + 90 && Math.abs(f.y - G.y) < 30) need = Math.min(need, f.y - 34);
  G.want = G.y + Math.max(0, G.vy) * .3 > need;
  for (const h of G.houses) if (h.wants && !h.done && !h.aimed){ const ct = h.top - h.ch, t = Math.sqrt(2 * Math.max(1, ct - G.y) / 900), mid = h.x + h.cx + 9;
    if (Math.abs(mid - DASH_PX - G.v * t) < 6){ h.aimed = true; G.pendingDrop = true; } } }, 16); });
await pm("top", "ONE BUTTON · STOMP THE CROWS", "Free to play · daily rankings");
await wait(3200);
// 8) outro
await pm("top", "");
await pm("card", `<div><div class="dogs pop">${DOG.map(s => `<img src="${s}">`).join("")}</div><div class="t pop2" style="font-size:40px">PLAY FREE</div>
  <div class="u pop3">game.scrappyxrp.fun</div><div class="s pop3">🧩 Sign in with Joey Wallet<br>now on Chrome</div></div>`);
await wait(2600);
const tEnd = Date.now();
await cdp.send("Page.stopScreencast").catch(() => {});
await ctx.close(); await br.close(); srv.kill();

const dur = (tEnd - tStart) / 1000;
const use = frames.filter(f => f.t <= tEnd).sort((a, b) => a.t - b.t);
let k = use.findIndex(f => f.t >= tStart); k = Math.max(0, k - 1);
const seq = use.slice(k), lines = [];
seq.forEach((f, i) => { const a = Math.max(f.t, tStart), b = i + 1 < seq.length ? seq[i + 1].t : tEnd; if (b > a) lines.push(`file '${f.file}'`, `duration ${((b - a) / 1000).toFixed(4)}`); });
lines.push(`file '${seq[seq.length - 1].file}'`);
fs.writeFileSync(V + "/list.txt", lines.join("\n"));
chiptune(dur, V + "/music.wav");
console.log({frames: seq.length, fps: (seq.length / dur).toFixed(1), dur, errs});
execFileSync(FF, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", V + "/list.txt", "-i", V + "/music.wav",
  "-filter_complex", "[1:a]loudnorm=I=-14:TP=-1.5:LRA=11[a]", "-map", "0:v", "-map", "[a]", "-t", dur.toFixed(3),
  "-vf", "fps=30,scale=1080:1920:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "19",
  "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", OUT + "/bark-arena-update.mp4"]);
console.log("mp4", fs.statSync(OUT + "/bark-arena-update.mp4").size);
bye(0);

// a lively chiptune loop (square bass, triangle octave, square lead, noise hats), 140 bpm, fades at both ends
function chiptune(secs, file){
  const SR = 44100, n = Math.ceil(secs * SR), buf = new Float32Array(n), beat = 60 / 140 / 2;
  const bass = [55, 55, 65.4, 55, 73.4, 55, 82.4, 73.4], lead = [440, 523, 659, 784, 659, 523, 587, 659];
  const prog = [1, 1.335, 1.122, 1.498];
  let sd = 7; const rr = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
  const note = (f, t, d, type, v) => { const a = Math.floor(t * SR), len = Math.floor(d * SR);
    for (let i = 0; i < len && a + i < n; i++){ const ph = (f * i / SR) % 1, env = Math.min(1, i / (SR * .008)) * Math.exp(-4 * i / len);
      const s = type === "square" ? (ph < .5 ? 1 : -1) : type === "tri" ? 4 * Math.abs(ph - .5) - 1 : rr() * 2 - 1; buf[a + i] += s * v * env; } };
  for (let i = 0; i * beat < secs; i++){
    const t = i * beat, bar = Math.floor(i / 8), tr = prog[Math.floor(bar / 2) % 4];
    note(bass[i % 8] * tr, t, .18, "square", .15);
    if (i % 2 === 0) note(bass[i % 8] * tr * 2, t, .08, "tri", .12);
    if (bar >= 2) note(lead[(i + bar) % 8] * tr, t, .15, "square", .05);
    note(0, t, .025, "noise", i % 2 ? .03 : .055);
    if (i % 8 === 4) note(0, t, .09, "noise", .09);
  }
  const fade = SR * 1.2;
  for (let i = 0; i < n; i++) buf[i] *= Math.min(1, i / (SR * .2), (n - i) / fade);
  const out = Buffer.alloc(44 + n * 2);
  out.write("RIFF", 0); out.writeUInt32LE(36 + n * 2, 4); out.write("WAVEfmt ", 8); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(SR, 24); out.writeUInt32LE(SR * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write("data", 36); out.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(buf[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, out);
}
