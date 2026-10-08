// Bark Arena how-to-play tutorial for YouTube (16:9, 1920x1080): the real website and game on the mock server
// (tut-mock.mjs), with chapter cards, step cards for wallet + mint, captions, a spotlight and a pointer.
// Sound = the game's own WebAudio + a chiptune bed rendered here. Writes <dir>/bark-arena-tutorial.mp4 and
// <dir>/chapters.txt (YouTube chapter timestamps).
// Usage: node tutorial.mjs <dir> [ffmpeg] — env CHROMIUM (browser), FONTS_DIR (figtree/gabarito/jetbrains-mono/
// press-start-2p *.woff2 from Google Fonts; optional, falls back to system fonts).
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import { createHmac } from "node:crypto";
const OUT = process.argv[2], FF = process.argv[3] || "ffmpeg", FONTS = process.env.FONTS_DIR || "";
const D = OUT + "/tutdata", V = OUT + "/tutvid", PORT = 3994, SITE = 3995;
const U = `http://127.0.0.1:${PORT}`, W = `http://127.0.0.1:${SITE}`;
for (const d of [D, V]) { fs.rmSync(d, {recursive: true, force: true}); fs.mkdirSync(d, {recursive: true}); }
fs.writeFileSync(D + "/session.secret", "testsecret");
const tok = a => { const b0 = Buffer.from(JSON.stringify({a, exp: 2e9})).toString("base64url"); return b0 + "." + createHmac("sha256", "testsecret").update(b0).digest("base64url"); };
const ME = "rTutoria1P1ayerXXXXXXXXXXXXXXX";
const RIV = [["rRiva1OneXXXXXXXXXXXXXXXXXXXXX", "Barkley", "moon", 340, 11, 3], ["rRiva1TwoXXXXXXXXXXXXXXXXXXXXX", "PixelPaws", "bone", 520, 16, 5],
             ["rRiva1ThreeXXXXXXXXXXXXXXXXXXX", "MoonDog", "moon", 210, 7, 2]];
const log = fs.openSync(OUT + "/tutserver.log", "w");
const srv = spawn("node", [new URL("./tut-mock.mjs", import.meta.url).pathname],
  {env: {...process.env, PORT: String(PORT), SITE_PORT: String(SITE), DATA_DIR: D, ISSUER: "rI", TAXON: "369", FONTS_DIR: FONTS, FFMPEG: FF}, stdio: ["ignore", log, log]});
const bye = c => { try { srv.kill(); } catch (e) {} process.exit(c); };
setTimeout(() => { console.log("TIMEOUT"); bye(1); }, 1200000);
process.on("uncaughtException", e => { console.log("ERR", e.stack); bye(1); });
process.on("unhandledRejection", e => { console.log("ERR", e && e.stack || e); bye(1); });
await new Promise(r => setTimeout(r, 1800));
const call = async (who, path, body) => {
  for (let i = 0; ; i++) {
    try { const r = await fetch(U + "/api" + path, {method: body ? "POST" : "GET", headers: {authorization: "Bearer " + tok(who), "content-type": "application/json"}, body: body && JSON.stringify(body)}); return await r.json(); }
    catch (e) { if (i > 3) throw e; await new Promise(r => setTimeout(r, 300)); }
  }
};
// other players: names, dogs, this week's numbers, packs, today's arena squads
const kennels = {};
for (const [a, name, pack, xp, wins, streak] of RIV) {
  kennels[a] = (await call(a, "/me/kennel")).nfts;
  await call(a, "/profile", {name});
  await call(a, "/pack", {action: "join", id: pack});
  await call(a, "/stats", {xp, wins, losses: Math.round(wins / 2), streak});
  await call(a, "/arena/squad", {ids: kennels[a].map(n => n.nft_id)});
}

// ---------------------------------------------------------------- browser
const font = (fam, file, w) => FONTS && fs.existsSync(`${FONTS}/${file}`)
  ? `@font-face{font-family:"${fam}";font-weight:${w};src:url(data:font/woff2;base64,${fs.readFileSync(`${FONTS}/${file}`).toString("base64")}) format("woff2")}` : "";
