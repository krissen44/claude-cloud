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
import { encodeForSigning, decode as decodeTx } from "ripple-binary-codec";

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
    holdings: async (a, tokens, t, dogs) => {
      await DB.prepare(`CREATE TABLE IF NOT EXISTS holdings (account TEXT PRIMARY KEY, tokens TEXT, updated INTEGER)`).run();
      try { await DB.prepare(`ALTER TABLE holdings ADD COLUMN dogs TEXT`).run(); } catch {}
      await DB.prepare(`INSERT INTO holdings (account, tokens, updated, dogs) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(account) DO UPDATE SET tokens = ?2, updated = ?3, dogs = ?4`).bind(a, JSON.stringify(tokens), t, JSON.stringify(dogs || [])).run();
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
    arenaRegSet: async (a, day, ids) => {
      await DB.prepare(`CREATE TABLE IF NOT EXISTS arena_reg (account TEXT PRIMARY KEY, day TEXT, ids TEXT)`).run();
      await DB.prepare(`INSERT INTO arena_reg (account, day, ids) VALUES (?1, ?2, ?3)
        ON CONFLICT(account) DO UPDATE SET day = ?2, ids = ?3`).bind(a, day, JSON.stringify(ids)).run();
    },
    arenaRegAll: async () => {
      await DB.prepare(`CREATE TABLE IF NOT EXISTS arena_reg (account TEXT PRIMARY KEY, day TEXT, ids TEXT)`).run();
      const rows = (await DB.prepare(`SELECT account, day, ids FROM arena_reg`).all()).results || [];
      return Object.fromEntries(rows.map(r => [r.account, {day: r.day, ids: JSON.parse(r.ids || "[]")}]));
    },
    defenseAdd: async (owner, e, dayKey, cap) => {
      await DB.prepare(`CREATE TABLE IF NOT EXISTS defense (account TEXT, id TEXT, xp INTEGER, won INTEGER, vs TEXT, at INTEGER)`).run();
      await DB.prepare(`CREATE TABLE IF NOT EXISTS defense_day (k TEXT PRIMARY KEY, xp INTEGER)`).run();
      const used = ((await DB.prepare(`SELECT xp FROM defense_day WHERE k = ?1`).bind(dayKey).first()) || {}).xp || 0;
      const xp = Math.max(0, Math.min(e.xp, cap - used));
      if (!xp) return 0;
      await DB.prepare(`INSERT INTO defense_day (k, xp) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET xp = ?2`).bind(dayKey, used + xp).run();
      await DB.prepare(`INSERT INTO defense (account, id, xp, won, vs, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`).bind(owner, e.id, xp, e.won ? 1 : 0, e.vs, e.at).run();
      return xp;
    },
    defenseGet: async (a) => {
      await DB.prepare(`CREATE TABLE IF NOT EXISTS defense (account TEXT, id TEXT, xp INTEGER, won INTEGER, vs TEXT, at INTEGER)`).run();
      return ((await DB.prepare(`SELECT id, xp, won, vs, at FROM defense WHERE account = ?1 ORDER BY at`).bind(a).all()).results || []).map(r => ({...r, won: !!r.won}));
    },
    defenseClear: async (a, upTo) => { await DB.prepare(`DELETE FROM defense WHERE account = ?1 AND at <= ?2`).bind(a, upTo).run(); },
    clubAdd: async (a, k) => {
      await DB.prepare(`CREATE TABLE IF NOT EXISTS club (account TEXT PRIMARY KEY, w INTEGER DEFAULT 0, l INTEGER DEFAULT 0, d INTEGER DEFAULT 0)`).run();
      await DB.prepare(`INSERT INTO club (account, ${k}) VALUES (?1, 1) ON CONFLICT(account) DO UPDATE SET ${k} = ${k} + 1`).bind(a).run();
    },
    clubGet: async (a) => {
      await DB.prepare(`CREATE TABLE IF NOT EXISTS club (account TEXT PRIMARY KEY, w INTEGER DEFAULT 0, l INTEGER DEFAULT 0, d INTEGER DEFAULT 0)`).run();
      return (await DB.prepare(`SELECT w, l, d FROM club WHERE account = ?1`).bind(a).first()) || {w: 0, l: 0, d: 0};
    },
    allHoldings: async () => {
      const rows = (await DB.prepare(`SELECT account, tokens, dogs, updated FROM holdings`).all().catch(() => ({results: []}))).results || [];
      return Object.fromEntries(rows.map(r => [r.account, {tokens: JSON.parse(r.tokens || "[]"), dogs: JSON.parse(r.dogs || "[]"), updated: r.updated}]));
    },
    profiles: async () => {
      await DB.prepare(`CREATE TABLE IF NOT EXISTS profiles (account TEXT PRIMARY KEY, name TEXT, name_lc TEXT UNIQUE, updated INTEGER)`).run();
      const rows = (await DB.prepare(`SELECT account, name, updated FROM profiles`).all()).results || [];
      return Object.fromEntries(rows.map(r => [r.account, {name: r.name, updated: r.updated}]));
    },
    profileSet: async (a, name) => {
      await DB.prepare(`CREATE TABLE IF NOT EXISTS profiles (account TEXT PRIMARY KEY, name TEXT, name_lc TEXT UNIQUE, updated INTEGER)`).run();
      if (!name) { await DB.prepare(`DELETE FROM profiles WHERE account = ?1`).bind(a).run(); return true; }
      try {
        await DB.prepare(`INSERT INTO profiles (account, name, name_lc, updated) VALUES (?1, ?2, ?3, ?4)
          ON CONFLICT(account) DO UPDATE SET name = ?2, name_lc = ?3, updated = ?4`).bind(a, name, name.toLowerCase(), Date.now()).run();
        return true;
      } catch { return false; }                                  // name_lc taken by someone else
    },
    saveGet: async (a) => {
      await DB.prepare(`CREATE TABLE IF NOT EXISTS saves (account TEXT PRIMARY KEY, data TEXT, updated INTEGER)`).run();
      const r = await DB.prepare(`SELECT data, updated FROM saves WHERE account = ?1`).bind(a).first();
      return r ? {data: JSON.parse(r.data), updated: r.updated} : null;
    },
    saveSet: async (a, data, t) => {
      await DB.prepare(`CREATE TABLE IF NOT EXISTS saves (account TEXT PRIMARY KEY, data TEXT, updated INTEGER)`).run();
      await DB.prepare(`INSERT INTO saves (account, data, updated) VALUES (?1, ?2, ?3)
        ON CONFLICT(account) DO UPDATE SET data = ?2, updated = ?3`).bind(a, JSON.stringify(data), t).run();
    },
    saveAll: async () => {
      await DB.prepare(`CREATE TABLE IF NOT EXISTS saves (account TEXT PRIMARY KEY, data TEXT, updated INTEGER)`).run();
      const rows = (await DB.prepare(`SELECT account, data, updated FROM saves`).all()).results || [];
      return Object.fromEntries(rows.map(r => [r.account, {data: JSON.parse(r.data), updated: r.updated}]));
    },
    dump: async () => {
      await packTable(DB);
      const all = async (q) => (await DB.prepare(q).all()).results || [];
      const players = Object.fromEntries((await all(`SELECT account, seen FROM players`)).map(r => [r.account, r.seen]));
      const holdings = Object.fromEntries((await all(`SELECT account, tokens, updated FROM holdings`).catch(() => [])).map(r => [r.account, {tokens: JSON.parse(r.tokens || "[]"), updated: r.updated}]));
      const packs = Object.fromEntries((await all(`SELECT account, pack, pending, week, lock_week AS lockWeek FROM packs`)).map(r => [r.account, r]));
      const profiles = Object.fromEntries((await all(`SELECT account, name, updated FROM profiles`).catch(() => [])).map(r => [r.account, {name: r.name, updated: r.updated}]));
      return {players, weekly: await all(`SELECT * FROM weekly`), holdings, packs, profiles};
    },
    loansAll: async () => {
      await DB.prepare(`CREATE TABLE IF NOT EXISTS loans (id TEXT PRIMARY KEY, data TEXT)`).run();
      return ((await DB.prepare(`SELECT data FROM loans`).all()).results || []).map(r => JSON.parse(r.data));
    },
    loanSet: async (l) => {
      await DB.prepare(`CREATE TABLE IF NOT EXISTS loans (id TEXT PRIMARY KEY, data TEXT)`).run();
      await DB.prepare(`INSERT INTO loans (id, data) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET data = ?2`).bind(l.id, JSON.stringify(l)).run();
    },
    lendAdd: async (owner, e, dayKey, cap) => {
      await DB.prepare(`CREATE TABLE IF NOT EXISTS lendq (account TEXT, data TEXT, at INTEGER)`).run();
      await DB.prepare(`CREATE TABLE IF NOT EXISTS lend_day (k TEXT PRIMARY KEY, xp INTEGER)`).run();
      const used = ((await DB.prepare(`SELECT xp FROM lend_day WHERE k = ?1`).bind(dayKey).first()) || {}).xp || 0;
      const trainer = Math.max(0, Math.min(e.trainer, cap - used));
      await DB.prepare(`INSERT INTO lend_day (k, xp) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET xp = ?2`).bind(dayKey, used + trainer).run();
      await DB.prepare(`INSERT INTO lendq (account, data, at) VALUES (?1, ?2, ?3)`).bind(owner, JSON.stringify({...e, trainer}), e.at).run();
    },
    lendGet: async (a) => {
      await DB.prepare(`CREATE TABLE IF NOT EXISTS lendq (account TEXT, data TEXT, at INTEGER)`).run();
      return ((await DB.prepare(`SELECT data FROM lendq WHERE account = ?1 ORDER BY at`).bind(a).all()).results || []).map(r => JSON.parse(r.data));
    },
    lendClear: async (a, upTo) => { await DB.prepare(`DELETE FROM lendq WHERE account = ?1 AND at <= ?2`).bind(a, upTo).run(); },
    resultGet: async (wk) => {
      await DB.prepare(`CREATE TABLE IF NOT EXISTS results (week TEXT PRIMARY KEY, data TEXT)`).run();
      const r = await DB.prepare(`SELECT data FROM results WHERE week = ?1`).bind(wk).first();
      return r ? JSON.parse(r.data) : null;
    },
    resultSet: async (wk, rec) => {
      await DB.prepare(`CREATE TABLE IF NOT EXISTS results (week TEXT PRIMARY KEY, data TEXT)`).run();
      await DB.prepare(`INSERT INTO results (week, data) VALUES (?1, ?2) ON CONFLICT(week) DO UPDATE SET data = ?2`).bind(wk, JSON.stringify(rec)).run();
    },
    blobGet: async (k) => {
      await DB.prepare(`CREATE TABLE IF NOT EXISTS blobs (k TEXT PRIMARY KEY, data TEXT)`).run();
      const r = await DB.prepare(`SELECT data FROM blobs WHERE k = ?1`).bind(k).first();
      return r ? JSON.parse(r.data) : null;
    },
    blobSet: async (k, v) => {
      await DB.prepare(`CREATE TABLE IF NOT EXISTS blobs (k TEXT PRIMARY KEY, data TEXT)`).run();
      await DB.prepare(`INSERT INTO blobs (k, data) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET data = ?2`).bind(k, JSON.stringify(v)).run();
    },
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
  await storeOf(env).seen(account, Date.now());                  // counts as activity for the admin numbers
  // Remember which Scrappys this player fights with, so nobody meets them as a rival.
  const tokenOfUri = uri => +(String(uri).match(/(\d+)\.json$/) || [])[1] || 0;
  const tokens = nfts.map(n => tokenOfUri(n.uri)).filter(Boolean);
  const dogs = nfts.map(n => ({t: tokenOfUri(n.uri), id: n.nft_id, uri: n.uri})).filter(d => d.t);
  await storeOf(env).holdings(account, tokens, Date.now(), dogs);
  const prof = (await storeOf(env).profiles())[account];
  const res = {account, nfts, name: prof ? prof.name : null};
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
    const p = by[r.pack]; if (!p || isTeam(env, r.account)) continue;
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

/* ------------------------------------------------------------------ collection index */
/* Every Pixel Scrappy with its NFTokenID and current owner, read with the Clio
   method nfts_by_issuer and cached for a day (memory + disk). Used for the
   "buy this rival" link and anything that needs to know who holds a token. */
const INDEX_TTL = 24 * 3600;
let indexBuild = null;
async function collectionIndex(env) {
  const c = (env.KV && await env.KV.get("nftindex", "json")) || (env.FILES && await env.FILES.getJson("nftindex"));
  if (c && Date.now() - c.at < INDEX_TTL * 1000) return c;
  if (!indexBuild) indexBuild = (async () => {
    const byToken = {}; let marker, pages = 0;
    try {
      do {
        const d = await xrplRequest({method: "nfts_by_issuer", params: [{issuer: env.ISSUER, limit: 400,
          ...(env.TAXON && env.TAXON !== "*" ? {nft_taxon: Number(env.TAXON)} : {}), ...(marker ? {marker} : {})}]});
        for (const n of d.nfts || []) {
          const t = +(hex2str(n.uri || n.URI).match(/(\d+)\.json$/) || [])[1];
          if (t) byToken[t] = {id: n.nft_id || n.NFTokenID, owner: n.owner || n.Owner || ""};
        }
        marker = d.marker; pages++;
      } while (marker && pages < 40);
    } catch (e) { if (!Object.keys(byToken).length) return c || {at: 0, byToken: {}}; }
    const out = {at: Date.now(), byToken};
    if (env.KV) await env.KV.put("nftindex", JSON.stringify(out), {expirationTtl: INDEX_TTL});
    if (env.FILES) await env.FILES.putJson("nftindex", out);
    return out;
  })().finally(() => { indexBuild = null; });
  return indexBuild;
}
async function nftLookup(env, token) {
  const t = +token; if (!(t >= 1 && t <= 99999)) return json({error: "bad_token"}, 400);
  const e = (await collectionIndex(env)).byToken[t];
  return json(e ? {token: t, id: e.id, owner: e.owner, url: `https://xrp.cafe/nft/${e.id}`} : {token: t, id: null, url: "https://xrp.cafe/collection/pixel-scrappy"});
}

/* ------------------------------------------------------------------ names & arena rivals */
const displayName = (names, a) => (names && names[a] && names[a].name) || shortAcct(a);
/* Team wallets (the issuer, plus TEAM=r…,r… if set) play for testing: they show
   on the boards marked as team, but never take a prize or count for a pack. */
const isTeam = (env, a) => !!a && (a === env.ISSUER || String(env.TEAM || "").split(",").map(x => x.trim()).includes(a));
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.\-]{1,14}[A-Za-z0-9_.]$/;           // 3–16 chars, no leading/trailing space
async function setProfile(env, account, b) {
  const name = String((b && b.name) || "").replace(/\s+/g, " ").trim();
  if (name && !NAME_RE.test(name)) return json({error: "bad_name"}, 400);
  if (name && /^r[1-9A-HJ-NP-Za-km-z]{5,}/.test(name)) return json({error: "bad_name"}, 400);   // no look-alike wallets
  if (!(await storeOf(env).profileSet(account, name))) return json({error: "name_taken"}, 409);
  if (env.KV) await env.KV.put("public:board", "", {expirationTtl: 1});
  return json({ok: true, name: name || null});
}
/* Arena rivals: only Scrappys other signed-in players hold, at the bond level
   their owner has trained them to, labelled with the owner's name. */
