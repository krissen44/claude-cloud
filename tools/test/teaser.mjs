// Bark Arena teaser: records the real game (video) and its WebAudio output (sound), then muxes an MP4.
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
const S = process.argv[2], FF = process.argv[3];
fs.mkdirSync(S + "/tvid", {recursive: true});
for (const f of fs.readdirSync(S + "/tvid")) fs.unlinkSync(S + "/tvid/" + f);
const srv = spawn("node", [new URL("./live.mjs", import.meta.url).pathname], {env:{...process.env, PORT:"3983", DATA_DIR:S+"/dataAnim", ISSUER:"rI", TAXON:"369"}, stdio:"ignore"});
const bye = c => { try { srv.kill(); } catch(e){} process.exit(c); };
setTimeout(() => { console.log("TIMEOUT"); bye(1); }, 400000);
process.on("uncaughtException", e => { console.log("ERR", e.stack); bye(1); });
await new Promise(r => setTimeout(r, 1200));

const br = await chromium.launch({executablePath: process.env.CHROMIUM || undefined, args:["--autoplay-policy=no-user-gesture-required"]});
const ctx = await br.newContext({viewport:{width:640,height:360}, deviceScaleFactor:2});
// every node that plays to the speakers also plays into a recorder stream
await ctx.addInitScript(() => {
  const orig = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function(t, ...r){
    if (t instanceof AudioDestinationNode){
      const c = this.context;
      if (!c.__msd){ c.__msd = c.createMediaStreamDestination(); window.__ac = c; }
      orig.call(this, c.__msd);
    }
    return orig.call(this, t, ...r);
  };
});
const p = await ctx.newPage();
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.route(u => !u.href.startsWith("http://127.0.0.1"), r => r.abort());
await p.goto("http://127.0.0.1:3983/"); await p.waitForTimeout(500);
await p.addStyleTag({content: `
  html,body{margin:0!important;padding:0!important;overflow:hidden;background:#0e1726}
  h1{display:none!important}
  .stage{position:fixed!important;left:8px;right:8px;top:8px;bottom:8px;height:auto!important;margin:0!important;max-width:none!important}
  .hud .nm b,.snd{display:none!important}
  #card{position:fixed;inset:0;z-index:99;display:grid;place-items:center;text-align:center;color:#fff;
    background:radial-gradient(ellipse at 50% 40%,#2a5ea8 0%,#122a52 55%,#070d1c 100%);font-family:system-ui,sans-serif;opacity:0;transition:opacity .45s}
  #card.on{opacity:1}
  #card .t{font:900 64px/1 system-ui,sans-serif;letter-spacing:.06em;color:#ffd54a;text-shadow:0 0 22px #ff9d00,5px 5px 0 #7a4a00}
  #card .s{font:700 17px system-ui;letter-spacing:.2em;margin-top:14px;color:#cfe6ff}
  #card .u{font:800 20px system-ui;margin-top:22px;color:#fff;padding:8px 18px;border:2px solid #fff;border-radius:999px;display:inline-block}
  #card .k{font:900 26px system-ui;color:#fff;margin-top:6px}
  #card .pop{animation:pop .6s cubic-bezier(.2,1.4,.4,1) both}
  @keyframes pop{from{transform:scale(.4);opacity:0}to{transform:scale(1);opacity:1}}
  #cap{position:fixed;left:0;right:0;bottom:16px;z-index:98;text-align:center;pointer-events:none}
  #cap b{font:900 18px system-ui;color:#fff;background:rgba(14,23,38,.82);padding:7px 16px;border-radius:999px;border:2px solid #ffd54a;opacity:0;transition:opacity .3s}
  #cap b.on{opacity:1}`});
