/**
 * Bark Arena — Server (Cloudflare Worker + D1 + KV)
 *
 * Was er macht:
 *   - Xaman-Login (SignIn-Payload: keine Transaktion, keine Gebühr)
 *   - liest vom Ledger, welche Pixel Scrappys eine Wallet hält
 *   - holt Metadaten und Bilder der NFTs (IPFS oder https) für das Spiel
 *   - echte Wochen-Rangliste zwischen allen Testern
 *   - /check: Selbstprüfung für die Einrichtung
 *
 * Geheimnisse (wrangler secret put):  XUMM_API_KEY, XUMM_API_SECRET, SESSION_SECRET
 * Variablen (wrangler.toml):          ISSUER, TAXON, ORIGIN, IPFS_GATEWAY, META_HOSTS
 */

import { verify as verifySig, deriveAddress } from "ripple-keypairs";
import { encodeForSigning } from "ripple-binary-codec";

const XUMM = "https://xumm.app/api/v1/platform";
const XRPL_NODES = ["https://xrplcluster.com", "https://s1.ripple.com:51234", "https://s2.ripple.com:51234"];
const IPFS_FALLBACKS = ["https://ipfs.io/ipfs/", "https://gateway.pinata.cloud/ipfs/", "https://dweb.link/ipfs/", "https://w3s.link/ipfs/"];
const FETCH_TIMEOUT = 12000;                // ms; a hanging gateway must not stall the kennel
const SESSION_TTL = 60 * 60 * 24 * 7;       // 7 Tage angemeldet bleiben
const OWNERSHIP_TTL = 60 * 5;               // Besitz alle 5 Minuten neu vom Ledger
const META_TTL = 60 * 60 * 24;              // Metadaten 1 Tag cachen

/* ------------------------------------------------------------------ helpers */
const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const hex2str = (h) => new TextDecoder().decode(new Uint8Array((h || "").match(/../g)?.map(b => parseInt(b, 16)) || []));
const shortAcct = (a) => a ? a.slice(0, 5) + "…" + a.slice(-4) : "?";
const fetchT = (url, opt = {}) => fetch(url, {...opt, signal: AbortSignal.timeout(FETCH_TIMEOUT)});

/* An IPFS URL on the configured gateway → the same path on every fallback gateway. */
function ipfsAlternatives(url, env) {
  const gw = (env.IPFS_GATEWAY || "https://ipfs.io/ipfs/").replace(/\/?$/, "/");
  if (!url.startsWith(gw)) return [url];
  const rest = url.slice(gw.length);
  return [...new Set([gw, ...IPFS_FALLBACKS])].map(g => g + rest);
}
/* Ask every gateway at once and take the first good answer; the others are
   cancelled. A dead or rate-limited gateway then costs nothing, and the whole
   lookup is over after FETCH_TIMEOUT at most. */
async function fetchAny(urls, opt) {
  const ctl = urls.map(() => new AbortController());
  const timer = setTimeout(() => ctl.forEach(c => c.abort(new DOMException("timeout", "TimeoutError"))), FETCH_TIMEOUT);
  const tries = urls.map((u, i) => fetch(u, {...opt, signal: ctl[i].signal})
    .then(r => { if (!r.ok) throw new Error("http_" + r.status); return [r, i]; })
    .catch(e => { throw new Error(e.name === "TimeoutError" ? "timeout" : e.name === "AbortError" ? "aborted" : String(e.message || e)); }));
  try {
    const [r, win] = await Promise.any(tries);
    ctl.forEach((c, i) => { if (i !== win) c.abort(); });
    return r;
  } catch (e) {
    throw (e.errors || []).find(x => x.message.startsWith("http_")) || (e.errors || [])[0] || e;
  } finally { clearTimeout(timer); }
}
/* TAXON empty or "*" → every taxon from ISSUER counts. */
const isScrappy = (env, n) => n.Issuer === env.ISSUER && (env.TAXON === "" || env.TAXON === "*" || String(n.NFTokenTaxon) === env.TAXON);

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), {name:"HMAC", hash:"SHA-256"}, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
async function mintSession(env, account) {
  const body = b64url(enc.encode(JSON.stringify({a: account, exp: Math.floor(Date.now()/1000) + SESSION_TTL})));
  return `${body}.${await hmac(env.SESSION_SECRET, body)}`;
}
async function readSession(env, token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (sig !== await hmac(env.SESSION_SECRET, body)) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body.replace(/-/g,"+").replace(/_/g,"/")), c => c.charCodeAt(0))));
    return p.exp >= Math.floor(Date.now()/1000) ? p.a : null;
  } catch { return null; }
}
function weekOf(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return t.toISOString().slice(0, 10);
}