const today = () => new Date().toISOString().slice(0, 10);
const DEFENSE_XP = {win: 18, loss: 6}, DEFENSE_CAP = 120;            // bond XP per defence, per dog per day
async function arenaRivals(env, account) {
  const st = storeOf(env), hold = await st.allHoldings(), names = await st.profiles(), reg = await st.arenaRegAll(), day = today();
  const squads = [], others = [];
  for (const [owner, h] of Object.entries(hold)) {
    if (owner === account) continue;
    const save = (await st.saveGet(owner) || {}).data || {};
    const r = reg[owner] && reg[owner].day === day ? reg[owner].ids : [];
    for (const d of h.dogs || []) {
      const g = (save.dogs || {})[d.id] || {};
      const x = {token: d.t, id: d.id, uri: d.uri, lvl: Math.max(1, Math.min(10, g.lvl | 0 || 1)), owner: displayName(names, owner), squad: r.includes(d.id)};
      (x.squad ? squads : others).push(x);
    }
  }
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  // today's registered squads first; other players' dogs only fill up while few squads are in
  const out = [...shuffle(squads), ...shuffle(others)].slice(0, 30);
  return json({rivals: out, total: squads.length + others.length, squads: squads.length});
}
/* Register today's arena squad: these dogs defend (and earn bond XP) in other players' arenas. */
async function arenaSquad(env, account, b) {
  const ids = Array.isArray(b && b.ids) ? b.ids.map(String).slice(0, 3) : [];
  const h = (await storeOf(env).allHoldings())[account] || {};
  const own = new Set((h.dogs || []).map(d => d.id));
  const valid = ids.filter(id => own.has(id));
  await storeOf(env).arenaRegSet(account, today(), valid);
  return json({ok: true, day: today(), ids: valid});
}
/* An arena fight against another player's dog: credit that dog's owner with bond XP. */
async function arenaResult(env, account, b) {
  const id = String((b && b.id) || ""), day = today();
  if (!id) return json({error: "bad_id"}, 400);
  if (env.KV) {                                                    // 3 tournaments x 3 rounds a day, a little slack
    const k = `defrep:${account}:${day}`, n = +(await env.KV.get(k) || 0);
    if (n >= 12) return json({ok: true, credited: 0});
    await env.KV.put(k, String(n + 1), {expirationTtl: 2 * 86400});
  }
  const st = storeOf(env), hold = await st.allHoldings(), reg = await st.arenaRegAll();
  const owner = Object.keys(hold).find(o => o !== account && (hold[o].dogs || []).some(d => d.id === id));
  if (!owner) return json({ok: true, credited: 0});
  // only dogs in the owner's registered squad for today earn bond XP
  if (!(reg[owner] && reg[owner].day === day && reg[owner].ids.includes(id))) return json({ok: true, credited: 0});
  const names = await st.profiles(), won = !b.attackerWon;
  const xp = await st.defenseAdd(owner, {id, xp: won ? DEFENSE_XP.win : DEFENSE_XP.loss, won, vs: displayName(names, account), at: Date.now()},
    `${id}|${day}`, DEFENSE_CAP);
  return json({ok: true, credited: xp});
}

