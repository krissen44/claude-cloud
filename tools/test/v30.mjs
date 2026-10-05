// v30: team wallets out of prizes, chat, open Club challenges, borrow requests, kennel bond ranking, name nudge
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createHmac } from "node:crypto";
const S = process.argv[2], D = S + "/dataV30", U = "http://127.0.0.1:3977";
fs.rmSync(D, {recursive:true, force:true}); fs.mkdirSync(D, {recursive:true}); fs.writeFileSync(D + "/session.secret", "testsecret");
const tok = a => { const b0 = Buffer.from(JSON.stringify({a, exp:2e9})).toString("base64url"); return b0 + "." + createHmac("sha256", "testsecret").update(b0).digest("base64url"); };
const A = "rAAAplayer111111111111111111", B = "rBBBplayer222222222222222222", N = "rNoHolderNNNNNNNNNNNNNNNNNN1", I = "rI";
const wkOf = d => { const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); };
const LAST = wkOf(new Date(Date.now() - 7 * 864e5)), NOW = wkOf(new Date());
const row = (a, wk, xp, wins, losses, pack) => ({account: a, week: wk, xp, wins, losses, streak: 3, pack});
const weekly = {};
for (const r of [row(I, LAST, 900, 30, 2, "moon"), row(A, LAST, 700, 20, 5, "moon"), row(B, LAST, 500, 15, 9, "ledger"),
                 row("rCCCplayer333333333333333333", LAST, 300, 10, 20, "moon"), row("rDDDplayer444444444444444444", LAST, 200, 6, 3, "moon"),
                 row(I, NOW, 400, 12, 1, "moon"), row(A, NOW, 300, 9, 2, "moon")]) weekly[r.week + "|" + r.account] = r;
fs.writeFileSync(D + "/store.json", JSON.stringify({players: {}, weekly, holdings: {}, profiles: {[I]: {name: "Scrappy"}}}));
const srv = spawn("node", [new URL("./season-mock.mjs", import.meta.url).pathname], {env:{...process.env, PORT:"3977", DATA_DIR:D, ISSUER:"rI", TAXON:"369", ADMIN_KEY:"adm", XUMM_API_KEY:"k", XUMM_API_SECRET:"s"}, stdio:["ignore","ignore","pipe"]});
setTimeout(() => { console.log("TIMEOUT"); srv.kill(); process.exit(1); }, 180000);
await new Promise(r => setTimeout(r, 1300));
const call = async (who, path, body) => { const r = await fetch(U + "/api" + path, {method: body ? "POST" : "GET", headers:{authorization:"Bearer " + tok(who), "content-type":"application/json"}, body: body && JSON.stringify(body)}); return {status: r.status, ...(await r.json())}; };
const ok = (c, m) => console.log((c ? "PASS " : "FAIL ") + m);

// --- team: issuer is #1 but takes no prize, and doesn't count for its pack
const season = await (await fetch(U + "/api/admin/season?key=adm")).json();
const wk = season.weeks.find(w => w.week === LAST);
console.log("prizes:", JSON.stringify(wk.prizes.map(p => p.place + "=" + p.name)));
ok(wk.prizes[0].account === A && !wk.prizes.some(p => p.account === I), "issuer skipped, A gets 1st");
ok(wk.top[0].account === I && wk.top[0].team === true, "issuer stays in the standings, marked team");
const moon = wk.packs.find(p => p.id === "moon");
ok(moon.members === 3 && moon.wins === 36, "team rows don't count for the pack (moon " + moon.members + " members, " + moon.wins + " wins)");
const lad = await call(A, "/ladder");
ok(lad.xp[0].team === true && !lad.xp[1].team, "ladder marks the team row");
const board = await (await fetch(U + "/api/public/board")).json();
ok(board.xp[0].team === true, "public board marks the team row");