const FONT_CSS = font("Press Start 2P", "press-start-2p.woff2", 400) + font("TutSans", "figtree-latin.woff2", "300 900") + font("TutHead", "gabarito-latin.woff2", "400 900");
const br = await chromium.launch({executablePath: process.env.CHROMIUM || undefined, args: ["--autoplay-policy=no-user-gesture-required"]});
const ctx = await br.newContext({viewport: {width: 1280, height: 720}, deviceScaleFactor: 1.5});
await ctx.addInitScript(([FONT_CSS]) => {
  // every node that plays to the speakers also plays into a recorder stream
  const orig = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (t, ...r) {
    if (t instanceof AudioDestinationNode) {
      const c = this.context;
      if (!c.__msd) { c.__msd = c.createMediaStreamDestination(); window.__ac = c; }
      orig.call(this, c.__msd);
    }
    return orig.call(this, t, ...r);
  };
  const css = FONT_CSS + `
  #tutCard{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;text-align:center;opacity:0;transition:opacity .45s;pointer-events:none;
    background:radial-gradient(ellipse at 50% 38%,#2a86d8 0%,#12407a 52%,#081428 100%);color:#fff;font-family:TutSans,system-ui,sans-serif}
  #tutCard.on{opacity:1}
  #tutCard .k{font:400 15px/1 'Press Start 2P',monospace;color:#9fd2ff;letter-spacing:.14em}
  #tutCard .t{font:400 46px/1.25 'Press Start 2P',monospace;color:#ffd54a;text-shadow:0 0 24px #ff9d00,5px 5px 0 #7a4a00;margin-top:22px;padding:0 40px}
  #tutCard .s{font:700 25px/1.4 TutSans,system-ui;color:#dbeeff;margin-top:24px}
  #tutCard .u{font:800 24px TutSans,system-ui;margin-top:26px;color:#0e1726;background:#ffd54a;padding:12px 26px;border-radius:999px;display:inline-block;box-shadow:0 5px 0 #7a4a00}
  #tutCard .dogs{display:flex;justify-content:center;gap:26px;margin-bottom:26px}
  #tutCard .dogs img{width:150px;height:150px;image-rendering:pixelated;animation:hop 1.1s ease-in-out infinite}
  #tutCard .dogs img:nth-child(2){animation-delay:.18s}#tutCard .dogs img:nth-child(3){animation-delay:.36s}
  #tutCard .pop{animation:pop .6s cubic-bezier(.2,1.4,.4,1) both}
  #tutCard .pop2{animation:pop .6s .25s cubic-bezier(.2,1.4,.4,1) both}
  #tutCard .pop3{animation:pop .6s .5s cubic-bezier(.2,1.4,.4,1) both}
  @keyframes pop{from{transform:scale(.4);opacity:0}to{transform:scale(1);opacity:1}}
  @keyframes hop{0%,100%{transform:translateY(0)}50%{transform:translateY(-16px)}}
  #tutCap{position:fixed;left:0;right:0;bottom:24px;z-index:2147482999;text-align:center;pointer-events:none;padding:0 60px}
  #tutCap div{display:inline-block;max-width:1060px;font:700 25px/1.35 TutSans,system-ui,sans-serif;color:#fff;background:rgba(14,23,38,.93);padding:13px 26px;
    border-radius:16px;border:3px solid #ffd54a;box-shadow:0 6px 0 rgba(0,0,0,.28);opacity:0;transform:translateY(12px);transition:opacity .3s,transform .3s}
  #tutCap div.on{opacity:1;transform:none}
  #tutCap b{color:#ffd54a}
  #tutSpot{position:fixed;z-index:2147482990;border:4px solid #ffd54a;border-radius:16px;box-shadow:0 0 0 9999px rgba(8,16,32,.42),0 0 26px #ffd54a;
    transition:left .45s,top .45s,width .45s,height .45s,opacity .35s;opacity:0;pointer-events:none}
  #tutSpot.on{opacity:1}
  #tutCur{position:fixed;z-index:2147483001;left:0;top:0;width:34px;height:34px;pointer-events:none;transition:transform .75s cubic-bezier(.45,0,.2,1),opacity .3s;opacity:0;
    filter:drop-shadow(2px 3px 2px rgba(0,0,0,.4))}
  #tutCur.on{opacity:1}
  #tutCur i{position:absolute;left:-16px;top:-16px;width:32px;height:32px;border-radius:50%;border:4px solid #ffd54a;opacity:0}
  #tutCur.tap i{animation:tap .5s ease-out}
  @keyframes tap{from{transform:scale(.3);opacity:1}to{transform:scale(1.8);opacity:0}}
  #tutSteps{position:fixed;inset:0;z-index:2147482995;opacity:0;transition:opacity .45s;pointer-events:none;color:#0e1726;font-family:TutSans,system-ui,sans-serif;
    background:#f4f8fd radial-gradient(#c9d9ec 1.4px,transparent 1.6px) 0 0/22px 22px;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:0 70px 70px}
  #tutSteps.on{opacity:1}
  #tutSteps .kk{font:800 16px TutSans;letter-spacing:.16em;text-transform:uppercase;color:#0f76c6}
  #tutSteps h2{font:900 46px/1.1 TutHead,TutSans,system-ui;margin:10px 0 34px;letter-spacing:-.02em;text-align:center}
  #tutSteps .row{display:grid;grid-template-columns:repeat(3,1fr);gap:26px;width:100%;max-width:1120px}
  #tutSteps .st{background:#fff;border:3px solid #0e1726;border-radius:20px;box-shadow:7px 7px 0 #0e1726;padding:24px 22px 22px;position:relative;
    opacity:0;transform:translateY(26px) scale(.94);transition:opacity .45s,transform .45s cubic-bezier(.2,1.4,.4,1)}
  #tutSteps .st.on{opacity:1;transform:none}
  #tutSteps .st.hi{border-color:#1b8ce3;box-shadow:7px 7px 0 #1b8ce3}
  #tutSteps .n{position:absolute;top:-20px;left:20px;width:40px;height:40px;border-radius:50%;background:#1b8ce3;color:#fff;font:900 21px/40px TutHead,TutSans;text-align:center;border:3px solid #0e1726}
  #tutSteps .ic{font-size:50px;line-height:1;margin:6px 0 12px}
  #tutSteps .ic img{width:76px;height:76px;image-rendering:pixelated}
  #tutSteps h3{font:900 25px/1.15 TutHead,TutSans;margin:0 0 9px}
  #tutSteps p{font:500 18px/1.4 TutSans;margin:0;color:#33445c}
  #tutSteps p b{color:#0e1726}
  #tutSteps .foot{margin-top:34px;font:700 19px TutSans;color:#33445c;background:#fff;border:2px solid #0e1726;border-radius:999px;padding:10px 22px;opacity:0;transition:opacity .4s}
  #tutSteps .foot.on{opacity:1}`;
  const add = () => {
    if (document.getElementById("tutCap")) return;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
    document.body.insertAdjacentHTML("beforeend", `<div id="tutSteps"></div><div id="tutSpot"></div><div id="tutCard"></div><div id="tutCap"><div></div></div>
      <div id="tutCur"><i></i><svg viewBox="0 0 24 24" width="34" height="34"><path d="M3 2l15 9-6.5 1.6L15 20l-3 1.3-3.4-7.4L3 18z" fill="#fff" stroke="#0e1726" stroke-width="1.6" stroke-linejoin="round"/></svg></div>`);
    let spotSel = null, pad = 8;
    const sp = document.getElementById("tutSpot"), cur = document.getElementById("tutCur");
    const tick = () => {
      const el = spotSel && document.querySelector(spotSel);
      if (el) { const r = el.getBoundingClientRect();
        Object.assign(sp.style, {left: r.left - pad + "px", top: r.top - pad + "px", width: r.width + 2 * pad + "px", height: r.height + 2 * pad + "px"}); sp.classList.add("on"); }
      else sp.classList.remove("on");
      requestAnimationFrame(tick);
    };
    tick();
    window.__tut = {
      card(h){ const c = document.getElementById("tutCard"); if (h) c.innerHTML = h; c.classList.toggle("on", !!h); },
      cap(t){ const b = document.querySelector("#tutCap div"); if (t) b.innerHTML = t; b.classList.toggle("on", !!t); },
      spot(sel, p){ spotSel = sel; pad = p == null ? 8 : p; },
      steps(h){ const s = document.getElementById("tutSteps"); if (h) s.innerHTML = h; s.classList.toggle("on", !!h); },
      step(i){ const all = document.querySelectorAll("#tutSteps .st"); all.forEach((x, k) => { x.classList.toggle("on", k <= i); x.classList.toggle("hi", k === i); });
        if (i >= all.length) { all.forEach(x => x.classList.remove("hi")); const f = document.querySelector("#tutSteps .foot"); if (f) f.classList.add("on"); } },
      cur(x, y){ cur.classList.add("on"); cur.style.transform = `translate(${x}px,${y}px)`; },
      curOff(){ cur.classList.remove("on"); },
      tap(){ cur.classList.remove("tap"); void cur.offsetWidth; cur.classList.add("tap"); },
    };
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add); else add();
}, [FONT_CSS]);
const p = await ctx.newPage();
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.route(u => !u.href.startsWith("http://127.0.0.1"), r => {
  const h = r.request().url();
  if (h.includes("fonts.googleapis.com")) return r.fulfill({status: 200, contentType: "text/css", body: ""});   // fonts come in with the overlay
  return r.abort();
});