/* ------------------------------------------------------------------ Fight Club */
/* Live duels between two players, refereed here. Both pick a move each round;
   when both are in (or the 20 s are up — a missing move counts as guard, and
   a second miss is a forfeit) the server draws the seed, resolves the round
   with the game's own engine (env.ENGINE) and hands both pages the moves and
   the seed, so they replay exactly the same round. The server's state decides
   the winner. Duels live in memory; the records are stored. Beta: no ranked XP. */
const CLUB_TURN_MS = 20000, CLUB_INVITE_MS = 15 * 60 * 1000, CLUB_KEEP_MS = 10 * 60 * 1000;
const DUELS = new Map();
const rid = () => [...crypto.getRandomValues(new Uint8Array(9))].map(b => b.toString(16).padStart(2, "0")).join("");
async function clubFighter(env, account, dogId) {
  const h = (await storeOf(env).allHoldings())[account] || {};
  const dog = (h.dogs || []).find(d => d.id === String(dogId));
  if (!dog) return null;
  const meta = await metaFor(env, dog.uri);
  const def = env.ENGINE.defFromMeta({nft_id: dog.id}, meta);
  const save = (await storeOf(env).saveGet(account) || {}).data || {};
  const lvl = Math.max(1, Math.min(10, ((save.dogs || {})[dog.id] || {}).lvl | 0 || 1));
  return {acct: account, name: displayName(await storeOf(env).profiles(), account), def, lvl, img: meta.image, uri: dog.uri};
}
function clubTick(env, d) {
  const now = Date.now();
  if (d.status === "open" && now - d.created > CLUB_INVITE_MS) { d.status = "done"; d.result = {winner: null, why: "expired"}; d.ended = now; }
  // catch up on every round whose time ran out, even if nobody asked in between
  while (d.status === "active" && now >= d.deadline) {
    const auto = {a: !d.moves.a, b: !d.moves.b};
    for (const s of ["a", "b"]) if (auto[s]) { d.moves[s] = "guard"; d.misses[s]++; }
    if (d.misses.a >= 2 || d.misses.b >= 2) {                      // a second missed round forfeits
      const both = d.misses.a >= 2 && d.misses.b >= 2;
      return clubFinish(env, d, both ? null : (d.misses.a >= 2 ? "b" : "a"), both ? "both players stopped answering" : "missed two rounds");
    }
    clubResolve(env, d, auto, d.deadline);
  }
}
function clubResolve(env, d, auto, from) {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const r = env.ENGINE.round(d.st, d.moves.a, d.moves.b, seed);
  d.rounds.push({t: d.st.turn, a: d.moves.a, b: d.moves.b, seed, auto: auto || {a: false, b: false}});
  d.st = r.state; d.moves = {a: null, b: null}; d.deadline = (from || Date.now()) + CLUB_TURN_MS;
  if (r.verdict) clubFinish(env, d, r.verdict === "DRAW" ? null : (r.verdict === "YOU WIN" ? "a" : "b"), "");
}
function clubFinish(env, d, winner, why) {
  d.status = "done"; d.ended = Date.now(); d.result = {winner, why};
  const st = storeOf(env);
  if (winner) { st.clubAdd(d[winner].acct, "w"); st.clubAdd(d[winner === "a" ? "b" : "a"].acct, "l"); }
  else { st.clubAdd(d.a.acct, "d"); st.clubAdd(d.b.acct, "d"); }
}
function clubView(d, me) {
  const side = d.a.acct === me ? "a" : d.b && d.b.acct === me ? "b" : null;
  const pub = f => f && {name: f.name, def: f.def, lvl: f.lvl, img: f.img, uri: f.uri};
  return {id: d.id, status: d.status, side, a: pub(d.a), b: pub(d.b), invite: d.inviteName || null, open: !!d.open,
    turn: d.st ? d.st.turn : 0, left: d.status === "active" ? Math.max(0, d.deadline - Date.now()) : 0,
    moved: {you: !!(side && d.moves[side]), them: !!(side && d.moves[side === "a" ? "b" : "a"])},
    rounds: d.rounds, result: d.result, hp: d.st ? {a: d.st.P.hp, b: d.st.E.hp} : null};
}
async function clubRoute(env, account, p, req, url) {
  if (!env.ENGINE) return json({error: "club_unavailable"}, 501);
  for (const [id, d] of DUELS) { clubTick(env, d); if (d.status === "done" && Date.now() - d.ended > CLUB_KEEP_MS) DUELS.delete(id); }
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  if (p === "/club/me") {
    const mine = [...DUELS.values()].filter(d => d.status !== "done" && (d.a.acct === account || (d.b && d.b.acct === account) || d.inviteAcct === account));
    // open challenges: posted to everyone in the Club, newest first
    const lobby = [...DUELS.values()].filter(d => d.open && d.status === "open" && d.a.acct !== account)
      .sort((x, y) => y.created - x.created).slice(0, 12).map(d => ({...clubView(d, account), posted: d.created}));
    return json({record: await storeOf(env).clubGet(account), duels: mine.map(d => clubView(d, account)).map((v, i) => ({...v, forMe: mine[i].inviteAcct === account && !mine[i].b})), lobby});
  }
  if (p === "/club/create") {
    if ([...DUELS.values()].filter(d => d.a.acct === account && d.status !== "done").length >= 3) return json({error: "too_many_open"}, 429);
    const me = await clubFighter(env, account, body.dogId);
    if (!me) return json({error: "not_your_dog"}, 400);
    let inviteAcct = null, inviteName = null;
    if (body.opponent) {
      const names = await storeOf(env).profiles(), want = String(body.opponent).trim().toLowerCase();
      inviteAcct = Object.keys(names).find(a => names[a].name.toLowerCase() === want) || null;
      if (!inviteAcct || inviteAcct === account) return json({error: "no_such_player"}, 404);
      inviteName = names[inviteAcct].name;
    }
    const open = !inviteAcct && !!body.open;
    const d = {id: rid(), created: Date.now(), status: "open", a: me, b: null, inviteAcct, inviteName, open,
               st: null, moves: {a: null, b: null}, misses: {a: 0, b: 0}, rounds: [], result: null, deadline: 0};
    DUELS.set(d.id, d);
    if (open) await chatSystem(env, `🥊 ${me.name} posted an open Fight Club challenge with ${me.def.name} (Bond ${me.lvl}) — accept it in the Club tab.`);
    return json({duel: clubView(d, account)});
  }
  const d = DUELS.get(String(body.id || url.searchParams.get("id") || ""));
  if (!d) return json({error: "no_such_duel"}, 404);
  if (p === "/club/state") return json({duel: clubView(d, account)});
  if (p === "/club/join") {
    if (d.status !== "open") return json({error: "duel_not_open"}, 409);
    if (d.a.acct === account) return json({error: "own_duel"}, 400);
    if (d.inviteAcct && d.inviteAcct !== account) return json({error: "not_invited"}, 403);
    const me = await clubFighter(env, account, body.dogId);
    if (!me) return json({error: "not_your_dog"}, 400);
    d.b = me; d.status = "active"; d.st = env.ENGINE.start(d.a.def, d.a.lvl, d.b.def, d.b.lvl); d.deadline = Date.now() + CLUB_TURN_MS;
    return json({duel: clubView(d, account)});
  }
  if (p === "/club/cancel") {
    if (d.a.acct !== account || d.status !== "open") return json({error: "cannot_cancel"}, 409);
    d.status = "done"; d.ended = Date.now(); d.result = {winner: null, why: "cancelled"};
    return json({ok: true});
  }
  if (p === "/club/move") {
    const side = d.a.acct === account ? "a" : d.b && d.b.acct === account ? "b" : null;
    if (!side || d.status !== "active") return json({error: "not_in_this_duel"}, 409);
    const m = String(body.move || "");
    if (!/^(bite|guard|taunt|ab[0-2])$/.test(m)) return json({error: "bad_move"}, 400);
    if (!d.moves[side]) d.moves[side] = m;
    if (d.moves.a && d.moves.b) clubResolve(env, d);
    return json({duel: clubView(d, account)});
  }
  if (p === "/club/leave") {
    const side = d.a.acct === account ? "a" : d.b && d.b.acct === account ? "b" : null;
    if (side && d.status === "active") clubFinish(env, d, side === "a" ? "b" : "a", "left the ring");
    return json({duel: clubView(d, account)});
  }
  return json({error: "not_found"}, 404);
}

