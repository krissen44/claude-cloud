/**
 * Bark Arena — Node.js server for Hostinger (or any Node host).
 * Serves the game at / and the API at /api/*, from the same address.
 * No npm packages needed: Node 20+ has fetch, Request and Response built in.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import worker from "./worker.js";
import { loadEngine } from "./fight-engine.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/* Data lives OUTSIDE the app folder: Hostinger replaces the app folder on every
   deploy, so anything stored inside it would be wiped by an update. */
const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), "bark-arena-data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const FILE = path.join(DATA_DIR, "store.json");
const SAVE_DIR = path.join(DATA_DIR, "saves");
fs.mkdirSync(SAVE_DIR, { recursive: true });

let db = { players: {}, weekly: {}, holdings: {} };
try { db = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}
db.holdings = db.holdings || {};
db.profiles = db.profiles || {};
db.arenaReg = db.arenaReg || {};      // account -> {day, ids}: today's arena squad
db.defense = db.defense || {};        // account -> [{id, xp, won, vs, at}]: bond XP earned while away
db.defenseDay = db.defenseDay || {};  // "nftId|day" -> XP credited that day (cap)
db.clubRec = db.clubRec || {};        // account -> {w, l, d}: Fight Club record
db.packs = db.packs || {};
db.results = db.results || {};        // week -> frozen results {json, sha256, anchor, prizes}
let dirty = false;
function flush() {
  if (!dirty) return;
  fs.writeFileSync(FILE + ".tmp", JSON.stringify(db));
  fs.renameSync(FILE + ".tmp", FILE);              // atomic: never a half-written file
  dirty = false;
}
setInterval(flush, 2000).unref();
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { try { flush(); } finally { process.exit(0); } });

const STORE = {
  async ping() { return true; },
  async seen(a, t) { db.players[a] = t; dirty = true; },
  async weekly(a, wk, wins, xp, streak, t, losses) {
    const k = wk + "|" + a, r = db.weekly[k] || { account: a, week: wk, wins: 0, xp: 0, streak: 0 };
    r.wins = Math.max(r.wins, wins); r.xp = Math.max(r.xp, xp); r.streak = Math.max(r.streak, streak); r.updated = t;
    r.losses = Math.max(r.losses || 0, losses || 0);
    db.weekly[k] = r; dirty = true;
  },
  async top(wk, col) {
    return Object.values(db.weekly).filter(r => r.week === wk && r[col] > 0)
      .sort((a, b) => b[col] - a[col]).slice(0, 10).map(r => ({ account: r.account, v: r[col] }));
  },
  async rank(wk, col, a) {
    const k = db.weekly[wk + "|" + a]; if (!k || !(k[col] > 0)) return null;
    return { rank: 1 + Object.values(db.weekly).filter(r => r.week === wk && r[col] > k[col]).length, v: k[col] };
  },
  async count(wk) { return Object.values(db.weekly).filter(r => r.week === wk).length; },
  async holdings(a, tokens, t, dogs) { db.holdings[a] = { tokens, dogs: dogs || [], updated: t }; dirty = true; },
  async allHoldings() { return db.holdings; },
  async clubAdd(a, k) { const r = db.clubRec[a] = db.clubRec[a] || { w: 0, l: 0, d: 0 }; r[k] = (r[k] || 0) + 1; dirty = true; },
  async clubGet(a) { return db.clubRec[a] || { w: 0, l: 0, d: 0 }; },
  async arenaRegSet(a, day, ids) { db.arenaReg[a] = { day, ids }; dirty = true; },
  async arenaRegAll() { return db.arenaReg; },
  async defenseAdd(owner, e, dayKey, cap) {
    const used = db.defenseDay[dayKey] || 0, xp = Math.max(0, Math.min(e.xp, cap - used));
    if (!xp) return 0;
    db.defenseDay[dayKey] = used + xp;
    (db.defense[owner] = db.defense[owner] || []).push({ ...e, xp });
    for (const k of Object.keys(db.defenseDay)) if (k.slice(-10) < dayKey.slice(-10)) delete db.defenseDay[k];   // keep only today
    dirty = true; return xp;
  },
  async defenseGet(a) { return db.defense[a] || []; },
  async defenseClear(a, upTo) { db.defense[a] = (db.defense[a] || []).filter(e => e.at > upTo); if (!db.defense[a].length) delete db.defense[a]; dirty = true; },
  /* Display names: unique regardless of case. */
  async profiles() { return db.profiles; },
  async profileSet(a, name) {
    if (name) {
      const lc = name.toLowerCase();
      if (Object.entries(db.profiles).some(([o, p]) => o !== a && p.name.toLowerCase() === lc)) return false;
      db.profiles[a] = { name, updated: Date.now() };
    } else delete db.profiles[a];
    dirty = true; return true;
  },
  async packGet(a) { return db.packs[a] || null; },
  async packSet(a, rec) { db.packs[a] = rec; dirty = true; },
  async packAll() { return Object.entries(db.packs).map(([account, r]) => ({ account, ...r })); },
  async weeklyPack(a, wk, pack) {
    const k = wk + "|" + a, r = db.weekly[k] || { account: a, week: wk, wins: 0, xp: 0, streak: 0, updated: Date.now() };
    r.pack = pack || null; db.weekly[k] = r; dirty = true;
  },
  async weekRows(wk) { return Object.values(db.weekly).filter(r => r.week === wk); },
  async resultGet(wk) { return db.results[wk] || null; },
  async resultSet(wk, rec) { db.results[wk] = rec; dirty = true; },
  async taken() { return [...new Set(Object.values(db.holdings).flatMap(h => h.tokens))]; },
  /* Full game saves, one file per wallet (accounts are validated r-addresses). */
  async saveGet(a) { try { return JSON.parse(fs.readFileSync(path.join(SAVE_DIR, a + ".json"), "utf8")); } catch { return null; } },
  async saveSet(a, data, t) {
    const f = path.join(SAVE_DIR, a + ".json");
    fs.writeFileSync(f + ".tmp", JSON.stringify({ data, updated: t }));
    fs.renameSync(f + ".tmp", f);
  },
  async saveAll() {
    const out = {};
    for (const f of fs.readdirSync(SAVE_DIR)) if (f.endsWith(".json")) {
      try { out[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(SAVE_DIR, f), "utf8")); } catch {}
    }
    return out;
  },
  async dump() { return { players: db.players, weekly: Object.values(db.weekly), holdings: db.holdings, packs: db.packs, profiles: db.profiles, results: db.results }; },
};