// ---------------------------------------------------------------- helpers
const wait = ms => p.waitForTimeout(ms);
const tut = (fn, ...a) => p.evaluate(([fn, a]) => window.__tut[fn](...a), [fn, a]);
const words = t => t.replace(/<[^>]+>/g, "").split(/\s+/).filter(Boolean).length;
const readMs = t => 1500 + words(t) * 300;
const say = async (t, ms) => { await tut("cap", t); await wait(ms == null ? readMs(t) : ms); };
const hush = () => tut("cap", "");
const spot = (sel, pad) => tut("spot", sel, pad);
const DOGS = await (async () => {
  const html = fs.readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
  const F = JSON.parse(html.match(/const DATA = (\{.*?\});\n/s)[1]).fighters;
  return id => F.find(f => f.id === id).img;
})();
let tStart = 0;
const marks = [];
const chapter = async (n, title, sub, ms = 2900) => {
  marks.push({t: (Date.now() - tStart) / 1000, title: (n ? n + ". " : "") + title});
  await hush(); await spot(null); await tut("curOff");
  await tut("card", `<div><div class="k pop">${n ? "CHAPTER " + n : "BARK ARENA"}</div><div class="t pop2">${title.toUpperCase()}</div>${sub ? `<div class="s pop3">${sub}</div>` : ""}</div>`);
  await wait(ms); await tut("card", ""); await wait(450);
};
const center = async sel => { await p.evaluate(s => { const e = document.querySelector(s); if (e) e.scrollIntoView({behavior: "smooth", block: "center"}); }, sel); await wait(850); };
const top = async () => { await p.evaluate(() => window.scrollTo({top: 0, behavior: "smooth"})); await wait(700); };
let curXY = [1100, 650];
const point = async (sel, dx = 0, dy = 0) => {
  const el = p.locator(sel).first(); await el.scrollIntoViewIfNeeded();
  const b = await el.boundingBox(); if (!b) throw new Error("no box " + sel);
  curXY = [b.x + b.width / 2 + dx, b.y + b.height / 2 + dy];
  await tut("cur", curXY[0], curXY[1]); await wait(800);
};
const click = async (sel, dx, dy) => { await point(sel, dx, dy); await tut("tap"); await wait(160); await p.click(sel); await wait(250); };
const steps = async (kicker, title, items, foot, perStep) => {
  const h = `<div class="kk">${kicker}</div><h2>${title}</h2><div class="row">${items.map((s, i) =>
    `<div class="st"><div class="n">${i + 1}</div><div class="ic">${s.icon}</div><h3>${s.h}</h3><p>${s.t}</p></div>`).join("")}</div>${foot ? `<div class="foot">${foot}</div>` : ""}`;
  await tut("steps", h); await wait(900);
  for (let i = 0; i < items.length; i++) { await tut("step", i); await wait(perStep[i]); }
  if (foot) { await tut("step", items.length); await wait(perStep[items.length] || 3500); }
};
const idle = () => p.waitForFunction(() => typeof busy !== "undefined" && !busy, null, {timeout: 20000});

