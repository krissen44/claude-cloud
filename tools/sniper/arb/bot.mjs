// XRPL arbitrage bot: finds XRP → token → … → XRP loops through AMM pools after every ledger and
// runs the best one as ONE all-or-nothing Batch transaction (two inner self-payments: XRP → … → T
// and T → … → XRP). If the second payment can't return at least stake + min profit + fee, nothing
// happens and only the batch fee (≈ 0.00005 XRP) is spent.
//
// Pool reserves come from the metadata of every validated transaction (no polling); the pool list
// is read once from the ledger (ledger_data type amm) and cached.

import fs from 'node:fs';
import path from 'node:path';
import { XRP, assetKey, assetObj, createGraph, applyMeta, findCycles, bestSize, cycleOut } from './engine.mjs';

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
    minProfit: num('ARB_MIN_PROFIT', 0.002), // XRP after fees
    minSize: num('ARB_MIN_SIZE', 0.1),
    maxSize: num('ARB_MAX_SIZE', 25),
    floor: num('ARB_FLOOR', 5), // XRP never used
    maxHops: num('ARB_MAX_HOPS', 4),
    minPoolXrp: num('ARB_MIN_POOL_XRP', 20), // pool depth (both sides, in XRP)
    slip: num('ARB_SLIP', 0.15), // % under the expected amount for the first payment
    feeDrops: num('ARB_FEE_DROPS', 50),
    maxFeesDay: num('ARB_MAX_FEES_DAY', 2), // XRP of fees per day, then pause until tomorrow
    maxLines: num('ARB_MAX_LINES', 25),
    lineMinScore: num('ARB_LINE_MIN_SCORE', 0.01),
    lastLedgers: num('ARB_LAST_LEDGERS', 2),
    fetchPerSec: num('ARB_FETCH_PER_SEC', 8),
    watch,
    dataDir: env.ARB_DATA_DIR || path.join(process.env.HOME || '.', 'xrpl-arb-data'),
    discord: env.ARB_DISCORD_WEBHOOK || '',
  };
}