/* In-memory cache with expiry, standing in for Cloudflare KV. */
const kv = new Map();
const KV = {
  async get(k, type) { const e = kv.get(k); if (!e || e.exp < Date.now()) return null; return type === "json" ? JSON.parse(e.v) : e.v; },
  async put(k, v, o) {
    kv.set(k, { v, exp: Date.now() + ((o && o.expirationTtl) || 3600) * 1000 });
    if (kv.size > 5000) kv.delete(kv.keys().next().value);
  },
};

/* Disk cache for NFT metadata and images. They never change, and a shared
   Hostinger IP is quickly rate limited (429) by public IPFS gateways, so each
   file is fetched once and then served from here, surviving restarts. */
const CACHE_DIR = path.join(DATA_DIR, "cache");
fs.mkdirSync(CACHE_DIR, { recursive: true });
const cachePath = (k) => path.join(CACHE_DIR, crypto.createHash("sha256").update(k).digest("hex"));
const FILES = {
  async getJson(k) { try { return JSON.parse(fs.readFileSync(cachePath(k) + ".json", "utf8")); } catch { return null; } },
  async putJson(k, v) { try { fs.writeFileSync(cachePath(k) + ".json", JSON.stringify(v)); } catch {} },
  async getBin(k) {
    try { return { body: fs.readFileSync(cachePath(k) + ".bin"), type: fs.readFileSync(cachePath(k) + ".type", "utf8") }; }
    catch { return null; }
  },
  async putBin(k, buf, type) {
    try { fs.writeFileSync(cachePath(k) + ".bin", Buffer.from(buf)); fs.writeFileSync(cachePath(k) + ".type", type); } catch {}
  },
};

/* The session secret is made once and kept, unless you set one yourself. */
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(DATA_DIR, "session.secret");
  try { return fs.readFileSync(f, "utf8").trim(); } catch {}
  const s = crypto.randomBytes(32).toString("base64");
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