// ---------------------------------------------------------------- recording
await p.goto(W + "/barkarena/"); await wait(1200);
await p.addStyleTag({content: `header img[src*="wordmark"]{display:none!important}`});
await p.evaluate(() => {               // the xrp.cafe embed can't load offline: show a fighter in its place
  const w = document.getElementById("mintWidget");
  if (w) w.innerHTML = '<img src="/pixelscrappy/nfts/259.png" alt="" style="width:240px;height:240px;image-rendering:pixelated;border-radius:18px;border:3px solid #0e1726;margin:10px auto;display:block">';
});
const cdp = await ctx.newCDPSession(p); const frames = []; let fn = 0;
cdp.on("Page.screencastFrame", async f => {
  const file = `${V}/f${String(fn++).padStart(6, "0")}.jpg`;
  fs.writeFileSync(file, Buffer.from(f.data, "base64")); frames.push({t: f.metadata.timestamp * 1000, file});
  try { await cdp.send("Page.screencastFrameAck", {sessionId: f.sessionId}); } catch (e) {}
});
const cast = () => cdp.send("Page.startScreencast", {format: "jpeg", quality: 90, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1});
await cast(); await wait(400);
tStart = Date.now();

// --- intro
await tut("card", `<div><div class="dogs pop"><img src="${DOGS("L8")}"><img src="${DOGS("2715")}"><img src="${DOGS("2723")}"></div>
  <div class="t pop2" style="margin-top:0">BARK ARENA</div><div class="s pop3">How to play — from minting your dog to winning the arena</div></div>`);
marks.push({t: 0, title: "Intro"});
await wait(4200); await tut("card", ""); await wait(500);
await say("Bark Arena is a free fighting game for <b>Pixel Scrappy</b> NFTs on the XRP Ledger.", 4200);
await say("Your dog fights with the <b>traits it really carries</b> — and levels up with you.", 4000);
await say("This guide takes you from <b>zero</b> to your first <b>arena win</b>. Let's go! 🐾", 3800);

// --- 1 wallet
await chapter(1, "Get a wallet", "A free XRPL wallet on your phone");
await steps("Step 1 · your wallet", "Get a free XRPL wallet", [
  {icon: "🦘", h: "Download Joey Wallet", t: "Our pick: free app for iPhone and Android, or a browser extension. <b>Xaman</b> works too."},
  {icon: "🔐", h: "Create your account", t: "Write your secret words on paper. <b>Never share them</b> — nobody from Bark Arena will ever ask."},
  {icon: "💧", h: "Add a little XRP", t: "Buy or send XRP to your new address — enough for the mint and the small XRPL reserve."},
], "💡 Already have an XRPL wallet? Skip to the next chapter.", [4600, 5200, 5000, 3600]);
await tut("steps", "");

