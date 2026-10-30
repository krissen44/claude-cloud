// XRPL arbitrage bot: finds XRP → token → … → XRP loops through AMM pools after every ledger and
// runs each as ONE all-or-nothing Batch transaction (two inner self-payments: XRP → … → T and
// T → … → XRP). If the second payment can't bring back at least stake + fee, nothing happens and
// only the batch fee (≈ 0.00005 XRP) is spent.
//
// Like bwif's small bot: Tickets instead of sequence numbers, so several small batches (different
// loops, no shared pool) go into the same ledger; break-even DeliverMin, so a loop that is still
// slightly positive when it lands is taken instead of failing.
//
// Pool reserves come from the metadata of every validated transaction (no polling); the pool list
// is read once from the ledger (ledger_data type amm) and cached.

import fs from 'node:fs';
import path from 'node:path';
import { XRP, assetKey, assetObj, createGraph, applyMeta, findCycles, bestSize, cycleOut } from './engine.mjs';
import { createUniverse } from './universe.mjs';
import { createLearner } from './learn.mjs';

// "FUZZY.rhCAT…" / "4655…(hex).rhCAT…" → asset key with the ledger's currency code
export function parseTokens(s) {
  const out = [];
  for (const part of String(s || '').split(/[\s,]+/).filter(Boolean)) {
    const [cur, iss] = part.split(/[.:]/);
    if (!cur || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(iss || '')) continue;
    const code = cur.length === 3 || /^[0-9A-F]{40}$/i.test(cur) ? cur.toUpperCase() : Buffer.from(cur, 'utf8').toString('hex').toUpperCase().padEnd(40, '0');
    out.push(`${code}.${iss}`);
  }
  return out;
}

const TF_INNER = 0x40000000;
const TF_ALL_OR_NOTHING = 0x00010000;
const TF_NO_DIRECT = 0x00010000; // Payment: tfNoRippleDirect
const TF_PARTIAL = 0x00020000;
const TF_SET_NO_RIPPLE = 0x00020000;
const DROPS = 1e6;
const now = () => Date.now();
const day = () => new Date().toISOString().slice(0, 10);
const month = () => new Date().toISOString().slice(0, 7);
const drops = (x) => String(Math.max(1, Math.floor(x * DROPS)));
const iou = (n) => String(Number(n.toPrecision(15))).replace('e+', 'e');
const name = (k) => {
  if (k === XRP) return 'XRP';
  const c = k.split('.')[0];
  if (c.length !== 40) return c;
  const s = Buffer.from(c, 'hex').toString('utf8').replace(/\0/g, '');
  return /^[\x20-\x7e]+$/.test(s) ? s : c.slice(0, 6);
};

// The owner's list: the top memecoins by market cap on FirstLedger with big XRP pools (27 Oct 2026).
// Issuer = the one with the deepest XRP pool for that name (copies with the same name are ignored).
export const DEFAULT_TOKENS = [
  'FUZZY.rhCAT4hRdi2Y9puNdkpMzxrdKa5wkppR62', 'ARMY.rGG3wQ4kUzd7Jnmk1n5NWPZjjut62kCBfC', 'PHNIX.rDFXbW2ZZCG5WgPtqwNiA2xZokLMm9ivmN', 'BCHAMP.rhYhn7s6z4HAfuJm7ehuSE7wxepRoUPwpi',
  'DROP.rszenFJoDdiGjyezQc8pME9KWDQH43Tswh', 'ATM.raDZ4t8WPXkmDfJWMLBcNZmmSHmBC523NZ', 'SLT.rfGCeDUdtbzKbXfgvrpG745qdC1hcZBz8S', 'PROFIT.rJwLNwaBUh9a7ajk9FeeLAuA791wVe3oyg',
  'FARM.rPrAEfVATUNDTJm9CUa8tYeD7oJrVdEGhU', '666.rhvf9fe6PP3GC8Bku2Ug7iQPjPDxYZfrxN', 'Teddy.r9Qk4VGodriw2xKLG9sRbTXWgknkz9TkDd', 'GOAT.r96Ny5BTU3z4Aw4BfiMJ7RTgDa5iE17u9t',
  'SEAL.r4pXXQzJ8soYSX4QKeeW4BzRQS1PCtVYLJ', '589.rfcasq9uRbvwcmLFvc4ti3j8Qt1CYCGgHz', 'BERT.rpwAnF1mMZRszxdinETFHwzGQiPgsv3jHR', 'JELLY.rKHsxmaqf2SfcyU9LRi3VyjpAtyg6ZrQMp',
  'Horizon.rDKJWtrPqKiMBzK9FTVvebMVec7FJtJLx6', 'TOTO.r9sH6YEVRyg8uYaKfyk1EfH36Lfq7a8PUD', 'PHX.rskkPc3Eea3phZmzYqdoRFXeHg1GF7oVzG', 'GRIM.rHLRdLwXiBZSD53ZQz8ogGJz25LzNCCjSz',
  'OLX.rswiX7wDL25Go4wGdLJK1ssSMpUsRGosJR', 'SCHWEPE.rUQXurByxmKni4aLpuWMYMxxV5GWT1Azw2', 'SIGMA.rfKYWZ84fm9eVEdoTcsQCo1WdqMPyaUF5z', 'scrap.rGHtYnnigyuaHehWGfAdoEhkoirkGNdZzo',
  'XRPM.r9mZNnos1GLtc55tkmr21G9BgXxV7w9hT1', 'XOX.rGJbFqiLdh23e9WigQ5sxTfFqTENveLX21', 'DeepTide.rnHDzEH4xyW6u4LbXqDoX1uk36v5ovhbFi', 'CBIRD.rHcU3JWTp7fnea3xgvbV8pCbEp9S3HjSUz',
  'SPY.rnmJEi7hzEL34R7x48e732qvSnmF5wsLtQ', 'Xmen.rMFL2KuFPMuiujdbVGbMzNNjj5QKyd6dZf', 'bwif.r33jHP8k9eFY9Vf1SLU2XKfoQ8A3SkXPEh', 'Laugh.r32nbPw6cyt3KdxinB4ua6WSLRrrF4SXAC',
  'UGA.rBFJGmWj6YaabVCxfsjiCM8pfYXs8xFdeC', 'TIME.rExSpmk2PAqxKRTT3mhjCrCpqVasBra5v8', 'SPC.rhnvCzgjfeK6Qabq7iTYcJc2h23483nriX', 'HIYO.rU5wZyCbZ2WhT51SLDV12vUHtcsqJn9631',
  'XYZ.rU5nUwkBUPx3MFPQSHmMnr9S9yg4g8cKLc', 'LIHUA.rnhtvpHsAgigmVemgtzt7pujj4gv6LVL2a',
].join(',');

// bwif's public bots – watched to learn routes and held tokens
export const DEFAULT_WATCH = 'raRBYswSuyUpH7h51UmWuNCw6Cj1TmpKD:bwif 1,raRBY29mxKf8oADemdUg5618xL6m5RhMLP:bwif 2';