const env = {
  ISSUER: process.env.ISSUER, TAXON: process.env.TAXON || "",
  XUMM_API_KEY: process.env.XUMM_API_KEY, XUMM_API_SECRET: process.env.XUMM_API_SECRET,
  SESSION_SECRET: sessionSecret(), ADMIN_KEY: process.env.ADMIN_KEY || "",
  ORIGIN: process.env.ORIGIN || "", RETURN_URL: process.env.RETURN_URL || "",
  IPFS_GATEWAY: process.env.IPFS_GATEWAY || "https://ipfs.io/ipfs/", META_HOSTS: process.env.META_HOSTS || "*",
  STORE, KV, FILES,
  ENGINE: loadEngine(path.join(ROOT, "public", "index.html")),   // Fight Club referee: the game's own engine
};

const GAME = fs.readFileSync(path.join(ROOT, "public", "index.html"));
// WalletConnect bundle for "Joey (mobile)", fetched only when a player picks it
const WC_JS = (() => { try { return fs.readFileSync(path.join(ROOT, "public", "wc.js")); } catch { return null; } })();

/* Admin dashboard at /admin: player numbers, a table of every player and
   full backups (JSON) / spreadsheets (CSV). Data comes from /api/admin/*,
   which only answers with ?key=ADMIN_KEY — no ADMIN_KEY set, no access. */
const ADMIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Bark Arena — admin</title>
<style>
:root{--ink:#0e1726;--muted:#586780;--line:#d2e0ee;--accent:#0f76c6;--bg:#eef4fa}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,sans-serif;padding:20px}
h1{margin:0 0 4px;font-size:22px}.muted{color:var(--muted)}
.card{background:#fff;border:2px solid var(--ink);border-radius:14px;box-shadow:0 3px 0 var(--ink);padding:14px;margin-top:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.stat b{display:block;font-size:26px}.stat span{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}
.btn{display:inline-block;border:2px solid var(--ink);border-radius:999px;padding:8px 14px;background:var(--accent);color:#fff;font-weight:700;text-decoration:none;box-shadow:0 3px 0 var(--ink);cursor:pointer;font-size:14px}
.btn.ghost{background:#fff;color:var(--ink)}
input{border:2px solid var(--ink);border-radius:999px;padding:8px 12px;font:inherit;min-width:220px}
.wrap{overflow:auto;max-height:70vh}table{border-collapse:collapse;width:100%;font-size:12.5px}
th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th{position:sticky;top:0;background:#fff;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);cursor:pointer}
td:first-child,th:first-child{text-align:left;font-family:ui-monospace,monospace}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.wk{margin-top:12px;border-top:1px solid var(--line);padding-top:10px}.wk h3{margin:0 0 4px;font-size:16px}
.wk td,.wk th{text-align:left;white-space:normal}
.mono{font-family:ui-monospace,monospace;font-size:12px;word-break:break-all}.ok{color:#177a3c;font-weight:700}
select{border:2px solid var(--ink);border-radius:999px;padding:6px 10px;font:inherit}
#modal{position:fixed;inset:0;background:#0e172699;display:grid;place-items:center;padding:16px}
#modal .card{max-width:360px;text-align:center}#modal img{width:240px;height:240px;image-rendering:pixelated}
</style></head><body>
<h1>🐾 Bark Arena — admin</h1><p class="muted" id="sub">Enter the admin key (ADMIN_KEY on Hostinger).</p>
<div class="card row" id="login"><input id="key" type="password" placeholder="ADMIN_KEY" autocomplete="current-password"><button class="btn" id="go">Open</button></div>
<div id="app" hidden>
  <div class="grid" id="stats"></div>
  <div class="card row"><a class="btn" id="dlJson">⬇ Full backup (JSON)</a><a class="btn ghost" id="dlCsv">⬇ Players (CSV)</a>
    <button class="btn ghost" id="reload">↻ Refresh</button><input id="filter" placeholder="Filter wallet / pack…"></div>
  <div class="card"><div class="wrap"><table id="tbl"></table></div></div>
  <div class="card"><h2 style="margin:0;font-size:18px">🏁 Week close — verifiable results &amp; prizes</h2>
    <p class="muted" style="margin:4px 0 0">A finished week is frozen 15 minutes after Monday 00:00 UTC. Anchor its SHA-256 on the XRPL and send the prizes
      (top 3 XP + most active member of the winning pack) from the treasury — every step is a Xaman QR you sign with the issuer wallet.</p>
    <div id="season"><p class="muted">Loading…</p></div></div>
</div>
<div id="modal" hidden><div class="card"><b id="mTitle">Sign in Xaman</b><p class="muted" id="mText" style="margin:6px 0"></p>
  <img id="mQr" alt="Xaman QR"><p><a id="mLink" target="_blank" rel="noopener">Open in Xaman</a></p>
  <p id="mState" class="muted">Waiting for the signature…</p><button class="btn ghost" id="mClose">Close</button></div></div>
<script>
const $ = id => document.getElementById(id);
let KEY = new URLSearchParams(location.search).get("key") || sessionStorage.getItem("ba_admin") || "", DATA = null, SORT = "totalXp", DIR = -1;
const COLS = [["account","Wallet"],["name","Name"],["lastSeen","Last seen"],["pack","Pack"],["scrappysHeld","Scrappys"],["dogs","Dogs played"],["maxBond","Max bond"],
  ["trainerLevel","Trainer"],["rankedFights","Ranked"],["totalWins","Wins"],["totalLosses","Losses"],["totalXp","XP (all weeks)"],
  ["weekWins","Wins wk"],["weekXp","XP wk"],["bestStreak","Best streak"],["arenaRuns","Arenas"],["weeksPlayed","Weeks"],["saveUpdated","Save"]];
const fmt = (k, v) => /lastSeen|saveUpdated/.test(k) ? (v ? v.slice(0,16).replace("T"," ") : "—") : v;
function draw(){
  const f = $("filter").value.toLowerCase();
  const rows = DATA.rows.filter(r => !f || r.account.toLowerCase().includes(f) || String(r.pack).includes(f))
    .sort((a,b) => (a[SORT] > b[SORT] ? 1 : a[SORT] < b[SORT] ? -1 : 0) * DIR);
  $("tbl").innerHTML = "<thead><tr>" + COLS.map(([k,l]) => "<th data-k='"+k+"'>"+l+(SORT===k?(DIR<0?" ▼":" ▲"):"")+"</th>").join("") + "</tr></thead><tbody>" +
    rows.map(r => "<tr>" + COLS.map(([k]) => "<td>" + fmt(k, r[k]) + "</td>").join("") + "</tr>").join("") + "</tbody>";
  $("tbl").querySelectorAll("th").forEach(th => th.onclick = () => { const k = th.dataset.k; DIR = SORT === k ? -DIR : -1; SORT = k; draw(); });
}
async function load(){
  const r = await fetch("/api/admin/export?key=" + encodeURIComponent(KEY), {cache:"no-store"});
  if (!r.ok){ sessionStorage.removeItem("ba_admin"); $("sub").textContent = r.status === 403 ? "Wrong key — or ADMIN_KEY is not set on the server." : "Server error " + r.status; return; }
  DATA = await r.json(); sessionStorage.setItem("ba_admin", KEY);
  history.replaceState(null, "", "/admin");                     // keep the key out of the address bar
  $("login").hidden = true; $("app").hidden = false;
  const S = DATA.summary;
  $("sub").textContent = "Exported " + DATA.exported.slice(0,16).replace("T"," ") + " UTC · week of " + DATA.week;
  $("stats").innerHTML = [["Players total",S.players],["Active today",S.activeToday],["Active 7 days",S.active7d],["Played this week",S.playedThisWeek],["Saves backed up",S.savesStored]]
    .map(([l,v]) => "<div class='card stat'><span>"+l+"</span><b>"+v+"</b></div>").join("");
  $("dlJson").href = "/api/admin/export?download=1&key=" + encodeURIComponent(KEY);
  $("dlCsv").href = "/api/admin/csv?key=" + encodeURIComponent(KEY);
  draw(); season();
}
/* week close */
let SEASON = null, MPOLL = null;
const api = (p, body) => fetch("/api/admin/" + p + (p.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(KEY),
  body ? {method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify(body), cache:"no-store"} : {cache:"no-store"}).then(r => r.json());
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const txLink = id => "<a class='mono' target='_blank' rel='noopener' href='https://livenet.xrpl.org/transactions/" + id + "'>" + id.slice(0, 10) + "…</a>";
const PLACE = {"1":"🥇 1st XP","2":"🥈 2nd XP","3":"🥉 3rd XP","pack":"🐾 Winning pack, most active"};
async function season(){
  SEASON = await api("season");
  const opts = (SEASON.treasury || []).map(n => "<option value='" + n.nftId + "'>#" + (n.token || "?") + "</option>").join("");
  $("season").innerHTML = "<p class='muted'>Treasury (issuer " + esc(SEASON.issuer) + "): <b>" + (SEASON.treasury || []).length + "</b> Pixel Scrappys free" +
    (SEASON.treasuryError ? " — ledger error: " + esc(SEASON.treasuryError) : "") + (SEASON.xaman ? "" : " · <b>XUMM keys missing</b>") + "</p>" +
    (SEASON.weeks.some(w => !w.open && w.players) ? "" : "<p class='muted'>No finished week with players yet.</p>") +
    SEASON.weeks.filter(w => w.open || w.players).map(w => w.open ? "<div class='wk'><h3>Week of " + w.week + "</h3><p class='muted'>Still running — closes 15 min after it ends.</p></div>" :
      "<div class='wk'><h3>Week of " + w.week + " · " + w.players + " players</h3>" +
      "<div class='mono'>sha256 " + w.sha256 + "</div>" +
      "<p>" + (w.anchor ? "<span class='ok'>⚓ Anchored</span> " + txLink(w.anchor.txid) : "<button class='btn' data-anchor='" + w.week + "'>⚓ Anchor on the XRPL (Xaman)</button>") +
      " <a class='muted' target='_blank' href='/api/public/results?week=" + w.week + "'>public results</a></p>" +
      (w.prizes.length ? "<table><tr><th>Prize</th><th>Winner</th><th>Status</th><th></th></tr>" + w.prizes.map(p =>
        "<tr><td>" + PLACE[p.place] + (p.pack ? " (" + esc(p.pack) + ")" : "") + "</td><td>" + esc(p.name) + "<br><span class='mono'>" + esc(p.account) + "</span></td><td>" +
        (p.status === "claimed" ? "<span class='ok'>✅ claimed #" + p.token + "</span>" : p.status === "offered" ? "🎁 offered #" + p.token + " " + (p.offerTx ? txLink(p.offerTx) : "") + "<br><span class='muted'>waiting for the winner</span>" : "—") +
        "</td><td>" + (p.status === "offered" || p.status === "claimed" ? "" : opts ? "<select data-nft='" + w.week + "|" + p.place + "'>" + opts + "</select> <button class='btn' data-prize='" + w.week + "|" + p.place + "'>🎁 Send (Xaman)</button>" : "<span class='muted'>treasury empty</span>") +
        "</td></tr>").join("") + "</table>" : "<p class='muted'>No prize winners (nobody earned XP).</p>") + "</div>").join("");
  $("season").querySelectorAll("[data-anchor]").forEach(b => b.onclick = () => sign(api("anchor", {week: b.dataset.anchor}), "Anchor week " + b.dataset.anchor, "Sign the AccountSet with the memo — no XRP is sent."));
  $("season").querySelectorAll("[data-prize]").forEach(b => b.onclick = () => {
    const [week, place] = b.dataset.prize.split("|"), sel = $("season").querySelector("[data-nft='" + b.dataset.prize + "']");
    const tok = sel.options[sel.selectedIndex].text;
    if (!confirm("Offer Pixel Scrappy " + tok + " as the " + PLACE[place] + " prize for the week of " + week + "?")) return;
    sign(api("prize", {week, place, nftId: sel.value}), "Prize " + tok, "Sign the free sell offer (Amount 0) — only the winner can accept it.");
  });
}
async function sign(req, title, text){
  const j = await req;
  if (!j.uuid){ alert("Could not create the Xaman request: " + (j.error || "error")); season(); return; }
  $("mTitle").textContent = title; $("mText").textContent = text; $("mQr").src = j.qr; $("mLink").href = j.deeplink;
  $("mState").textContent = "Waiting for the signature…"; $("modal").hidden = false;
  clearInterval(MPOLL);
  MPOLL = setInterval(async () => {
    const s = await api("xaman?uuid=" + j.uuid).catch(() => ({}));
    if (s.state === "pending" || !s.state) return;
    clearInterval(MPOLL);
    $("mState").innerHTML = s.state === "signed" ? "<span class='ok'>✅ Signed and submitted</span> " + (s.txid ? txLink(s.txid) : "") : "❌ " + s.state + (s.result ? " (" + s.result + ")" : "");
    season();
  }, 2500);
}
$("mClose").onclick = () => { clearInterval(MPOLL); $("modal").hidden = true; season(); };
$("go").onclick = () => { KEY = $("key").value.trim(); load(); };
$("key").onkeydown = e => { if (e.key === "Enter") $("go").click(); };
$("reload").onclick = load; $("filter").oninput = () => DATA && draw();
if (KEY) load();
</script></body></html>`;

/* Private beta: with ACCESS_KEY set, the game (page and API) only opens for
   people who came in once through https://game…/?key=ACCESS_KEY — that visit
   leaves a cookie for a year. Without ACCESS_KEY the game is public. */
const ACCESS_KEY = process.env.ACCESS_KEY || "";
const ACCESS_COOKIE = "ba_access";
const accessToken = ACCESS_KEY ? crypto.createHmac("sha256", ACCESS_KEY).update("bark-arena-access").digest("hex").slice(0, 32) : "";
function hasAccess(req) {
  if (!ACCESS_KEY) return true;
  const c = String(req.headers.cookie || "").split(/;\s*/).find(x => x.startsWith(ACCESS_COOKIE + "="));
  return !!c && c.slice(ACCESS_COOKIE.length + 1) === accessToken;
}
const SOON = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Bark Arena — coming soon</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(180deg,#bfe3fc,#eef4fa);font:16px/1.5 system-ui,sans-serif;color:#0e1726;text-align:center;padding:24px}
h1{font:900 clamp(32px,8vw,64px)/1 system-ui,sans-serif;color:#1b8ce3;letter-spacing:.04em;margin:0 0 12px;text-shadow:3px 3px 0 #0a4f8f}
a{color:#0f76c6;font-weight:700}</style></head>
<body><div><h1>BARK ARENA</h1><p>The Pixel Scrappy game is in private beta.<br>It opens to everyone soon.</p>
<p><a href="https://scrappyxrp.fun/pixelscrappy/">← Pixel Scrappy</a></p></div></body></html>`;

function readBody(req) {
  return new Promise((ok, fail) => {
    const chunks = []; let n = 0;
    req.on("data", c => { n += c.length; if (n > 64 * 1024) { req.destroy(); fail(new Error("too large")); } else chunks.push(c); });
    req.on("end", () => ok(Buffer.concat(chunks))); req.on("error", fail);
  });
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://local");
    if (ACCESS_KEY && url.searchParams.get("key") === ACCESS_KEY) {
      res.writeHead(302, {"set-cookie": `${ACCESS_COOKIE}=${accessToken}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`, location: "/"});
      res.end(); return;
    }
    // the public leaderboard stays readable for the website during the private beta
    if (url.pathname === "/admin") {                              // own ADMIN_KEY, not the beta gate
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" });
      res.end(ADMIN_PAGE); return;
    }
    if (!hasAccess(req) && !url.pathname.startsWith("/api/public/") && !url.pathname.startsWith("/api/admin/")) {
      const api = url.pathname === "/api" || url.pathname.startsWith("/api/");
      res.writeHead(api ? 403 : 200, {"content-type": api ? "application/json" : "text/html; charset=utf-8", "cache-control": "no-store"});
      res.end(api ? JSON.stringify({error: "private_beta"}) : SOON); return;
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const headers = {};
      for (const h of ["authorization", "content-type", "origin"]) if (req.headers[h]) headers[h] = req.headers[h];
      const body = ["GET", "HEAD", "OPTIONS"].includes(req.method) ? undefined : await readBody(req);
      const r = await worker.fetch(new Request("https://local" + (url.pathname.slice(4) || "/") + url.search,
        { method: req.method, headers, body }), env);
      const out = {}; r.headers.forEach((v, k) => { out[k] = v; });
      res.writeHead(r.status, out);
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    if (url.pathname === "/wc.js" && WC_JS) {
      res.writeHead(200, {"content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400"});
      res.end(WC_JS); return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    res.end(GAME);
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
}).listen(process.env.PORT || 3000, () => {
  console.log(`Bark Arena läuft auf Port ${process.env.PORT || 3000} · Daten in ${DATA_DIR}`);
  const miss = ["ISSUER", "XUMM_API_KEY", "XUMM_API_SECRET"].filter(k => !process.env[k]);
  if (miss.length) console.log("FEHLENDE Umgebungsvariablen: " + miss.join(", "));
});