// --- 2 mint
await chapter(2, "Mint your Pixel Scrappy", "5,000 dogs · 126 traits · every one fights differently");
await say("Open <b>scrappyxrp.fun/barkarena</b> — everything starts here.", 3600);
await click('a[href="#mint"]');
await wait(900);
await spot("#mint .getfighter", 12);
await say("<b>Get your fighter</b> — your own dog in the ring in 3 steps.", 3800);
await spot("#mint .steps", 10);
await say("Wallet ✔️ · <b>mint a Pixel Scrappy</b> · sign in to Bark Arena.", 3800);
await spot(null);
await steps("Step 2 · your fighter", "Mint on xrp.cafe", [
  {icon: `<img src="${DOGS("2723")}">`, h: "Open the mint", t: "Right on the Bark Arena page, or the <b>Pixel Scrappy</b> collection on <b>xrp.cafe</b>."},
  {icon: "🔗", h: "Connect & mint", t: "Connect your wallet and press <b>Mint</b>. You get a random dog from the collection."},
  {icon: "✅", h: "Approve in your wallet", t: "Check and sign the request in Joey. Seconds later the NFT is <b>in your wallet</b>."},
], "🛒 Prefer a certain look? Buy one on xrp.cafe instead — any Pixel Scrappy can fight.", [4600, 4600, 4800, 4400]);
await tut("steps", "");
await wait(300);
await say("No dog yet? Try the <b>free demo</b> — or ask a holder to <b>lend</b> you one.", 4000);

// --- 3 sign in (the game)
await chapter(3, "Sign in", "game.scrappyxrp.fun — free, no transaction");
await hush(); await tut("curOff");
await p.goto(U + "/"); await wait(900);
try { await cdp.send("Page.stopScreencast"); } catch (e) {}
await cast();
await p.evaluate(() => { S.unlock(); if (!S.on) S.toggle(); });
const tAudio = await p.evaluate(() => new Promise(res => {
  const rec = new MediaRecorder(window.__ac.__msd.stream, {mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 160000});
  window.__chunks = []; window.__rec = rec;
  rec.ondataavailable = e => window.__chunks.push(e.data);
  rec.onstart = () => res(Date.now()); rec.start(250);
}));
await say("Open the game and press <b>Connect wallet</b>.", 2600);
await click("#connectLive");
await spot("#app .card:has(#pickXaman)", 10);
await say("Choose your wallet. We recommend <b>Joey Wallet</b>: the <b>Joey app</b> (scan a QR code) or the <b>Joey extension</b>. Xaman works too.", 5400);
await point("#pickJoeyM");
await say("Signing in only proves the wallet is yours — <b>no transaction, no fee</b>, nothing leaves your wallet.", 5000);
await spot(null); await tut("curOff");
await p.evaluate(([t, a]) => { lsSet('ba_session', {token: t, account: a}); WALLET.login = null; walletSignedIn(t, a); }, [tok(ME), ME]);
await say("Signed in ✔️ — Bark Arena reads which Pixel Scrappys you hold from the ledger…", 2000);
await p.waitForFunction(() => typeof OWNED !== "undefined" && OWNED && OWNED.length >= 4 && !WALLET.loading, null, {timeout: 60000});
await wait(1600);

// --- 4 kennel
await chapter(4, "Your kennel", "Your dogs, their kits and their bond");
await spot(".pick", 10);
await say("Every Pixel Scrappy in your wallet joins your <b>kennel</b>. Sell one and it leaves — with its training.", 4800);
await spot(".pick > button:first-child", 6);
await say("Each dog has 8 traits, but only the <b>3 rarest fight</b>. They make its kit.", 4400);
await say("<b>★</b> marks an active ability — a special move that costs energy. Max one per dog.", 4400);
await say("The <b>Bond</b> level (1–10) grows with every fight this dog wins or loses.", 4200);
await center(".pick + p.mini + p.mini");
await spot(".pick + p.mini + p.mini", 8);
await say("Bond perks: more energy, more health, a second wind, cheaper abilities. <b>The bond stays with the NFT.</b>", 5200);
await top();
await spot(".pnl > div:first-child", 8);
await say("<b>Tickets</b> = ranked fights: 5 a day, +1 for each extra Scrappy you hold (max 10). Unused ones bank up to 15.", 5600);
await spot(".pnl > div:last-child", 8);
await say("Three <b>daily quests</b> give bonus XP. They reset at midnight UTC.", 4000);
await spot("#nameEdit", 6);
await say("Tip: set a <b>player name</b> — it shows on the leaderboard and to your rivals.", 3200);
await click("#nameEdit");
await spot("#nameIn", 6);
await p.locator("#nameIn").pressSequentially("BarkBuddy", {delay: 110});
await click("#nameSave"); await wait(900);
await spot(null);