/* ------------------------------------------------------------------ lending */
/* A holder lends one of their Scrappys to a player without one. The NFT never
   moves — this is a record here. The borrower fights with it like their own;
   every bond XP it earns goes to the dog (the owner's save, collected on their
   next visit) and the owner gets 25 % of the trainer XP the borrower earns with
   it. If a borrower wins a weekly prize mostly with a borrowed dog, the lender
   gets a prize share (an extra line for the admin in week close). */
const LEND_MAX_OUT = 3, LEND_DAYS = [1, 14], LEND_SHARE = 0.25, LEND_TRAINER_CAP = 150;   // trainer XP per owner per day
async function activeLoans(env) {
  const st = storeOf(env), hold = await st.allHoldings(), now = Date.now();
  return (await st.loansAll()).filter(l => !l.ended && now < l.end &&
    ((hold[l.owner] || {}).dogs || []).some(d => d.id === l.dog.id));       // sold the dog = loan over
}
async function lendInfo(env, account) {
  const st = storeOf(env), names = await st.profiles(), loans = await activeLoans(env);
  const view = l => ({id: l.id, dog: l.dog, owner: l.owner, ownerName: displayName(names, l.owner),
    borrower: l.borrower, borrowerName: displayName(names, l.borrower), end: l.end});
  const inn = loans.filter(l => l.borrower === account).map(l => view(l));
  for (const l of inn) {                                                     // the dog's real bond, from its owner's save
    const g = (((await st.saveGet(l.owner)) || {}).data || {}).dogs || {};
    l.lvl = Math.max(1, (g[l.dog.id] || {}).lvl | 0 || 1); l.xp = (g[l.dog.id] || {}).xp | 0;
  }
  const seek = await seekersOf(env, loans), mine = seek.find(x => x.account === account);
  return {out: loans.filter(l => l.owner === account).map(view), in: inn, rewards: await st.lendGet(account),
    seeking: !!mine, seekers: seek.filter(x => x.account !== account).map(x => ({name: x.name, since: x.at}))};
}
/* "Looking for a dog": players without a Scrappy can put their name on a list
   every holder sees in the lending card (a week, or until they borrow one). */
const SEEK_TTL = 7 * 864e5;
async function seekersOf(env, loans) {
  const st = storeOf(env), list = (await st.blobGet("lendseek")) || {}, hold = await st.allHoldings(), names = await st.profiles(), now = Date.now();
  return Object.entries(list).filter(([a, at]) => now - at < SEEK_TTL && names[a] && !((hold[a] || {}).tokens || []).length && !loans.some(l => l.borrower === a))
    .sort((x, y) => y[1] - x[1]).slice(0, 20).map(([a, at]) => ({account: a, name: names[a].name, at}));
}
async function lendSeek(env, account, b) {
  const st = storeOf(env), hold = await st.allHoldings(), names = await st.profiles();
  const list = (await st.blobGet("lendseek")) || {};
  if (b && b.on) {
    if (((hold[account] || {}).tokens || []).length) return json({error: "borrower_holds"}, 409);
    if (!names[account]) return json({error: "need_name"}, 409);
    const fresh = !list[account];
    list[account] = Date.now();
    if (fresh) await chatSystem(env, `🤝 ${names[account].name} is looking for a Scrappy to borrow — holders can lend one in their kennel.`);
  } else delete list[account];
  for (const [a, at] of Object.entries(list)) if (Date.now() - at > SEEK_TTL) delete list[a];
  await st.blobSet("lendseek", list);
  return json({ok: true, ...(await lendInfo(env, account))});
}

/* ------------------------------------------------------------------ chat */
/* One small room for everybody who is signed in. The last 80 messages are kept;
   pages poll for new ones. Plain text only: no links (phishing) except our own
   sites, nothing that looks like a wallet secret, one message per 4 s. The admin
   can delete a message or mute a wallet. */