export function readArbConfig(env = process.env) {
  const num = (k, d) => (env[k] === undefined || env[k] === '' ? d : Number(env[k]));
  const bool = (k, d) => (env[k] === undefined || env[k] === '' ? d : /^(1|true|yes|on)$/i.test(env[k]));
  const watch = new Map();
  for (const part of (env.ARB_WATCH ?? DEFAULT_WATCH).split(',').map((x) => x.trim()).filter(Boolean)) {
    const [a, n] = part.split(':');
    if (/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a)) watch.set(a, n || a.slice(0, 8));
  }
  return {
    dryRun: bool('ARB_DRY_RUN', false),
    paused: bool('ARB_PAUSE', false),
    minProfit: num('ARB_MIN_PROFIT', 0.0002), // expected XRP after fees to send a loop (bwif's small bot wins 0.0002–0.001)
    lockProfit: num('ARB_LOCK_PROFIT', 0), // must come back on top of stake + fee, else nothing happens (0 = break-even)
    minSize: num('ARB_MIN_SIZE', 0.1),
    maxSize: num('ARB_MAX_SIZE', 2), // small: bwif's small bot mostly uses 0.1–0.4 XRP
    // learning: only loops whose estimated chance (from our own results) reaches the target are sent;
    // unknown ones are tried within a daily exploration budget (costs only fees)
    targetWin: num('ARB_TARGET_WIN', 90) / 100,
    exploreDay: num('ARB_EXPLORE_DAY', 300),
    exploreMinChance: num('ARB_EXPLORE_MIN_CHANCE', 15) / 100, // learning tries need at least this estimated chance
    learnMinTries: num('ARB_LEARN_MIN_TRIES', 6),
    learnHalfLifeH: num('ARB_LEARN_HALF_LIFE_H', 72),
    parallel: num('ARB_PARALLEL', 5), // batches per ledger (0 = one at a time, no tickets)
    tickets: num('ARB_TICKETS', 0), // tickets kept ready (0 = 3 per parallel batch + 3)
    floor: num('ARB_FLOOR', 5), // XRP never used
    maxHops: num('ARB_MAX_HOPS', 5),
    minPoolXrp: num('ARB_MIN_POOL_XRP', 20), // pool depth (both sides, in XRP)
    slip: num('ARB_SLIP', 0.15), // % under the expected amount for the first payment
    feeDrops: num('ARB_FEE_DROPS', 50), // minimum fee per batch
    maxFeeDrops: num('ARB_MAX_FEE_DROPS', 200000), // never more than this per batch …
    feeShare: num('ARB_FEE_SHARE', 50) / 100, // … nor more than this share of what the loop is expected to earn (chance × profit)
    maxFeesDay: num('ARB_MAX_FEES_DAY', 2), // XRP of fees per day, then pause until tomorrow
    maxLines: num('ARB_MAX_LINES', 50),
    // focus: only trade the top tokens by XRP liquidity + hyped ones + the rivals' + your own list
    focus: bool('ARB_FOCUS', true), // focus decides the trust lines
    focusOnly: bool('ARB_FOCUS_ONLY', true), // … and, if on, also limits the search to focus tokens
    topN: num('ARB_TOP_N', 50),
    hotGrowth: num('ARB_HOT_GROWTH', 30), // % more XRP in the pool …
    hotWindowH: num('ARB_HOT_WINDOW_H', 6), // … within these hours …
    hotMinTrades: num('ARB_HOT_MIN_TRADES', 20), // … with at least this many trades
    hotKeepH: num('ARB_HOT_KEEP_H', 24), // stays in focus this long after it last qualified
    tokens: parseTokens(env.ARB_TOKENS || DEFAULT_TOKENS),
    listOnly: bool('ARB_LIST_ONLY', true), // trade only the tokens of the list – nothing else, no lines for others
    // bridges: a loop may pass through a very liquid token inside the same all-or-nothing batch
    // (never held, no trust line), e.g. FUZZY → WIND → DROP – how the bwif bots win most of their loops
    // speed: watch transactions while they enter the open ledger, read the touched pools' live state
    // and send into the same / next ledger – instead of waiting for validation (one ledger late)
    live: bool('ARB_LIVE', true),
    books: bool('ARB_BOOKS', true), // DEX order books of the list tokens (XRP pair) are part of the model
    bookRefreshMin: num('ARB_BOOK_REFRESH_MIN', 10),
    multiSubmit: bool('ARB_MULTI_SUBMIT', true), // every batch to all servers in ARB_XRPL_WS at once
    liveMaxPerLedger: num('ARB_LIVE_MAX_PER_LEDGER', 15), // pool reads per open ledger (server load)
    // 'next': collect what moved during a ledger and send the moment the next ledger opens (lands right
    // after the trade that made the gap, like the bwif bots); 'now': send at once into the same ledger
    // (the network orders a ledger, not arrival – about half of those land before the trade)
    liveSend: /^now$/i.test(env.ARB_LIVE_SEND || '') ? 'now' : 'next',
    bridge: bool('ARB_BRIDGE', true),
    bridgeMinXrp: num('ARB_BRIDGE_MIN_XRP', 1000), // XRP in the bridge token's own XRP pool
    lineMinScore: num('ARB_LINE_MIN_SCORE', 0.01),
    lastLedgers: num('ARB_LAST_LEDGERS', 1), // valid for the next ledger only (like bwif) – no stale tries
    fetchPerSec: num('ARB_FETCH_PER_SEC', 5),
    watch,
    dataDir: env.ARB_DATA_DIR || path.join(process.env.HOME || '.', 'xrpl-arb-data'),
    discord: env.ARB_DISCORD_WEBHOOK || '',
  };
}