// --- 5 fighting
await chapter(5, "Your first fight", "Bite · Guard · Taunt · Abilities");
await say("Tap a dog to start a <b>ranked fight</b>. It uses one ticket.", 3200);
await click(".pick > button:first-child");
await p.waitForFunction(() => document.querySelector(".stage") && document.querySelector("#ctrl .acts"), null, {timeout: 15000});
await wait(1800); await tut("curOff");
await spot(".stage", 4);
await say("Your rival is a real Pixel Scrappy from the collection, matched to <b>your bond level</b>.", 4400);
await spot(".hud.l", 6);
await say("Ten rounds. Whoever has <b>more health (in %)</b> at the final bell wins.", 4200);
await say("The ◆ diamonds are <b>energy</b>: you start with 2 and get +1 every round.", 4200);
await spot("#ctrl .acts:not(.abil)", 8);
await say("Every round you both choose a move <b>at the same time</b> — rock-paper-scissors with teeth.", 4800);
await spot('[data-a="bite"]', 6);
await say("🦷 <b>Bite</b>: 4–7 damage. Beats a taunt — but a guard stops it.", 4000);
await spot('[data-a="guard"]', 6);
await say("🛡️ <b>Guard</b>: blocks a bite and snaps back for 2. Loses to a taunt.", 4000);
await spot('[data-a="taunt"]', 6);
await say("🐶 <b>Taunt</b>: +2 energy and 2 chip damage through a guard. Takes extra from a bite.", 4600);
await spot("#ctrl .acts.abil", 6);
await say("And this dog's ability: <b>Moonshot</b> — big damage through a guard, for 6 energy.", 4600);
await spot(null);
const plan = ["taunt", "bite", "guard", "ability", "taunt", "bite", "ability", "guard", "bite", "bite"];
const roundCap = {
  0: "Round 1: a <b>taunt</b> to charge up energy…",
  1: "Now a <b>bite</b>!",
  2: "Expecting a bite back? <b>Guard</b> it.",
  3: "Enough energy — <b>Moonshot!</b> 🚀",
  4: "Watch out: the opponent <b>learns your habits</b>. Mix your moves!",
  6: "From round 7 it's <b>Frenzy</b>: every bite hits harder.",
  8: "Last rounds — play the score.",
};
for (let i = 0; i < 10; i++) {
  await idle();
  const over = await p.evaluate(() => over); if (over) break;
  if (roundCap[i]) await tut("cap", roundCap[i]);
  let mv = plan[i];
  if (mv === "ability" && await p.evaluate(() => !P.actives[0] || P.actives[0].cost > P.energy)) mv = "bite";
  await click(mv === "ability" ? '[data-ab="0"]' : `[data-a="${mv}"]`);
  await wait(600);
  if (roundCap[i]) await wait(Math.max(0, readMs(roundCap[i]) - 2600));
}
await p.waitForFunction(() => over && !busy, null, {timeout: 30000});
await hush(); await tut("curOff"); await wait(2400);
await center("#ctrl .res");
await spot("#ctrl .res", 8);
const won = await p.evaluate(() => verdict());
await say(`${won === "YOU WIN" ? "Victory! 🎉" : won === "YOU LOSE" ? "Lost this one — it still counts." : "A draw!"} Ranked fights give XP: <b>30 for a win, 12 for a loss</b>, +10 against a rarer dog.`, 5600);
await say("XP raises this dog's <b>bond</b> and your <b>trainer level</b> — and climbs the weekly ladder.", 4800);
await spot(null);
await click("#menu"); await wait(800);

// --- 6 arena
await chapter(6, "Arena tournaments", "Three knockout tournaments a day");
await click('[data-t="arena"]'); await wait(1600);
await spot("#app > .card:nth-of-type(2)", 8);
await say("Every day you get <b>3 arena tournaments</b>: quarter-final, semi-final, final. One loss and you're out.", 5200);
await say("Your rivals here are dogs that <b>other players really own</b> — at their real bond level.", 4600);
await spot(null);
await center(".pick");
await say("Pick a <b>squad of up to 3</b>. They fight the rounds in this order.", 3200);
for (const n of [1, 2, 3]) { await click(`.pick > button:nth-child(${n})`); await wait(250); }
await spot(".pick", 8);
await say("Your squad also <b>defends</b> while you're away: when others beat or lose to them, your dogs earn bond XP.", 5400);
await spot(null);
await top();
await spot("#sign", 6);
await say("<b>Sign up</b> to fight live yourself for full XP. Otherwise your squad fights as ghosts for half XP.", 4800);
await click("#sign"); await wait(500); await spot(null);
await center("#runArena");
await click("#runArena");
await p.waitForFunction(() => document.querySelector(".stage") && document.querySelector("#ctrl .acts"), null, {timeout: 20000});
await tut("curOff"); await wait(1600);
await say("The <b>arena stage</b>: same rules, louder crowd.", 3000);
const aplan = ["taunt", "bite", "ability", "guard", "bite", "taunt", "bite", "ability", "bite", "guard"];
for (let i = 0; i < 10; i++) {
  await idle();
  if (await p.evaluate(() => over)) break;
  if (i === 2) await tut("cap", "Arena XP: <b>35 / 60 / 100</b> for 1, 2 or 3 wins — shared across your squad.");
  if (i === 6) await hush();
  let mv = aplan[i];
  if (mv === "ability" && await p.evaluate(() => !P.actives[0] || P.actives[0].cost > P.energy)) mv = "bite";
  await click(mv === "ability" ? '[data-ab="0"]' : `[data-a="${mv}"]`);
  await wait(500);
}
await p.waitForFunction(() => over && !busy, null, {timeout: 30000});
await tut("curOff"); await wait(2200);
await center("#ctrl .res"); await spot("#ctrl .res", 8);
await say("Win all three and you're <b>Champion</b> of the day. 🏆", 3600);
await spot(null); await hush();
await p.evaluate(() => { arenaRun = null; tab = "packs"; menu(); loadPacks(); });
await wait(1400);