// --- chat
await call(A, "/profile", {name: "Alpha"}); await call(B, "/profile", {name: "BarkBoss"}); await call(N, "/profile", {name: "Newbie"});
for (const x of [A, B, N]) await call(x, "/me/kennel");
let r = await call(A, "/chat", {text: "Hello arena! Who wants a duel?"}); ok(r.ok, "plain message");
r = await call(A, "/chat", {text: "second"}); ok(r.status === 429 && r.error === "slow_down", "rate limit");
r = await call(B, "/chat", {text: "free xrp at https://evil-airdrop.com/claim"}); ok(r.error === "no_links", "foreign link blocked");
r = await call(B, "/chat", {text: "claim at evil-drop.xyz now"}); ok(r.error === "no_links", "bare domain blocked");
await new Promise(r => setTimeout(r, 4100));
r = await call(B, "/chat", {text: "Board is on scrappyxrp.fun/barkarena and my dog on xrp.cafe — gg e.g. nice.try"}); ok(r.ok, "own sites + normal dots allowed");
await new Promise(r => setTimeout(r, 4100));
r = await call(B, "/chat", {text: "my seed is sn3nxiW7v8KXzPzAqzyHXbSSKNuN9"}); ok(r.error === "no_secrets", "family seed blocked");
r = await call(N, "/chat", {text: "<b>hi</b> ‮ reversed"}); ok(r.ok, "html posted as text");
let c = await call(A, "/chat?since=0");
ok(c.msgs.length === 3 && c.msgs.every(m => !m.a), "3 messages, no wallets in the public feed");
ok(c.msgs[2].text.includes("<b>hi</b>") && !c.msgs[2].text.includes("‮"), "control chars stripped, html kept as text");
const adm = await (await fetch(U + "/api/admin/chat/mute?key=adm", {method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({account: N, on: true})})).json();
ok(adm.mute.includes(N), "admin mute");
await new Promise(r => setTimeout(r, 4100));
r = await call(N, "/chat", {text: "still here?"}); ok(r.status === 403 && r.error === "muted", "muted can't write");
await fetch(U + "/api/admin/chat/mute?key=adm", {method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({account: N, on: false})});
const del = await (await fetch(U + "/api/admin/chat/del?key=adm", {method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({id: c.msgs[2].id})})).json();
ok(del.msgs.length === 2, "admin delete");

// --- open Club challenge
const kA = await call(A, "/me/kennel");
r = await call(A, "/club/create", {dogId: kA.nfts[0].nft_id, open: true}); ok(r.duel && r.duel.open, "open challenge created");
let me = await call(B, "/club/me"); ok(me.lobby.length === 1 && me.lobby[0].a.name === "Alpha", "B sees it in the lobby");
me = await call(A, "/club/me"); ok(me.lobby.length === 0, "A doesn't see its own in the lobby");
c = await call(B, "/chat?since=0"); ok(c.msgs.some(m => m.sys && /open Fight Club challenge/.test(m.text)), "chat announces it");

// --- borrow requests
r = await call(N, "/lend/seek", {on: true}); ok(r.seeking === true, "non-holder joins the list");
r = await call(B, "/lend/seek", {on: true}); ok(r.error === "borrower_holds", "holder can't ask");
const lA = await call(A, "/lend"); ok(lA.seekers.length === 1 && lA.seekers[0].name === "Newbie", "holders see the seeker");
c = await call(B, "/chat?since=0"); ok(c.msgs.some(m => m.sys && /Newbie is looking/.test(m.text)), "chat announces the request");
r = await call(A, "/lend", {dogId: kA.nfts[1].nft_id, to: "Newbie", days: 3}); ok(r.ok, "A lends to Newbie");
ok((await call(A, "/lend")).seekers.length === 0, "seeker drops off once borrowing");

// --- UI
const br = await chromium.launch({executablePath: process.env.CHROMIUM || undefined}); const errs = [];
async function player(acct, w = 420){
  const p = await br.newPage({viewport:{width:w,height:1000}});
  p.on("pageerror", e => errs.push(acct.slice(0,6) + ": " + e.message)); p.on("dialog", d => d.accept());
  await p.route(u => !u.href.startsWith(U), rt => rt.abort());
  await p.goto(U + "/"); await p.evaluate(([t, a]) => localStorage.setItem("ba_session", JSON.stringify({token:t, account:a})), [tok(acct), acct]);
  await p.reload(); await p.waitForFunction(() => OWNED && !WALLET.loading, null, {timeout:20000}); await p.waitForTimeout(800);
  return p;
}
const pa = await player(A, 900);
await pa.evaluate(() => { const ids = OWNED.map(f => f.id); const set = (i, l, w, ls) => Object.assign(SAVE.dog(ids[i]), {lvl:l, xp:20, w, l:ls});
  set(0, 3, 5, 4); set(1, 8, 30, 6); set(2, 6, 12, 7); menu(); });
