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

// ---- which fights: underdog wins and close calls travel best (week 1 on YouTube: "Rare vs LEGENDARY… no way",
// "Nobody bet on the rare" led; Legendary-vs-Legendary and Fight Club clips trailed)
const RK = {Common: 0, Uncommon: 1, Rare: 2, Epic: 3, Mythic: 5, Legendary: 5};
const winner = r => r.result === "W" ? r.P : r.result === "L" ? r.E : null;
const upset = r => { const w = winner(r), l = w === r.P ? r.E : r.P; return !!w && (RK[w.def.rarity] || 0) + 2 <= (RK[l.def.rarity] || 0); };
const score = r => (upset(r) ? 6 : 0) + (r.close ? 3 : 0) + Math.max(RK[r.P.def.rarity] || 0, RK[r.E.def.rarity] || 0) / 2
  + ((r.P.def.legendary ? 1 : 0) + (r.E.def.legendary ? 1 : 0) === 1 ? 2 : 0)        // one Legendary against a smaller dog
  + (r.kind === "club" ? 1 : 0) + (r.kind === "arena" ? 1 + (r.stage === 2 ? 2 : 0) : 0) + (r.rounds.length >= 6 ? 1 : 0);
// Real players' fights only: today's best first; if the day was quiet, unused real fights of the last week;
// an exhibition only when there are no real fights left at all.
let picks = [];
try {
  const j = await (await fetch(`${GAME}/api/public/replays?n=40`)).json();
  const fresh = (j.replays || []).filter(r => !state.used.includes(r.id) && r.rounds.length >= 3);
  const best = h => fresh.filter(r => Date.now() - r.at < h * 3600e3).sort((a, b) => score(b) - score(a));
  for (const r of [...best(36), ...best(7 * 24)]) if (picks.length < N && !picks.some(p => p.id === r.id)) picks.push({id: r.id});
} catch (e) { log("playlist:", e.message); }
while (picks.length < N) picks.push({ghost: true});
log("clips to make:", picks.map(p => p.id || "exhibition").join(", "));

