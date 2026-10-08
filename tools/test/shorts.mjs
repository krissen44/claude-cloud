// Shorts factory end to end: a Club duel → public/kit/factory.mjs records clips → uploaded → /admin lists them
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import { createHmac } from "node:crypto";
const S = process.argv[2], D = S + "/dataShorts", U = "http://127.0.0.1:3981";
fs.rmSync(D, {recursive:true, force:true}); fs.mkdirSync(D, {recursive:true}); fs.writeFileSync(D + "/session.secret", "testsecret");
const tok = a => { const b0 = Buffer.from(JSON.stringify({a, exp:2e9})).toString("base64url"); return b0 + "." + createHmac("sha256", "testsecret").update(b0).digest("base64url"); };
const A = "rAAAplayer111111111111111111", B = "rBBBplayer222222222222222222";
const srv = spawn("node", [new URL("./season-mock.mjs", import.meta.url).pathname], {env:{...process.env, PORT:"3981", DATA_DIR:D, ISSUER:"rI", TAXON:"369", ADMIN_KEY:"adm"}, stdio:["ignore", fs.openSync(S + "/shorts-srv.log", "w"), fs.openSync(S + "/shorts-srv.log", "a")]});
const bye = c => { try { srv.kill(); } catch {} process.exit(c); };
setTimeout(() => { console.log("TIMEOUT"); bye(1); }, 600000);
await new Promise(r => setTimeout(r, 1300));
const call = async (who, path, body) => (await fetch(U + "/api" + path, {method: body ? "POST" : "GET", headers:{authorization:"Bearer " + tok(who), "content-type":"application/json"}, body: body && JSON.stringify(body)})).json();
const realFetch = globalThis.fetch;    // the server closes idle keep-alive sockets during the long factory run: retry once
globalThis.fetch = async (u, o = {}) => { for (let i = 0; ; i++) { try { return await realFetch(u, o); } catch (e) { if (i >= 4) throw e; await new Promise(r => setTimeout(r, 300)); } } };
const ok = (c, m) => console.log((c ? "PASS " : "FAIL ") + m);
await call(A, "/profile", {name: "Alpha"}); await call(B, "/profile", {name: "BarkBoss"});
const kA = await call(A, "/me/kennel"), kB = await call(B, "/me/kennel");
const d = (await call(A, "/club/create", {dogId: kA.nfts[2].nft_id, opponent: "BarkBoss"})).duel;
await call(B, "/club/join", {id: d.id, dogId: kB.nfts[1].nft_id});
const mv = ["bite", "taunt", "guard", "bite", "ab0", "bite"];
for (let i = 0; i < 12; i++){ await call(A, "/club/move", {id: d.id, move: mv[i % 6]}); if ((await call(B, "/club/move", {id: d.id, move: mv[(i + 3) % 6]})).duel.status === "done") break; }
// funnel pings from the website + a player's source
for (const ev of ["view", "view", "mintview", "mint", "play"]) await fetch(U + "/api/public/hit", {method: "POST", body: JSON.stringify({src: "tt", ev})});
await call(B, "/src", {src: "tt", at: Date.now()});
const fun = await (await fetch(U + "/api/admin/funnel?key=adm")).json();
ok(fun.days[0].src.tt.view === 2 && fun.days[0].src.tt.mint === 1 && fun.players.tt.players === 1, "funnel counts website hits and new players by source");
// run the factory (2 clips: the duel + one exhibition)
fs.copyFileSync(new URL("../../public/kit/factory.mjs", import.meta.url), new URL("./factory.run.mjs", import.meta.url));
const t0 = Date.now();
try {
  execFileSync("node", [new URL("./factory.run.mjs", import.meta.url).pathname], {stdio: "inherit", env: {...process.env, GAME_URL: U, ADMIN_KEY: "adm", CLIPS: "2",
    WORK_DIR: S + "/shorts-work", STATE_FILE: S + "/shorts-state.json", FFMPEG: process.env.FFMPEG || "ffmpeg", KEEP_WORK: "1"}, timeout: 500000});
} catch (e) { console.log("factory exit", e.status); }
console.log("factory took", Math.round((Date.now() - t0) / 1000), "s");
const list = (await (await fetch(U + "/api/admin/clips?key=adm")).json()).clips;
ok(list.length === 2, "two clips listed in /admin (" + list.map(c => c.name + " " + c.kind + " " + c.seconds + "s " + c.fps + "fps").join(", ") + ")");
for (const c of list) console.log(" ·", c.name, "|", c.story, "|", c.mb, "MB\n   YT:", JSON.stringify(c.youtube), "\n   TT:", JSON.stringify(c.tiktok), "\n   IG:", JSON.stringify(c.instagram), "\n   comments:", c.comment, "|", c.commentTT);
for (const c of list) ok(!/undefined|null|NaN|\[object| a [AEIOU]/.test(JSON.stringify([c.youtube, c.tiktok, c.instagram, c.comment, c.commentTT])), c.name + ": no broken placeholders or 'a Uncommon' in the texts");
const v = await fetch(U + `/api/admin/clips/file?key=adm&name=${list[0].name}.mp4`);
fs.writeFileSync(S + "/clip0.mp4", Buffer.from(await v.arrayBuffer()));
const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height", "-show_entries", "format=duration", "-of", "compact", S + "/clip0.mp4"]).toString();
console.log(probe.trim());
ok(/width=1080\|height=1920/.test(probe) && /codec_type=audio/.test(probe), "MP4 is 1080×1920 with sound");
// the TikTok cut: own file, shorter, captions without crypto words
for (const c of list){
  ok(!!c.tt && c.tt.seconds > 3, `${c.name}: TikTok cut ${c.tt && c.tt.seconds}s vs YouTube ${c.seconds}s ("${c.tt && c.tt.hook}")`);
  ok(!/xrp|nft|crypto|ledger|mint|web3/i.test(c.tiktok + c.instagram + c.commentTT), `${c.name}: TikTok/Instagram texts free of crypto words`);
  ok(/xrp ledger/i.test(c.youtube.description), `${c.name}: YouTube text keeps the NFT/XRPL pitch`);
}
const tv = await fetch(U + `/api/admin/clips/file?key=adm&name=${list[0].name}-tt.mp4`);
fs.writeFileSync(S + "/clip0-tt.mp4", Buffer.from(await tv.arrayBuffer()));
const ptt = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "compact", S + "/clip0-tt.mp4"]).toString();
ok(/width=1080\|height=1920/.test(ptt) && /codec_type=audio/.test(ptt), "TikTok MP4 is 1080×1920 with sound");
const rg = await fetch(U + `/api/admin/clips/file?key=adm&name=${list[0].name}.mp4`, {headers: {range: "bytes=0-99"}});
ok(rg.status === 206 && (await rg.arrayBuffer()).byteLength === 100, "range requests for the video player");
ok((await fetch(U + `/api/admin/clips?key=wrong`)).status === 403, "clips need the admin key");
const pst = await (await fetch(U + "/api/admin/clips/posted?key=adm", {method: "POST", body: JSON.stringify({name: list[0].name, platform: "tiktok", on: true})})).json();
ok(pst.posted && pst.posted.tiktok, "mark as posted");
for (const [i, t] of [[0, 1], [1, 5], [2, 12], [3, 999]]) execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-sseof", t === 999 ? "-1.5" : "-0", ...(t === 999 ? [] : ["-ss", String(t)]), "-i", S + "/clip0.mp4", "-frames:v", "1", "-vf", "scale=360:640", S + `/clip0-${i}.jpg`]);
const { chromium } = await import("playwright");
const br = await chromium.launch({executablePath: process.env.CHROMIUM || undefined}); const errs = [];
const ad = await br.newPage({viewport: {width: 1100, height: 1400}}); ad.on("pageerror", e => errs.push("admin: " + e.message));
await ad.route(u => !u.href.startsWith(U), r => r.abort());
await ad.goto(U + "/admin?key=adm"); await ad.waitForSelector(".clip video", {timeout: 15000}); await ad.waitForSelector("#funnel table", {timeout: 15000});
await ad.locator("#clips").scrollIntoViewIfNeeded(); await ad.waitForTimeout(500);
const cards = ad.locator(".card:has(#clips), .card:has(#funnel)");
await cards.first().screenshot({path: S + "/admin-clips.png"}); await cards.nth(1).screenshot({path: S + "/admin-funnel.png"});
ok(await ad.locator(".clip").count() === 2, "admin shows the clips");
const web = await br.newPage({viewport: {width: 420, height: 1600}}); web.on("pageerror", e => errs.push("web: " + e.message));
const hits = []; await web.route("**/*", r => { const u = r.request().url(); if (u.includes("/public/hit")) hits.push(r.request().postData()); if (u.startsWith("file:")) r.continue(); else r.abort(); });
await web.goto("file://" + new URL("../../website/barkarena/index.html", import.meta.url).pathname + "?src=tt"); await web.waitForTimeout(800);
ok(await web.locator("#welcome").isVisible() && /TikTok/.test(await web.locator("#welcomeT").innerText()), "website welcomes TikTok visitors");
ok((await web.locator('a[data-ev="play"]').first().getAttribute("href")).includes("src=tt"), "game links carry the source");
ok(hits.some(h => /"ev":"view"/.test(h) && /"src":"tt"/.test(h)), "website counts the visit");
await web.screenshot({path: S + "/web-welcome.png"});
console.log("page errors:", errs.length ? errs : "none");
await br.close();
// what the TikTok cut shows on screen: no crypto words, no wallet tags
{ const br2 = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
  const pt = await br2.newPage({viewport: {width: 450, height: 800}}); await pt.route(u => !u.href.startsWith(U), r => r.abort());
  await pt.goto(U + "/clip?v=tt&id=" + list.find(c => c.replay).replay); await pt.waitForFunction(() => typeof CLIP === "object" && CLIP.state === "ready", null, {timeout: 60000});
  const txt = await pt.locator("#app").innerText();
  ok(!/xrp|ledger|nft|r[1-9A-Za-z]{3,}…/i.test(txt), "TikTok cut on screen: no crypto words, no wallet tags (" + txt.replace(/\s+/g, " ").slice(0, 120) + ")");
  await pt.evaluate(() => CLIP.go()); await pt.waitForFunction(() => CLIP.state === "done", null, {timeout: 120000});
  const end = await pt.locator(".clipend").innerText();
  ok(/Follow for daily fights/.test(end) && !/NFT|XRP/.test(end), "TikTok end card asks for a follow");
  await pt.screenshot({path: S + "/clip-tt-end.png"}); await br2.close(); }
const kit = await fetch(U + "/kit/shorts.sh"); ok(kit.status === 200 && (await kit.text()).includes("barkarena-shorts"), "installer served at /kit/shorts.sh");
bye(0);