export function createArb({ client, wallet, cfg, log = console.log, fetchFn = globalThis.fetch }) {
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
  const lines = new Set(S.lines);
  let reserves = { base: 1, inc: 0.2 };
  let acct = { balance: 0, seq: 0, owners: 0 };
  let ledger = 0;
  let inFlight = null;
  let activated = null;
  let stopped = false;

  const req = async (command, params = {}) => (await client.request({ command, ...params })).result;

  // ---------- safety: issuer checks + cool-down after failures ----------
  // A token with a transfer fee or a freeze makes our math wrong (the batch would fail every
  // ledger and burn fees), so only tokens whose issuer was checked and is clean are traded.
  const issuers = new Map(); // issuer → {ok, why, at}
  const checking = new Set();
  async function checkIssuer(iss) {
    if (checking.has(iss)) return;
    checking.add(iss);
    try {
      const d = (await req('account_info', { account: iss, ledger_index: 'validated' })).account_data;
      const fee = d.TransferRate ? d.TransferRate / 1e9 - 1 : 0;
      const frozen = (d.Flags || 0) & 0x00400000;
      issuers.set(iss, { ok: !(fee > 0) && !frozen, why: fee > 0 ? `transfer fee ${(fee * 100).toFixed(2)}%` : frozen ? 'frozen' : '', at: now() });
    } catch { issuers.set(iss, { ok: false, why: 'unknown', at: now() }); }
    checking.delete(iss);
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
  function failed(o) {
    cool.set(o.key, ledger + 10);
    for (const a of o.assets) {
      const t = tokFails.get(a) || { n: 0, until: 0 };
      t.n = t.until && t.until < now() ? 1 : t.n + 1;
      if (t.n >= 3) { t.until = now() + 3600e3; t.n = 0; say(`🧊 ${name(a)}: 3 failed cycles – not used for 1 h`); }
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
  }
  function savePools() {
    try { fs.writeFileSync(poolFile, JSON.stringify([...g.pools.values()].map((p) => ({ id: p.id, a: p.a, b: p.b, fee: p.fee })))); } catch {}
  }

  // read pool balances in the background, XRP pools first
  async function fetchLoop() {
    while (!stopped) {
      const id = queue.shift();
      if (!id) { await new Promise((r) => setTimeout(r, 500)); continue; }
      queued.delete(id);
      try {
        const r = await req('amm_info', { amm_account: id, ledger_index: 'validated' });
        const am = r.amm;
        const val = (x) => (typeof x === 'string' ? Number(x) / DROPS : Number(x.value));
        const k1 = assetKey(typeof am.amount === 'string' ? XRP : am.amount);
        const k2 = assetKey(typeof am.amount2 === 'string' ? XRP : am.amount2);
        const v1 = val(am.amount), v2 = val(am.amount2);
        const fee = (am.trading_fee || 0) / 1e5;
        const p = g.pools.get(id);
        if (!p) { g.upsert({ id, a: k1, b: k2, ra: v1, rb: v2, fee }); stat('poolsFromStream'); } // learned from the stream
        else g.upsert(k1 === p.a ? { id, ra: v1, rb: v2, fee } : { id, ra: v2, rb: v1, fee });
        stat('poolsFetched');
      } catch (e) {
        if (/actNotFound|ammNotFound/i.test(String(e?.data?.error || e?.message))) g.remove(id);
      }
      await new Promise((r) => setTimeout(r, 1000 / cfg.fetchPerSec));
    }
  }

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
      for (const l of r.lines || []) lines.add(`${l.currency}.${l.account}`);
      marker = r.marker;
    } while (marker);
    S.lines = [...lines];
  }
  const available = () => acct.balance - reserves.base - reserves.inc * acct.owners - cfg.floor;

  // ---------- stream ----------
  let changed = new Set();
  let timer = null;
  const rivalBatches = new Map(); // parent hash → record

  function onTransaction(ev) {
    const tx = ev.tx_json || ev.transaction;
    if (!tx || !ev.validated || !ev.meta) return;
    if (ev.ledger_index > ledger) ledger = ev.ledger_index;
    const hash = ev.hash || tx.hash;
    for (const id of applyMeta(g, ev.meta, (nid) => want(nid, true))) changed.add(id);
    // our batch: the outer tx and its inner payments come through the stream
    if (inFlight) {
      if (hash === inFlight.hash) inFlight.outer = ev.meta.TransactionResult;
      if (tx.Account === me && tx.ParentBatchID === inFlight.hash) inFlight.inner++;
    }
    if (cfg.watch.has(tx.Account)) watchRival(tx, ev, hash);
    clearTimeout(timer);
    timer = setTimeout(onLedgerDone, 120); // run once the ledger's transactions are in
  }

  // ---------- search + execute ----------
  async function onLedgerDone() {
    if (stopped) return;
    stat('ledgers');
    if (inFlight) await settle();
    const ch = changed;
    changed = new Set();
    if (!ch.size) return;
    const t0 = now();
    const cycles = findCycles(g, ch, { maxHops: cfg.maxHops, minDepthXrp: cfg.minPoolXrp, minRate: 1.0005 });
    stat('cyclesSeen', cycles.length);
    const feeXrp = cfg.feeDrops / DROPS;
    const room = Math.min(cfg.maxSize, Math.max(0, available()));
    const opps = [];
    for (const c of cycles) {
      const hi = Math.max(cfg.minSize, Math.min(room || cfg.maxSize, cfg.maxSize));
      const { x, profit } = bestSize(g, c.hops, cfg.minSize, hi);
      const net = profit - feeXrp;
      if (net < cfg.minProfit) continue;
      const assets = c.hops.slice(0, -1).map((h) => h.to);
      const held = assets.findIndex((a) => lines.has(a));
      opps.push({ ...c, x, profit, net, assets, held });
    }
    S.stats.lastSearchMs = now() - t0;
    if (!opps.length) return;
    opps.sort((a, b) => b.net - a.net);
    stat('opportunities', opps.length);
    for (const o of opps.slice(0, 5)) {
      append('opps', { t: now(), ledger, route: ['XRP', ...o.assets.map(name), 'XRP'].join('>'), hops: o.hops.length, x: +o.x.toFixed(4), profit: +o.profit.toFixed(6), net: +o.net.toFixed(6), executable: o.held >= 0, room: +room.toFixed(3) });
      for (const a of o.assets) S.hot[a] = (S.hot[a] || 0) + o.net; // tokens worth a trust line
    }
    const usable = opps.filter((o) => !blocked(o));
    if (!usable.length) { stat('skippedCooldown'); return; }
    const clean = usable.filter((o) => tokensOk(o.assets));
    if (!clean.length) { stat('skippedIssuerCheck'); return; }
    const best = clean.find((o) => o.held >= 0);
    if (!best) { stat('missedNoLine'); return; }
    if (cfg.paused || cfg.dryRun || room < cfg.minSize) { stat(cfg.paused ? 'skippedPaused' : room < cfg.minSize ? 'skippedNoRoom' : 'dryRunOpps'); return; }
    if (S.day !== day()) { S.day = day(); S.dayFees = 0; }
    if (S.dayFees >= cfg.maxFeesDay) { stat('skippedFeeCap'); return; }
    if (inFlight) { stat('skippedBusy'); return; } // one batch at a time (sequence numbers)
    await execute(best);
  }

  function buildBatch(o) {
    const i = o.held;
    const T = o.assets[i];
    const first = o.hops.slice(0, i + 1);
    const second = o.hops.slice(i + 1);
    const q1Exp = cycleOut(g, first, o.x);
    const q1 = q1Exp * (1 - cfg.slip / 100);
    const outExp = cycleOut(g, second, q1);
    const feeXrp = cfg.feeDrops / DROPS;
    const minBack = o.x + feeXrp + cfg.minProfit;
    if (outExp < minBack) return null;
    const pathOf = (hops) => hops.slice(0, -1).map((h) => assetObj(h.to));
    const tok = assetObj(T);
    const p1 = {
      TransactionType: 'Payment', Account: me, Destination: me,
      Amount: { ...tok, value: iou(q1) }, SendMax: drops(o.x),
      Flags: TF_INNER | (first.length > 1 ? TF_NO_DIRECT : 0),
      ...(first.length > 1 ? { Paths: [pathOf(first)] } : {}),
      Sequence: acct.seq + 1, Fee: '0', SigningPubKey: '',
    };
    const p2 = {
      TransactionType: 'Payment', Account: me, Destination: me,
      Amount: drops(outExp * 1.2), DeliverMin: drops(minBack), SendMax: { ...tok, value: iou(q1) },
      Flags: TF_INNER | TF_PARTIAL | (second.length > 1 ? TF_NO_DIRECT : 0),
      ...(second.length > 1 ? { Paths: [pathOf(second)] } : {}),
      Sequence: acct.seq + 2, Fee: '0', SigningPubKey: '',
    };
    return {
      TransactionType: 'Batch', Account: me, Flags: TF_ALL_OR_NOTHING,
      RawTransactions: [{ RawTransaction: p1 }, { RawTransaction: p2 }],
      Sequence: acct.seq, Fee: String(cfg.feeDrops), LastLedgerSequence: ledger + 1 + cfg.lastLedgers,
    };
  }

  async function execute(o) {
    if (!acct.seq) return; // wallet not activated yet
    const tx = buildBatch(o);
    if (!tx) return;
    let signed;
    try { signed = wallet.sign(tx); } catch (e) { say(`⚠️ sign failed: ${e.message}`); return; }
    const route = ['XRP', ...o.assets.map(name), 'XRP'].join(' → ');
    inFlight = { hash: signed.hash, o, route, at: now(), sentLedger: ledger, last: tx.LastLedgerSequence, balance: acct.balance, inner: 0, outer: null };
    stat('attempts');
    S.dayFees += cfg.feeDrops / DROPS;
    try {
      const r = await req('submit', { tx_blob: signed.tx_blob });
      inFlight.prelim = r.engine_result;
      if (!/^(tesSUCCESS|terQUEUED)$/.test(r.engine_result)) {
        stat('rejected');
        append('trades', { t: now(), route, x: o.x, expected: o.net, result: r.engine_result, applied: false });
        if (/^tef|^ter|^tel/.test(r.engine_result)) await refreshAccount().catch(() => {});
        inFlight = null;
      }
    } catch (e) {
      say(`⚠️ submit failed: ${e.message}`);
      inFlight = null;
    }
  }

  // after the ledger: did our batch land, and what did it earn?
  async function settle() {
    const f = inFlight;
    if (!f.outer && ledger <= f.last) return; // not validated yet, still possible
    inFlight = null;
    await refreshAccount().catch(() => {});
    const applied = f.inner > 0;
    const pnl = acct.balance - f.balance;
    stat(applied ? 'wins' : f.outer ? 'notApplied' : 'expired');
    if (!applied) failed(f.o);
    if (applied) S.stats.profit = (S.stats.profit || 0) + pnl;
    S.stats.fees = (S.stats.fees || 0) + (f.outer ? cfg.feeDrops / DROPS : 0);
    const rec = { t: now(), route: f.route, hops: f.o.hops.length, x: +f.o.x.toFixed(4), expected: +f.o.net.toFixed(6), pnl: +pnl.toFixed(6), applied, result: f.outer || 'expired', ledgers: ledger - f.sentLedger, held: name(f.o.assets[f.o.held]) };
    S.trades.unshift(rec);
    S.trades = S.trades.slice(0, 100);
    append('trades', rec);
    save();
    if (applied) say(`✅ ${f.route}: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} XRP (size ${f.o.x.toFixed(2)}, expected +${f.o.net.toFixed(6)})`);
  }

  // ---------- rivals ----------
  function watchRival(tx, ev, hash) {
    const who = cfg.watch.get(tx.Account);
    if (tx.TransactionType === 'Batch') {
      const inner = (tx.RawTransactions || []).map((r) => r.RawTransaction);
      const pays = inner.filter((t) => t.TransactionType === 'Payment');
      const route = [];
      for (const p of pays) {
        const from = typeof p.SendMax === 'string' ? 'XRP' : name(assetKey(p.SendMax));
        if (!route.length) route.push(from);
        for (const step of p.Paths?.[0] || []) route.push(step.currency ? name(assetKey(step)) : '?');
        route.push(typeof p.Amount === 'string' ? 'XRP' : name(assetKey(p.Amount)));
        // the token they hold between the two payments deserves a trust line here too
        if (typeof p.Amount !== 'string') S.hot[assetKey(p.Amount)] = (S.hot[assetKey(p.Amount)] || 0) + 0.02;
      }
      rivalBatches.set(hash, { t: now(), who, ledger: ev.ledger_index, route: route.join(' → '), pnl: 0, applied: false, fee: Number(tx.Fee) / DROPS });
      setTimeout(() => closeRival(hash), 10000);
      stat('rivalBatches');
      return;
    }
    const r = rivalBatches.get(tx.ParentBatchID);
    if (!r) return;
    r.applied = true;
    for (const n of ev.meta.AffectedNodes || []) {
      const node = n.ModifiedNode;
      if (node?.LedgerEntryType === 'AccountRoot' && node.FinalFields?.Account === tx.Account && node.PreviousFields?.Balance != null) {
        r.pnl += (Number(node.FinalFields.Balance) - Number(node.PreviousFields.Balance)) / DROPS;
      }
    }
  }
  function closeRival(hash) {
    const r = rivalBatches.get(hash);
    if (!r) return;
    rivalBatches.delete(hash);
    r.pnl = +(r.pnl - r.fee).toFixed(6);
    if (r.applied) { stat('rivalWins'); S.stats.rivalProfit = (S.stats.rivalProfit || 0) + r.pnl; }
    S.rivals.unshift(r);
    S.rivals = S.rivals.slice(0, 100);
    append('rivals', r);
  }

  // ---------- trust lines for the hottest tokens ----------
  async function manageLines() {
    if (inFlight || cfg.dryRun || stopped) return;
    for (const k of Object.keys(S.hot)) { S.hot[k] *= 0.97; if (S.hot[k] < 1e-4) delete S.hot[k]; }
    const cand = Object.entries(S.hot).filter(([k]) => !lines.has(k) && k !== XRP).sort((a, b) => b[1] - a[1])[0];
    if (!cand || cand[1] < cfg.lineMinScore) return;
    if (lines.size >= cfg.maxLines) return;
    if (available() < reserves.inc + cfg.minSize) return;
    try {
      const r = await client.submitAndWait({ TransactionType: 'TrustSet', Account: me, Flags: TF_SET_NO_RIPPLE, LimitAmount: { ...assetObj(cand[0]), value: '9999999999999999e80' } }, { wallet, autofill: true });
      if (r.result.meta?.TransactionResult === 'tesSUCCESS') {
        lines.add(cand[0]);
        S.lines = [...lines];
        stat('linesAdded');
        say(`🔗 trust line for ${name(cand[0])} (score ${cand[1].toFixed(3)})`);
      }
    } catch (e) { say(`⚠️ trust line ${name(cand[0])}: ${e.message}`); }
    await refreshAccount().catch(() => {});
    save();
  }

  // a wallet without XRP isn't on the ledger yet – keep watching/recording and check again every minute
  async function loadWallet() {
    if (cfg.dryRun || acct.seq) return;
    try {
      await refreshAccount(); await refreshLines();
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
    await client.request({ command: 'subscribe', streams: ['transactions'] });
    fetchLoop();
    discover().catch((e) => { discovering = false; say(`⚠️ pool discovery: ${e.message}`); });
    timers.push(setInterval(() => manageLines(), 60000));
    timers.push(setInterval(() => { save(); savePools(); }, 600000));
    say(`🤖 Arb bot running${cfg.dryRun ? ' (DRY RUN)' : ''} – wallet ${me}, ${acct.balance.toFixed(2)} XRP, ${lines.size} trust lines`);
  }
  async function resubscribe() { await client.request({ command: 'subscribe', streams: ['transactions'] }); }
  function stop() { stopped = true; timers.forEach(clearInterval); clearTimeout(timer); save(); savePools(); }

  function status() {
    const ready = [...g.pools.values()].filter((p) => p.ready).length;
    return {
      wallet: me, dryRun: cfg.dryRun, paused: cfg.paused, balance: acct.balance, startBalance: S.startBalance,
      available: Math.max(0, available()), ledger, pools: g.pools.size, poolsReady: ready, queue: queue.length, discovering,
      stats: S.stats, dayFees: S.dayFees, maxFeesDay: cfg.maxFeesDay, trades: S.trades.slice(0, 50), rivals: S.rivals.slice(0, 40),
      lines: [...lines].map(name), hot: Object.entries(S.hot).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => ({ token: name(k), score: +v.toFixed(4), line: lines.has(k) })),
      watching: [...cfg.watch.values()], inFlight: inFlight ? inFlight.route : null, activated: activated !== false,
    };
  }
  const readJsonl = (prefix) => {
    const out = [];
    for (const f of fs.readdirSync(cfg.dataDir).filter((x) => x.startsWith(prefix + '-') && x.endsWith('.jsonl')).sort()) {
      for (const line of fs.readFileSync(path.join(cfg.dataDir, f), 'utf8').split('\n')) if (line) { try { out.push(JSON.parse(line)); } catch {} }
    }
    return out;
  };

  return { start, stop, resubscribe, status, onTransaction, onLedgerDone, readJsonl, graph: g, say, _manageLines: manageLines, _loadWallet: loadWallet, _state: () => S, _lines: lines, _acct: () => acct };
}