// ---- captions: written from what happened in this very fight (who won, how, against whom), with hashtags that
// fit it. YouTube keeps the NFT/XRPL pitch; TikTok and Instagram don't (they throttle crypto content).
const pick = a => a[Math.floor(Math.random() * a.length)];
const uniq = a => [...new Set(a)];
const camel = t => "#" + String(t).replace(/^#\d+\s*/, "").replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join("");
const wallet = w => /…/.test(w || "");
function story(c, plain){
  const st = c.stats || {}, r = c.rep, W = st.w === "P" ? r.P : st.w === "E" ? r.E : null, L = W === r.P ? r.E : r.P;
  const dog = x => x.def.name.replace(/^Pixel Scrappy /, "Scrappy ");
  const name = x => x.who && !(plain && wallet(x.who)) ? `${x.who}'s ${dog(x)}` : dog(x);
  const leg = [r.P, r.E].find(x => /^#\d+ /.test(x.def.name) && x.def.rarity === "Legendary");
  let kind = "fight";
  if (!W) kind = "draw";
  else if (st.upset) kind = "upset";
  else if (st.winLowHp && st.winLow < .25) kind = "comeback";
  else if (r.kind === "arena" && r.stage === 2) kind = "final";
  else if (r.kind === "club") kind = "club";
  else if (st.big >= 9) kind = "bigbite";
  else if (st.ko) kind = "ko";
  else if (leg) kind = "legendary";
  // "<winner> <verb> <loser><tail>"
  const verb = {upset: "took down", comeback: `came back from ${st.winLowHp} HP to beat`, final: "beat", club: "beat", bigbite: "beat",
    ko: "knocked out", legendary: "beat", fight: "beat", draw: "drew with"}[kind];
  const tail = {final: " in the arena final", club: " in a live duel", bigbite: ` with a ${st.big}-damage bite`, ko: ` in round ${st.rounds}`,
    fight: ` in ${st.rounds} rounds`}[kind] || "";
  return {kind, W, L, leg, name, verb, tail, st};
}
const an = w => (/^[aeiou]/i.test(w) ? "an " : "a ") + w;
const STORY_TAGS = {upset: ["#underdog", "#plottwist", "#upset"], comeback: ["#comeback", "#nevergiveup", "#clutch"], final: ["#tournament", "#final", "#champion"],
  club: ["#pvp", "#1v1", "#duel"], bigbite: ["#critical", "#onebite", "#oof"], ko: ["#knockout", "#ko", "#flawless"], legendary: ["#legendary", "#rare"],
  fight: ["#battle", "#whowins"], draw: ["#draw", "#rematch"]};
function comments(t, c, plain){
  const W = t.W, L = t.L, n = x => t.name(x);
  switch (t.kind){
    case "upset": return pick([`${an(W.def.rarity)[0].toUpperCase() + an(W.def.rarity).slice(1)} just beat ${an(L.def.rarity)} 🤯 Would you have bet on ${n(W)}? 👇`, `${n(W)} had no business winning this… or did it? 👇 Rarity or skill?`]);
    case "comeback": return pick([`${n(W)} was down to ${t.st.winLowHp} HP and still won 😤 Would you have guarded or gone all in? 👇`, `${t.st.winLowHp} HP left and still took it 💀➡️👑 Best comeback you've seen? 👇`]);
    case "final": return `${n(W)} takes the arena final 👑 Who takes the crown next? 👇`;
    case "club": return `${n(c.rep.P)} vs ${n(c.rep.E)} — two real players, picked live 🥊 Who should step in the ring next? 👇`;
    case "bigbite": return `${t.st.big} damage in a single bite 🦷 Fair or broken? 👇`;
    case "ko": return `KO in round ${t.st.rounds} 💀 Rematch or was it decided? 👇`;
    case "legendary": return `${t.leg.def.name.replace(/^#\d+ /, "")} is one of only 20 hand-drawn Legendaries 🌟 Which one should fight next? 👇`;
    case "draw": return `A draw?! 😳 Who deserved the win? 👇`;
    default: return pick([`${n(W)} or ${n(L)} — who would you have picked? 👇`, `Rate ${n(W)}'s win 1–10 👇`]);
  }
}
function captions(yt, tt){
  const a = story(yt, false), b = story(tt, true);
  const line = (t, c) => t.W ? `${t.name(t.W)} (${t.W.def.rarity}, Bond ${t.W.lvl}) ${t.verb} ${t.name(t.L)} (${t.L.def.rarity}, Bond ${t.L.lvl})${t.tail}`
    : `${t.name(c.rep.P)} and ${t.name(c.rep.E)} fought to a draw`;
  const real = yt.rep.kind !== "ghost";
  const legTag = t => t.leg ? [camel(t.leg.def.name)] : [];
  const ytTags = uniq(["#Shorts", ...STORY_TAGS[a.kind].slice(0, 2), ...legTag(a), "#PixelScrappy", "#pixelart", "#NFTgame", "#XRPL"]).slice(0, 7).join(" ");
  const ttTags = uniq([...STORY_TAGS[b.kind].slice(0, 2), ...legTag(b), "#pixelart", "#indiegame", "#cutedogs", "#fyp"]).slice(0, 6).join(" ");
  const igTags = uniq([...STORY_TAGS[b.kind], ...legTag(b), "#pixelart", "#indiegame", "#retrogaming", "#dogsofinstagram", "#8bit", "#gamedev"]).slice(0, 10).join(" ");
  const cy = comments(a, yt, false), ct = comments(b, tt, true);
  return {
    hook: yt.hook, line: line(a, yt), question: cy, story: a.kind,
    youtube: {title: `${yt.hook} #Shorts`.slice(0, 100),
      description: `${line(a, yt)}. 🐾\n${cy}\n\n${real ? "A real fight from Bark Arena players" : "An exhibition fight in Bark Arena"} — every fighter is a Pixel Scrappy NFT on the XRP Ledger.\nPlay free & get your fighter: ${SITE}?src=yt\n\n${ytTags}`},
    tiktok: `${tt.hook} ${line(b, tt)} 🐾\n${ct}\nPlay free — link in bio\n${ttTags}`,
    instagram: `${tt.hook}\n${line(b, tt)}.\n${ct}\nPlay free → link in bio 🐾\n.\n${igTags}`,
    comment: `${cy} Play free → scrappyxrp.fun/barkarena 🐾`,
    commentTT: ct,
    tt: {hook: tt.hook, line: line(b, tt), story: b.kind},
  };
}

// ---- recording: frames from Chrome's screencast + the page's WebAudio, muxed by ffmpeg
const br = await chromium.launch({executablePath: process.env.CHROMIUM || undefined, args: ["--autoplay-policy=no-user-gesture-required"]});
fs.mkdirSync(WORK, {recursive: true});
async function record(query, dir, music){
  fs.rmSync(dir, {recursive: true, force: true}); fs.mkdirSync(dir, {recursive: true});
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
    await pg.goto(`${GAME}/clip?${query}`, {waitUntil: "load", timeout: 60000});
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
    if (music) await pg.evaluate(() => {          // a quiet chiptune bed under the fight (same graph, so it's recorded)
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
    execFileSync(FF, ["-y", "-loglevel", "error", "-ss", Math.min(2.2, dur / 3).toFixed(2), "-i", mp4, "-frames:v", "1", "-q:v", "3", jpg]);
    return {...info, mp4, jpg, seconds: +dur.toFixed(1), fps: +(seq.length / dur).toFixed(1)};
  } finally { await ctx.close().catch(() => {}); }
}
const put = async (name, body) => {
  const r = await fetch(`${GAME}/api/admin/clips/upload?key=${encodeURIComponent(KEY)}&name=${name}`, {method: "PUT", body});
  if (!r.ok) throw new Error(`upload ${name}: ${r.status}`);
};

let made = 0;
for (const p of picks){
  const tag = `${day}-${state.n % 1000 + 1}`.replace(/[^0-9a-z-]/g, ""), dir = path.join(WORK, tag);
  const q = p.id ? "id=" + encodeURIComponent(p.id) : "ghost=1";
  try {
    // YouTube cut (full fight, chiptune, mint end card) and TikTok/Reels cut (last rounds, no music — add a trending
    // sound in the app — no crypto words, follow end card): two different files, so neither looks like a re-upload
    const yt = await record(q, dir + "-yt", MUSIC);
    const tt = await record(q + "&v=tt", dir + "-tt", false);
    await put(`${tag}.mp4`, fs.readFileSync(yt.mp4)); await put(`${tag}.jpg`, fs.readFileSync(yt.jpg));
    await put(`${tag}-tt.mp4`, fs.readFileSync(tt.mp4)); await put(`${tag}-tt.jpg`, fs.readFileSync(tt.jpg));
    const meta = {day, made: Date.now(), seconds: yt.seconds, fps: yt.fps, replay: p.id || null, kind: yt.rep.kind,
      stats: yt.stats, rep: yt.rep, ...captions(yt, tt)};
    meta.tt.seconds = tt.seconds;
    await put(`${tag}.json`, JSON.stringify(meta, null, 1));
    log(`clip ${tag}: YouTube ${yt.seconds}s "${yt.hook}" · TikTok ${tt.seconds}s "${tt.hook}"`);
    if (p.id) state.used.push(p.id);
    state.n++; made++;
  } catch (e) { log("clip failed:", e.message); }
  finally { if (!process.env.KEEP_WORK) for (const d of [dir + "-yt", dir + "-tt"]) fs.rmSync(d, {recursive: true, force: true}); }
}
await br.close();
state.used = state.used.slice(-500);
fs.writeFileSync(STATE, JSON.stringify(state));
log(`done: ${made} of ${picks.length} clips`);
process.exit(made ? 0 : 1);
