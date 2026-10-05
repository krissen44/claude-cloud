// Bark Arena Shorts factory — runs on the VPS once a day (systemd timer, see shorts.sh).
// Picks the most watchable fights of the last day, records each in portrait from https://…/clip
// (picture + the game's own sound, no screen or speaker needed), encodes a 1080×1920 MP4, writes the
// captions for YouTube Shorts, TikTok and Instagram Reels, and uploads everything to the game server,
// where /admin → "📱 Clips" shows it ready to post.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GAME = (process.env.GAME_URL || "https://game.scrappyxrp.fun").replace(/\/$/, "");
const KEY = process.env.ADMIN_KEY || "", N = Math.max(1, Math.min(6, +process.env.CLIPS || 3));
const SITE = process.env.SITE_URL || "https://scrappyxrp.fun/barkarena/";
const WORK = process.env.WORK_DIR || "/opt/barkarena-shorts/work", STATE = process.env.STATE_FILE || "/opt/barkarena-shorts/state.json";
const FF = process.env.FFMPEG || "ffmpeg", MUSIC = process.env.MUSIC !== "0";
if (!KEY) { console.error("ADMIN_KEY missing"); process.exit(1); }
const log = (...a) => console.log(new Date().toISOString(), ...a);
const state = (() => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {used: [], n: 0}; } })();
const day = new Date().toISOString().slice(0, 10);

// ---- which fights
const RK = {Common: 0, Uncommon: 1, Rare: 2, Epic: 3, Mythic: 5, Legendary: 5};
const score = r => Math.max(RK[r.P.def.rarity] || 0, RK[r.E.def.rarity] || 0) + (r.P.def.legendary || r.E.def.legendary ? 3 : 0)
  + (r.kind === "club" ? 4 : 0) + (r.kind === "arena" ? 2 + (r.stage === 2 ? 3 : 0) : 0) + (r.close ? 3 : 0) + (r.rounds.length >= 6 ? 1 : 0);
let picks = [];
try {
  const j = await (await fetch(`${GAME}/api/public/replays?n=40`)).json();
  picks = (j.replays || []).filter(r => Date.now() - r.at < 36 * 3600e3 && !state.used.includes(r.id) && r.rounds.length >= 3)
    .sort((a, b) => score(b) - score(a)).slice(0, N).map(r => ({id: r.id}));
} catch (e) { log("playlist:", e.message); }
while (picks.length < N) picks.push({ghost: true});
log("clips to make:", picks.map(p => p.id || "exhibition").join(", "));

// ---- captions (the algorithms like a question, a hook, 3–6 hashtags; the link goes in bio / description)
const pick = a => a[Math.floor(Math.random() * a.length)];
const TAGS = ["#PixelScrappy", "#XRPL", "#NFTgame", "#XRP", "#pixelart", "#indiegame", "#web3gaming", "#dogs", "#NFT", "#cryptogaming"];
const tags = (n, extra = []) => [...extra, ...TAGS.slice().sort(() => Math.random() - .5)].slice(0, n).join(" ");
const QUESTIONS = ["Which dog would you pick? 👇", "Would you have guarded there? 🤔", "Rate this fight 1–10 👇", "Team left or team right? 👇", "Name a better comeback 👇"];
function captions(c){
  const a = c.rep.P, b = c.rep.E, q = pick(QUESTIONS);
  const who = x => x.who ? `${x.who}'s ${x.def.name}` : x.def.name;
  const line = `${who(a)} (${a.def.rarity}) vs ${who(b)} (${b.def.rarity})`;
  return {
    hook: c.hook, line, question: q,
    youtube: {title: `${c.hook} #Shorts`.slice(0, 100),
      description: `${line} — Bark Arena, where every fighter is a Pixel Scrappy NFT on the XRP Ledger. 🐾\n${q}\n\nMint your fighter & play: ${SITE}?src=yt\n\n${tags(5, ["#Shorts"])}`},
    tiktok: `${c.hook} ${q}\nEvery dog is an NFT on the XRP Ledger — mint yours, link in bio 🐾\n${tags(6, ["#fyp"])}`,
    instagram: `${c.hook}\n${line}\n${q}\nMint your fighter → link in bio 🐾\n.\n${tags(8)}`,
    comment: `${q} Mint your own fighter: scrappyxrp.fun/barkarena 🐾`,
  };
}

