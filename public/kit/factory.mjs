// Bark Arena Shorts factory — runs once a day (GitHub Actions, .github/workflows/shorts.yml; or a VPS timer, shorts.sh).
// Picks today's format and fight (one Short a day by default), records it in portrait from https://…/clip
// (picture + the game's own sound, no screen or speaker needed), encodes a 1080×1920 MP4, writes the
// captions for YouTube Shorts, TikTok and Instagram Reels, and uploads everything to the game server,
// where /admin → "📱 Clips" shows it ready to post.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GAME = (process.env.GAME_URL || "https://game.scrappyxrp.fun").replace(/\/$/, "");
const KEY = process.env.ADMIN_KEY || "", N = Math.max(1, Math.min(3, +process.env.CLIPS || 1));
const SITE = process.env.SITE_URL || "https://scrappyxrp.fun/barkarena/";
const WORK = process.env.WORK_DIR || "/opt/barkarena-shorts/work", STATE = process.env.STATE_FILE || "/opt/barkarena-shorts/state.json";
const FF = process.env.FFMPEG || "ffmpeg", MUSIC = process.env.MUSIC !== "0";
if (!KEY) { console.error("ADMIN_KEY missing"); process.exit(1); }
const log = (...a) => console.log(new Date().toISOString(), ...a);
const state = Object.assign({used: [], n: 0, hooks: [], titles: [], leg: 0}, (() => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; } })());
const day = new Date().toISOString().slice(0, 10);

// ---- which fights: underdog wins and close calls travel best (week 1 on YouTube: "Rare vs LEGENDARY… no way",
// "Nobody bet on the rare" led; Legendary-vs-Legendary and Fight Club clips trailed)
const RK = {Common: 0, Uncommon: 1, Rare: 2, Epic: 3, Mythic: 5, Legendary: 5};
const winner = r => r.result === "W" ? r.P : r.result === "L" ? r.E : null;
const upset = r => { const w = winner(r), l = w === r.P ? r.E : r.P; return !!w && (RK[w.def.rarity] || 0) + 2 <= (RK[l.def.rarity] || 0); };
const score = r => (upset(r) ? 6 : 0) + (r.close ? 3 : 0) + Math.max(RK[r.P.def.rarity] || 0, RK[r.E.def.rarity] || 0) / 2
  + ((r.P.def.legendary ? 1 : 0) + (r.E.def.legendary ? 1 : 0) === 1 ? 2 : 0)        // one Legendary against a smaller dog
  + (r.kind === "club" ? 1 : 0) + (r.kind === "arena" ? 1 + (r.stage === 2 ? 2 : 0) : 0) + (r.rounds.length >= 6 ? 1 : 0);
/* One Short a day (YouTube tests every upload on a small audience: several a day take each other's audience, and
   look like mass-produced clips). The format changes through the week so the channel isn't one template on repeat:
   Mon "Weekly Champion" (last week's winner in one of their fights), Wed "Legendary Spotlight", Fri the weekly boss
   against a small dog, Sun "1 HP Club" (the closest win of the week), the other days the best real fight of the day.
   FORMAT=fight|champ|leg|boss|hp1 forces one. */
const wd = new Date().getUTCDay();
let fmt = process.env.FORMAT || {1: "champ", 3: "leg", 5: "boss", 0: "hp1"}[wd] || "fight";
const getJson = async u => { try { const r = await fetch(GAME + u); return r.ok ? await r.json() : null; } catch { return null; } };
const reps = ((await getJson("/api/public/replays?n=40")) || {}).replays || [];
const fresh = reps.filter(r => !state.used.includes(r.id) && r.rounds.length >= 3);
const within = (list, h) => list.filter(r => Date.now() - r.at < h * 3600e3).sort((a, b) => score(b) - score(a));
let picks = [];
if (fmt === "champ") {
  const b = await getJson("/api/public/board"), top = ((b && b.last && b.last.xp) || []).find(x => !x.team);
  const r = top && within(fresh.filter(r => r.result === "W" && r.P.who === top.who), 7 * 24)[0];
  if (r) picks.push({id: r.id, fmt, champ: top.who}); else fmt = "fight";
}
if (fmt === "hp1") {
  const r = within(fresh.filter(r => r.close && r.result === "W"), 7 * 24)[0];
  if (r) picks.push({id: r.id, fmt}); else fmt = "fight";
}
if (fmt === "leg") { state.leg = state.leg % 20 + 1; picks.push({ghost: true, fmt, q: "leg=" + state.leg}); }
if (fmt === "boss") {
  const b = await getJson("/api/public/boss");
  if (b && b.n) picks.push({ghost: true, fmt, q: "boss=" + b.n}); else fmt = "fight";
}
// the best real fight: today's first, else unused real fights of the last week, an exhibition only when there are none
for (const r of [...within(fresh, 36), ...within(fresh, 7 * 24)]) if (picks.length < N && !picks.some(p => p.id === r.id)) picks.push({id: r.id, fmt: "fight"});
while (picks.length < N) picks.push({ghost: true, fmt: "fight"});
picks = picks.slice(0, N);
log("clips to make:", picks.map(p => `${p.fmt}:${p.id || "exhibition"}`).join(", "));