/* URIs from the ledger or from metadata → a fetchable https URL, or null. */
function resolveUrl(u, env, base) {
  if (!u) return null;
  u = String(u).trim();
  const gw = (env.IPFS_GATEWAY || "https://ipfs.io/ipfs/").replace(/\/?$/, "/");
  if (u.startsWith("ipfs://")) return gw + u.slice(7).replace(/^ipfs\//, "");
  if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})(\/.*)?$/.test(u)) return gw + u;
  if (/^https:\/\//i.test(u)) return u;
  if (base && !/^[a-z]+:/i.test(u)) {
    // relative image next to its metadata; xrp.cafe uploads keep images/ beside metadata/
    let abs = new URL(u, base).toString();
    if (/\/metadata\//.test(base)) abs = abs.replace("/metadata/", "/images/");
    return abs;
  }
  return null;
}
function hostAllowed(url, env) {
  try {
    const h = new URL(url).host;
    const gw = new URL(env.IPFS_GATEWAY || "https://ipfs.io/ipfs/").host;
    if (h === gw || IPFS_FALLBACKS.some(g => new URL(g).host === h)) return true;
    const list = (env.META_HOSTS || "*").split(",").map(s => s.trim()).filter(Boolean);
    return list.includes("*") || list.includes(h);
  } catch { return false; }
}

/* ------------------------------------------------------------------ storage */
let packTableReady = false;
async function packTable(DB) {
  if (packTableReady) return;
  await DB.prepare(`CREATE TABLE IF NOT EXISTS packs (account TEXT PRIMARY KEY, pack TEXT, pending TEXT, week TEXT)`).run();
  try { await DB.prepare(`ALTER TABLE weekly ADD COLUMN pack TEXT`).run(); } catch {}   // already there
  try { await DB.prepare(`ALTER TABLE weekly ADD COLUMN losses INTEGER DEFAULT 0`).run(); } catch {}
  try { await DB.prepare(`ALTER TABLE packs ADD COLUMN lock_week TEXT`).run(); } catch {}
  packTableReady = true;
}
/* Cloudflare passes a D1 database as env.DB; the Node server passes env.STORE. */
function storeOf(env) {
  if (env.STORE) return env.STORE;
  const DB = env.DB;
  return {
    ping: () => DB.prepare("SELECT 1").first(),
    seen: (a, t) => DB.prepare(`INSERT INTO players (account, seen) VALUES (?1, ?2) ON CONFLICT(account) DO UPDATE SET seen = ?2`).bind(a, t).run(),
    weekly: async (a, wk, wins, xp, streak, t, losses) => { await packTable(DB); return DB.prepare(
      `INSERT INTO weekly (account, week, wins, xp, streak, updated, losses) VALUES (?1,?2,?3,?4,?5,?6,?7)
       ON CONFLICT(account, week) DO UPDATE SET wins = MAX(weekly.wins, ?3), xp = MAX(weekly.xp, ?4),
         streak = MAX(weekly.streak, ?5), updated = ?6, losses = MAX(COALESCE(weekly.losses, 0), ?7)`).bind(a, wk, wins, xp, streak, t, losses || 0).run(); },
    top: async (wk, col) => (await DB.prepare(`SELECT account, ${col} AS v FROM weekly WHERE week = ?1 AND ${col} > 0 ORDER BY ${col} DESC LIMIT 10`).bind(wk).all()).results || [],
    rank: async (wk, col, a) => {
      const me = await DB.prepare(`SELECT ${col} AS v FROM weekly WHERE week = ?1 AND account = ?2`).bind(wk, a).first();
      if (!me || !(me.v > 0)) return null;
      const n = await DB.prepare(`SELECT COUNT(*) AS n FROM weekly WHERE week = ?1 AND ${col} > ?2`).bind(wk, me.v).first();
      return {rank: n.n + 1, v: me.v};
    },
    count: async (wk) => (await DB.prepare(`SELECT COUNT(*) AS n FROM weekly WHERE week = ?1`).bind(wk).first()).n,
    holdings: async (a, tokens, t) => {
      await DB.prepare(`CREATE TABLE IF NOT EXISTS holdings (account TEXT PRIMARY KEY, tokens TEXT, updated INTEGER)`).run();
      await DB.prepare(`INSERT INTO holdings (account, tokens, updated) VALUES (?1, ?2, ?3)
        ON CONFLICT(account) DO UPDATE SET tokens = ?2, updated = ?3`).bind(a, JSON.stringify(tokens), t).run();
    },
    packGet: async (a) => {
      await packTable(DB);
      const r = await DB.prepare(`SELECT pack, pending, week, lock_week AS lockWeek FROM packs WHERE account = ?1`).bind(a).first();
      return r || null;
    },
    packSet: async (a, rec) => {
      await packTable(DB);
      await DB.prepare(`INSERT INTO packs (account, pack, pending, week, lock_week) VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(account) DO UPDATE SET pack = ?2, pending = ?3, week = ?4, lock_week = ?5`).bind(a, rec.pack, rec.pending, rec.week, rec.lockWeek || null).run();
    },
    packAll: async () => { await packTable(DB); return (await DB.prepare(`SELECT account, pack, pending, week FROM packs`).all()).results || []; },
    weeklyPack: async (a, wk, pack) => {
      await packTable(DB);
      await DB.prepare(`INSERT INTO weekly (account, week, wins, xp, streak, updated, pack) VALUES (?1, ?2, 0, 0, 0, ?3, ?4)
        ON CONFLICT(account, week) DO UPDATE SET pack = ?4`).bind(a, wk, Date.now(), pack || null).run();
    },
    weekRows: async (wk) => { await packTable(DB); return (await DB.prepare(`SELECT account, wins, losses, xp, streak, pack FROM weekly WHERE week = ?1`).bind(wk).all()).results || []; },
    taken: async () => {
      await DB.prepare(`CREATE TABLE IF NOT EXISTS holdings (account TEXT PRIMARY KEY, tokens TEXT, updated INTEGER)`).run();
      const rows = (await DB.prepare(`SELECT tokens FROM holdings`).all()).results || [];
      return [...new Set(rows.flatMap(r => JSON.parse(r.tokens || "[]")))];
    },
  };
}

/* ------------------------------------------------------------------ ledger */
async function xrplRequest(body) {
  let err = new Error("xrpl_unavailable");
  for (const node of XRPL_NODES) {
    try {
      const r = await fetchT(node, {method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify(body)});
      if (!r.ok) continue;
      const d = (await r.json()).result;
      if (d && d.error && d.error !== "actNotFound" && d.error !== "actMalformed") { err = new Error(d.error); continue; }
      return d;
    } catch (e) { /* next node */ }
  }
  throw err;
}
async function accountNfts(env, account, all) {
  const out = []; let marker;
  do {
    const d = await xrplRequest({method:"account_nfts", params:[{account, ledger_index:"validated", limit:400, ...(marker ? {marker} : {})}]});
    if (d.error) { if (d.error === "actNotFound") return []; throw new Error(d.error); }
    for (const n of d.account_nfts || [])
      if (all || isScrappy(env, n))
        out.push({nft_id: n.NFTokenID, uri: hex2str(n.URI), serial: n.nft_serial, issuer: n.Issuer, taxon: n.NFTokenTaxon});
    marker = d.marker;
  } while (marker);
  return out;
}
async function ownedNfts(env, account, fresh) {
  const k = `own:${account}`;
  const c = env.KV && !fresh ? await env.KV.get(k, "json") : null;
  if (c) return c;
  const out = await accountNfts(env, account);
  // an empty wallet is not cached: a Scrappy bought a minute ago must show on ↻ Refresh
  if (env.KV && out.length) await env.KV.put(k, JSON.stringify(out), {expirationTtl: OWNERSHIP_TTL});
  return out;
}
async function kennel(env, account, fresh) {
  if (!/^r/.test(env.ISSUER)) return json({error:"server_not_configured (ISSUER missing)"}, 500);
  const nfts = await ownedNfts(env, account, fresh);
  // Remember which Scrappys this player fights with, so nobody meets them as a rival.
  const tokens = nfts.map(n => +(String(n.uri).match(/(\d+)\.json$/) || [])[1]).filter(Boolean);
  await storeOf(env).holdings(account, tokens, Date.now());
  const res = {account, nfts};
  if (!nfts.length) {
    // Tell the player (and the admin) why nothing matched, instead of a silent 0.
    const every = await accountNfts(env, account, true);
    res.other_nfts = every.length;
    if (every.length) res.hint = `This wallet holds ${every.length} NFT(s), but none from issuer ${shortAcct(env.ISSUER)}` +
      (env.TAXON && env.TAXON !== "*" ? ` with taxon ${env.TAXON}` : "") + `. Admin: open /api/check?account=${account}`;
  }
  return json(res);
}
async function metaFor(env, uri) {
  const url = resolveUrl(uri, env);
  if (!url || !hostAllowed(url, env)) throw new Error("uri_not_allowed");
  const k = `meta:${url}`;
  const c = (env.KV ? await env.KV.get(k, "json") : null) || (env.FILES ? await env.FILES.getJson(k) : null);
  if (c) return c;
  const r = await fetchAny(ipfsAlternatives(url, env), {cf: {cacheTtl: META_TTL}}).catch(e => { throw new Error("meta_" + e.message); });
  const m = await r.json();
  const out = {
    name: m.name || "",
    token: +((m.name || "").match(/#\s*(\d+)/) || [])[1] || null,
    image: resolveUrl(m.image || m.image_url, env, url),
    attributes: Array.isArray(m.attributes) ? m.attributes.map(a => ({t: String(a.trait_type || ""), v: String(a.value ?? "")})) : [],
  };
  if (env.KV) await env.KV.put(k, JSON.stringify(out), {expirationTtl: META_TTL});
  if (env.FILES) await env.FILES.putJson(k, out);          // NFT metadata never changes: keep it for good
  return out;
}

/* ------------------------------------------------------------------ routes */
async function authStart(env) {
  const r = await fetch(`${XUMM}/payload`, {method:"POST",
    headers:{"content-type":"application/json", "X-API-Key":env.XUMM_API_KEY, "X-API-Secret":env.XUMM_API_SECRET},
    body: JSON.stringify({txjson:{TransactionType:"SignIn"},
      options:{submit:false, expire:5, return_url:{app: env.RETURN_URL || firstOrigin(env), web: env.RETURN_URL || firstOrigin(env)}},
      custom_meta:{instruction:"Sign in to Bark Arena. No transaction, no fee."}})});
  if (!r.ok) return json({error:"xaman_unavailable", status:r.status}, 502);
  const p = await r.json();
  return json({uuid:p.uuid, qr:p.refs.qr_png, deeplink:p.next.always});
}
async function authStatus(env, uuid) {
  if (!/^[0-9a-f-]{36}$/i.test(uuid)) return json({error:"bad_uuid"}, 400);
  const r = await fetch(`${XUMM}/payload/${uuid}`, {headers:{"X-API-Key":env.XUMM_API_KEY, "X-API-Secret":env.XUMM_API_SECRET}});
  if (!r.ok) return json({error:"xaman_unavailable"}, 502);
  const p = await r.json();
  if (p.meta.expired) return json({state:"expired"});
  if (!p.meta.resolved) return json({state:"pending"});
  if (!p.meta.signed) return json({state:"rejected"});
  const account = p.response.account;
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(account)) return json({error:"bad_account"}, 400);
  await storeOf(env).seen(account, Date.now());
  return json({state:"signed", account, token: await mintSession(env, account)});
}
/* ------------------------------------------------------------------ packs */
/* Real packs: membership lives here, and a pack's week is the sum of its
   members' weekly rows. Each weekly row remembers the pack it was earned for,
   so past weeks (and their bonuses) stay as they were. */
const PACK_IDS = ["ledger", "moon", "bone", "static"];
const PACK_MAX = 10;
const PACK_WEEKS = 9;                       // this week + the 8 the bonus history looks back on
const LEAVE = "-";                          // a queued "leave on Monday"

/* Transfers land on the week roll: a queued move becomes the pack on Monday. */
async function myPack(env, account) {
  const st = storeOf(env), wk = weekOf();
  const rec = (await st.packGet(account)) || {pack: null, pending: null, week: wk};
  if (rec.week !== wk) {
    if (rec.pending) { rec.pack = rec.pending === LEAVE ? null : rec.pending; rec.pending = null; }
    rec.week = wk;
    await st.packSet(account, rec);
    await st.weeklyPack(account, wk, rec.pack);
  }
  return rec;
}
async function packRows(env, wk) {
  const rows = await storeOf(env).weekRows(wk), by = {};
  for (const id of PACK_IDS) by[id] = {id, members: 0, wins: 0, losses: 0, xp: 0, streak: 0};
  for (const r of rows) {
    const p = by[r.pack]; if (!p) continue;
    p.members++; p.wins += r.wins | 0; p.losses += r.losses | 0; p.xp += r.xp | 0; p.streak = Math.max(p.streak, r.streak | 0);
  }
  return Object.values(by);
}
async function packs(env, account) {
  const st = storeOf(env), wk = weekOf();
  // Carry every member into this week, so a pack's size counts everyone, not only who has fought yet.
  const cur = new Map((await st.weekRows(wk)).map(r => [r.account, r.pack || null]));
  for (const r of await st.packAll()) {
    const rec = r.account === account ? await myPack(env, r.account) : r;
    let pack = rec.pack;
    if (rec.week !== wk && rec.pending) pack = rec.pending === LEAVE ? null : rec.pending;   // their Monday move, even before they log in
    if (pack && cur.get(r.account) !== pack) await st.weeklyPack(r.account, wk, pack);
  }
  const weeks = {};
  for (let i = 0; i < PACK_WEEKS; i++) {
    const w = weekOf(new Date(Date.now() - i * 7 * 864e5));
    weeks[w] = await packRows(env, w);
  }
  const me = account ? await myPack(env, account) : null;
  return json({week: wk, weeks, max: PACK_MAX, me: me && {pack: me.pack, pending: me.pending, locked: isLocked(me, wk)}});
}
/* One pack per week. Joining with no pack is instant, and from then on the
   week is locked: switching or leaving only queues a move for Monday. Having
   been in a pack this week also locks it, so leave-and-rejoin can't hop. */
const isLocked = (rec, wk) => !!rec.pack || rec.lockWeek === wk;
async function packMove(env, account, b) {
  const st = storeOf(env), wk = weekOf(), rec = await myPack(env, account);
  const id = String(b.id || "");
  if (rec.pack && rec.lockWeek !== wk) rec.lockWeek = wk;       // a pack held from before counts as this week's
  if (b.action === "join") {
    if (!PACK_IDS.includes(id)) return json({error: "bad_pack"}, 400);
    const size = (await packRows(env, wk)).find(p => p.id === id).members;
    if (size >= PACK_MAX && rec.pack !== id) return json({error: "pack_full"}, 409);
    if (!isLocked(rec, wk)) { rec.pack = id; rec.pending = null; rec.lockWeek = wk; await st.weeklyPack(account, wk, id); }
    else rec.pending = rec.pack === id ? null : id;             // your own pack = stay; any other = move on Monday
  } else if (b.action === "leave") {
    if (!rec.pack) return json({error: "no_pack"}, 400);
    rec.pending = LEAVE;                                         // leaves on Monday, not now
  } else if (b.action === "cancel") {
    rec.pending = null;
  } else return json({error: "bad_action"}, 400);
  await st.packSet(account, rec);
  return packs(env, account);
}

/* ------------------------------------------------------------------ Joey */
/* Joey Wallet sign-in (browser extension, XLS-72d provider `signIn`).
   1. /auth/joey/start hands out a one-time nonce (5 minutes).
   2. The wallet signs a CAIP-122 "Sign in with XRPL" message carrying that nonce
      — or, for a Ledger account, a canonical unsubmittable 1-drop Payment to
      itself (Sequence 0) with the nonce in a memo.
   3. /auth/joey/verify checks the signature, that the key belongs to the
      address, that the domain is ours and the nonce is fresh, then issues the
      same session as a Xaman sign-in. */
const JOEY_NONCE_TTL = 300;
const hexOf = (str) => Array.from(enc.encode(str), b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
function ourHosts(env, req) {
  const hosts = [];
  for (const u of [env.RETURN_URL, ...(env.ORIGIN || "").split(",")]) {
    try { if (u && u.trim()) hosts.push(new URL(u.trim()).host); } catch {}
  }
  // unconfigured (local dev): fall back to the page the request came from
  if (!hosts.length) { try { hosts.push(new URL(req.headers.get("origin")).host); } catch {} }
  return hosts;
}
async function joeyStart(env) {
  if (!env.KV) return json({error: "no_kv"}, 500);
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
  await env.KV.put(`joey:${nonce}`, "1", {expirationTtl: JOEY_NONCE_TTL});
  return json({nonce, statement: "Sign in to Bark Arena. No transaction, no fee."});
}
async function takeNonce(env, nonce) {
  if (!nonce || !/^[0-9a-f]{16,64}$/i.test(nonce) || !env.KV) return false;
  const ok = await env.KV.get(`joey:${nonce}`);
  if (ok) await env.KV.put(`joey:${nonce}`, "", {expirationTtl: 1});   // one use only
  return !!ok;
}
function verifyCaip122(env, req, b) {
  const msg = String(b.message || ""), pub = String(b.publicKey || ""), sig = String(b.signature || "");
  const lines = msg.split("\n");
  const head = /^(.+) wants you to sign in with your XRPL account:$/.exec(lines[0] || "");
  if (!head) return {error: "bad_message"};
  const address = (lines[1] || "").trim();
  const field = (name) => { const l = lines.find(x => x.startsWith(name + ": ")); return l ? l.slice(name.length + 2).trim() : ""; };
  if (!ourHosts(env, req).includes(head[1])) return {error: "wrong_domain"};
  const issued = Date.parse(field("Issued At"));
  if (issued && Math.abs(Date.now() - issued) > 10 * 60 * 1000) return {error: "stale_message"};
  const exp = Date.parse(field("Expiration Time"));
  if (exp && exp < Date.now()) return {error: "expired_message"};
  let valid = false;
  try { valid = verifySig(hexOf(msg), sig, pub) && deriveAddress(pub) === address; } catch {}
  if (!valid) return {error: "bad_signature"};
  return {address, nonce: field("Nonce")};
}
function verifyChallengeTx(b) {
  let tx;
  try { tx = typeof b.signedTx === "string" ? JSON.parse(b.signedTx) : b.signedTx; } catch { return {error: "bad_tx"}; }
  if (!tx || tx.TransactionType !== "Payment" || tx.Account !== tx.Destination || Number(tx.Sequence) !== 0) return {error: "not_a_challenge"};
  let valid = false;
  try { valid = verifySig(encodeForSigning(tx), tx.TxnSignature, tx.SigningPubKey) && deriveAddress(tx.SigningPubKey) === tx.Account; } catch {}
  if (!valid) return {error: "bad_signature"};
  let nonce = "";
  for (const m of tx.Memos || []) {
    try { const d = JSON.parse(hex2str(m.Memo && m.Memo.MemoData)); if (d && d.challenge) nonce = String(d.challenge); } catch {}
  }
  return {address: tx.Account, nonce};
}
async function joeyVerify(env, req, b) {
  const r = b && b.signedTx ? verifyChallengeTx(b) : verifyCaip122(env, req, b || {});
  if (r.error) return json({error: r.error}, 401);
  if (b.address && b.address !== r.address) return json({error: "address_mismatch"}, 401);
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(r.address)) return json({error: "bad_account"}, 400);
  if (!(await takeNonce(env, r.nonce))) return json({error: "stale_nonce"}, 401);
  await storeOf(env).seen(r.address, Date.now());
  return json({state: "signed", account: r.address, token: await mintSession(env, r.address), via: "joey"});
}

async function postStats(env, account, b) {
  const wk = weekOf();
  const wins = Math.max(0, Math.min(500, b.wins|0)), xp = Math.max(0, Math.min(20000, b.xp|0)), streak = Math.max(0, Math.min(200, b.streak|0));
  const losses = Math.max(0, Math.min(500, b.losses|0));
  await storeOf(env).weekly(account, wk, wins, xp, streak, Date.now(), losses);
  const rec = await myPack(env, account);
  await storeOf(env).weeklyPack(account, wk, rec.pack);
  return json({ok:true, week:wk});
}
async function ladder(env, me, week) {
  // ?week=YYYY-MM-DD (a Monday) reads a finished week for the weekly results; default is this week
  const now = weekOf();
  const wk = /^\d{4}-\d{2}-\d{2}$/.test(week || "") && week <= now ? weekOf(new Date(week + "T12:00:00Z")) : now;
  const st = storeOf(env);
  const [x, w, s] = await Promise.all([st.top(wk, "xp"), st.top(wk, "wins"), st.top(wk, "streak")]);
  const fmt = (rows) => rows.map(r => ({who: shortAcct(r.account), v: r.v, you: r.account === me}));
  const mine = me ? {xp: await st.rank(wk, "xp", me), wins: await st.rank(wk, "wins", me), streak: await st.rank(wk, "streak", me)} : null;
  return json({week:wk, players: await st.count(wk), xp: fmt(x), wins: fmt(w), streak: fmt(s), mine});
}
/* Public, read-only standings for the website (scrappyxrp.fun/barkarena/):
   this week's player boards, packs this week and how last week ended.
   No sign-in, wallets shortened, cached for a minute. */
async function publicBoard(env) {
  const k = "public:board";
  const c = env.KV ? await env.KV.get(k, "json") : null;
  if (c) return c;
  const st = storeOf(env), wk = weekOf(), last = weekOf(new Date(Date.now() - 7 * 864e5));
  const fmt = rows => rows.map(r => ({who: shortAcct(r.account), v: r.v}));
  const [x, w, s] = await Promise.all([st.top(wk, "xp"), st.top(wk, "wins"), st.top(wk, "streak")]);
  const [lx, lw, ls] = await Promise.all([st.top(last, "xp"), st.top(last, "wins"), st.top(last, "streak")]);
  const out = {
    week: wk, players: await st.count(wk), xp: fmt(x), wins: fmt(w), streak: fmt(s),
    packs: await packRows(env, wk),
    last: {week: last, players: await st.count(last), xp: fmt(lx), wins: fmt(lw), streak: fmt(ls), packs: await packRows(env, last)},
    updated: new Date().toISOString(),
  };
  if (env.KV) await env.KV.put(k, JSON.stringify(out), {expirationTtl: 60});
  return out;
}
async function check(env, account) {
  const rep = {ok:true, config:{
    issuer: env.ISSUER && env.ISSUER.startsWith("r") ? env.ISSUER : "FEHLT",
    taxon: env.TAXON || "* (alle)", origin: env.ORIGIN || "FEHLT",
    xaman_keys: !!(env.XUMM_API_KEY && env.XUMM_API_SECRET), session_secret: !!env.SESSION_SECRET,
    kv: !!env.KV, db: !!(env.DB || env.STORE)}};
  try { await storeOf(env).ping(); rep.config.db_reachable = true; } catch (e) { rep.config.db_reachable = String(e.message); rep.ok = false; }
  if (!account) { rep.hint = "Hänge ?account=rDEINEADRESSE an, um eine echte Wallet zu prüfen."; return json(rep); }
  try {
    const nfts = await accountNfts(env, account);
    rep.wallet = {account, pixel_scrappys: nfts.length, samples: []};
    for (const n of nfts.slice(0, 3)) {
      const s = {nft_id: n.nft_id, uri: n.uri};
      try {
        const m = await metaFor(env, n.uri);
        s.name = m.name; s.token = m.token; s.attributes = m.attributes.length; s.image = m.image;
        if (m.image) { try { const ir = await fetchAny(ipfsAlternatives(m.image, env)); s.image_status = ir.status; s.image_type = ir.headers.get("content-type"); } catch (e) { s.image_status = e.message; rep.ok = false; } }
      } catch (e) { s.error = String(e.message); rep.ok = false; }
      rep.wallet.samples.push(s);
    }
    {
      // List everything this wallet holds, grouped, so the right ISSUER/TAXON
      // can be read straight off this page.
      const every = await accountNfts(env, account, true);
      const groups = {};
      for (const n of every) {
        const k = n.issuer + "|" + n.taxon;
        (groups[k] = groups[k] || {issuer: n.issuer, taxon: String(n.taxon), count: 0, sample_uri: n.uri}).count++;
      }
      const list = Object.values(groups).sort((a, b) => b.count - a.count);
      for (const g of list.slice(0, 6)) {
        try { const m = await metaFor(env, g.sample_uri); g.sample_name = m.name; } catch (e) { g.sample_name = "(Metadaten nicht lesbar: " + e.message + ")"; }
      }
      rep.wallet.all_nfts_by_issuer = list;
      rep.wallet.nfts_total = every.length;
      if (!nfts.length) rep.hint = list.length
        ? `Keine NFTs mit ISSUER=${env.ISSUER} und TAXON=${env.TAXON}. Diese Wallet hält aber ${every.length} NFT(s) in ${list.length} Gruppe(n) — siehe all_nfts_by_issuer. Bei der Gruppe mit "Pixel Scrappy" im sample_name stehen der richtige Issuer und Taxon.`
        : "Diese Wallet hält überhaupt keine NFTs. Richtige Adresse?";
      if (!nfts.length) rep.ok = false;
    }
  } catch (e) { rep.wallet = {error: String(e.message)}; rep.ok = false; }
  return json(rep);
}

/* ------------------------------------------------------------------ plumbing */
const json = (o, s = 200) => new Response(JSON.stringify(o, null, 1), {status:s, headers:{"content-type":"application/json; charset=utf-8"}});
function firstOrigin(env) { return (env.ORIGIN || "").split(",")[0].trim(); }
function corsFor(req, env) {
  const o = req.headers.get("origin") || "";
  const list = (env.ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
  const allow = list.includes(o) ? o : (list[0] || "*");
  return {"access-control-allow-origin": allow, "vary":"origin",
          "access-control-allow-headers":"content-type,authorization", "access-control-allow-methods":"GET,POST,OPTIONS"};
}
function withCors(res, cors) {
  const h = new Headers(res.headers); for (const [k, v] of Object.entries(cors)) h.set(k, v);
  return new Response(res.body, {status: res.status, headers: h});
}

export default {
  async fetch(req, env) {
    env = {...env, ISSUER: String(env.ISSUER || "").trim(), TAXON: String(env.TAXON ?? "").trim()};
    const url = new URL(req.url), cors = corsFor(req, env);
    if (req.method === "OPTIONS") return new Response(null, {headers: cors});
    try {
      const p = url.pathname;
      if (p === "/" ) return withCors(json({ok:true, service:"bark-arena"}), cors);
      if (p === "/public/board") {
        const r = json(await publicBoard(env));
        r.headers.set("access-control-allow-origin", "*");          // any site may show the board
        r.headers.set("cache-control", "public, max-age=60");
        return r;
      }
      if (p === "/check") return withCors(await check(env, url.searchParams.get("account")), cors);
      if (p === "/auth/start" && req.method === "POST") return withCors(await authStart(env), cors);
      if (p === "/auth/joey/start" && req.method === "POST") return withCors(await joeyStart(env), cors);
      if (p === "/auth/joey/verify" && req.method === "POST") return withCors(await joeyVerify(env, req, await req.json().catch(() => ({}))), cors);
      if (p === "/auth/status") return withCors(await authStatus(env, url.searchParams.get("uuid") || ""), cors);

      const account = await readSession(env, (req.headers.get("authorization") || "").replace(/^Bearer /, ""));
      if (p === "/ladder") return withCors(await ladder(env, account, url.searchParams.get("week")), cors);
      if (!account) return withCors(json({error:"unauthorized"}, 401), cors);

      if (p === "/me/kennel") return withCors(await kennel(env, account, url.searchParams.has("fresh")), cors);
      if (p === "/packs") return withCors(await packs(env, account), cors);
      if (p === "/pack" && req.method === "POST") return withCors(await packMove(env, account, await req.json()), cors);
      if (p === "/taken") return withCors(json({tokens: await storeOf(env).taken()}), cors);
      if (p === "/meta") return withCors(json(await metaFor(env, url.searchParams.get("uri") || "")), cors);
      if (p === "/img") {
        const u = url.searchParams.get("u") || "";
        if (!/^https:\/\//i.test(u) || !hostAllowed(u, env)) return withCors(json({error:"img_not_allowed"}, 400), cors);
        const hit = env.FILES ? await env.FILES.getBin("img:" + u) : null;
        if (hit) return withCors(new Response(hit.body, {status:200, headers:{"content-type": hit.type, "cache-control":"public, max-age=86400"}}), cors);
        let r;
        try { r = await fetchAny(ipfsAlternatives(u, env), {cf: {cacheTtl: META_TTL, cacheEverything: true}}); }
        catch (e) { return withCors(json({error:"img_" + e.message}, 502), cors); }
        const type = r.headers.get("content-type") || "image/png";
        const h = new Headers({"content-type": type, "cache-control":"public, max-age=86400"});
        if (!env.FILES) return withCors(new Response(r.body, {status:200, headers:h}), cors);
        const buf = await r.arrayBuffer();
        await env.FILES.putBin("img:" + u, buf, type);
        return withCors(new Response(buf, {status:200, headers:h}), cors);
      }
      if (p === "/stats" && req.method === "POST") return withCors(await postStats(env, account, await req.json()), cors);
      return withCors(json({error:"not_found"}, 404), cors);
    } catch (e) {
      return withCors(json({error: String(e.message || e)}, 500), cors);
    }
  },
};