await p.evaluate(() => {
  document.body.insertAdjacentHTML("beforeend", '<div id="card"></div><div id="cap"><b></b></div>');
  S.unlock();
  if (!S.on) S.toggle();
});
// a small chiptune loop under everything (same audio graph, so it is recorded too)
const music = async (secs) => p.evaluate((secs) => {
  const c = window.__ac; if (!c) return "no ctx";
  const g = c.createGain(); g.gain.value = .07; g.connect(c.destination);
  const t0 = c.currentTime + .05, beat = .25;            // 120 bpm, eighth notes
  const bass = [55, 55, 65.4, 55, 73.4, 55, 65.4, 49], lead = [440, 523, 587, 659, 587, 523, 659, 784];
  const note = (f, t, d, type, v) => { const o = c.createOscillator(), e = c.createGain(); o.type = type; o.frequency.value = f;
    e.gain.setValueAtTime(0.0001, t); e.gain.exponentialRampToValueAtTime(v, t + .01); e.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(e); e.connect(g); o.start(t); o.stop(t + d + .02); };
  for (let i = 0; i * beat < secs; i++){
    const t = t0 + i * beat, bar = Math.floor(i / 8);
    note(bass[i % 8] * (bar % 4 === 3 ? 1.335 : 1), t, .2, "square", .9);
    if (i % 2 === 0) note(bass[i % 8] * 2, t, .08, "triangle", .5);
    if (bar % 2 === 1 && i % 2 === 0) note(lead[(i / 2 + bar) % 8], t, .22, "square", .35);
    const n = c.createBufferSource(), b = c.createBuffer(1, 2205, 44100), d = b.getChannelData(0);   // hi-hat
    for (let k = 0; k < d.length; k++) d[k] = (Math.random() * 2 - 1) * (1 - k / d.length);
    n.buffer = b; const hp = c.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 7000;
    const e = c.createGain(); e.gain.value = i % 2 ? .25 : .5; n.connect(hp); hp.connect(e); e.connect(g); n.start(t);
  }
  return "ok";
}, secs);
// start recording the sound
const tAudio = await p.evaluate(() => new Promise(res => {
  const rec = new MediaRecorder(window.__ac.__msd.stream, {mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 160000});
  window.__chunks = []; window.__rec = rec;
  rec.ondataavailable = e => window.__chunks.push(e.data);
  rec.onstart = () => res(Date.now()); rec.start(250);
}));
console.log("music:", await music(70));

const card = async (html, ms) => { await p.evaluate(h => { const c = document.getElementById("card"); c.innerHTML = h; c.classList.add("on"); }, html); await p.waitForTimeout(ms); };
const uncard = async () => { await p.evaluate(() => document.getElementById("card").classList.remove("on")); await p.waitForTimeout(450); };
const cap = async (txt) => p.evaluate(t => { const b = document.querySelector("#cap b"); b.textContent = t; b.classList.toggle("on", !!t); }, txt);
const scene = async (theme, me, foe, rounds, opts = {}) => {
  await p.evaluate(([theme, me, foe]) => {
    arenaRun = theme === "arena" ? {round:0, sq:[], won:0} : null; clubMode = theme === "club";
    const commons = DATA.fighters.filter(f => f.rarity === 'Common');
    const pick = id => id.startsWith("T:") ? {id:"t"+id, name:"Pixel Scrappy", rarity: /laser|brain/.test(id) ? "Mythic" : "Rare", traits:[id.slice(2)], img: commons[2].img}
      : id === "C" ? commons[0] : id === "C2" ? commons[1] : id === "M" ? DATA.fighters.find(f => f.rarity === 'Mythic') : DATA.fighters.find(f => f.id === id);
    startFight(pick(me), pick(foe), false, 5);
    P.hp = P.maxHp = 60; E.hp = E.maxHp = 60; setBars();
    window.scrollTo(0, 0); document.getElementById("ctrl").style.display = "none"; document.querySelector(".card:has(#log)").style.display = "none";
  }, [theme, me, foe]);
  await p.waitForFunction(() => !busy, null, {timeout: 10000}); await p.waitForTimeout(250);
  for (const [a, b] of rounds){
    await p.evaluate(([a, b]) => { P.energy = E.energy = 9;
      const mv = (f, m) => m === "ability" && f.actives[0] ? {type:"ability", a:f.actives[0]} : {type: m === "ability" ? "bite" : m};
      resolve(mv(P, a), mv(E, b)); play(); }, [a, b]);
    await p.waitForFunction(() => !busy, null, {timeout: 15000}); await p.waitForTimeout(200);
  }
  if (opts.ko){ await p.evaluate(() => { E.hp = 0; setBars(); koFx("l"); confetti("l"); S.win(); }); await p.waitForTimeout(2200); }
};