const names = await pa.locator(".pick button b").allInnerTexts();
console.log("kennel order:", JSON.stringify(names.slice(0, 3)));
ok(/^🥇/.test(names[0]) && /^🥈/.test(names[1]), "kennel ranked by bond with medals");
await pa.locator(".pick").first().scrollIntoViewIfNeeded();
await pa.screenshot({path: S + "/v30-kennel.png", fullPage: true});
await pa.click("#chatFab"); await pa.waitForSelector("#chatBox");
await pa.fill("#chatBox input", "Anyone up for the Club? 🥊"); await pa.click("#chatBox form button");
await pa.waitForTimeout(800);
ok((await pa.locator("#chatList").innerText()).includes("Anyone up for the Club"), "chat send from the page");
await pa.screenshot({path: S + "/v30-chat.png"});
const pb = await player(B);
await pb.click('[data-t="club"]'); await pb.locator("[data-fcdog]").first().click(); await pb.waitForTimeout(3500);
ok((await pb.locator("#scList").innerText()).includes("OPEN CHALLENGES"), "B's Club tab lists open challenges");
await pb.screenshot({path: S + "/v30-club.png", fullPage: true});
const fab = await pb.locator("#chatFab").innerText(); ok(/\d/.test(fab), "unread badge on the chat button (" + fab.replace(/\s/g,"") + ")");
// name nudge after a ranked win (a player without a name)
const pq = await player("rQQQplayer555555555555555555");
await pq.locator("[data-f]").first().click(); await pq.waitForSelector(".stage");
ok(!(await pq.locator("#chatFab").count()), "chat hidden in the ring");
await pq.evaluate(() => { isRanked = true; E.hp = 0; over = true; lastGain = {xp:30, levels:[]}; renderControls(); });
ok(await pq.locator("#nameNudge").count() === 1, "name nudge after a win");
await pq.locator("#ctrl").screenshot({path: S + "/v30-nudge.png"});
await pq.click("#nameNudge"); ok(await pq.locator("#nameIn").count() === 1, "nudge opens the name editor");
// non-holder: borrow card
const pn = await player("rNoHolderMMMMMMMMMMMMMMMMMM2");
ok((await pn.locator("body").innerText()).includes("BORROW A SCRAPPY"), "non-holder sees the borrow card");
await pn.screenshot({path: S + "/v30-borrow.png", fullPage: true});
// admin: treasury by rarity, prizes pre-picked rarest first, send all in a row
const tre = (await (await fetch(U + "/api/admin/season?key=adm")).json()).treasury;
console.log("treasury:", tre.map(n => "#" + n.token + " " + n.rarity).join(", "));
ok(tre.find(n => n.token === 104).rarity === "Mythic" && tre.every(n => n.rank > 0), "treasury carries rarity");
const pad = await br.newPage({viewport:{width:1200,height:1000}}); pad.on("pageerror", e => errs.push("admin: " + e.message)); pad.on("dialog", d => d.accept());
await pad.goto(U + "/admin?key=adm"); await pad.waitForSelector("[data-sendall]", {timeout:15000});
const picks = await pad.$$eval("select[data-nft]", ss => ss.map(s => s.dataset.nft.split("|")[1] + "=" + s.options[s.selectedIndex].text));
console.log("picks:", JSON.stringify(picks));
ok(/^1=#104 · Mythic/.test(picks[0]) && /^2=#103 · Epic/.test(picks[1]) && /^3=#102 · Rare/.test(picks[2]), "rarest to 1st, then 2nd, 3rd");
await pad.screenshot({path: S + "/v30-admin-prizes.png", fullPage: true});
await pad.click("[data-sendall]");
await pad.waitForFunction(() => document.querySelectorAll("#season [data-prize]").length === 0, null, {timeout:30000});
const rowsTxt = await pad.locator("#season table").first().innerText();
ok((rowsTxt.match(/offered #10[234]/g) || []).length === 3, "send all: three offers signed one after another");
await pad.locator("#modal #mClose").click().catch(() => {});
await pad.screenshot({path: S + "/v30-admin-sent.png", fullPage: true});
console.log("page errors:", errs.length ? errs : "none");
await br.close(); srv.kill(); process.exit(0);