// --- 7 packs
await chapter(7, "Packs", "Team up — up to 10 per pack");
await top();
await spot(".pkg", 8);
await say("Join one of 4 <b>packs</b>. They are ranked by <b>wins per member</b> — a small, sharp pack beats a big lazy one.", 5600);
await click('[data-join="moon"]'); await wait(1200);
await spot('.pk.mine', 8);
await say("Joined! You stay in one pack for the whole week. Switching happens on Monday.", 4400);
await spot(null);
await center("#app > .card:nth-of-type(3)");
await spot("#app > .card:nth-of-type(3)", 8);
await say("Leading packs win <b>weekly bonuses</b> for every member: Fang, Hide and Spirit.", 4600);
await spot(null);

// --- 8 fight club
await chapter(8, "Fight Club", "Live duels against real players");
const R1 = RIV[0][0];
const duel = (await call(R1, "/club/create", {dogId: kennels[R1][0].nft_id, open: true})).duel;
await p.evaluate(() => { tab = "club"; menu(); scRefresh().then(() => { if (tab === "club" && !clubMode) menu(); }); });
await wait(1500); await top();
await say("Duel a friend by <b>name</b> or with an <b>invite link</b> — or post an <b>open challenge</b>.", 4600);
await center(".pick"); await click('[data-fcdog]'); await wait(700);
await top();
await spot("[data-scjoin]", 10);
await say("Barkley posted an open challenge. Let's take it! 🥊", 3000);
await click("[data-scjoin]");
let rivalOn = true;
(async () => {
  const mv = ["bite", "guard", "taunt", "bite", "taunt"]; let k = 0;
  while (rivalOn) { await call(R1, "/club/move", {id: duel.id, move: mv[k++ % mv.length]}).catch(() => {}); await new Promise(r => setTimeout(r, 900)); }
})();
await p.waitForFunction(() => clubMode && document.querySelector("#ctrl [data-fc]"), null, {timeout: 20000});
await tut("curOff"); await wait(1800);
await say("Both players have <b>20 seconds</b> per round. The server reveals both moves at once — no peeking.", 4800);
for (const mv of ["taunt", "bite", "guard"]) {
  await p.waitForFunction(() => document.querySelector('#ctrl [data-fc="bite"]:not([disabled])'), null, {timeout: 30000});
  await wait(500);
  await click(`[data-fc="${mv}"]`);
  await wait(2200);
}
await tut("curOff");
await say("Fight Club uses <b>no tickets</b> and gives no XP — just bragging rights and your Club record.", 4600);
rivalOn = false;
await call(R1, "/club/leave", {id: duel.id});
await p.waitForFunction(() => document.querySelector("#fcBack"), null, {timeout: 30000}).catch(() => {});
await wait(1800); await hush();
await p.evaluate(() => { const b = document.getElementById("fcBack"); if (b) b.click(); else { clubMode = false; menu(); } });
await wait(800);

// --- 9 ladder + prizes + chat
await chapter(9, "Ladder & weekly prizes", "Every Monday 00:00 UTC");
await click('[data-t="ladder"]'); await wait(1600);
await spot("#ladderBox", 10);
await say("The weekly <b>ladder</b>: most XP, most wins, longest streak. It resets every Monday.", 4600);
await say("🎁 The <b>top 3 by XP</b> win a Pixel Scrappy NFT — plus the most active member of the best pack.", 5200);
await say("⚓ The final results are sealed with a hash <b>on the XRP Ledger</b>, so nobody can change them.", 5000);
await spot(null);
for (const [a, , , , , ] of RIV.slice(1)) await call(a, "/chat", {text: a === RIV[1][0] ? "gg everyone, the arena final was close 😅" : "who wants a Fight Club duel later? 🥊"});
await click("#chatFab"); await wait(1400);
await spot("#chatBox", 6);
await say("And there's a <b>chat</b> 💬 to find duel partners, borrowers and lenders.", 3600);
await p.locator("#chatBox input").click();
await p.locator("#chatBox input").pressSequentially("just won my first fight! 🐾", {delay: 85});
await p.keyboard.press("Enter"); await wait(2400);
await spot(null);
await p.evaluate(() => { const b = document.querySelector("#chatBox header button"); if (b) b.click(); });
await hush();

// --- outro
await chapter(0, "Quick recap", "", 1);
marks.pop();
await steps("Recap", "From zero to the arena", [
  {icon: "🦘", h: "Wallet + mint", t: "Joey Wallet (or Xaman), then mint a <b>Pixel Scrappy</b> on xrp.cafe."},
  {icon: "🥊", h: "Fight every day", t: "5+ ranked fights, 3 arena tournaments, quests and your pack."},
  {icon: "🏆", h: "Climb the ladder", t: "Top 3 every week win a <b>Pixel Scrappy NFT</b>."},
], null, [2600, 2600, 3200]);
marks.push({t: (Date.now() - tStart) / 1000, title: "Get your fighter"});
await tut("card", `<div><div class="dogs pop"><img src="${DOGS("L19")}"><img src="${DOGS("2724")}"><img src="${DOGS("L4")}"></div>
  <div class="t pop2" style="margin-top:0;font-size:38px">GET YOUR FIGHTER</div>
  <div class="u pop3">scrappyxrp.fun/barkarena</div><div class="s pop3">Free demo · link in the description · subscribe for daily fights 🐾</div></div>`);