// submitAlso(request) → promises of the same submit on other servers (each relays it to its own
// peers, so the batch reaches the validators sooner). The first success counts.
export function createArb({ client, wallet, cfg, log = console.log, fetchFn = globalThis.fetch, submitAlso = null }) {
  const me = wallet?.address || 'rDRYRUN';
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const stateFile = path.join(cfg.dataDir, 'arb-state.json');
  const poolFile = path.join(cfg.dataDir, 'arb-pools.json');
  let S = { stats: { since: now() }, day: '', dayFees: 0, hot: {}, trades: [], rivals: [], lines: [], startBalance: null };
  try { S = { ...S, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch {}
  const save = () => { try { fs.writeFileSync(stateFile + '.tmp', JSON.stringify(S)); fs.renameSync(stateFile + '.tmp', stateFile); } catch {} };
  const say = (m) => {
    log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
    if (cfg.discord && fetchFn) fetchFn(cfg.discord, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: m.slice(0, 1900) }) }).catch(() => {});
  };
  const stat = (k, n = 1) => { S.stats[k] = (S.stats[k] || 0) + n; };
  const append = (file, obj) => { try { fs.appendFileSync(path.join(cfg.dataDir, `${file}-${month()}.jsonl`), JSON.stringify(obj) + '\n'); } catch {} };

  const g = createGraph();
  const uni = createUniverse(g, cfg);
  const learn = createLearner(S, cfg);
  // who moved which pool in the last ledgers (to tell "someone was faster" from "our math was off")
  const touches = new Map(); // pool → [{l, i, a}]
  const xrpDepth = (a) => { const p = g.pools.get(g.xrpPool.get(a)); return p?.ready ? g.xrpSide(p) : 0; };
  const isBridge = (a) => cfg.bridge && a !== XRP && !uni.has(a) && xrpDepth(a) >= cfg.bridgeMinXrp && issuers.get(issuerOf(a))?.ok !== false;
  const allow = (a) => (cfg.listOnly ? uni.has(a) || isBridge(a) : !(cfg.focus && cfg.focusOnly) || uni.has(a));
  const lines = new Set(S.lines);
  let reserves = { base: 1, inc: 0.2 };
  let acct = { balance: 0, seq: 0, owners: 0 };
  let ledger = 0;
  // batches on their way (outer hash → record). With tickets several per ledger, else one at a time.
  const flights = new Map();
  const committed = () => { let x = 0; for (const f of flights.values()) x += f.o.x; return x; };
  // Tickets: every batch takes three (outer + 2 inner). A batch whose loop fails uses up only the
  // outer one; the inner ones come back. A batch that never lands gives all three back.
  const tickets = new Set(); // free
  const busyTickets = new Set(); // in a batch on its way
  let ticketsSynced = 0;
  const useTickets = () => cfg.parallel > 0 && !cfg.dryRun;
  const ticketTarget = () => Math.min(240, cfg.tickets || cfg.parallel * 3 + 3);
  const release = (tk) => tk?.forEach((t) => { busyTickets.delete(t); tickets.add(t); });
  // Fees: a busy ledger needs more than the minimum, or the batch is refused (telCAN_NOT_QUEUE).
  // The open-ledger fee level is read every ledger; a batch (2 inner payments) costs 4 × base.
  let feeLvl = { base: 10, open: 256, ref: 256, at: 0 };
  async function updateFee() {
    try {
      const r = await req('fee');
      feeLvl = { base: Number(r.drops?.base_fee || 10), open: Number(r.levels?.open_ledger_level || 256), ref: Number(r.levels?.reference_level || 256), at: now() };
    } catch {}
  }
  const feeCap = (o) => Math.min(cfg.maxFeeDrops, Math.max(cfg.feeDrops, Math.floor(cfg.feeShare * (o.p ?? 0.25) * o.profit * DROPS)));
  const batchFee = () => Math.ceil(Math.max(cfg.feeDrops, feeLvl.base * 4 * (feeLvl.open / feeLvl.ref) * 1.25));
  // Sequence numbers: a trust line or a refused batch makes our cached sequence stale.
  let seqDirty = true;
  let lineBusy = false;
  let activated = null;
  let stopped = false;

  const req = async (command, params = {}) => (await client.request({ command, ...params })).result;

  // ---------- safety: issuer checks + cool-down after failures ----------
  // A token with a transfer fee or a freeze makes our math wrong (the batch would fail every
  // ledger and burn fees), so only tokens whose issuer was checked and is clean are traded.
  const issuers = new Map(); // issuer → {ok, why, at}
  // Checks run through a small queue (a burst of hundreds made the server refuse them). A check
  // that fails is NOT a verdict: it is retried in 2 minutes instead of blocking the token for hours.
  const checking = new Set();
  const issuerQueue = [];
  let issuerRunning = 0;
  function checkIssuer(iss) {
    if (checking.has(iss)) return;
    checking.add(iss);
    issuerQueue.push(iss);
    pumpIssuers();
  }
  function pumpIssuers() {
    while (issuerRunning < 2 && issuerQueue.length) {
      const iss = issuerQueue.shift();
      issuerRunning++;
      (async () => {
        try {
          const d = (await req('account_info', { account: iss, ledger_index: 'validated' })).account_data;
          const fee = d.TransferRate ? d.TransferRate / 1e9 - 1 : 0;
          const frozen = (d.Flags || 0) & 0x00400000;
          issuers.set(iss, { ok: !(fee > 0) && !frozen, why: fee > 0 ? `transfer fee ${(fee * 100).toFixed(2)}%` : frozen ? 'frozen' : '', at: now() });
        } catch (e) {
          stat('issuerCheckFailed');
          // unknown ≠ bad: keep any earlier verdict, else ask again in 2 minutes
          if (!issuers.get(iss)?.verdict) issuers.set(iss, { ok: false, why: 'retry', at: now() - 6 * 3600e3 + 120e3 });
          if (/slowDown|tooBusy|rate/i.test(String(e?.data?.error || e?.message))) await new Promise((r) => setTimeout(r, 3000));
        }
        const v = issuers.get(iss);
        if (v && v.why !== 'retry') v.verdict = true;
        checking.delete(iss);
        issuerRunning--;
        await new Promise((r) => setTimeout(r, 100));
        pumpIssuers();
      })();
    }
  }
  const issuerOf = (asset) => asset.split('.')[1];
  function tokensOk(assets) {
    let ok = true;
    for (const a of assets) {
      const i = issuers.get(issuerOf(a));
      if (!i || now() - i.at > 6 * 3600e3) { checkIssuer(issuerOf(a)); ok = false; } else if (!i.ok) ok = false;
    }
    return ok;
  }
  const cool = new Map(); // cycle key → ledger until which it is not tried again
  const tokFails = new Map(); // token → {n, until}
  const blocked = (o) => (cool.get(o.key) || 0) > ledger || o.assets.some((a) => (tokFails.get(a)?.until || 0) > now());
  function failed(o, why = 'model') {
    // beaten / expired = the loop was real, someone was faster or we didn't get in: try again soon.
    // model = nothing got in the way and it still failed: block the route a while; a token whose
    // routes fail like that 4 times in a row pauses for 20 minutes
    if (why !== 'model') { cool.set(o.key, ledger + 3); return; }
    cool.set(o.key, ledger + 30);
    for (const a of o.assets) {
      const t = tokFails.get(a) || { n: 0, until: 0 };
      t.n = t.until && t.until < now() ? 1 : t.n + 1;
      if (t.n >= 4) { t.until = now() + 20 * 60e3; t.n = 0; say(`🧊 ${name(a)}: 4 failed cycles in a row – paused 20 min`); }
      tokFails.set(a, t);
    }
  }

  // ---------- pool discovery ----------
  const queue = []; // pool ids whose balances must be (re)read
  const queued = new Set();
  const want = (id, front = false) => { if (queued.has(id)) return; queued.add(id); front ? queue.unshift(id) : queue.push(id); };
  let discovering = false;

  async function discover() {
    discovering = true;
    try {
      const cached = JSON.parse(fs.readFileSync(poolFile, 'utf8'));
      for (const p of cached) { g.upsert({ id: p.id, a: p.a, b: p.b, fee: p.fee }); want(p.id); }
      say(`📦 ${cached.length} pools from cache – refreshing balances`);
    } catch {}
    let marker;
    let n = 0;
    do {
      const r = await req('ledger_data', { type: 'amm', limit: 400, ledger_index: 'validated', ...(marker ? { marker } : {}) });
      for (const o of r.state || []) {
        if (o.LedgerEntryType && o.LedgerEntryType !== 'AMM') continue;
        const id = o.Account;
        const a = assetKey(o.Asset), b = assetKey(o.Asset2);
        if (!g.pools.has(id)) want(id, a === XRP || b === XRP);
        g.upsert({ id, a, b, fee: (o.TradingFee || 0) / 1e5 });
        n++;
      }
      marker = r.marker;
    } while (marker && !stopped);
    stat('poolsListed', 0);
    S.stats.poolsListed = n;
    savePools();
    discovering = false;
    say(`🗺️ ${n} AMM pools on the ledger`);
    uni.snapshot(); refocus();
  }
  function savePools() {
    try { fs.writeFileSync(poolFile, JSON.stringify([...g.pools.values()].map((p) => ({ id: p.id, a: p.a, b: p.b, fee: p.fee })))); } catch {}
  }

  // read pool balances in the background, XRP pools first
  // Pools between two tokens never show up as AMMs in the stream (no XRP balance moves), and the
  // full pool list can't be read from public servers – so token pairs are asked for directly:
  // the pairs of every rival route and all pairs inside the focus.
  const pairChecked = new Map(); // "a|b" → time of the last lookup
  function wantPair(a, b) {
    if (a === b) return;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (now() - (pairChecked.get(k) || 0) < 6 * 3600e3) return;
    for (const id of g.adj.get(a) || []) if (g.other(g.pools.get(id), a) === b) return; // known
    pairChecked.set(k, now());
    want('pair:' + k);
  }
  async function fetchLoop() {
    while (!stopped) {
      const id = queue.shift();
      if (!id) { await new Promise((r) => setTimeout(r, 500)); continue; }
      queued.delete(id);
      try {
        if (id.startsWith('book:')) { await readBooks(id.slice(5), 'validated'); await new Promise((r) => setTimeout(r, 1000 / cfg.fetchPerSec)); continue; }
        const pair = id.startsWith('pair:') ? id.slice(5).split('|') : null;
        const r = await req('amm_info', pair ? { asset: assetObj(pair[0]), asset2: assetObj(pair[1]), ledger_index: 'validated' } : { amm_account: id, ledger_index: 'validated' });
        const am = r.amm;
        const val = (x) => (typeof x === 'string' ? Number(x) / DROPS : Number(x.value));
        const k1 = assetKey(typeof am.amount === 'string' ? XRP : am.amount);
        const k2 = assetKey(typeof am.amount2 === 'string' ? XRP : am.amount2);
        const v1 = val(am.amount), v2 = val(am.amount2);
        const fee = (am.trading_fee || 0) / 1e5;
        const pid = pair ? am.account : id;
        const p = g.pools.get(pid);
        if (!p) { g.upsert({ id: pid, a: k1, b: k2, ra: v1, rb: v2, fee }); stat(pair ? 'poolsFromPairs' : 'poolsFromStream'); }
        else g.upsert(k1 === p.a ? { id: pid, ra: v1, rb: v2, fee } : { id: pid, ra: v2, rb: v1, fee });
        stat('poolsFetched');
      } catch (e) {
        const err = String(e?.data?.error || e?.message);
        if (/tooBusy|slowDown|rate limit/i.test(err)) { // server says slow down: put it back and wait
          stat('rateLimited');
          if (id.startsWith('pair:')) pairChecked.delete(id.slice(5));
          want(id);
          await new Promise((r) => setTimeout(r, 15000));
        } else if (!id.startsWith('pair:') && /actNotFound|ammNotFound/i.test(err)) g.remove(id);
      }
      await new Promise((r) => setTimeout(r, 1000 / cfg.fetchPerSec));
    }
  }

  // ---------- order books ----------
  // Both XRP books of a list token (buy side and sell side), read with book_offers. An offer that
  // changed in a ledger re-reads its book; a book that changed = its XRP pool counts as moved.
  const bookAt = new Map(); // token → last read
  const amt = (x) => (typeof x === 'string' ? Number(x) / DROPS : Number(x?.value || 0));
  async function readBook(from, to, at) {
    const r = await req('book_offers', { taker_pays: assetObj(from), taker_gets: assetObj(to), limit: 20, ledger_index: at });
    const offers = [];
    for (const o of r.offers || []) {
      if (o.Account === me) continue;
      const pays = amt(o.taker_pays_funded ?? o.TakerPays), gets = amt(o.taker_gets_funded ?? o.TakerGets);
      if (pays > 0 && gets > 0) offers.push({ in: pays, out: gets, owner: o.Account });
    }
    stat('booksRead');
    return g.setBook(from, to, offers);
  }
  async function readBooks(t, at = 'validated') {
    if (!cfg.books || !g.xrpPool.get(t)) return false;
    bookAt.set(t, now());
    const ch = (await Promise.all([readBook(XRP, t, at), readBook(t, XRP, at)])).some(Boolean);
    if (ch && at === 'validated') { stat('bookChanged'); queueSearch(new Set([g.xrpPool.get(t)]), { lls: ledger + 1 + cfg.lastLedgers, view: ledger, live: false }); }
    return ch;
  }
  const bookTokens = () => [...uni.set()].filter((a) => a !== XRP && g.xrpPool.get(a));
  function refreshBooks() {
    if (!cfg.books) return;
    for (const t of bookTokens()) if (now() - (bookAt.get(t) || 0) > cfg.bookRefreshMin * 60e3) want('book:' + t);
  }
  // offers of our tokens that changed in this transaction → read those books again
  function offersMoved(meta) {
    if (!cfg.books) return;
    for (const n of meta?.AffectedNodes || []) {
      const node = n.ModifiedNode || n.CreatedNode || n.DeletedNode;
      if (node?.LedgerEntryType !== 'Offer') continue;
      const f = node.FinalFields || node.NewFields || {};
      const a = assetKey(f.TakerGets), b = assetKey(f.TakerPays);
      const t = a === XRP ? b : b === XRP ? a : null;
      if (t && t !== XRP && uni.has(t) && g.xrpPool.get(t)) dropBook(t);
    }
  }
  // offers of t changed (taken, cancelled, new): the AMM side is already updated from the same
  // transaction, the book would be stale until read again → a phantom gap ("buy the offer someone
  // just took"). So the book is dropped at once and only used again after a fresh read.
  function dropBook(t) {
    const had = g.books.has(`${XRP}>${t}`) || g.books.has(`${t}>${XRP}`);
    if (had) { g.setBook(XRP, t, []); g.setBook(t, XRP, []); stat('bookDropped'); }
    want('book:' + t, true);
  }
  // our book loop failed although nobody else moved the pool → don't trust that book for an hour
  S.bookBan ||= {};
  const bookBanned = (assets) => assets.some((a) => now() - (S.bookBan[a] || 0) < 3600e3);

  // ---------- account ----------
  async function refreshAccount() {
    const d = (await req('account_info', { account: me, ledger_index: 'validated' })).account_data;
    acct = { balance: Number(d.Balance) / DROPS, seq: d.Sequence, owners: d.OwnerCount || 0 };
    if (S.startBalance == null) S.startBalance = acct.balance;
    return acct;
  }
  async function refreshLines() {
    let marker;
    lines.clear();
    do {
      const r = await req('account_lines', { account: me, ledger_index: 'validated', limit: 400, ...(marker ? { marker } : {}) });
      for (const l of r.lines || []) { lines.add(`${l.currency}.${l.account}`); lineBal.set(`${l.currency}.${l.account}`, Math.abs(Number(l.balance))); }
      marker = r.marker;
    } while (marker);
    S.lines = [...lines];
  }
  const available = () => acct.balance - reserves.base - reserves.inc * acct.owners - cfg.floor;

  // ---------- stream ----------
  let changed = new Set();
  let timer = null;
  const rivalBatches = new Map(); // parent hash → record
  const innerEarly = new Map(); // parent hash → inner payments seen before their batch

  const seenValidated = new Set();
  function onTransaction(ev) {
    const tx = ev.tx_json || ev.transaction;
    if (!tx) return;
    if (!ev.validated) { if (cfg.live) { noteOpen(ev); onProposed(tx, ev); } return; }
    if (!ev.meta) return;
    const hash = ev.hash || tx.hash;
    if (seenValidated.has(hash)) return; // a server may send it on both streams
    seenValidated.add(hash);
    if (seenValidated.size > 20000) seenValidated.clear();
    if (ev.ledger_index > ledger) ledger = ev.ledger_index;
    const moved = applyMeta(g, ev.meta, (nid) => want(nid, true));
    offersMoved(ev.meta);
    // a pool read live from a newer open ledger keeps that newer state
    for (const id of moved) {
      const fr = fresh.get(id);
      if (!fr) continue;
      if (fr.idx > ev.ledger_index) g.upsert({ id, ra: fr.ra, rb: fr.rb });
      else fresh.delete(id);
    }
    for (const id of moved) changed.add(id);
    if (tx.Account !== me) {
      for (const id of moved) {
        const list = (touches.get(id) || []).filter((x) => x.l >= ev.ledger_index - 3);
        list.push({ l: ev.ledger_index, i: ev.meta.TransactionIndex, a: tx.Account });
        touches.set(id, list);
      }
      if (touches.size > 5000) for (const [id, list] of touches) if (list.at(-1).l < ev.ledger_index - 3) touches.delete(id);
    }
    uni.noteChanged(moved);
    // our batches: the outer tx and its inner payments come through the stream
    if (flights.size) {
      const f = flights.get(hash);
      if (f) { f.outer = ev.meta.TransactionResult; f.vLedger = ev.ledger_index; f.vIdx = ev.meta.TransactionIndex; }
      const pf = tx.Account === me && flights.get(ev.meta.ParentBatchID || tx.ParentBatchID);
      if (pf) { pf.inner++; pf.got += myDelta(ev.meta); }
    }
    if (cfg.watch.has(tx.Account)) watchRival(tx, ev, hash);
    clearTimeout(timer);
    timer = setTimeout(onLedgerDone, 120); // run once the ledger's transactions are in
  }

  // ---------- live: the open ledger ----------
  // A transaction that enters the open ledger touching our tokens → read the live reserves of the
  // pools it can have moved (amm_info on the open ledger), search on that, send at once.
  const fresh = new Map(); // pool → {ra, rb, idx} read live from open ledger idx
  const liveWant = new Set();
  const liveBooks = new Set(); // tokens whose books to read live (offers placed / taken)
  let liveTimer = null;
  let liveBudget = { idx: 0, n: 0 };
  const assetsOf = (t, out = new Set()) => {
    for (const k of ['Amount', 'SendMax', 'DeliverMin', 'TakerGets', 'TakerPays', 'Asset', 'Asset2']) {
      const v = t[k];
      if (v == null) continue;
      out.add(typeof v === 'string' || v.currency === 'XRP' || !v.issuer ? XRP : `${v.currency}.${v.issuer}`);
    }
    for (const path of t.Paths || []) for (const st of path) if (st.currency && st.currency !== 'XRP' && (st.issuer || st.account)) out.add(`${st.currency}.${st.issuer || st.account}`);
    for (const r of t.RawTransactions || []) assetsOf(r.RawTransaction || {}, out);
    return out;
  };
  function onProposed(tx, ev) {
    if (tx.Account === me || !/^tes/.test(ev.engine_result || 'tesSUCCESS')) return;
    if (!/^(Payment|OfferCreate|AMMDeposit|AMMWithdraw|Batch|AMMCreate)$/.test(tx.TransactionType)) return;
    const as = [...assetsOf(tx)].filter((a) => a === XRP || allow(a));
    const toks = as.filter((a) => a !== XRP);
    if (!toks.length) return;
    // the XRP pool of each token, and pools between the tokens it names
    for (const a of toks) { const id = g.xrpPool.get(a); if (id) liveWant.add(id); }
    // offers may change with it: drop those books now, read them live on the open ledger
    if (cfg.books && /^(OfferCreate|OfferCancel|Payment|Batch)$/.test(tx.TransactionType)) for (const a of toks) if (g.xrpPool.get(a) && (tx.TransactionType !== 'Payment' || g.books.has(`${XRP}>${a}`) || g.books.has(`${a}>${XRP}`))) { if (g.books.has(`${XRP}>${a}`) || g.books.has(`${a}>${XRP}`)) { g.setBook(XRP, a, []); g.setBook(a, XRP, []); stat('bookDropped'); } liveBooks.add(a); }
    for (const a of toks) for (const id of g.adj.get(a) || []) { const p = g.pools.get(id); if (p && as.includes(g.other(p, a))) liveWant.add(id); }
    stat('liveSeen');
    const cur = ev.ledger_current_index || ledger + 1;
    clearTimeout(liveTimer);
    if (cfg.liveSend === 'now') { liveTimer = setTimeout(() => liveRead(cur), 25); return; }
    // send when the next ledger opens; if no other transaction shows that, after ~4 s anyway
    liveTimer = setTimeout(() => liveRead(cur + 1), 4500);
  }
  // a transaction of a newer open ledger = the previous one closed: its moves are final now
  let openIdx = 0;
  function noteOpen(ev) {
    const i = ev.ledger_current_index;
    if (!i || i <= openIdx) return;
    const had = openIdx;
    openIdx = i;
    if (had && cfg.liveSend === 'next' && (liveWant.size || liveBooks.size)) { clearTimeout(liveTimer); stat('liveRollover'); liveRead(i); }
  }
  async function liveRead(cur) {
    if (stopped || (!liveWant.size && !liveBooks.size)) return;
    if (liveBudget.idx !== cur) liveBudget = { idx: cur, n: 0 };
    const ids = [...liveWant].filter((id) => g.pools.get(id)?.ready).slice(0, Math.max(0, cfg.liveMaxPerLedger - liveBudget.n));
    liveWant.clear();
    const bt = [...liveBooks].slice(0, Math.max(0, Math.floor((cfg.liveMaxPerLedger - liveBudget.n - ids.length) / 2)));
    liveBooks.clear();
    if (!ids.length && !bt.length) { stat('liveSkippedBudget'); return; }
    liveBudget.n += ids.length + 2 * bt.length;
    const t0 = now();
    const ch = new Set();
    let idx = cur;
    await Promise.all(ids.map(async (id) => {
      try {
        const r = await req('amm_info', { amm_account: id, ledger_index: 'current' });
        const am = r.amm;
        const val = (x) => (typeof x === 'string' ? Number(x) / DROPS : Number(x.value));
        const p = g.pools.get(id);
        const k1 = assetKey(typeof am.amount === 'string' ? XRP : am.amount);
        const [ra, rb] = k1 === p.a ? [val(am.amount), val(am.amount2)] : [val(am.amount2), val(am.amount)];
        if (r.ledger_current_index) idx = Math.max(idx, r.ledger_current_index);
        if (Math.abs(ra - p.ra) > 1e-12 || Math.abs(rb - p.rb) > 1e-12) { g.upsert({ id, ra, rb, fee: (am.trading_fee || 0) / 1e5 }); ch.add(id); }
        fresh.set(id, { ra, rb, idx: r.ledger_current_index || cur });
      } catch { stat('liveReadFailed'); }
    }).concat(bt.map(async (t) => {
      try { if (await readBooks(t, 'current')) { ch.add(g.xrpPool.get(t)); stat('liveBookChanged'); } } catch { stat('liveReadFailed'); }
    })));
    S.stats.liveReadMs = now() - t0;
    stat('liveReads', ids.length);
    if (!ch.size) return;
    // valid for this open ledger and the next one
    queueSearch(ch, { lls: idx + 1, view: idx, live: true });
  }

  // change of our XRP balance in one transaction (inner payments carry no fee)
  function myDelta(meta) {
    let d = 0;
    for (const n of meta.AffectedNodes || []) {
      const node = n.ModifiedNode;
      if (node?.LedgerEntryType === 'AccountRoot' && node.FinalFields?.Account === me && node.PreviousFields?.Balance != null) d += (Number(node.FinalFields.Balance) - Number(node.PreviousFields.Balance)) / DROPS;
    }
    return d;
  }

  // ---------- search + execute ----------
  async function onLedgerDone() {
    if (stopped) return;
    stat('ledgers');
    if (flights.size) await settle();
    updateFee(); // for the next ledger
    if (useTickets() && acct.seq && !lineBusy) {
      if (tickets.size + busyTickets.size <= ticketTarget() - 3) ensureTickets();
      else if (!flights.size && ledger - ticketsSynced > 50) syncTickets().catch(() => {});
    }
    const ch = changed;
    changed = new Set();
    if (!ch.size) return;
    queueSearch(ch, { lls: ledger + 1 + cfg.lastLedgers, view: ledger, live: false });
  }

  // one search at a time (tickets, free XRP and pools in flight are shared)
  let searchChain = Promise.resolve();
  const queueSearch = (ch, ctx) => { searchChain = searchChain.then(() => search(ch, ctx)).catch((e) => say(`⚠️ search: ${e.message}`)); return searchChain; };
  async function search(ch, ctx) {
    if (stopped) return;
    const t0 = now();
    const cycles = findCycles(g, ch, { maxHops: cfg.maxHops, minDepthXrp: cfg.minPoolXrp, minRate: 1.0005, allow });
    stat('cyclesSeen', cycles.length);
    const feeDrops = batchFee();
    const feeXrp = feeDrops / DROPS;
    if (feeDrops > cfg.maxFeeDrops) { stat('skippedFeeHigh'); }
    const free = Math.max(0, available() - committed());
    const room = Math.min(cfg.maxSize, free);
    const opps = [];
    for (const c of cycles) {
      const hi = Math.max(cfg.minSize, Math.min(room || cfg.maxSize, cfg.maxSize));
      const { x, profit } = bestSize(g, c.hops, cfg.minSize, hi);
      const net = profit - feeXrp;
      if (net < cfg.minProfit) continue;
      const assets = c.hops.slice(0, -1).map((h) => h.to);
      const held = assets.findIndex((a) => lines.has(a));
      // does an offer make it pay? (same loop through the AMMs alone earns less)
      const book = !!(g.books.size && cycleOut(g, c.hops, x) - cycleOut(g, c.hops, x, false) > 1e-9);
      if (book && bookBanned(assets)) { stat('skippedBookBan'); continue; }
      opps.push({ ...c, x, profit, net, assets, held, book });
    }
    S.stats.lastSearchMs = now() - t0;
    if (!opps.length) return;
    opps.sort((a, b) => b.net - a.net);
    stat('opportunities', opps.length);
    if (opps.some((o) => o.book)) stat('bookOpps');
    for (const o of opps.slice(0, 5)) {
      append('opps', { t: now(), ledger, live: ctx.live, route: ['XRP', ...o.assets.map(name), 'XRP'].join('>'), hops: o.hops.length, x: +o.x.toFixed(4), profit: +o.profit.toFixed(6), net: +o.net.toFixed(6), executable: o.held >= 0, room: +room.toFixed(3), book: o.book });
      for (const a of o.assets) S.hot[a] = (S.hot[a] || 0) + o.net; // tokens worth a trust line
    }
    const usable = opps.filter((o) => !blocked(o));
    if (!usable.length) { stat('skippedCooldown'); return; }
    const clean = usable.filter((o) => tokensOk(o.assets));
    if (!clean.length) { stat('skippedIssuerCheck'); return; }
    if (!clean.some((o) => o.held >= 0)) { stat('missedNoLine'); return; }
    if (S.day !== day()) { S.day = day(); S.dayFees = 0; S.dayExplore = 0; }
    // learning: send what our own results say goes through (≥ target win rate), explore the unknown
    let budget = cfg.exploreDay - (S.dayExplore || 0);
    const cand = [];
    for (const o of clean) {
      if (o.held < 0) continue;
      o.mode = learn.decide(o, feeXrp, budget);
      if (o.mode === 'explore') budget--;
      if (o.mode === 'go' || o.mode === 'explore') cand.push(o);
      else stat(o.mode === 'lowChance' ? 'skippedLowChance' : 'skippedNegativeEv');
    }
    if (!cand.length) return;
    cand.sort((a, b) => (a.mode === 'go') === (b.mode === 'go') ? b.ev - a.ev : a.mode === 'go' ? -1 : 1);
    const best = cand[0];
    if (cfg.paused || cfg.dryRun || room < cfg.minSize) { stat(cfg.paused ? 'skippedPaused' : room < cfg.minSize ? 'skippedNoRoom' : 'dryRunOpps'); return; }
    if (S.dayFees >= cfg.maxFeesDay) { stat('skippedFeeCap'); return; }
    if (feeDrops > cfg.maxFeeDrops) return;
    if (!useTickets()) {
      if (flights.size || lineBusy) { stat('skippedBusy'); return; } // one transaction at a time (sequence numbers)
      await execute(best, feeDrops, ctx);
      return;
    }
    // several loops into this ledger: no two share a pool (the second would see the price the
    // first one left), each takes its own three tickets, together they stay within the free XRP
    const usedPools = new Set();
    for (const f of flights.values()) for (const h of f.o.hops) usedPools.add(h.pool);
    let slots = Math.min(cfg.parallel - flights.size, Math.floor(tickets.size / 3));
    if (slots <= 0) { stat(tickets.size < 3 ? 'skippedNoTickets' : 'skippedBusy'); return; }
    let left = free;
    let sent = 0;
    for (const o of cand) {
      if (slots <= 0 || S.dayFees >= cfg.maxFeesDay) break;
      if (o.held < 0 || o.x > left || o.hops.some((h) => usedPools.has(h.pool))) continue;
      for (const h of o.hops) usedPools.add(h.pool);
      left -= o.x; slots--;
      if (await execute(o, feeDrops, ctx)) sent++;
    }
    if (sent > 1) stat('multiLedgers');
  }

  function buildBatch(o, feeDrops, tk, lls) {
    const i = o.held;
    const T = o.assets[i];
    const first = o.hops.slice(0, i + 1);
    const second = o.hops.slice(i + 1);
    const outExp = cycleOut(g, o.hops, o.x); // both legs in one go: a pool used twice sees its own first leg
    const feeXrp = feeDrops / DROPS;
    const minBack = o.x + feeXrp + cfg.lockProfit;
    if (outExp < minBack) return null;
    const pathOf = (hops) => hops.slice(0, -1).map((h) => assetObj(h.to));
    const tok = assetObj(T);
    // Like the bwif bots: leg 1 spends exactly the stake and takes whatever T it buys (partial
    // payment, no amount to guess); leg 2 sells all T and must bring back stake + fee + min profit,
    // else the whole batch does nothing.
    const p1 = {
      TransactionType: 'Payment', Account: me, Destination: me,
      Amount: { ...tok, value: '9999999999999999e80' }, SendMax: drops(o.x),
      Flags: TF_INNER | TF_PARTIAL | (first.length > 1 ? TF_NO_DIRECT : 0),
      ...(first.length > 1 ? { Paths: [pathOf(first)] } : {}),
      ...(tk ? { Sequence: 0, TicketSequence: tk[1] } : { Sequence: acct.seq + 1 }), Fee: '0', SigningPubKey: '',
    };
    const p2 = {
      TransactionType: 'Payment', Account: me, Destination: me,
      Amount: '999999999999999', DeliverMin: drops(minBack), SendMax: { ...tok, value: '9999999999999999e80' },
      Flags: TF_INNER | TF_PARTIAL | (second.length > 1 ? TF_NO_DIRECT : 0),
      ...(second.length > 1 ? { Paths: [pathOf(second)] } : {}),
      ...(tk ? { Sequence: 0, TicketSequence: tk[2] } : { Sequence: acct.seq + 2 }), Fee: '0', SigningPubKey: '',
    };
    return {
      TransactionType: 'Batch', Account: me, Flags: TF_ALL_OR_NOTHING,
      RawTransactions: [{ RawTransaction: p1 }, { RawTransaction: p2 }],
      ...(tk ? { Sequence: 0, TicketSequence: tk[0] } : { Sequence: acct.seq }), Fee: String(feeDrops), LastLedgerSequence: lls || ledger + 1 + cfg.lastLedgers,
    };
  }

  // the same signed batch to every server at once; the first tesSUCCESS/terQUEUED wins, otherwise
  // the main server's answer (others often say tefALREADY / tefPAST_SEQ once it got there)
  const okSubmit = (r) => /^(tesSUCCESS|terQUEUED)$/.test(r?.engine_result || '');
  function submitAll(blob) {
    const main = req('submit', { tx_blob: blob });
    let more = [];
    if (submitAlso && cfg.multiSubmit !== false) { try { more = (submitAlso({ command: 'submit', tx_blob: blob }) || []).map((p) => Promise.resolve(p).then((x) => x?.result ?? x)); } catch {} }
    if (!more.length) return main;
    stat('multiSubmit');
    return new Promise((resolve, reject) => {
      let left = more.length + 1;
      let mainR, mainE, other;
      const end = () => { if (--left === 0) (mainR || other ? resolve(mainR || other) : reject(mainE)); };
      main.then((r) => { mainR = r; if (okSubmit(r)) resolve(r); end(); }, (e) => { mainE = e; end(); });
      for (const p of more) p.then((r) => { other ||= r; if (okSubmit(r)) resolve(r); end(); }, () => end());
    });
  }

  async function execute(o, feeDrops = cfg.feeDrops, ctx = {}) {
    if (!acct.seq) return false; // wallet not activated yet
    // a big loop may pay more to be sure to get in (up to 10 % of what it should earn)
    // The fee the open ledger asks for right now (busy moments: 20–30k drops, bwif pays that for big
    // loops), at most ARB_FEE_SHARE of what the loop should earn on average (chance × profit).
    const cap = feeCap(o);
    if (!ctx.feeTry) {
      if (now() - feeLvl.at > 1000) await updateFee();
      feeDrops = Math.max(feeDrops, batchFee(), Math.min(cap, Math.floor(o.profit * DROPS * 0.1)));
      if (feeDrops > cap) { stat('skippedFeeHigh'); return false; }
    }
    o.net = o.profit - feeDrops / DROPS; // expected profit after this fee
    let tk = null;
    if (useTickets()) {
      tk = [...tickets].sort((x, y) => x - y).slice(0, 3);
      if (tk.length < 3) return false;
      for (const t of tk) { tickets.delete(t); busyTickets.add(t); }
    } else if (seqDirty) { try { await refreshAccount(); seqDirty = false; } catch { return false; } }
    const tx = buildBatch(o, feeDrops, tk, ctx.lls);
    if (!tx) { release(tk); return false; }
    let signed;
    try { signed = wallet.sign(tx); } catch (e) { release(tk); say(`⚠️ sign failed: ${e.message}`); return false; }
    const route = ['XRP', ...o.assets.map(name), 'XRP'].join(' → ');
    const f = { hash: signed.hash, o, route, at: now(), sentLedger: ctx.view ?? ledger, live: !!ctx.live, last: tx.LastLedgerSequence, inner: 0, got: 0, outer: null, fee: feeDrops, tk, mode: o.mode || 'go' };
    if (f.mode === 'explore') S.dayExplore = (S.dayExplore || 0) + 1;
    flights.set(f.hash, f);
    stat('attempts');
    S.dayFees += feeDrops / DROPS;
    try {
      const r = await submitAll(signed.tx_blob);
      f.prelim = r.engine_result;
      if (!/^(tesSUCCESS|terQUEUED)$/.test(r.engine_result)) {
        stat('rejected');
        append('trades', { t: now(), route, x: o.x, expected: o.net, result: r.engine_result, applied: false });
        S.dayFees -= feeDrops / DROPS; // refused = not charged
        flights.delete(f.hash);
        release(tk);
        // fee too low for the open ledger right now: read the fee again and try once more
        if (/CAN_NOT_QUEUE|INSUF_FEE/.test(r.engine_result) && (ctx.feeTry || 0) < 2) {
          await updateFee();
          const nf = Math.min(cap, Math.max(Math.ceil(batchFee() * 1.5), feeDrops * 2));
          if (nf > feeDrops && o.profit - nf / DROPS >= cfg.minProfit) { stat('feeRetry'); return execute(o, nf, { ...ctx, feeTry: (ctx.feeTry || 0) + 1 }); }
          stat('feeTooHighForLoop');
        }
        if (tk && /TICKET|PAST_SEQ/.test(r.engine_result)) syncTickets().catch(() => {});
        if (!tk) seqDirty = true;
        return false;
      }
      return true;
    } catch (e) {
      say(`⚠️ submit failed: ${e.message}`);
      flights.delete(f.hash);
      release(tk);
      return false;
    }
  }

  // after each ledger: which batches landed, and what did they earn? (from their inner payments)
  async function settle() {
    let done = 0;
    // landed, but no inner payment came through the stream: ask the ledger (once per ledger)
    const ask = [...flights.values()].filter((f) => f.outer === 'tesSUCCESS' && !f.inner && f.vLedger && !f.asked);
    for (const L of new Set(ask.map((f) => f.vLedger))) {
      try {
        const r = await req('account_tx', { account: me, ledger_index_min: L, ledger_index_max: L, limit: 200 });
        for (const t of r.transactions || []) {
          const pf = flights.get(t.meta?.ParentBatchID);
          if (pf && !pf.inner) { pf.byLedger = true; }
          if (pf?.byLedger) { pf.inner++; pf.got += myDelta(t.meta); }
        }
        stat('innerFromLedger');
      } catch {}
    }
    for (const f of ask) f.asked = true;
    for (const f of [...flights.values()]) {
      if (!f.outer && ledger <= f.last) continue; // not validated yet, still possible
      flights.delete(f.hash);
      done++;
      const applied = f.inner > 0;
      // our batch took offers: forget those books until they are read again (no trading on gone offers)
      if (applied && f.o.book) for (const h of f.o.hops) { const t = h.from === XRP ? h.to : h.to === XRP ? h.from : null; if (t) { g.setBook(XRP, t, []); g.setBook(t, XRP, []); want('book:' + t, true); } }
      if (f.tk) {
        for (const t of f.tk) busyTickets.delete(t);
        if (!applied) for (const t of f.outer ? f.tk.slice(1) : f.tk) tickets.add(t); // unused tickets come back
      }
      const feeXrp = f.outer ? f.fee / DROPS : 0;
      const pnl = (applied ? f.got : 0) - feeXrp;
      stat(applied ? 'wins' : f.outer ? 'notApplied' : 'expired');
      // why did it miss? someone moved one of our pools earlier in that ledger → beaten
      let why = '';
      let by = '';
      let late = false;
      if (!applied && f.outer) {
        const beat = [];
        for (const h of f.o.hops) {
          // someone moved it after the state we computed on: earlier in our ledger, or in a ledger
          // between our view and ours (= we were late)
          const t = (touches.get(h.pool) || []).find((x) => (x.l === f.vLedger && (x.i == null || f.vIdx == null || x.i < f.vIdx)) || (x.l > f.sentLedger && x.l < f.vLedger));
          if (t) { beat.push(h.pool); by ||= cfg.watch.get(t.a) || t.a.slice(0, 8); if (t.l < f.vLedger) late = true; }
        }
        why = beat.length ? 'beaten' : 'model';
        f.o.beatenPools = beat;
        stat(why === 'beaten' ? 'missBeaten' : 'missModel');
        if (f.o.book) for (const t of f.o.assets) { S.bookBan[t] = now(); dropBook(t); } // its offers weren't what we read
        if (late) stat('missLate');
      }
      if (applied || f.outer) {
        learn.record(f.o, applied ? 'win' : 'miss', why);
        const m = f.mode === 'explore' ? 'explore' : 'go';
        stat(m + 'Tries');
        if (applied) stat(m + 'Wins');
        if (f.vLedger) { stat(f.live ? 'liveLanded' : 'slowLanded'); stat((f.live ? 'liveLandedAfter' : 'slowLandedAfter'), f.vLedger - f.sentLedger); }
      }
      if (applied) for (const a of f.o.assets) tokFails.delete(a);
      if (!applied && f.outer) failed(f.o, why);
      else if (!applied) failed(f.o, 'expired');
      if (applied) S.stats.profit = (S.stats.profit || 0) + pnl;
      S.stats.fees = (S.stats.fees || 0) + feeXrp;
      const rec = { t: now(), route: f.route, hops: f.o.hops.length, x: +f.o.x.toFixed(4), expected: +f.o.net.toFixed(6), pnl: +pnl.toFixed(6), applied, result: f.outer || 'expired', ledgers: ledger - f.sentLedger, held: name(f.o.assets[f.o.held]), ticket: !!f.tk, mode: f.mode, p: f.o.p, why, by, live: f.live, book: !!f.o.book, late: why === 'beaten' && late, landedAfter: f.vLedger ? f.vLedger - f.sentLedger : null };
      S.trades.unshift(rec);
      append('trades', rec);
      if (applied) say(`✅ ${f.route}: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} XRP (size ${f.o.x.toFixed(2)}, expected +${f.o.net.toFixed(6)})`);
    }
    if (!done) return;
    S.trades = S.trades.slice(0, 100);
    await refreshAccount().catch(() => {});
    if (!flights.size) seqDirty = false; // refreshAccount above read the current sequence
    save();
  }

  // ---------- tickets ----------
  async function syncTickets() {
    if (!useTickets() || !acct.seq) return;
    const all = new Set();
    let marker;
    do {
      const r = await req('account_objects', { account: me, type: 'ticket', ledger_index: 'validated', limit: 400, ...(marker ? { marker } : {}) });
      for (const o of r.account_objects || []) if (o.TicketSequence) all.add(o.TicketSequence);
      marker = r.marker;
    } while (marker);
    tickets.clear();
    for (const t of all) if (!busyTickets.has(t)) tickets.add(t);
    ticketsSynced = ledger;
  }
  // keep enough tickets ready (each locks 0.2 XRP of reserve until it is used)
  async function ensureTickets() {
    if (!useTickets() || lineBusy || stopped || !acct.seq) return;
    const have = tickets.size + busyTickets.size;
    const n = Math.min(ticketTarget() - have, 250 - have);
    if (n < 3) return;
    if (available() - committed() < reserves.inc * n + cfg.minSize) { stat('skippedTicketReserve'); return; }
    lineBusy = true;
    try {
      const r = await client.submitAndWait({ TransactionType: 'TicketCreate', Account: me, TicketCount: n }, { wallet, autofill: true });
      if (r.result.meta?.TransactionResult === 'tesSUCCESS') stat('ticketsCreated', n);
      else say(`⚠️ tickets: ${r.result.meta?.TransactionResult}`);
    } catch (e) { say(`⚠️ tickets: ${e.message}`); }
    finally { seqDirty = true; lineBusy = false; }
    await syncTickets().catch(() => {});
    await refreshAccount().catch(() => {});
  }

  // ---------- rivals ----------
  function watchRival(tx, ev, hash) {
    const who = cfg.watch.get(tx.Account);
    if (tx.TransactionType === 'Batch') {
      const inner = (tx.RawTransactions || []).map((r) => r.RawTransaction);
      const pays = inner.filter((t) => t.TransactionType === 'Payment');
      const route = [];
      const keys = [];
      for (const p of pays) {
        const from = typeof p.SendMax === 'string' ? XRP : assetKey(p.SendMax);
        if (!keys.length) keys.push(from);
        for (const step of p.Paths?.[0] || []) if (step.currency) keys.push(assetKey(step));
        keys.push(typeof p.Amount === 'string' ? XRP : assetKey(p.Amount));
        // the token they hold between the two payments deserves a trust line here too
        if (typeof p.Amount !== 'string') S.hot[assetKey(p.Amount)] = (S.hot[assetKey(p.Amount)] || 0) + 0.02;
        if (typeof p.Amount !== 'string') uni.noteRival(assetKey(p.Amount));
        for (const step of p.Paths?.[0] || []) if (step.currency) uni.noteRival(assetKey(step));
      }
      const early = innerEarly.get(hash);
      innerEarly.delete(hash);
      for (const k of keys) route.push(name(k));
      for (let i = 0; i < keys.length - 1; i++) wantPair(keys[i], keys[i + 1]);
      rivalBatches.set(hash, { t: now(), who, acct: tx.Account, ledger: ev.ledger_index, route: route.join(' → '), pnl: early ? early.d : 0, applied: !!early, inner: !!early, fee: Number(tx.Fee) / DROPS, ...ourView(keys) });
      setTimeout(() => closeRival(hash), 10000);
      stat('rivalBatches');
      return;
    }
    const parent = ev.meta.ParentBatchID || tx.ParentBatchID; // the ledger puts it in the metadata
    if (!parent) return;
    let d = 0;
    for (const n of ev.meta.AffectedNodes || []) {
      const node = n.ModifiedNode;
      if (node?.LedgerEntryType === 'AccountRoot' && node.FinalFields?.Account === tx.Account && node.PreviousFields?.Balance != null) {
        d += (Number(node.FinalFields.Balance) - Number(node.PreviousFields.Balance)) / DROPS;
      }
    }
    const r = rivalBatches.get(parent);
    if (r) { r.applied = true; r.inner = true; r.pnl += d; return; }
    // inner payments can arrive before their batch – keep them until it does
    const b = innerEarly.get(parent) || { d: 0, n: 0, at: now() };
    b.d += d; b.n++;
    innerEarly.set(parent, b);
    for (const [k, v] of innerEarly) if (now() - v.at > 30000) innerEarly.delete(k);
  }
  // Does our model know the rival's route? Each step needs an AMM pool (else they used an order
  // book), and the tokens/hops must be inside our limits – this tells why we miss their cycles.
  function ourView(keys) {
    const missing = [];
    const outFocus = [];
    let rate = 1;
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i], b = keys[i + 1];
      let best = null;
      for (const id of g.adj.get(a) || []) {
        const p = g.pools.get(id);
        if (p?.ready && g.other(p, a) === b && (!best || g.depth(p) > g.depth(best))) best = p;
      }
      if (!best) { missing.push(`${name(a)}/${name(b)}`); continue; }
      rate *= (g.resOf(best, b) / g.resOf(best, a)) * (1 - best.fee);
      if (b !== XRP && !uni.has(b)) outFocus.push(name(b));
    }
    return {
      hops: keys.length - 1,
      ammOnly: missing.length === 0,
      missingAmm: missing.join(' '),
      ourRateAfter: missing.length ? null : +rate.toFixed(5), // after their trade: ≈1 or below means they took it
      notInFocus: [...new Set(outFocus)].join(' '),
      tooLong: keys.length - 1 > cfg.maxHops,
    };
  }
  const rivalTx = new Map(); // "acct:ledger" → their transactions in that ledger (one request per ledger)
  const balAt = async (acct, l) => Number((await req('account_info', { account: acct, ledger_index: l })).account_data.Balance) / DROPS;
  async function closeRival(hash) {
    const r = rivalBatches.get(hash);
    if (!r) return;
    rivalBatches.delete(hash);
    // the stream may not carry the inner payments: read them from the ledger (exact per batch);
    // only if that fails, the balance change of the whole ledger (shared by all their batches in it)
    if (!r.inner && r.acct && r.ledger) {
      try {
        const k = `${r.acct}:${r.ledger}`;
        let txs = rivalTx.get(k);
        if (!txs) { txs = req('account_tx', { account: r.acct, ledger_index_min: r.ledger, ledger_index_max: r.ledger, limit: 400 }).then((x) => x.transactions || []); rivalTx.set(k, txs); setTimeout(() => rivalTx.delete(k), 60000); }
        let d = 0, n = 0;
        for (const t of await txs) {
          if (t.meta?.ParentBatchID !== hash) continue;
          n++;
          for (const nd of t.meta.AffectedNodes || []) {
            const m = nd.ModifiedNode;
            if (m?.LedgerEntryType === 'AccountRoot' && m.FinalFields?.Account === r.acct && m.PreviousFields?.Balance != null) d += (Number(m.FinalFields.Balance) - Number(m.PreviousFields.Balance)) / DROPS;
          }
        }
        r.pnl = d; r.applied = n > 0; r.byLedger = true;
      } catch {
        try { r.pnl = (await balAt(r.acct, r.ledger)) - (await balAt(r.acct, r.ledger - 1)) + r.fee; r.applied = r.pnl > 1e-9; r.byBalance = true; } catch {}
      }
    }
    delete r.acct;
    r.pnl = +(r.pnl - r.fee).toFixed(6);
    if (r.applied) { stat('rivalWins'); S.stats.rivalProfit = (S.stats.rivalProfit || 0) + r.pnl; }
    S.rivals.unshift(r);
    S.rivals = S.rivals.slice(0, 100);
    append('rivals', r);
  }

  // ---------- focus set + trust lines ----------
  // The token held between the two payments needs a trust line, so lines are kept for the focus
  // tokens up front (in priority order, up to ARB_MAX_LINES); tokens that left the focus give
  // their line back (0.2 XRP reserve) once its balance is zero.
  function refocus() {
    uni.recompute();
    if (!cfg.focus && !cfg.listOnly) return;
    const f = [...uni.set()];
    for (const tok of f) if (!g.xrpPool.has(tok)) wantPair(XRP, tok);
    for (let i = 0; i < f.length; i++) for (let j = i + 1; j < f.length; j++) wantPair(f[i], f[j]);
    // bridge tokens: check their issuers up front, so a loop through them can run at first sight
    if (cfg.listOnly && cfg.bridge) for (const [tok] of g.xrpPool) if (isBridge(tok) && !issuers.has(issuerOf(tok))) checkIssuer(issuerOf(tok));
    // token/token pools between two focus tokens (or a focus token and a bridge) are read now
    for (const tok of uni.set()) {
      for (const id of g.adj.get(tok) || []) {
        const p = g.pools.get(id);
        if (p && !p.ready && allow(p.a) && allow(p.b)) want(id, true);
      }
    }
  }
  const lineBal = new Map();
  async function trustSet(asset, limit) {
    lineBusy = true;
    try {
      const r = await client.submitAndWait({ TransactionType: 'TrustSet', Account: me, Flags: TF_SET_NO_RIPPLE, LimitAmount: { ...assetObj(asset), value: limit } }, { wallet, autofill: true });
      return r.result.meta?.TransactionResult === 'tesSUCCESS';
    } catch (e) { say(`⚠️ trust line ${name(asset)}: ${e.message}`); return false; }
    finally { seqDirty = true; lineBusy = false; }
  }
  async function manageLines() {
    if ((!useTickets() && flights.size) || lineBusy || cfg.dryRun || stopped || !acct.seq) return;
    if (useTickets() && tickets.size + busyTickets.size <= ticketTarget() - 3) await ensureTickets();
    if (lineBusy) return;
    for (const k of Object.keys(S.hot)) { S.hot[k] *= 0.97; if (S.hot[k] < 1e-4) delete S.hot[k]; }
    const wantList = cfg.focus || cfg.listOnly
      ? uni.priority().filter((k) => g.xrpPool.has(k)).slice(0, cfg.maxLines)
      : Object.entries(S.hot).filter(([k, v]) => k !== XRP && v >= cfg.lineMinScore).sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, cfg.maxLines);
    if (cfg.listOnly) {
      // list only: give back every other line that holds nothing (0.2 XRP reserve each)
      const drop = [...lines].find((k) => !uni.has(k) && !(lineBal.get(k) > 0));
      if (drop) {
        if (await trustSet(drop, '0')) { lines.delete(drop); S.lines = [...lines]; lineBal.delete(drop); stat('linesRemoved'); say(`✂️ trust line ${name(drop)} removed (not on the list)`); }
        await refreshAccount().catch(() => {});
        return;
      }
    }
    const next = wantList.find((k) => !lines.has(k));
    if (!next) return;
    if (lines.size >= cfg.maxLines) {
      // make room: give back a line that left the focus and holds nothing
      const drop = [...lines].find((k) => !wantList.includes(k) && !(lineBal.get(k) > 0));
      if (!drop) return;
      if (await trustSet(drop, '0')) { lines.delete(drop); S.lines = [...lines]; stat('linesRemoved'); say(`✂️ trust line ${name(drop)} removed (left the focus)`); }
      await refreshAccount().catch(() => {});
      return;
    }
    if (available() < reserves.inc + cfg.minSize) return;
    if (await trustSet(next, '9999999999999999e80')) {
      lines.add(next);
      S.lines = [...lines];
      stat('linesAdded');
      say(`🔗 trust line for ${name(next)}`);
    }
    await refreshAccount().catch(() => {});
    save();
  }

  // a wallet without XRP isn't on the ledger yet – keep watching/recording and check again every minute
  async function loadWallet() {
    if (cfg.dryRun || acct.seq) return;
    try {
      await refreshAccount(); await refreshLines(); await syncTickets().catch(() => {});
      if (activated === false) say(`💰 Wallet activated: ${acct.balance.toFixed(2)} XRP – trading starts`);
      activated = true;
    } catch (e) {
      if (activated !== false) say(`⚠️ Wallet ${me} not on the ledger yet (${e?.data?.error || e.message}) – send XRP to it; watching and recording meanwhile`);
      activated = false;
    }
  }

  // ---------- lifecycle ----------
  const timers = [];
  async function start() {
    try {
      const v = (await req('server_info')).info?.validated_ledger;
      if (v) { reserves = { base: v.reserve_base_xrp, inc: v.reserve_inc_xrp }; ledger = v.seq; }
    } catch {}
    await loadWallet();
    timers.push(setInterval(loadWallet, 60000));
    client.on('transaction', onTransaction);
    await subscribe();
    fetchLoop();
    discover().catch((e) => { discovering = false; say(`⚠️ pool discovery: ${e.message}`); });
    timers.push(setInterval(() => manageLines(), 15000));
    timers.push(setInterval(() => uni.snapshot(), 300000));
    timers.push(setInterval(() => refocus(), 120000));
    timers.push(setInterval(() => refreshLines().catch(() => {}), 600000));
    timers.push(setInterval(refreshBooks, 60000));
    setTimeout(() => { uni.snapshot(); refocus(); refreshBooks(); }, 20000);
    timers.push(setInterval(() => { save(); savePools(); }, 600000));
    say(`🤖 Arb bot running${cfg.dryRun ? ' (DRY RUN)' : ''} – wallet ${me}, ${acct.balance.toFixed(2)} XRP, ${lines.size} trust lines`);
  }
  // live: transactions_proposed also carries the validated ones (with metadata)
  async function subscribe() {
    if (cfg.live) {
      try { await client.request({ command: 'subscribe', streams: ['transactions_proposed'] }); return; } catch (e) { say(`⚠️ live stream refused (${e?.data?.error || e.message}) – validated ledgers only`); }
    }
    await client.request({ command: 'subscribe', streams: ['transactions'] });
  }
  async function resubscribe() { await subscribe(); }
  function stop() { stopped = true; timers.forEach(clearInterval); clearTimeout(timer); save(); savePools(); }

  const poolName = (id) => { const p = g.pools.get(id); return p ? `${name(p.a)}/${name(p.b)}` : id.slice(0, 8); };
  const routeName = (key) => 'XRP → ' + key.split('>').map((s) => name(s.slice(s.indexOf(':') + 1))).join(' → ');
  function status() {
    const ready = [...g.pools.values()].filter((p) => p.ready).length;
    return {
      wallet: me, dryRun: cfg.dryRun, paused: cfg.paused, balance: acct.balance, startBalance: S.startBalance,
      available: Math.max(0, available()), ledger, pools: g.pools.size, poolsReady: ready, queue: queue.length, discovering,
      stats: S.stats, dayFees: S.dayFees, maxFeesDay: cfg.maxFeesDay, trades: S.trades.slice(0, 50), rivals: S.rivals.slice(0, 40),
      lines: [...lines].map(name), hot: Object.entries(S.hot).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => ({ token: name(k), score: +v.toFixed(4), line: lines.has(k) })),
      listOnly: cfg.listOnly, bridge: cfg.listOnly && cfg.bridge, bridges: cfg.listOnly && cfg.bridge ? [...g.xrpPool.keys()].filter(isBridge).map(name) : [], candidates: uni.candidates().slice(0, 15).map((x) => ({ ...x, token: name(x.tok), id: `${name(x.tok)}.${x.tok.split('.')[1]}` })),
      otherLines: [...lines].filter((k) => !uni.has(k)).map((k) => `${name(k)}${lineBal.get(k) > 0 ? ' (holds ' + lineBal.get(k) + ')' : ''}`),
      focus: cfg.focus || cfg.listOnly, focusList: uni.list().slice(0, 60).map((x) => ({ ...x, token: name(x.tok), line: lines.has(x.tok) })),
      watching: [...cfg.watch.values()], inFlight: [...flights.values()].map((f) => f.route), activated: activated !== false,
      parallel: useTickets() ? cfg.parallel : 1, tickets: { free: tickets.size, busy: busyTickets.size, target: useTickets() ? ticketTarget() : 0 },
      learn: { target: cfg.targetWin, exploreDay: cfg.exploreDay, exploredToday: S.dayExplore || 0, classes: learn.table(), why: learn.why(), worstRoutes: learn.worst('r:').map((r) => ({ ...r, key: routeName(r.key) })), worstTokens: learn.worst('t:').map((r) => ({ ...r, key: name(r.key) })), worstPools: learn.worst('p:').map((r) => ({ ...r, key: poolName(r.key) })) },
      books: { on: cfg.books, tokens: bookTokens().filter((t) => g.books.has(`${XRP}>${t}`) || g.books.has(`${t}>${XRP}`)).length, offers: [...g.books.values()].reduce((a, b) => a + b.length, 0) },
      sizes: { min: cfg.minSize, max: cfg.maxSize }, minProfit: cfg.minProfit, topN: cfg.topN, focusOnly: cfg.focusOnly,
    };
  }
  const readJsonl = (prefix) => {
    const out = [];
    for (const f of fs.readdirSync(cfg.dataDir).filter((x) => x.startsWith(prefix + '-') && x.endsWith('.jsonl')).sort()) {
      for (const line of fs.readFileSync(path.join(cfg.dataDir, f), 'utf8').split('\n')) if (line) { try { out.push(JSON.parse(line)); } catch {} }
    }
    return out;
  };

  return { start, stop, resubscribe, status, onTransaction, onLedgerDone, readJsonl, graph: g, say, _manageLines: manageLines, _ensureTickets: ensureTickets, _loadWallet: loadWallet, _refocus: refocus, _refreshBooks: refreshBooks, _uni: uni, _state: () => S, _lines: lines, _acct: () => acct };
}
