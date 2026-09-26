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

const XUMM = "https://xumm.app/api/v1/platform";
const XRPL_NODES = ["https://xrplcluster.com", "https://s1.ripple.com:51234", "https://s2.ripple.com:51234"];
const IPFS_FALLBACKS = ["https://ipfs.io/ipfs/", "https://gateway.pinata.cloud/ipfs/", "https://dweb.link/ipfs/", "https://w3s.link/ipfs/"];
const FETCH_TIMEOUT = 10000;                // ms; a hanging gateway must not stall the kennel
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
/* Fetch from the first gateway that answers; the last error wins if none do. */
async function fetchAny(urls, opt) {
  let err;
  for (const u of urls) {
    try { const r = await fetchT(u, opt); if (r.ok) return r; err = new Error("http_" + r.status); }
    catch (e) { err = new Error(e.name === "TimeoutError" ? "timeout" : String(e.message || e)); }
  }
  throw err;
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
/* Cloudflare passes a D1 database as env.DB; the Node server passes env.STORE. */
function storeOf(env) {
  if (env.STORE) return env.STORE;
  const DB = env.DB;
  return {
    ping: () => DB.prepare("SELECT 1").first(),
    seen: (a, t) => DB.prepare(`INSERT INTO players (account, seen) VALUES (?1, ?2) ON CONFLICT(account) DO UPDATE SET seen = ?2`).bind(a, t).run(),
    weekly: (a, wk, wins, xp, streak, t) => DB.prepare(
      `INSERT INTO weekly (account, week, wins, xp, streak, updated) VALUES (?1,?2,?3,?4,?5,?6)
       ON CONFLICT(account, week) DO UPDATE SET wins = MAX(weekly.wins, ?3), xp = MAX(weekly.xp, ?4),
         streak = MAX(weekly.streak, ?5), updated = ?6`).bind(a, wk, wins, xp, streak, t).run(),
    top: async (wk, col) => (await DB.prepare(`SELECT account, ${col} AS v FROM weekly WHERE week = ?1 AND ${col} > 0 ORDER BY ${col} DESC LIMIT 10`).bind(wk).all()).results || [],
    count: async (wk) => (await DB.prepare(`SELECT COUNT(*) AS n FROM weekly WHERE week = ?1`).bind(wk).first()).n,
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
  const c = env.KV ? await env.KV.get(k, "json") : null;
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
async function postStats(env, account, b) {
  const wk = weekOf();
  const wins = Math.max(0, Math.min(500, b.wins|0)), xp = Math.max(0, Math.min(20000, b.xp|0)), streak = Math.max(0, Math.min(200, b.streak|0));
  await storeOf(env).weekly(account, wk, wins, xp, streak, Date.now());
  return json({ok:true, week:wk});
}
async function ladder(env, me) {
  const wk = weekOf();
  const st = storeOf(env);
  const [x, w, s] = await Promise.all([st.top(wk, "xp"), st.top(wk, "wins"), st.top(wk, "streak")]);
  const fmt = (rows) => rows.map(r => ({who: shortAcct(r.account), v: r.v, you: r.account === me}));
  return json({week:wk, players: await st.count(wk), xp: fmt(x), wins: fmt(w), streak: fmt(s)});
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
      if (p === "/check") return withCors(await check(env, url.searchParams.get("account")), cors);
      if (p === "/auth/start" && req.method === "POST") return withCors(await authStart(env), cors);
      if (p === "/auth/status") return withCors(await authStatus(env, url.searchParams.get("uuid") || ""), cors);

      const account = await readSession(env, (req.headers.get("authorization") || "").replace(/^Bearer /, ""));
      if (p === "/ladder") return withCors(await ladder(env, account), cors);
      if (!account) return withCors(json({error:"unauthorized"}, 401), cors);

      if (p === "/me/kennel") return withCors(await kennel(env, account, url.searchParams.has("fresh")), cors);
      if (p === "/meta") return withCors(json(await metaFor(env, url.searchParams.get("uri") || "")), cors);
      if (p === "/img") {
        const u = url.searchParams.get("u") || "";
        if (!/^https:\/\//i.test(u) || !hostAllowed(u, env)) return withCors(json({error:"img_not_allowed"}, 400), cors);
        let r;
        try { r = await fetchAny(ipfsAlternatives(u, env), {cf: {cacheTtl: META_TTL, cacheEverything: true}}); }
        catch (e) { return withCors(json({error:"img_" + e.message}, 502), cors); }
        const h = new Headers({"content-type": r.headers.get("content-type") || "image/png", "cache-control":"public, max-age=86400"});
        return withCors(new Response(r.body, {status:200, headers:h}), cors);
      }
      if (p === "/stats" && req.method === "POST") return withCors(await postStats(env, account, await req.json()), cors);
      return withCors(json({error:"not_found"}, 404), cors);
    } catch (e) {
      return withCors(json({error: String(e.message || e)}, 500), cors);
    }
  },
};