const CHAT_KEEP = 80, CHAT_MAX = 200, CHAT_GAP_MS = 4000;
const CHAT_TLDS = /^(?:com|net|org|io|xyz|app|fun|link|gg|me|co|ly|to|info|site|online|club|top|vip|pro|shop|store|live|ru|cn|de|uk|us|tk|ml|ga|cf|gq|finance|exchange|dev|ai|so|cc|tv|biz|money|claim|click|win|bet|nft|art|page|eu|in|xrp)$/i;
const CHAT_OK_HOSTS = /^(?:[a-z0-9-]+\.)*(?:scrappyxrp\.fun|xrp\.cafe)$/i;
async function chatLoad(env) { return (await storeOf(env).blobGet("chat")) || {seq: 0, msgs: [], mute: {}, last: {}}; }
async function chatSave(env, c) { c.msgs = c.msgs.slice(-CHAT_KEEP); await storeOf(env).blobSet("chat", c); }
async function chatSystem(env, text) {
  const c = await chatLoad(env);
  c.msgs.push({id: ++c.seq, at: Date.now(), sys: true, text: String(text).slice(0, 240)});
  await chatSave(env, c);
}
const chatPublic = m => ({id: m.id, at: m.at, who: m.who || null, text: m.text, ...(m.sys ? {sys: true} : {}), ...(m.team ? {team: true} : {})});
async function chatGet(env, account, since) {
  const c = await chatLoad(env), n = Math.max(0, +since || 0);
  return json({seq: c.seq, msgs: c.msgs.filter(m => m.id > n).map(chatPublic), muted: !!c.mute[account]});
}
function chatClean(t) {
  return String(t || "").replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e]/g, " ").replace(/\s+/g, " ").trim().slice(0, CHAT_MAX);
}
async function chatPost(env, account, b) {
  const text = chatClean(b && b.text);
  if (!text) return json({error: "empty"}, 400);
  const hosts = text.match(/(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[\/:?#]\S*)?/gi) || [];
  for (const h of hosts) {
    const host = h.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[\/:?#]/)[0];
    const linky = /^(?:https?:\/\/|www\.)/i.test(h) || CHAT_TLDS.test(host.split(".").pop());
    if (linky && !CHAT_OK_HOSTS.test(host)) return json({error: "no_links"}, 400);
  }
  if (/\bs[1-9A-HJ-NP-Za-km-z]{28}\b/.test(text))                        // a family seed: never in public
    return json({error: "no_secrets"}, 400);
  const c = await chatLoad(env);
  if (c.mute[account]) return json({error: "muted"}, 403);
  const now = Date.now();
  if (now - (c.last[account] || 0) < CHAT_GAP_MS) return json({error: "slow_down"}, 429);
  c.last[account] = now;
  for (const [a, t] of Object.entries(c.last)) if (now - t > 3600e3) delete c.last[a];
  const names = await storeOf(env).profiles();
  c.msgs.push({id: ++c.seq, at: now, a: account, who: displayName(names, account), text, ...(isTeam(env, account) ? {team: true} : {})});
  await chatSave(env, c);
  return json({ok: true, seq: c.seq});
}
async function adminChat(env, p, b) {
  const c = await chatLoad(env);
  if (p === "/admin/chat/del") { c.msgs = c.msgs.filter(m => m.id !== +b.id); await chatSave(env, c); }
  if (p === "/admin/chat/mute") {
    const a = String(b.account || "");
    if (!/^r\w{20,40}$/.test(a)) return json({error: "bad_account"}, 400);
    if (b.on) c.mute[a] = Date.now(); else delete c.mute[a];
    await chatSave(env, c);
  }
  return json({msgs: c.msgs, mute: Object.keys(c.mute)});
}
async function lendStart(env, account, b) {
  const st = storeOf(env), hold = await st.allHoldings(), loans = await activeLoans(env);
  const dog = ((hold[account] || {}).dogs || []).find(d => d.id === String(b.dogId || ""));
  if (!dog) return json({error: "not_your_dog"}, 400);
  const names = await st.profiles(), want = String(b.to || "").trim().toLowerCase();
  const to = Object.keys(names).find(a => names[a].name.toLowerCase() === want);
  if (!to || to === account) return json({error: "no_such_player"}, 404);
  if (((hold[to] || {}).tokens || []).length) return json({error: "borrower_holds"}, 409);
  if (loans.some(l => l.borrower === to)) return json({error: "borrower_busy"}, 409);
  if (loans.some(l => l.dog.id === dog.id)) return json({error: "dog_lent"}, 409);
  if (loans.filter(l => l.owner === account).length >= LEND_MAX_OUT) return json({error: "too_many_loans"}, 429);
  const days = Math.max(LEND_DAYS[0], Math.min(LEND_DAYS[1], b.days | 0 || 7));
  const loan = {id: rid(), owner: account, borrower: to, dog: {id: dog.id, uri: dog.uri, t: dog.t}, start: Date.now(), end: Date.now() + days * 864e5, xp: {}};
  await st.loanSet(loan);
  return json({ok: true, ...(await lendInfo(env, account))});
}
async function lendEnd(env, account, b) {
  const st = storeOf(env), l = (await st.loansAll()).find(x => x.id === String(b.id || ""));
  if (!l || (l.owner !== account && l.borrower !== account)) return json({error: "no_such_loan"}, 404);
  if (!l.ended) { l.ended = Date.now(); await st.loanSet(l); }
  return json({ok: true, ...(await lendInfo(env, account))});
}
/* The borrower's page reports what a fight with the borrowed dog earned. */
async function lendReport(env, account, b) {
  const st = storeOf(env), l = (await activeLoans(env)).find(x => x.id === String(b.id || "") && x.borrower === account);
  if (!l) return json({error: "no_such_loan"}, 404);
  const bond = Math.max(0, Math.min(100, b.bond | 0)), trainer = Math.max(0, Math.min(50, b.trainer | 0));
  if (!bond && !trainer) return json({ok: true});
  const wk = weekOf();
  l.xp[wk] = (l.xp[wk] || 0) + bond;                                         // ladder XP with this dog, for the prize share
  await st.loanSet(l);
  const share = Math.round(trainer * LEND_SHARE);
  await st.lendAdd(l.owner, {id: l.dog.id, t: l.dog.t, bond, trainer: share, from: account, at: Date.now()}, `${l.owner}|${today()}`, LEND_TRAINER_CAP);
  return json({ok: true});
}

/* ------------------------------------------------------------------ week close: verifiable results + prizes */
/* After a week ends its results are frozen once: a canonical JSON of the final
   player and pack standings plus the prize winners, and its SHA-256. The admin
   anchors that hash on the XRPL (an AccountSet with a memo, signed with Xaman
   from the issuer wallet), so anyone can check later that the published
   results were never changed: sha256(json) = the memo on the ledger.
   Prizes: the treasury (Pixel Scrappys held by the issuer wallet) pays the top
   3 of the XP ladder and the most active member of the winning pack. The admin
   signs an NFTokenCreateOffer (sell, Amount 0, Destination = winner) per prize;
   the winner accepts it in the game (Xaman) or in any wallet. No key on the server. */
const CLOSE_GRACE_MS = 15 * 60 * 1000;                     // late stats posts land before we freeze
const PRIZE_PLACES = ["1", "2", "3", "pack"];
const weekEndMs = wk => Date.parse(wk + "T00:00:00Z") + 7 * 864e5;
const closable = wk => /^\d{4}-\d{2}-\d{2}$/.test(wk) && weekOf(new Date(wk + "T12:00:00Z")) === wk && Date.now() >= weekEndMs(wk) + CLOSE_GRACE_MS;
async function sha256hex(s) {
  const b = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function buildResults(env, wk) {
  const st = storeOf(env), names = await st.profiles();
  const rows = (await st.weekRows(wk)).filter(r => (r.xp | 0) > 0 || (r.wins | 0) + (r.losses | 0) > 0)
    .sort((a, b) => (b.xp | 0) - (a.xp | 0) || (b.wins | 0) - (a.wins | 0) || (a.account < b.account ? -1 : 1));
  const players = rows.map((r, i) => ({rank: i + 1, account: r.account, name: displayName(names, r.account),
    xp: r.xp | 0, wins: r.wins | 0, losses: r.losses | 0, streak: r.streak | 0, pack: r.pack || null,
    ...(isTeam(env, r.account) ? {team: true} : {})}));
  const packs = (await packRows(env, wk)).filter(p => p.members > 0)
    .map(p => ({id: p.id, members: p.members, wins: p.wins, losses: p.losses, xp: p.xp, perMember: Math.round(100 * p.wins / p.members) / 100}))
    .sort((a, b) => b.perMember - a.perMember || b.wins - a.wins || (a.id < b.id ? -1 : 1))
    .map((p, i) => ({rank: i + 1, ...p}));
  const prizes = players.filter(p => p.xp > 0 && !p.team).slice(0, 3).map((p, i) => ({place: String(i + 1), account: p.account, name: p.name}));
  const win = packs[0];
  if (win && win.wins > 0) {
    const taken = new Set(prizes.map(p => p.account));
    const active = players.filter(p => p.pack === win.id && !p.team && !taken.has(p.account))
      .sort((a, b) => (b.wins + b.losses) - (a.wins + a.losses) || b.xp - a.xp)[0];
    if (active) prizes.push({place: "pack", account: active.account, name: active.name, pack: win.id});
  }
  // lender's share: a prize won mostly (≥ 50 % of the week's XP) with a borrowed dog
  const loans = await st.loansAll();
  for (const p of [...prizes]) {
    const xp = (players.find(x => x.account === p.account) || {}).xp || 0;
    const best = loans.filter(l => l.borrower === p.account && (l.xp || {})[wk]).sort((a, b) => b.xp[wk] - a.xp[wk])[0];
    if (best && xp && best.xp[wk] * 2 >= xp)
      prizes.push({place: "L" + p.place, account: best.owner, name: displayName(names, best.owner), lenderOf: p.place, dog: best.dog.t || null});
  }
  return {game: "Bark Arena", week: wk, players, packs, prizes};
}
/* The frozen record of a finished week (made on first use, never rebuilt). */
async function weekResult(env, wk) {
  const st = storeOf(env);
  let rec = await st.resultGet(wk);
  if (rec || !closable(wk)) return rec || null;
  const data = JSON.stringify(await buildResults(env, wk));
  rec = {week: wk, json: data, sha256: await sha256hex(data), frozen: Date.now(), anchor: null, prizes: {}};
  await st.resultSet(wk, rec);
  return rec;
}
const lastWeeks = n => Array.from({length: n}, (_, i) => weekOf(new Date(Date.now() - (i + 1) * 7 * 864e5)));
function publicResult(rec) {
  const d = JSON.parse(rec.json);
  return {week: rec.week, sha256: rec.sha256, json: rec.json, anchor: rec.anchor,
    prizes: d.prizes.map(p => ({place: p.place, name: p.name, pack: p.pack || null,
      token: (rec.prizes[p.place] || {}).token || null, status: (rec.prizes[p.place] || {}).status || "pending"})),
    verify: "sha256(json) must equal the sha256 in the memo of the anchor transaction"};
}
async function publicResults(env, week) {
  const weeks = week ? [week] : lastWeeks(8);
  for (const wk of weeks) {
    const rec = await weekResult(env, wk);
    if (rec) return json(publicResult(rec));
  }
  return json({error: "no_results"}, 404);
}

/* --- Xaman payloads, signed by the admin (issuer wallet) or a prize winner --- */
async function xamanPayload(env, txjson, instruction, signer, pending) {
  if (!env.XUMM_API_KEY) return json({error: "xaman_not_configured"}, 501);
  const r = await fetch(`${XUMM}/payload`, {method: "POST",
    headers: {"content-type": "application/json", "X-API-Key": env.XUMM_API_KEY, "X-API-Secret": env.XUMM_API_SECRET},
    body: JSON.stringify({txjson, options: {submit: true, expire: 10, ...(signer ? {signers: [signer]} : {})},
      custom_meta: {instruction}})});
  if (!r.ok) return json({error: "xaman_unavailable", status: r.status}, 502);
  const p = await r.json();
  await env.KV.put(`xpay:${p.uuid}`, JSON.stringify(pending), {expirationTtl: 24 * 3600});
  return json({uuid: p.uuid, qr: p.refs.qr_png, deeplink: p.next.always});
}
/* Poll a payload; once signed, record what it did (only once). */
async function xamanResolve(env, uuid, account) {
  if (!/^[0-9a-f-]{36}$/i.test(uuid || "")) return json({error: "bad_uuid"}, 400);
  const pend = await env.KV.get(`xpay:${uuid}`, "json");
  if (!pend || (account && pend.account !== account)) return json({error: "unknown_payload"}, 404);
  const r = await fetch(`${XUMM}/payload/${uuid}`, {headers: {"X-API-Key": env.XUMM_API_KEY, "X-API-Secret": env.XUMM_API_SECRET}});
  if (!r.ok) return json({error: "xaman_unavailable"}, 502);
  const p = await r.json();
  if (p.meta.expired && !p.meta.signed) return json({state: "expired"});
  if (!p.meta.resolved) return json({state: "pending"});
  if (!p.meta.signed) return json({state: "rejected"});
  const txid = p.response.txid, result = p.response.dispatched_result || "", signer = p.response.account;
  if (result && result !== "tesSUCCESS") return json({state: "failed", result});
  if (!pend.done) {
    const st = storeOf(env), rec = await st.resultGet(pend.week);
    if (rec) {
      if (pend.kind === "anchor") rec.anchor = {txid, account: signer, at: Date.now()};
      if (pend.kind === "offer") rec.prizes[pend.place] = {...rec.prizes[pend.place], status: "offered", offerTx: txid, at: Date.now()};
      if (pend.kind === "accept") rec.prizes[pend.place] = {...rec.prizes[pend.place], status: "claimed", claimTx: txid, claimed: Date.now()};
      await st.resultSet(pend.week, rec);
      if (env.KV) await env.KV.put("public:board", "", {expirationTtl: 1});
    }
    await env.KV.put(`xpay:${uuid}`, JSON.stringify({...pend, done: true}), {expirationTtl: 24 * 3600});
  }
  return json({state: "signed", txid, result});
}
const memoHex = s => hexOf(s);
async function adminSeason(env) {
  const weeks = [];
  for (const wk of lastWeeks(6)) {
    const rec = await weekResult(env, wk);
    if (!rec) { weeks.push({week: wk, open: true}); continue; }
    const d = JSON.parse(rec.json);
    weeks.push({week: wk, sha256: rec.sha256, anchor: rec.anchor, players: d.players.length, top: d.players.slice(0, 5), packs: d.packs,
      prizes: d.prizes.map(p => ({...p, ...(rec.prizes[p.place] || {})}))});
  }
  let treasury = [], treasuryError = null;
  try {
    const used = new Set();
    for (const wk of lastWeeks(60)) {
      const rec = await storeOf(env).resultGet(wk);
      if (rec) for (const x of Object.values(rec.prizes || {})) if (x.nftId) used.add(x.nftId);
    }
    treasury = (await accountNfts(env, env.ISSUER)).filter(n => !used.has(n.nft_id))
      .map(n => ({nftId: n.nft_id, uri: n.uri, token: +(n.uri.match(/(\d+)\.json$/) || [])[1] || null}))
      .sort((a, b) => (a.token || 0) - (b.token || 0));
    await treasuryRarity(env, treasury);
  } catch (e) { treasuryError = String(e.message); }
  return json({issuer: env.ISSUER, xaman: !!env.XUMM_API_KEY, weeks, treasury, treasuryError});
}
/* Rarity of each treasury Scrappy from its metadata (disk-cached), so the admin
   page can hand the rarest pieces to the top places. rank: higher = rarer. */
const RARITY_RANK = {common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5, mythic: 6};
async function treasuryRarity(env, list) {
  let i = 0;
  const work = async () => { while (i < list.length) {
    const n = list[i++];
    try {
      const m = await metaFor(env, n.uri), get = k => (m.attributes.find(a => a.t.toLowerCase() === k) || {}).v || "";
      const handmade = n.token >= 1 && n.token <= 20;              // #1–#20: the hand-built Legendaries
      n.rarity = handmade ? "Legendary" : (get("rarity") || "Common");
      n.handmade = handmade;
      n.set = get("set") || null; n.setMatch = +get("set match") || 0;
      n.rank = handmade ? 7 : (RARITY_RANK[n.rarity.toLowerCase()] || 1);
    } catch { n.rarity = null; n.rank = 0; }
    delete n.uri;
  } };
  await Promise.all(Array.from({length: 6}, work));
}
async function adminAnchor(env, b) {
  const rec = await weekResult(env, String(b.week || ""));
  if (!rec) return json({error: "week_not_closed"}, 409);
  if (rec.anchor) return json({error: "already_anchored", anchor: rec.anchor}, 409);
  const origin = firstOrigin(env) || (env.RETURN_URL || "").replace(/\/$/, "");
  const memo = JSON.stringify({game: "Bark Arena", week: rec.week, sha256: rec.sha256, results: `${origin}/api/public/results?week=${rec.week}`});
  return xamanPayload(env, {TransactionType: "AccountSet", Account: env.ISSUER,
      Memos: [{Memo: {MemoType: memoHex("barkarena/results"), MemoFormat: memoHex("application/json"), MemoData: memoHex(memo)}}]},
    `Bark Arena: anchor the results of the week of ${rec.week} (sha256 ${rec.sha256.slice(0, 12)}…). No XRP is sent.`,
    env.ISSUER, {kind: "anchor", week: rec.week});
}
async function adminPrize(env, b) {
  const rec = await weekResult(env, String(b.week || ""));
  if (!rec) return json({error: "week_not_closed"}, 409);
  const place = String(b.place || ""), win = JSON.parse(rec.json).prizes.find(p => p.place === place);
  if (!win) return json({error: "no_such_prize"}, 404);
  if ((rec.prizes[place] || {}).status === "offered" || (rec.prizes[place] || {}).status === "claimed") return json({error: "already_offered"}, 409);
  const nft = (await accountNfts(env, env.ISSUER)).find(n => n.nft_id === String(b.nftId || ""));
  if (!nft) return json({error: "not_in_treasury"}, 404);
  const token = +(nft.uri.match(/(\d+)\.json$/) || [])[1] || null;
  rec.prizes[place] = {account: win.account, nftId: nft.nft_id, token, status: "signing"};
  await storeOf(env).resultSet(rec.week, rec);
  return xamanPayload(env, {TransactionType: "NFTokenCreateOffer", Account: env.ISSUER, NFTokenID: nft.nft_id,
      Amount: "0", Flags: 1, Destination: win.account},
    `Bark Arena prize, week of ${rec.week}, place ${place}: Pixel Scrappy #${token} for ${win.name}. A free sell offer only this player can accept.`,
    env.ISSUER, {kind: "offer", week: rec.week, place});
}
/* The player's side: prizes won, and accepting one. */
async function myPrizes(env, account) {
  const out = [];
  for (const wk of lastWeeks(12)) {
    const rec = await storeOf(env).resultGet(wk); if (!rec) continue;
    for (const [place, x] of Object.entries(rec.prizes || {}))
      if (x.account === account && (x.status === "offered" || x.status === "claimed"))
        out.push({week: wk, place, token: x.token, nftId: x.nftId, status: x.status});
  }
  return json({prizes: out});
}
async function claimPrize(env, account, b) {
  const rec = await storeOf(env).resultGet(String(b.week || "")), place = String(b.place || "");
  const x = rec && rec.prizes[place];
  if (!x || x.account !== account || x.status !== "offered") return json({error: "no_prize"}, 404);
  let offers = [];
  try { offers = (await xrplRequest({method: "nft_sell_offers", params: [{nft_id: x.nftId, ledger_index: "validated"}]})).offers || []; }
  catch (e) { if (e.message !== "objectNotFound") return json({error: "xrpl_unavailable"}, 502); }   // no offers left = objectNotFound
  const offer = offers.find(o => o.destination === account && String(o.amount) === "0");
  if (!offer) {
    // already accepted in another wallet? then it's theirs
    const mine = await accountNfts(env, account).catch(() => []);
    if (mine.some(n => n.nft_id === x.nftId)) {
      rec.prizes[place] = {...x, status: "claimed", claimed: Date.now()}; await storeOf(env).resultSet(rec.week, rec);
      return json({state: "claimed"});
    }
    return json({error: "offer_not_found"}, 404);
  }
  const res = await xamanPayload(env, {TransactionType: "NFTokenAcceptOffer", Account: account, NFTokenSellOffer: offer.nft_offer_index},
    `Bark Arena prize: accept Pixel Scrappy #${x.token} into your wallet. It's free — no XRP is paid.`,
    account, {kind: "accept", week: rec.week, place, account});
  const j = await res.json();
  return json({...j, offer: offer.nft_offer_index}, res.status);
}

/* ------------------------------------------------------------------ saves */
/* The whole browser save (bonds, trainer XP, quests, tickets, arena, …) is
   mirrored here per wallet: a backup, and the same progress on every device. */
async function saveGet(env, account) {
  const r = await storeOf(env).saveGet(account);
  return json(r ? {data: r.data, updated: r.updated} : {data: null});
}
async function savePut(env, account, b) {
  const data = b && b.data;
  if (!data || typeof data !== "object" || Array.isArray(data) || data.v !== 1) return json({error: "bad_save"}, 400);
  if (JSON.stringify(data).length > 60000) return json({error: "save_too_large"}, 413);
  const t = Date.now();
  await storeOf(env).saveSet(account, data, t);
  return json({ok: true, updated: t});
}

/* ------------------------------------------------------------------ admin */
/* /api/admin/export and /api/admin/csv, only with ?key=ADMIN_KEY (unset = off). */
function adminOk(env, url) {
  const k = url.searchParams.get("key") || "";
  if (!env.ADMIN_KEY || k.length !== env.ADMIN_KEY.length) return false;
  let diff = 0;
  for (let i = 0; i < k.length; i++) diff |= k.charCodeAt(i) ^ env.ADMIN_KEY.charCodeAt(i);
  return diff === 0;
}
async function adminData(env) {
  const st = storeOf(env), d = await st.dump(), saves = await st.saveAll();
  const wk = weekOf(), now = Date.now();
  const accounts = [...new Set([...Object.keys(d.players || {}), ...Object.keys(saves)])];
  const rows = accounts.map(a => {
    const s = (saves[a] || {}).data || {}, weeks = d.weekly.filter(r => r.account === a), cur = weeks.find(r => r.week === wk) || {};
    const bonds = Object.values(s.dogs || {}).map(g => g.lvl || 1);
    const sum = k => weeks.reduce((n, r) => n + (r[k] | 0), 0);
    return {
      account: a, name: ((d.profiles || {})[a] || {}).name || "", lastSeen: d.players[a] ? new Date(d.players[a]).toISOString() : "",
      saveUpdated: saves[a] ? new Date(saves[a].updated).toISOString() : "",
      trainerXp: s.trainerXp | 0, trainerLevel: 1 + Math.floor((s.trainerXp | 0) / 250), rankedFights: s.fights | 0,
      streak: s.streak | 0, bestStreak: s.best | 0, tickets: s.tickets | 0,
      dogs: bonds.length, maxBond: bonds.length ? Math.max(...bonds) : 0,
      arenaRuns: (s.arena || {}).runs | 0, arenaBest: (s.arena || {}).best | 0,
      pack: ((d.packs || {})[a] || {}).pack || s.pack || "",
      scrappysHeld: (((d.holdings || {})[a] || {}).tokens || []).length,
      weekWins: cur.wins | 0, weekLosses: cur.losses | 0, weekXp: cur.xp | 0, weekStreak: cur.streak | 0,
      totalWins: sum("wins"), totalLosses: sum("losses"), totalXp: sum("xp"), weeksPlayed: weeks.filter(r => (r.wins | 0) + (r.losses | 0) > 0).length,
    };
  }).sort((x, y) => y.totalXp - x.totalXp || y.trainerXp - x.trainerXp);
  const since = ms => rows.filter(r => r.lastSeen && now - Date.parse(r.lastSeen) < ms).length;
  return {
    exported: new Date().toISOString(), week: wk,
    summary: {players: rows.length, activeToday: since(864e5), active7d: since(7 * 864e5), savesStored: Object.keys(saves).length,
              playedThisWeek: rows.filter(r => r.weekWins + r.weekLosses > 0).length},
    rows, raw: {...d, saves},
  };
}
function toCsv(rows) {
  if (!rows.length) return "account\n";
  const cols = Object.keys(rows[0]);
  const cell = v => { const t = String(v ?? ""); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  return [cols.join(","), ...rows.map(r => cols.map(c => cell(r[c])).join(","))].join("\n") + "\n";
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
  try {
    tx = b.txBlob ? decodeTx(String(b.txBlob))                       // WalletConnect returns the signed blob
       : typeof b.signedTx === "string" ? JSON.parse(b.signedTx) : b.signedTx;
  } catch { return {error: "bad_tx"}; }
  // A payment of XRP to yourself: rippled refuses it (temREDUNDANT), so this
  // signature can never move funds, whatever Sequence the wallet filled in.
  if (!tx || tx.TransactionType !== "Payment" || tx.Account !== tx.Destination || typeof tx.Amount !== "string") return {error: "not_a_challenge"};
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
  const r = b && (b.signedTx || b.txBlob) ? verifyChallengeTx(b) : verifyCaip122(env, req, b || {});
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
  const names = await st.profiles();
  const fmt = (rows) => rows.map(r => ({who: displayName(names, r.account), v: r.v, you: r.account === me, ...(isTeam(env, r.account) ? {team: true} : {})}));
  const mine = me ? {xp: await st.rank(wk, "xp", me), wins: await st.rank(wk, "wins", me), streak: await st.rank(wk, "streak", me)} : null;
  return json({week:wk, players: await st.count(wk), xp: fmt(x), wins: fmt(w), streak: fmt(s), mine});
}
/* Public, read-only standings for the website (scrappyxrp.fun/barkarena/):
   this week's player boards, packs this week and how last week ended.
   No sign-in, wallets shortened, cached for a minute. */
async function publicBoard(env) {
  const k = "public:board";
  // a cleared entry is "" (see setProfile), which is not JSON: treat it as a miss
  const c = env.KV ? await env.KV.get(k, "json").catch(() => null) : null;
  if (c) return c;
  const st = storeOf(env), wk = weekOf(), last = weekOf(new Date(Date.now() - 7 * 864e5));
  const names = await st.profiles();
  const fmt = rows => rows.map(r => ({who: displayName(names, r.account), v: r.v, ...(isTeam(env, r.account) ? {team: true} : {})}));
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
      if (p === "/admin/export" || p === "/admin/csv") {
        if (!adminOk(env, url)) return json({error: "forbidden"}, 403);
        const data = await adminData(env), day = new Date().toISOString().slice(0, 10);
        if (p === "/admin/csv") return new Response(toCsv(data.rows), {headers: {"content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="bark-arena-players-${day}.csv"`, "cache-control": "no-store"}});
        const r = json(data);
        if (url.searchParams.has("download")) r.headers.set("content-disposition", `attachment; filename="bark-arena-backup-${day}.json"`);
        r.headers.set("cache-control", "no-store");
        return r;
      }
      if (p === "/public/results") {
        const r = await publicResults(env, url.searchParams.get("week"));
        r.headers.set("access-control-allow-origin", "*");
        r.headers.set("cache-control", "public, max-age=60");
        return r;
      }
      if (p.startsWith("/admin/") && p !== "/admin/export" && p !== "/admin/csv") {
        if (!adminOk(env, url)) return json({error: "forbidden"}, 403);
        const b = req.method === "POST" ? await req.json().catch(() => ({})) : {};
        let r = json({error: "not_found"}, 404);
        if (p === "/admin/season") r = await adminSeason(env);
        if (p === "/admin/anchor" && req.method === "POST") r = await adminAnchor(env, b);
        if (p === "/admin/prize" && req.method === "POST") r = await adminPrize(env, b);
        if (p === "/admin/xaman") r = await xamanResolve(env, url.searchParams.get("uuid"));
        if (p === "/admin/chat" || ((p === "/admin/chat/del" || p === "/admin/chat/mute") && req.method === "POST")) r = await adminChat(env, p, b);
        r.headers.set("cache-control", "no-store");
        return r;
      }
      if (p === "/public/nft") return withCors(await nftLookup(env, url.searchParams.get("t")), cors);
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
      if (p === "/profile" && req.method === "POST") return withCors(await setProfile(env, account, await req.json().catch(() => null)), cors);
      if (p === "/lend" && req.method === "GET") return withCors(json(await lendInfo(env, account)), cors);
      if (p === "/lend" && req.method === "POST") return withCors(await lendStart(env, account, await req.json().catch(() => ({}))), cors);
      if (p === "/lend/end" && req.method === "POST") return withCors(await lendEnd(env, account, await req.json().catch(() => ({}))), cors);
      if (p === "/lend/report" && req.method === "POST") return withCors(await lendReport(env, account, await req.json().catch(() => ({}))), cors);
      if (p === "/lend/seek" && req.method === "POST") return withCors(await lendSeek(env, account, await req.json().catch(() => ({}))), cors);
      if (p === "/chat" && req.method === "GET") return withCors(await chatGet(env, account, url.searchParams.get("since")), cors);
      if (p === "/chat" && req.method === "POST") return withCors(await chatPost(env, account, await req.json().catch(() => ({}))), cors);
      if (p === "/lend/claim" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        await storeOf(env).lendClear(account, +b.upTo || 0);
        return withCors(json({ok: true}), cors);
      }
      if (p === "/prizes") return withCors(await myPrizes(env, account), cors);
      if (p === "/prizes/claim" && req.method === "POST") return withCors(await claimPrize(env, account, await req.json().catch(() => ({}))), cors);
      if (p === "/prizes/status") return withCors(await xamanResolve(env, url.searchParams.get("uuid"), account), cors);
      if (p.startsWith("/club/")) return withCors(await clubRoute(env, account, p, req, url), cors);
      if (p === "/arena/squad" && req.method === "POST") return withCors(await arenaSquad(env, account, await req.json().catch(() => null)), cors);
      if (p === "/arena/result" && req.method === "POST") return withCors(await arenaResult(env, account, await req.json().catch(() => null)), cors);
      if (p === "/arena/defense" && req.method === "GET") return withCors(json({items: await storeOf(env).defenseGet(account)}), cors);
      if (p === "/arena/defense/claim" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        await storeOf(env).defenseClear(account, +b.upTo || 0);
        return withCors(json({ok: true}), cors);
      }
      if (p === "/arena/rivals") return withCors(await arenaRivals(env, account), cors);
      if (p === "/save" && req.method === "GET") return withCors(await saveGet(env, account), cors);
      if (p === "/save" && req.method === "POST") return withCors(await savePut(env, account, await req.json().catch(() => null)), cors);
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