// frames straight from Chrome at device resolution (1280x720), each with its own timestamp
const cdp = await ctx.newCDPSession(p); const frames = []; let fn = 0;
cdp.on("Page.screencastFrame", async f => {
  const file = `${S}/tvid/f${String(fn++).padStart(5, "0")}.jpg`;
  fs.writeFileSync(file, Buffer.from(f.data, "base64")); frames.push({t: f.metadata.timestamp * 1000, file});
  try { await cdp.send("Page.screencastFrameAck", {sessionId: f.sessionId}); } catch(e){}
});
await cdp.send("Page.startScreencast", {format: "jpeg", quality: 92, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1});
await p.waitForTimeout(300);
const tStart = Date.now();
// gameplay only: no title, captions or end card
await scene("meadow", "C", "C2", [["bite","taunt"],["taunt","bite"],["bite","guard"]]);
await scene("meadow", "L10", "C", [["ability","taunt"],["bite","taunt"]]);
await scene("arena", "L8", "M", [["ability","taunt"],["taunt","ability"]]);
await scene("arena", "L19", "L9", [["ability","ability"]]);
await scene("arena", "L6", "C", [["ability","taunt"],["bite","bite"]]);
await scene("club", "L17", "L4", [["ability","ability"],["bite","taunt"]], {ko: true});
const tEnd = Date.now();

// collect the sound
const b64 = await p.evaluate(() => new Promise(res => {
  window.__rec.onstop = async () => { const blob = new Blob(window.__chunks, {type: "audio/webm"}); const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(",")[1]); fr.readAsDataURL(blob); };
  window.__rec.stop();
}));
await cdp.send("Page.stopScreencast");
fs.writeFileSync(S + "/tvid/audio.webm", Buffer.from(b64, "base64"));
await ctx.close(); await br.close(); srv.kill();
// a concat list: every frame shown until the next one arrived
const use = frames.filter(f => f.t <= tEnd).sort((a, b) => a.t - b.t);
let k = use.findIndex(f => f.t >= tStart); k = Math.max(0, k - 1);
const seq = use.slice(k), lines = [];
seq.forEach((f, i) => { const from = Math.max(f.t, tStart), to = i + 1 < seq.length ? seq[i + 1].t : tEnd;
  if (to > from) lines.push(`file '${f.file}'`, `duration ${((to - from) / 1000).toFixed(4)}`); });
lines.push(`file '${seq[seq.length - 1].file}'`);
fs.writeFileSync(S + "/tvid/list.txt", lines.join("\n"));
const dur = (tEnd - tStart) / 1000, aSkip = (tStart - tAudio) / 1000;
console.log({frames: seq.length, fps: (seq.length / dur).toFixed(1), dur, aSkip, audioKB: Math.round(b64.length * .75 / 1024), errs});
execFileSync(FF, ["-y", "-loglevel", "error",
  "-f", "concat", "-safe", "0", "-i", S + "/tvid/list.txt",
  "-ss", Math.max(0, aSkip).toFixed(3), "-i", S + "/tvid/audio.webm",
  "-t", dur.toFixed(3), "-map", "0:v", "-map", "1:a",
  "-vf", "fps=30,scale=1280:720:flags=lanczos,format=yuv420p",
  "-c:v", "libx264", "-preset", "medium", "-crf", "19",
  "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-movflags", "+faststart",
  S + "/bark-arena-gameplay.mp4"]);
console.log("mp4", fs.statSync(S + "/bark-arena-gameplay.mp4").size);
bye(0);