// ---- recording: frames from Chrome's screencast + the page's WebAudio, muxed by ffmpeg
const br = await chromium.launch({executablePath: process.env.CHROMIUM || undefined, args: ["--autoplay-policy=no-user-gesture-required"]});
fs.mkdirSync(WORK, {recursive: true});
let made = 0;
for (const [i, p] of picks.entries()){
  const tag = `${day}-${state.n % 1000 + 1}`.replace(/[^0-9a-z-]/g, "");
  const dir = path.join(WORK, tag); fs.rmSync(dir, {recursive: true, force: true}); fs.mkdirSync(dir, {recursive: true});
  const ctx = await br.newContext({viewport: {width: 450, height: 800}, deviceScaleFactor: 1.6});
  try {
    await ctx.addInitScript(() => {                 // everything that plays to the speakers also plays into a recorder
      const orig = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function(t, ...r){
        if (t instanceof AudioDestinationNode){ const c = this.context; if (!c.__msd){ c.__msd = c.createMediaStreamDestination(); window.__ac = c; } orig.call(this, c.__msd); }
        return orig.call(this, t, ...r);
      };
    });
    const pg = await ctx.newPage();
    pg.on("pageerror", e => log("page:", e.message));
    await pg.goto(`${GAME}/clip?${p.id ? "id=" + encodeURIComponent(p.id) : "ghost=1"}`, {waitUntil: "load", timeout: 60000});
    await pg.waitForFunction(() => typeof CLIP === "object" && CLIP.state === "ready", null, {timeout: 120000});
    const info = await pg.evaluate(() => ({hook: CLIP.hook, stats: CLIP.stats, rep: {kind: CLIP.rep.kind, stage: CLIP.rep.stage,
      P: {who: CLIP.rep.P.who || null, lvl: CLIP.rep.P.lvl, def: {name: CLIP.rep.P.def.name, rarity: CLIP.rep.P.def.rarity, token: CLIP.rep.P.def.token}},
      E: {who: CLIP.rep.E.who || null, lvl: CLIP.rep.E.lvl, def: {name: CLIP.rep.E.def.name, rarity: CLIP.rep.E.def.rarity, token: CLIP.rep.E.def.token}}}}));
    await pg.evaluate(() => { S.unlock(); if (!S.on) S.toggle(); S.click(); });       // wakes the audio graph
    const tAudio = await pg.evaluate(() => new Promise(res => {
      const rec = new MediaRecorder(window.__ac.__msd.stream, {mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 160000});
      window.__chunks = []; window.__rec = rec; rec.ondataavailable = e => window.__chunks.push(e.data);
      rec.onstart = () => res(Date.now()); rec.start(250);
    }));
    if (MUSIC) await pg.evaluate(() => {          // a quiet chiptune bed under the fight (same graph, so it's recorded)
      const c = window.__ac, g = c.createGain(); g.gain.value = .05; g.connect(c.destination);
      const t0 = c.currentTime + .05, beat = .25, bass = [55, 55, 65.4, 55, 73.4, 55, 65.4, 49], lead = [440, 523, 587, 659, 587, 523, 659, 784];
      const note = (f, t, d, type, v) => { const o = c.createOscillator(), e = c.createGain(); o.type = type; o.frequency.value = f;
        e.gain.setValueAtTime(.0001, t); e.gain.exponentialRampToValueAtTime(v, t + .01); e.gain.exponentialRampToValueAtTime(.0001, t + d); o.connect(e); e.connect(g); o.start(t); o.stop(t + d + .02); };
      for (let i = 0; i * beat < 70; i++){ const t = t0 + i * beat, bar = Math.floor(i / 8);
        note(bass[i % 8] * (bar % 4 === 3 ? 1.335 : 1), t, .2, "square", .9); if (bar % 2 === 1 && i % 2 === 0) note(lead[(i / 2 + bar) % 8], t, .22, "square", .35); }
    });
    const cdp = await ctx.newCDPSession(pg), frames = []; let fn = 0;
    cdp.on("Page.screencastFrame", async f => {
      const file = path.join(dir, `f${String(fn++).padStart(5, "0")}.jpg`);
      fs.writeFileSync(file, Buffer.from(f.data, "base64")); frames.push({t: f.metadata.timestamp * 1000, file});
      try { await cdp.send("Page.screencastFrameAck", {sessionId: f.sessionId}); } catch {}
    });
    await cdp.send("Page.startScreencast", {format: "jpeg", quality: 90, maxWidth: 720, maxHeight: 1280, everyNthFrame: 1});
    await pg.waitForTimeout(400);
    const tStart = Date.now();
    await pg.evaluate(() => CLIP.go());
    await pg.waitForFunction(() => CLIP.state === "done", null, {timeout: 180000, polling: 200});
    const tEnd = Date.now();
    const b64 = await pg.evaluate(() => new Promise(res => {
      window.__rec.onstop = () => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.readAsDataURL(new Blob(window.__chunks, {type: "audio/webm"})); };
      window.__rec.stop();
    }));
    await cdp.send("Page.stopScreencast");
    fs.writeFileSync(path.join(dir, "audio.webm"), Buffer.from(b64, "base64"));
    const use = frames.filter(f => f.t <= tEnd).sort((a, b) => a.t - b.t);
    let k = Math.max(0, use.findIndex(f => f.t >= tStart) - 1);
    const seq = use.slice(k), lines = [];
    seq.forEach((f, j) => { const from = Math.max(f.t, tStart), to = j + 1 < seq.length ? seq[j + 1].t : tEnd;
      if (to > from) lines.push(`file '${f.file}'`, `duration ${((to - from) / 1000).toFixed(4)}`); });
    lines.push(`file '${seq[seq.length - 1].file}'`);
    fs.writeFileSync(path.join(dir, "list.txt"), lines.join("\n"));
    const dur = (tEnd - tStart) / 1000, mp4 = path.join(dir, "clip.mp4"), jpg = path.join(dir, "thumb.jpg");
    execFileSync(FF, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(dir, "list.txt"),
      "-ss", Math.max(0, (tStart - tAudio) / 1000).toFixed(3), "-i", path.join(dir, "audio.webm"),
      "-t", dur.toFixed(3), "-map", "0:v", "-map", "1:a", "-vf", "fps=30,scale=1080:1920:flags=lanczos,format=yuv420p",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-profile:v", "high", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-movflags", "+faststart", mp4]);
    execFileSync(FF, ["-y", "-loglevel", "error", "-ss", "2.2", "-i", mp4, "-frames:v", "1", "-q:v", "3", jpg]);
    const meta = {day, made: Date.now(), seconds: +dur.toFixed(1), fps: +(seq.length / dur).toFixed(1), replay: p.id || null, kind: info.rep.kind,
      stats: info.stats, rep: info.rep, ...captions(info)};
    for (const [file, ext] of [[mp4, "mp4"], [jpg, "jpg"]]) {
      const r = await fetch(`${GAME}/api/admin/clips/upload?key=${encodeURIComponent(KEY)}&name=${tag}.${ext}`, {method: "PUT", body: fs.readFileSync(file)});
      if (!r.ok) throw new Error(`upload ${ext}: ${r.status}`);
    }
    const r = await fetch(`${GAME}/api/admin/clips/upload?key=${encodeURIComponent(KEY)}&name=${tag}.json`, {method: "PUT", body: JSON.stringify(meta, null, 1)});
    if (!r.ok) throw new Error("upload json: " + r.status);
    log(`clip ${tag}: ${meta.seconds}s, ${meta.fps} fps, "${meta.hook}"`);
    if (p.id) state.used.push(p.id);
    state.n++; made++;
  } catch (e) { log("clip failed:", e.message); }
  finally { await ctx.close().catch(() => {}); if (!process.env.KEEP_WORK) fs.rmSync(dir, {recursive: true, force: true}); }
}
await br.close();
state.used = state.used.slice(-500);
fs.writeFileSync(STATE, JSON.stringify(state));
log(`done: ${made} of ${picks.length} clips`);
process.exit(made ? 0 : 1);