// ---- captions, written for people who have never heard of the game (YouTube Shorts review, 13 Oct):
// · title: one emotion, different every day (template ids rotate through state.titles), no #Shorts (YouTube knows),
//   no game words outsiders don't know (Bond, Mythic, Epic, wallets)
// · description: short — the first sentence is what shows; links aren't clickable in Shorts, so none
// · 3–5 hashtags, gaming/pixel tags first, crypto at most one
// · pinned comment: a question about this very fight, no link
// TikTok and Instagram texts stay free of crypto words (they throttle them).
const pick = a => a[Math.floor(Math.random() * a.length)];
const uniq = a => [...new Set(a)];
const camel = t => "#" + String(t).replace(/^#\d+\s*/, "").replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join("");
const wallet = w => /…/.test(w || "") || /^r[1-9A-HJ-NP-Za-km-z]{6,}/.test(w || "");
const tier = d => d.legendary || /^#\d+ /.test(d.name) && d.rarity === "Legendary" ? "legendary"
  : ({Common: "common", Uncommon: "uncommon", Rare: "rare", Epic: "super rare", Mythic: "ultra rare"}[d.rarity] || "common");
function story(c, plain){
  const st = c.stats || {}, r = c.rep, W = st.w === "P" ? r.P : st.w === "E" ? r.E : null, L = W === r.P ? r.E : r.P;
  const dog = x => /^#\d+ /.test(x.def.name) ? x.def.name.replace(/^#\d+ /, "") : "Scrappy #" + (x.def.token || x.def.name.replace(/\D+/g, ""));
  const name = x => x.who && !(plain && wallet(x.who)) ? `${x.who}'s ${dog(x)}` : dog(x);
  const leg = [r.P, r.E].find(x => /^#\d+ /.test(x.def.name) && x.def.rarity === "Legendary");
  let kind = "fight";
  if (!W) kind = "draw";
  else if (c.fmt === "boss") kind = "boss";
  else if (c.fmt === "champ") kind = "champ";
  else if (st.upset) kind = "upset";
  else if (st.winLowHp && st.winLow < .25) kind = "comeback";
  else if (r.kind === "arena" && r.stage === 2) kind = "final";
  else if (r.kind === "club") kind = "club";
  else if (c.fmt === "leg" && leg) kind = "legendary";
  else if (st.big >= 9) kind = "bigbite";
  else if (st.ko) kind = "ko";
  else if (leg) kind = "legendary";
  const hp = Math.max(1, st.winLowHp | 0);
  const verb = {upset: "took down", comeback: `came back from ${hp} HP to beat`, final: "beat", club: "beat", bigbite: "beat", boss: "beat",
    champ: "beat", ko: "knocked out", legendary: "beat", fight: "beat", draw: "drew with"}[kind];
  const tail = {final: " in the arena final", club: " in a live duel", bigbite: ` with a ${st.big}-damage bite`, ko: ` in round ${st.rounds}`,
    upset: ` — ${an(tier(W.def))} dog against ${an(tier(L.def))} one`, boss: " — the weekly boss", fight: ` in ${st.rounds} rounds`}[kind] || "";
  return {kind, W, L, leg, name, verb, tail, st, hp};
}
const an = w => (/^[aeiou]/i.test(w) ? "an " : "a ") + w;
const cap = w => w[0].toUpperCase() + w.slice(1);
// title templates per story — [id, text]; the factory skips ids used in the last weeks
function titles(t, c){
  const W = t.W, L = t.L, hp = t.hp, legName = t.leg ? t.leg.def.name.replace(/^#\d+ /, "") : "";
  const T = {
    upset: [["u-under", "The underdog nobody believed in 🐶"], ["u-worst", "Worst dog in the game wins?! 😳"], ["u-business", "He had no business winning this 😳"],
      ["u-vs", `${cap(an(tier(W.def)))} dog vs ${an(tier(L.def))} one 🤯`], ["u-picked", "Nobody picked this dog… 🐾"]],
    comeback: [["c-hp", `This ${W.def.legendary || tier(W.def) === "legendary" ? "Legendary" : "tiny dog"} had ${hp} HP left 😳`], ["c-last", "Wait for the last bite 💀"], ["c-never", "Never count this dog out 😤"], ["c-almost", "Almost knocked out… then this 😱"]],
    final: [["f-crown", "One bite from the crown 👑"], ["f-final", "The final nobody saw coming 🏆"]],
    club: [["k-ring", "Two players. One ring. 🥊"], ["k-live", "Real players, live duel — who wins? 🥊"]],
    bigbite: [["b-dmg", `${t.st.big} damage in ONE bite 🦷`], ["b-personal", "That bite was personal 💥"]],
    ko: [["o-mercy", "No mercy. Full knockout 💥"], ["o-ko", "This ends in a KO 💀"], ["o-last", "Wait for the last bite 💀"]],
    legendary: [["l-20", "1 of only 20 Legendaries enters the arena 🌟"], ["l-nobody", "Legendary dog vs nobody 🤯"], ["l-name", legName ? `Meet ${legName}, a hand-drawn Legendary 🌟` : "When the Legendary shows up 🌟"],
      ["l-shows", "When the Legendary shows up 🌟"]],
    boss: W && !W.def.legendary ? [["s-beat", "A tiny dog just beat the boss 😳"], ["s-can", "Can a tiny dog beat the boss? 😳"]] : [["s-can", "Can a tiny dog beat the boss? 😳"], ["s-boss", "The boss doesn't lose. Or does it? 👀"]],
    champ: [["h-champ", "This week's champion 👑"], ["h-best", "How the best player of the week fights 👑"]],
    draw: [["d-draw", "Nobody won this one?! 😳"]],
    fight: [["g-who", "Which dog wins? 👀"], ["g-real", "Pixel dogs, real fights 🐾"], ["g-cute", "Cutest fight you'll see today 🐶"], ["g-last", "Watch the last round 👀"]],
  }[t.kind] || [];
  if (c.fmt === "hp1" && t.W) T.unshift(["p-hp", `Won with ${hp} HP left 😳`], ["p-close", "The closest win of the week 😳"]);
  return T;
}
const QUESTIONS = {upset: ["Would you have bet on the small one? 👇", "Rarity or skill — what won this? 👇"], comeback: ["Would you have guarded or gone all in? 👇", "Best comeback you've seen? 👇"],
  final: ["Who takes the crown next week? 👇"], club: ["Who should step in the ring next? 👇"], bigbite: ["Fair or too strong? 👇"], ko: ["Rematch, or was it decided? 👇"],
  legendary: ["Which Legendary should fight next? 👇"], boss: ["Would you take on the boss? 👇"], champ: ["Can anyone beat them next week? 👇"],
  draw: ["Who deserved the win? 👇"], fight: ["Who would you pick? 👇", "Rate this win 1–10 👇"]};
const TAGS = {fight: ["#pixelart", "#indiegame", "#dogs", "#gaming"], legendary: ["#pixelart", "#pixelartist", "#indiegame", "#legendary"]};
function captions(yt, tt){
  const a = story(yt, false), b = story(tt, true);
  const line = (t, c) => t.W ? `${t.name(t.W)} ${t.verb} ${t.name(t.L)}${t.tail}` : `${t.name(c.rep.P)} and ${t.name(c.rep.E)} fought to a draw`;
  const real = yt.rep.kind !== "ghost";
  const all = titles(a, yt), freshT = all.filter(([id]) => !state.titles.includes(id)), [tid, title] = (freshT.length ? freshT : all)[0] || ["x", yt.hook];
  state.titles = [...state.titles, tid].slice(-25);
  const q = pick(QUESTIONS[a.kind] || QUESTIONS.fight), qt = pick(QUESTIONS[b.kind] || QUESTIONS.fight);
  const ytTags = (a.kind === "legendary" ? TAGS.legendary : [...TAGS.fight, "#XRPL"]).join(" ");
  const legTag = t => t.leg ? [camel(t.leg.def.name)] : [];
  const STORY_TAGS = {upset: "#underdog", comeback: "#comeback", final: "#tournament", club: "#pvp", bigbite: "#critical", ko: "#knockout", legendary: "#legendary", boss: "#bossfight", champ: "#champion"};
  const ttTags = uniq([STORY_TAGS[b.kind], ...legTag(b), "#pixelart", "#indiegame", "#cutedogs", "#fyp"].filter(Boolean)).slice(0, 5).join(" ");
  const igTags = uniq([STORY_TAGS[b.kind], ...legTag(b), "#pixelart", "#indiegame", "#retrogaming", "#dogsofinstagram", "#8bit", "#gamedev"].filter(Boolean)).slice(0, 8).join(" ");
  return {
    hook: yt.hook, line: line(a, yt), question: q, story: a.kind, format: yt.fmt, titleId: tid,
    youtube: {title: title.slice(0, 100),
      description: `${real ? "A real fight from Bark Arena" : "An exhibition fight from Bark Arena"}: a free pixel dog battle game where every fighter is a real NFT. 🐾\n${line(a, yt)}.\n${q}\n\n${ytTags}`},
    tiktok: `${title} 🐾\n${line(b, tt)}.\n${qt}\nPlay free — link in bio\n${ttTags}`,
    instagram: `${title}\n${line(b, tt)}.\n${qt}\nPlay free → link in bio 🐾\n.\n${igTags}`,
    comment: q,
    commentTT: qt,
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
    // Mythic/Legendary fighters wait hidden ('inbound') for an entrance that a cold-open clip never plays: on game builds
    // before the fix (v34.2) one dog stayed invisible in every such Short (owner, 24 Oct). Keep both dogs visible.
    await pg.addStyleTag({content: ".fighter.inbound > .rig, .fighter.inbound > .shd, .fighter.inbound > .lglo, .fighter.inbound > .mglo { visibility: visible !important }"});
    const info = await pg.evaluate(() => ({hook: CLIP.hook, hookId: CLIP.hookId || null, fmt: CLIP.fmt || "", stats: CLIP.stats, rep: {kind: CLIP.rep.kind, stage: CLIP.rep.stage,
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
  const q = (p.id ? "id=" + encodeURIComponent(p.id) : "ghost=1" + (p.q ? "&" + p.q : "")) + `&fmt=${p.fmt}&avoid=${state.hooks.slice(-6).join(",")}`;
  try {
    // YouTube cut (chiptune) and TikTok/Reels cut (no music — add a trending sound in the app — no crypto words):
    // both open on the decisive moment, rewind, and end on it again (~10–14 s, loops into its own start)
    const yt = await record(q, dir + "-yt", MUSIC); yt.fmt = p.fmt;
    const tt = await record(q + "&v=tt", dir + "-tt", false); tt.fmt = p.fmt;
    await put(`${tag}.mp4`, fs.readFileSync(yt.mp4)); await put(`${tag}.jpg`, fs.readFileSync(yt.jpg));
    await put(`${tag}-tt.mp4`, fs.readFileSync(tt.mp4)); await put(`${tag}-tt.jpg`, fs.readFileSync(tt.jpg));
    const meta = {day, made: Date.now(), seconds: yt.seconds, fps: yt.fps, replay: p.id || null, kind: yt.rep.kind,
      stats: yt.stats, rep: yt.rep, ...captions(yt, tt)};
    meta.tt.seconds = tt.seconds;
    await put(`${tag}.json`, JSON.stringify(meta, null, 1));
    log(`clip ${tag} [${p.fmt}]: YouTube ${yt.seconds}s "${meta.youtube.title}" / "${yt.hook}" · TikTok ${tt.seconds}s "${tt.hook}"`);
    if (p.id) state.used.push(p.id);
    if (yt.hookId) state.hooks = [...state.hooks, yt.hookId].slice(-12);
    state.n++; made++;
  } catch (e) { log("clip failed:", e.message); }
  finally { if (!process.env.KEEP_WORK) for (const d of [dir + "-yt", dir + "-tt"]) fs.rmSync(d, {recursive: true, force: true}); }
}
await br.close();
state.used = state.used.slice(-500);
fs.writeFileSync(STATE, JSON.stringify(state));
log(`done: ${made} of ${picks.length} clips`);
process.exit(made ? 0 : 1);