await tut("steps", "");
await wait(6500);
const tEnd = Date.now();

// ---------------------------------------------------------------- collect + mux
const b64 = await p.evaluate(() => new Promise(res => {
  window.__rec.onstop = async () => { const blob = new Blob(window.__chunks, {type: "audio/webm"}); const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(",")[1]); fr.readAsDataURL(blob); };
  window.__rec.stop();
}));
await cdp.send("Page.stopScreencast").catch(() => {});
fs.writeFileSync(V + "/game.webm", Buffer.from(b64, "base64"));
await ctx.close(); await br.close(); srv.kill();
const dur = (tEnd - tStart) / 1000;
const use = frames.filter(f => f.t <= tEnd).sort((a, b) => a.t - b.t);
let k = use.findIndex(f => f.t >= tStart); k = Math.max(0, k - 1);
const seq = use.slice(k), lines = [];
seq.forEach((f, i) => { const from = Math.max(f.t, tStart), to = i + 1 < seq.length ? seq[i + 1].t : tEnd;
  if (to > from) lines.push(`file '${f.file}'`, `duration ${((to - from) / 1000).toFixed(4)}`); });
lines.push(`file '${seq[seq.length - 1].file}'`);
fs.writeFileSync(V + "/list.txt", lines.join("\n"));
chiptune(dur, V + "/music.wav");
const gameDelay = Math.max(0, Math.round(tAudio - tStart));
console.log({frames: seq.length, fps: (seq.length / dur).toFixed(1), dur, gameDelay, errs});
execFileSync(FF, ["-y", "-loglevel", "error",
  "-f", "concat", "-safe", "0", "-i", V + "/list.txt",
  "-i", V + "/music.wav", "-i", V + "/game.webm",
  "-filter_complex", `[1:a]volume=0.55[m];[2:a]adelay=${gameDelay}|${gameDelay},volume=1.0[g];[m][g]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[a]`,
  "-map", "0:v", "-map", "[a]", "-t", dur.toFixed(3),
  "-vf", "fps=30,scale=1920:1080:flags=lanczos,format=yuv420p",
  "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart",
  OUT + "/bark-arena-tutorial.mp4"]);
const ts = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
fs.writeFileSync(OUT + "/chapters.txt", marks.map(m => `${ts(m.t)} ${m.title}`).join("\n") + "\n");
console.log(fs.readFileSync(OUT + "/chapters.txt", "utf8"));
console.log("mp4", fs.statSync(OUT + "/bark-arena-tutorial.mp4").size);
bye(0);

// ---------------------------------------------------------------- music
/* A quiet chiptune loop (square bass, triangle octave, square lead every other bar, noise hi-hat), 120 bpm,
   rendered straight to a 44.1 kHz mono WAV with a fade at both ends. */
function chiptune(secs, file){
  const SR = 44100, n = Math.ceil(secs * SR), buf = new Float32Array(n), beat = .25;
  const bass = [55, 55, 65.4, 55, 73.4, 55, 65.4, 49], lead = [440, 523, 587, 659, 587, 523, 659, 784];
  const prog = [1, 1, 1.335, 1.122];                    // bar-wise transpose: I I IV II
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const note = (f, t, d, type, v) => {
    const a = Math.floor(t * SR), len = Math.floor(d * SR);
    for (let i = 0; i < len && a + i < n; i++) {
      const ph = (f * i / SR) % 1, env = Math.min(1, i / (SR * .01)) * Math.exp(-4 * i / len);
      const s = type === "square" ? (ph < .5 ? 1 : -1) : type === "tri" ? 4 * Math.abs(ph - .5) - 1 : rnd() * 2 - 1;
      buf[a + i] += s * v * env;
    }
  };
  for (let i = 0; i * beat < secs; i++) {
    const t = i * beat, bar = Math.floor(i / 8), tr = prog[Math.floor(bar / 2) % 4];
    note(bass[i % 8] * tr, t, .2, "square", .16);
    if (i % 2 === 0) note(bass[i % 8] * tr * 2, t, .09, "tri", .12);
    if (bar % 2 === 1 && i % 2 === 0) note(lead[(i / 2 + bar) % 8] * tr, t, .22, "square", .055);
    note(0, t, .03, "noise", i % 2 ? .035 : .06);
  }
  const fade = SR * 2;
  for (let i = 0; i < n; i++) { const g = Math.min(1, i / (SR * .5), (n - i) / fade); buf[i] *= g; }
  const out = Buffer.alloc(44 + n * 2);
  out.write("RIFF", 0); out.writeUInt32LE(36 + n * 2, 4); out.write("WAVEfmt ", 8); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(SR, 24); out.writeUInt32LE(SR * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write("data", 36); out.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(buf[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, out);
}
