// XRPL launch sniper: watches every new XRP/token AMM pool (FirstLedger, Horizon and any other
// launchpad create their pools with AMMCreate), checks the token for the usual rug signs,
// buys a fixed amount of XRP and sells by fixed rules (take profit, trailing stop, stop loss,
// rug exit, max hold time).
//
// The ledger connection is injected (`client`), so the same code runs against xrpl.js on
// mainnet and against the simulator in test/sim.mjs.

import fs from 'node:fs';
import { createRecorder, ammAccountOf, ammTokDelta, bundleOf, isBigLaunch } from './recorder.mjs';
import { chartHealth, createChartLearner } from './chart.mjs';
import { createSocials, hasSocials, socialsText } from './socials.mjs';
import path from 'node:path';

const DROPS = 1_000_000;
const F = {
  disableMaster: 0x00100000,
  requireAuth: 0x00040000,
  noFreeze: 0x00200000,
  globalFreeze: 0x00400000,
  defaultRipple: 0x00800000,
  clawback: 0x80000000,
};
const TF_PARTIAL = 0x00020000;
// results that mean "not allowed (yet)" rather than "price moved"
const PROTECT_CODES = /^(tecFROZEN|tecNO_AUTH|tecNO_LINE|tecNO_PERMISSION|tecNO_ISSUER|tecPATH_DRY)$/;
const TF_IOC = 0x00020000; // OfferCreate: tfImmediateOrCancel
const TF_SELL = 0x00080000; // OfferCreate: tfSell – spend all of TakerGets even at a better rate
const TF_SET_NO_RIPPLE = 0x00020000;
const BLACKHOLES = new Set([
  'rrrrrrrrrrrrrrrrrrrrrhoLvTp', // ACCOUNT_ZERO
  'rrrrrrrrrrrrrrrrrrrrBZbvji', // ACCOUNT_ONE
  'rrrrrrrrrrrrrrrrrrrn5RM1rHd', // NaN address
]);

export function readConfig(env = process.env) {
  const num = (k, d) => (env[k] === undefined || env[k] === '' ? d : Number(env[k]));
  const bool = (k, d) => (env[k] === undefined || env[k] === '' ? d : /^(1|true|yes|on)$/i.test(env[k]));
  return {
    dryRun: bool('DRY_RUN', false),
    pauseBuys: bool('PAUSE_BUYS', false), // no new buys, open positions are still sold by the rules
    buyXrp: num('BUY_XRP', 1),
    // size by share of the supply instead: buy this percent of all tokens (0 = off → BUY_XRP), at most BUY_MAX_XRP
    buySupplyPct: num('BUY_SUPPLY_PCT', 0),
    // big launches (this much XRP in the pool): bought first – they skip the queue of other buys –
    // with their own stake
    bigLaunchXrp: num('BIG_LAUNCH_XRP', 300),
    bigBuyXrp: num('BIG_BUY_XRP', num('BUY_XRP', 1)),
    buyMaxXrp: num('BUY_MAX_XRP', 10),
    // first buyers: see a launch while it enters the open ledger (≈ 4–6 s before it is validated),
    // check it on that ledger and buy at once – one ledger earlier than before
    fastLaunch: bool('FAST_LAUNCH', true),
    maxOpen: num('MAX_OPEN', 25),
    maxBuysPerDay: num('MAX_BUYS_PER_DAY', 40),
    minBalanceXrp: num('MIN_BALANCE_XRP', 10), // spendable XRP that is never used for buys
    minPoolXrp: num('MIN_POOL_XRP', 100),
    poolWaitMin: num('POOL_WAIT_MIN', 10), // a smaller launch is watched this long and bought once it reaches the minimum
    maxPoolXrp: num('MAX_POOL_XRP', 0), // 0 = no upper limit
    maxAmmFee: num('MAX_AMM_FEE', 1), // percent
    maxTransferFee: num('MAX_TRANSFER_FEE', 0), // percent
    requireBlackhole: bool('REQUIRE_BLACKHOLE', true),
    blackholeWaitS: num('BLACKHOLE_WAIT_S', 120),
    protectWaitMin: num('PROTECT_WAIT_MIN', 60), // launch protection phase: wait this long for it to be lifted
    // after a protection the early buyers are in already: skip if the price is above this many × launch (0 = off)
    protectMaxX: num('PROTECT_MAX_X', 12),
    // crowd entry: a launch that was skipped (dev holds the supply / pool too small) but then draws a
    // real crowd – many different buyers and a deep pool within the first hour – is bought after all,
    // with the classic exits (half at +100 %, trailing 30 %, stop −50 %, rug alarm, max 24 h)
    // chart: hold instead of selling while the chart is healthy, buy more once; learns its thresholds
    chartSmart: bool('CHART_SMART', true),
    chartHoldScore: num('CHART_HOLD_SCORE', 70),
    chartAdd: bool('CHART_ADD', true),
    chartAddScore: num('CHART_ADD_SCORE', 80),
    chartAddXrp: num('CHART_ADD_XRP', num('BUY_XRP', 1)),
    chartMaxAdds: num('CHART_MAX_ADDS', 1),
    hardStop: num('HARD_STOP', 75), // a loss this big is sold whatever the chart says
    chartLearn: bool('CHART_LEARN', true),
    // trust lines of dead / dust tokens: tokens go back to the issuer, the line is deleted (frees 0.2 XRP)
    cleanup: bool('CLEANUP_LINES', true),
    dustXrp: num('DUST_XRP', 0.05), // a leftover worth less than this (and not an open trade) is cleared
    crowd: bool('CROWD_BUY', true),
    crowdMinBuyers: num('CROWD_MIN_BUYERS', 100),
    crowdMinPoolXrp: num('CROWD_MIN_POOL_XRP', 500),
    crowdWindowMin: num('CROWD_WINDOW_MIN', 60),
    crowdBuyXrp: num('CROWD_BUY_XRP', num('BUY_XRP', 1)),
    crowdRequireBlackhole: bool('CROWD_REQUIRE_BLACKHOLE', false),
    minPoolSupplyPct: num('MIN_POOL_SUPPLY_PCT', 20), // share of the supply that sits in the pool
    // FirstLedger launches in two steps: the pool is created with ~1 % of the supply, the other 99 % is
    // deposited into it seconds later. A low share is waited for this long (bought the moment it arrives)
    supplyWaitS: num('SUPPLY_WAIT_S', 60),
    // socials from the issuer's xrp-ledger.toml: 'x' = needs an X/Twitter link, 'any' = X, Telegram,
    // Discord or a website, 'off'. Waited for SOCIALS_WAIT_S; a file that can't be read decides nothing
    // default 'off' = socials never hold up a buy: they're read in the background and shown
    socials: /^(x|any)$/i.test(env.SOCIALS_REQUIRED || '') ? env.SOCIALS_REQUIRED.toLowerCase() : 'off',
    socialsWaitS: num('SOCIALS_WAIT_S', 60),
    // launches by a creator – or a wallet funded by the same wallet – that rugged before are skipped
    skipRuggers: bool('SKIP_RUGGERS', true),
    // bundle: the dev's own wallets (same address start, or got the token from the dev). When one of
    // them sells ≥ BUNDLE_SELL_PCT % of what it holds, everything is sold at once (seen in the open ledger)
    bundleExit: bool('BUNDLE_EXIT', true),
    bundleSellPct: num('BUNDLE_SELL_PCT', 10),
    buySlippage: num('BUY_SLIPPAGE', 35),
    sellSlippage: num('SELL_SLIPPAGE', 30),
    tp1: num('TAKE_PROFIT', 100), // percent gain for the first sale
    // first sale: 'auto' = exactly enough tokens to get the stake back (+ buffer), the rest is a free
    // "moonbag" that is never sold; a number = that percent of the bag
    tp1Part: /^auto$/i.test(env.TAKE_PROFIT_PART || 'auto') ? 'auto' : Number(env.TAKE_PROFIT_PART),
    recoverBuffer: num('RECOVER_BUFFER', 5), // percent on top of the stake (fees, trust line)
    trail: num('TRAILING_STOP', 0), // after the first sale: sell the rest this far below the peak (0 = never)
    // before the stake is back:
    stopLoss: num('STOP_LOSS', 50), // 0 = off
    rugDrop: num('RUG_POOL_DROP', 40), // pool XRP below entry by this percent → sell everything (0 = off)
    maxHoldH: num('MAX_HOLD_H', 24), // 0 = off
    // moonbags: only a dead pool is cleared, to free the 0.2 XRP trust line reserve
    deadPoolDrop: num('DEAD_POOL_DROP', 90),
    // wallet tracking: TRACK_WALLETS=rAbc…:Name,rDef… → buy what these wallets buy
    track: parseTrack(env.TRACK_WALLETS || ''),
    copyBuyXrp: num('COPY_BUY_XRP', num('BUY_XRP', 1)),
    // smart wallets: found from the launches we follow, then copied like TRACK_WALLETS
    autoTrack: bool('AUTO_TRACK', true),
    autoMinLaunches: num('AUTO_MIN_LAUNCHES', 3),
    autoMinWin: num('AUTO_MIN_WIN', 60), // percent of launches with ≥ 10 % more XRP out than in
    autoMinPnl: num('AUTO_MIN_PNL', 5), // XRP taken out minus put in, over all followed launches
    autoMinEarly: num('AUTO_MIN_EARLY', 0), // how many of those launches it bought within 2 min (sniper)
    autoMax: num('AUTO_MAX', 5),
    // big launches: a wallet that was in early (≤ 2 min) and made ≥ 2× on this many of them is copied
    autoBigHits: num('AUTO_BIG_HITS', 2),
    copyMinXrp: num('COPY_MIN_XRP', 5), // ignore buys of the tracked wallet below this many XRP
    copyMinPoolXrp: num('COPY_MIN_POOL_XRP', num('MIN_POOL_XRP', 100)),
    // copied buys sell by classic rules (no moonbag): half at +100 %, rest on a 30 % trailing stop,
    // everything at −50 %, on a 40 % pool drop or after 24 h
    copyRules: {
      tp1: num('COPY_TAKE_PROFIT', 100),
      tp1Part: num('COPY_TAKE_PROFIT_PART', 50),
      trail: num('COPY_TRAILING_STOP', 30),
      stopLoss: num('COPY_STOP_LOSS', 50),
      rugDrop: num('COPY_RUG_POOL_DROP', 40),
      maxHoldH: num('COPY_MAX_HOLD_H', 24),
    },
    checkS: num('CHECK_S', 8),
    dataDir: env.DATA_DIR || path.join(process.env.HOME || '.', 'xrpl-sniper-data'),
    discord: env.DISCORD_WEBHOOK || '',
    // sells of a token whose market cap is at least this much wait for your OK on the status page
    // (rug exits stay automatic). 0 = off
    mcapApproval: num('MCAP_APPROVAL', 100000),
    // the first sale (stake back / first take profit) never waits for approval
    autoFirstSale: bool('AUTO_FIRST_SALE', true),
    mcapCurrency: /^xrp$/i.test(env.MCAP_CURRENCY || '') ? 'XRP' : 'USD',
    // runners: launched with at least RUNNER_START_XRP in the pool and the pool's XRP grew by
    // RUNNER_GROWTH percent within RUNNER_WINDOW_MIN → every sell (except a rug) waits for your OK
    runnerStartXrp: num('RUNNER_START_XRP', 300), // 0 = off
    runnerGrowth: num('RUNNER_GROWTH', 100),
    runnerWindowMin: num('RUNNER_WINDOW_MIN', 60),
    xrpUsd: num('XRP_USD', 0), // fallback price if the XRP/RLUSD pool can't be read
    publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''), // status page address for the Discord link
  };
}

// ---------- helpers ----------
function parseTrack(s) {
  const m = new Map();
  for (const part of s.split(',').map((x) => x.trim()).filter(Boolean)) {
    const [addr, name] = part.split(':');
    if (/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(addr)) m.set(addr, name || addr.slice(0, 8));
  }
  return m;
}

export function currencyName(c) {
  if (!c || c.length !== 40) return c;
  try {
    const s = Buffer.from(c, 'hex').toString('utf8').replace(/\0/g, '');
    return /^[\x20-\x7e]+$/.test(s) ? s : c.slice(0, 8);
  } catch { return c.slice(0, 8); }
}

// IOU amounts: max 16 significant digits; xrpl accepts "1.5e20" but not "1.5e+20".
export function iouValue(n, down = false) {
  if (!(n > 0) || !isFinite(n)) return '0';
  let v = Number(n.toPrecision(15));
  if (down && v > n) {
    // never offer more than we hold: step one unit down in the 15th significant digit
    const step = 10 ** (Math.floor(Math.log10(n)) - 14);
    v = Number((v - step).toPrecision(15));
  }
  return String(v).replace('e+', 'e');
}

const xrp = (drops) => Number(drops) / DROPS;
const toDrops = (x) => String(Math.max(1, Math.floor(x * DROPS)));
const key = (cur, iss) => `${cur}.${iss}`;
const now = () => Date.now();
const day = () => new Date().toISOString().slice(0, 10);

// Constant product with the AMM trading fee taken from the input.
export function swapOut(inAmt, poolIn, poolOut, feePct) {
  const i = inAmt * (1 - feePct / 100);
  return (poolOut * i) / (poolIn + i);
}

// Delivered amount and XRP balance change of `account` from a validated tx's metadata.
function txEffects(meta, account, currency, issuer) {
  let xrpDelta = 0;
  let tokDelta = 0;
  for (const n of meta?.AffectedNodes || []) {
    const node = n.ModifiedNode || n.CreatedNode || n.DeletedNode;
    if (!node) continue;
    const fin = node.FinalFields || node.NewFields || {};
    const prev = node.PreviousFields || {};
    if (node.LedgerEntryType === 'AccountRoot' && fin.Account === account && prev.Balance !== undefined) {
      xrpDelta += xrp(fin.Balance) - xrp(prev.Balance);
    }
    if (node.LedgerEntryType === 'RippleState' && fin.Balance?.currency === currency) {
      const lo = fin.LowLimit?.issuer;
      const hi = fin.HighLimit?.issuer;
      if ((lo === account && hi === issuer) || (hi === account && lo === issuer)) {
        const sign = lo === account ? 1 : -1; // balance is from the low side's view
        const before = Number(prev.Balance?.value ?? (n.CreatedNode ? 0 : fin.Balance.value));
        tokDelta += sign * (Number(fin.Balance.value) - before);
      }
    }
  }
  return { xrpDelta, tokDelta };
}

// Tokens `account` bought with XRP in a validated tx (Payment, OfferCreate, …): XRP went down by
// more than the fee and a trust line balance went up. LP tokens (currency 03…) are ignored.
export function buysOf(meta, account, feeDrops = 0) {
  let xrpDelta = 0;
  const got = [];
  for (const n of meta?.AffectedNodes || []) {
    const node = n.ModifiedNode || n.CreatedNode || n.DeletedNode;
    if (!node) continue;
    const fin = node.FinalFields || node.NewFields || {};
    const prev = node.PreviousFields || {};
    if (node.LedgerEntryType === 'AccountRoot' && fin.Account === account && prev.Balance !== undefined) {
      xrpDelta += xrp(fin.Balance) - xrp(prev.Balance);
    }
    if (node.LedgerEntryType === 'RippleState' && fin.Balance) {
      const lo = fin.LowLimit?.issuer;
      const hi = fin.HighLimit?.issuer;
      if (lo !== account && hi !== account) continue;
      const cur = fin.Balance.currency;
      if (/^03/.test(cur) && cur.length === 40) continue;
      const before = Number(prev.Balance?.value ?? (n.CreatedNode ? 0 : fin.Balance.value));
      const d = (lo === account ? 1 : -1) * (Number(fin.Balance.value) - before);
      if (d > 0) got.push({ currency: cur, issuer: lo === account ? hi : lo, tokens: d });
    }
  }
  const spent = -(xrpDelta + feeDrops / DROPS);
  return spent > 0 ? got.map((g) => ({ ...g, xrp: spent })) : [];
}

export const isMoonbag = (p) => p.tp1Done && !p.copy;

// ---------- the bot ----------
export function createBot({ client, wallet, cfg, log = console.log, fetchFn = globalThis.fetch, record = true }) {
  const me = wallet?.address || 'rDRYRUN';
  const file = path.join(cfg.dataDir, 'state.json');
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  let S = { positions: {}, history: [], seen: {}, day: '', buysToday: 0, realized: 0, startedAt: now() };
  try { S = { ...S, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  const pending = new Map(); // token key → launch waiting for checks
  const waiters = new Map(); // issuer → wake-up functions of launches waiting on it
  let reserves = { base: 1, inc: 0.2 };
  let ticking = false;
  let stopped = false;

  const save = () => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(S, null, 1));
    fs.renameSync(tmp, file);
  };
  const say = (msg) => {
    log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
    if (cfg.discord && fetchFn) {
      fetchFn(cfg.discord, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: msg.slice(0, 1900) }) }).catch(() => {});
    }
  };

  // One transaction at a time (sequence numbers); sells jump the queue.
  const queue = [];
  let busy = false;
  function submit(tx, prio = false) {
    return new Promise((resolve, reject) => {
      (prio ? queue.unshift.bind(queue) : queue.push.bind(queue))({ tx, resolve, reject });
      pump();
    });
  }
  // Sequence numbers need one transaction at a time – but only until it is in the open ledger:
  // the next one can be signed then (its sequence comes from the open ledger). Waiting for the
  // validation happens outside the queue, so a big launch's buy never waits ~4 s behind a sale.
  async function pump() {
    if (busy) return;
    const job = queue.shift();
    if (!job) return;
    busy = true;
    if (typeof client.submit !== 'function') { // simple clients: one after another until validated
      try { job.resolve((await client.submitAndWait(job.tx, { wallet, autofill: true })).result); } catch (e) { job.reject(e); }
      busy = false;
      return pump();
    }
    let sub;
    try { sub = (await client.submit(job.tx, { wallet, autofill: true })).result; } catch (e) { busy = false; job.reject(e); return pump(); }
    busy = false;
    pump();
    const code = sub.engine_result || '';
    const hash = sub.tx_json?.hash || sub.hash;
    // not applied at all (tel/tem/tef): final now
    if (!/^(tes|tec|ter)/.test(code) || !hash) return job.resolve({ meta: { TransactionResult: code || 'not submitted' }, hash });
    job.resolve(await validated(hash, sub.tx_json?.LastLedgerSequence));
  }
  async function validated(hash, last) {
    for (let i = 0; i < 200; i++) {
      try {
        const r = await req('tx', { transaction: hash });
        if (r.validated) return r;
      } catch {}
      if (last && i % 4 === 3) { try { if ((await req('ledger_current')).ledger_current_index > last + 1) return { meta: { TransactionResult: 'expired' }, hash }; } catch {} }
      await new Promise((res) => setTimeout(res, 500));
    }
    return { meta: { TransactionResult: 'not validated' }, hash };
  }
  const okResult = (r) => r?.meta?.TransactionResult === 'tesSUCCESS';

  // counters for the status page: launches seen, skipped by reason, buys ok / failed
  S.stats ||= { since: now(), skipped: {} };
  const stat = (k, reason) => {
    if (reason) S.stats.skipped[reason] = (S.stats.skipped[reason] || 0) + 1;
    else S.stats[k] = (S.stats[k] || 0) + 1;
  };
  const SKIP_KINDS = [
    [/blackholed/, 'not blackholed'], [/pool only/, 'pool too small'], [/> max/, 'pool too big'],
    [/clawback/, 'clawback'], [/froze/, 'frozen'], [/transfer fee/, 'transfer fee'], [/AMM fee/, 'AMM fee'],
    [/rugged before/, 'dev rugged before'], [/no socials/, 'no socials'], [/bundle is selling/, 'bundle selling'],
    [/supply/, 'dev holds the supply'], [/pumped/, 'pumped during protection'], [/pool gone/, 'pool gone'], [/approval/, 'trust lines need approval'],
  ];
  const skipKind = (text) => (SKIP_KINDS.find(([re]) => re.test(text)) || [0, 'other'])[1];

  async function req(command, params = {}) {
    const r = await client.request({ command, ...params });
    return r.result;
  }

  async function pool(currency, issuer, li = 'validated') {
    try {
      const r = await req('amm_info', { asset: { currency: 'XRP' }, asset2: { currency, issuer }, ledger_index: li });
      const a = r.amm;
      const xrpSide = typeof a.amount === 'string' ? a.amount : a.amount2;
      const tokSide = typeof a.amount === 'string' ? a.amount2 : a.amount;
      return { xrp: xrp(xrpSide), tok: Number(tokSide.value), fee: (a.trading_fee || 0) / 1000 };
    } catch (e) {
      if (/actNotFound|ammNotFound|Account not found/i.test(String(e?.data?.error || e?.message))) return null;
      throw e;
    }
  }

  // data recorder: follows every launch for 24 h and logs every event (see recorder.mjs)
  const NOREC = { follow() {}, checks() {}, decision() {}, trade() {}, tx() {}, event() {}, stop() {}, rows: () => [], csv: () => '', analysis: () => null, events: () => [], following: () => 0 };
  const rec = record ? createRecorder({ dir: cfg.dataDir, pool: (c, i) => pool(c, i), log: (m) => log(m), ignore: [me] }) : NOREC;
  const chart = createChartLearner(S, cfg, { now, log: (m) => say(m) });

  // ---------- smart wallets ----------
  // Ranked from the followed launches; the best ones (and the ones you pinned) are copied.
  S.walletPin ||= {}; S.walletBan ||= {};
  let auto = new Map(); // wallet → label
  const isSmart = (w) => (cfg.autoBigHits > 0 && w.bigHits >= cfg.autoBigHits && w.pnl > 0)
    || (w.launches >= cfg.autoMinLaunches && w.winRate * 100 >= cfg.autoMinWin && w.pnl >= cfg.autoMinPnl && w.early >= cfg.autoMinEarly);
  function refreshSmart() {
    const list = rec.wallets ? rec.wallets() : [];
    const next = new Map();
    for (const a of Object.keys(S.walletPin)) next.set(a, `📌 ${a.slice(0, 6)}`);
    if (cfg.autoTrack) for (const w of list.filter((x) => isSmart(x) && !S.walletBan[x.wallet]).slice(0, cfg.autoMax)) next.set(w.wallet, `🕵️ ${w.wallet.slice(0, 6)} (${w.launches} launches${w.bigHits ? `, ${w.bigHits}× early in a 🚀` : ''}, ${Math.round(w.winRate * 100)}%, ${w.pnl >= 0 ? '+' : ''}${w.pnl} XRP)`);
    for (const a of next.keys()) if (!auto.has(a)) { say(`🕵️ Now copying ${next.get(a)}`); rec.event('smart_wallet', { wallet: a, label: next.get(a) }); }
    auto = next;
  }
  const tracked = (a) => cfg.track.has(a) || auto.has(a);
  const trackedName = (a) => cfg.track.get(a) || auto.get(a) || a.slice(0, 8);

  async function refreshReserves() {
    try {
      const r = await req('server_info');
      const v = r.info?.validated_ledger;
      if (v) reserves = { base: v.reserve_base_xrp, inc: v.reserve_inc_xrp };
    } catch {}
  }

  async function spendable() {
    if (cfg.dryRun) return 1e9;
    const r = await req('account_info', { account: me, ledger_index: 'validated' });
    const d = r.account_data;
    return xrp(d.Balance) - reserves.base - reserves.inc * (d.OwnerCount || 0);
  }

  // ---------- launch detection ----------
  const seenValidated = new Set();
  const launchValidated = new Map(); // k → wake-ups waiting for the validated AMMCreate
  function onTransaction(ev) {
    const tx = ev.tx_json || ev.transaction;
    if (!tx) return;
    if (!ev.validated) {
      // open ledger: only launches, to be one of the first buyers
      if (cfg.fastLaunch && tx.TransactionType === 'AMMCreate' && /^tes/.test(ev.engine_result || '')) onLaunch(tx, ev, true);
      if (cfg.fastLaunch && tx.TransactionType === 'AMMDeposit' && /^tes/.test(ev.engine_result || '')) onDeposit(tx, false);
      if (/^tes/.test(ev.engine_result || '')) bundleProposed(tx);
      return;
    }
    if (ev.meta?.TransactionResult !== 'tesSUCCESS') return;
    const h = ev.hash || tx.hash;
    if (h) { if (seenValidated.has(h)) return; seenValidated.add(h); if (seenValidated.size > 20000) seenValidated.clear(); }
    rec.tx(ev);
    if (tracked(tx.Account) && tx.Account !== me) onTracked(tx, ev);
    // the issuer of a waiting launch did something (unfreeze, blackhole, fee change) → re-check now
    const ws = waiters.get(tx.Account);
    if (ws) { waiters.delete(tx.Account); for (const wake of ws) setTimeout(() => wake(true), 50); }
    if (tx.TransactionType === 'AMMDeposit') onDeposit(tx, true);
    bundleTx(tx, ev.meta);
    if (tx.TransactionType !== 'AMMCreate') return;
    onLaunch(tx, ev, false);
  }
  // a deposit into the pool of a launch that waits for its supply: check again at once
  // (from the open ledger: on the open ledger, so the buy can follow the deposit straight away)
  function onDeposit(tx, validated) {
    const a = [tx.Asset, tx.Asset2].find((x) => x && x.currency && x.currency !== 'XRP' && x.issuer);
    if (!a) return;
    const k = key(a.currency, a.issuer);
    const l = pending.get(k);
    if (!l || !l.supplyWait) return;
    if (validated) {
      l.validated = true;
      const wake = launchValidated.get(k);
      if (wake) { launchValidated.delete(k); wake.forEach((f) => f()); }
    } else { l.fast = true; l.validated = false; stat('depositSeenOpen'); }
    const ws = waiters.get(k);
    if (ws) { waiters.delete(k); for (const w of ws) setTimeout(() => w(), 0); }
  }
  function onLaunch(tx, ev, fast) {
    const xrpAmt = typeof tx.Amount === 'string' ? tx.Amount : typeof tx.Amount2 === 'string' ? tx.Amount2 : null;
    const tok = typeof tx.Amount === 'object' ? tx.Amount : typeof tx.Amount2 === 'object' ? tx.Amount2 : null;
    if (!xrpAmt || !tok) return; // token/token pools are not launches against XRP
    const k = key(tok.currency, tok.issuer);
    if (!fast) {
      // the validated AMMCreate of a launch first seen in the open ledger: now its pool account is known
      const lf = pending.get(k);
      if (lf?.fast) lf.validated = true;
      rec.setAmm?.(k, ammAccountOf(ev.meta));
      const wake = launchValidated.get(k);
      if (wake) { launchValidated.delete(k); wake.forEach((f) => f()); }
    }
    if (S.seen[k] || pending.has(k) || S.positions[k]) return;
    S.seen[k] = now();
    const launch = {
      k, currency: tok.currency, issuer: tok.issuer, name: currencyName(tok.currency),
      creator: tx.Account, poolXrp: xrp(xrpAmt), poolTok: Number(tok.value), at: now(),
      hash: ev.hash || tx.hash, fast, validated: !fast,
    };
    if (fast) stat('fastLaunches');
    bundleWatch(launch);
    pending.set(k, launch);
    stat('launches');
    rec.follow({ k, kind: 'launch', name: launch.name, currency: tok.currency, issuer: tok.issuer, creator: tx.Account, poolXrp: launch.poolXrp, poolTok: launch.poolTok, amm: fast ? '' : ammAccountOf(ev.meta), ledger: ev.ledger_index || ev.ledger_current_index || 0, hash: launch.hash || '' });
    say(`🆕 Launch ${launch.name} (${launch.issuer.slice(0, 8)}…) pool ${launch.poolXrp.toFixed(1)} XRP${fast ? ' ⚡ open ledger' : ''}`);
    evaluate(launch).catch((e) => { pending.delete(k); say(`⚠️ ${launch.name}: check failed – ${e.message}`); });
  }

  // A tracked wallet bought a token → run the same checks and buy it too (once per token).
  function onTracked(tx, ev) {
    if (tx.TransactionType === 'AMMDeposit' || tx.TransactionType === 'AMMCreate') return;
    const who = trackedName(tx.Account);
    for (const b of buysOf(ev.meta, tx.Account, Number(tx.Fee || 0))) {
      if (b.issuer === tx.Account || b.xrp < cfg.copyMinXrp) continue;
      const k = key(b.currency, b.issuer);
      S.copied ||= {};
      if (S.copied[k] || pending.has(k) || S.positions[k]) continue;
      S.copied[k] = now();
      const l = {
        k, currency: b.currency, issuer: b.issuer, name: currencyName(b.currency), at: now(),
        copy: who, buyXrp: cfg.copyBuyXrp, minPool: cfg.copyMinPoolXrp, poolWait: 0,
      };
      pending.set(k, l);
      stat('copySignals');
      rec.follow({ k, kind: 'copy', name: l.name, currency: b.currency, issuer: b.issuer, copy: who, ledger: ev.ledger_index || 0 });
      rec.event('copy_signal', { k, who, wallet: tx.Account, xrp: +b.xrp.toFixed(3), tokens: b.tokens });
      say(`👀 ${who} bought ${l.name} for ${b.xrp.toFixed(1)} XRP – checking`);
      evaluate(l).catch((e) => { pending.delete(k); say(`⚠️ ${l.name}: check failed – ${e.message}`); });
    }
  }

  // the wallet that sent a creator its first XRP (activated it) – serial ruggers reuse their funder
  const funders = new Map();
  async function funderOf(a) {
    if (funders.has(a)) return funders.get(a);
    let f = null;
    try {
      const r = await req('account_tx', { account: a, forward: true, limit: 3 });
      for (const t of r.transactions || []) { const tx = t.tx_json || t.tx; if (tx?.TransactionType === 'Payment' && tx.Destination === a && tx.Account !== a) { f = tx.Account; break; } }
    } catch {}
    funders.set(a, f);
    if (funders.size > 5000) funders.clear();
    return f;
  }
  const socials = createSocials({ fetchFn });

  // ---------- bundles ----------
  const bundles = new Map(); // launch → {creator, issuer, currency, wallets: Set, hold: Map}
  function bundleWatch(l) {
    if (!cfg.bundleExit || !l.creator || bundles.has(l.k)) return;
    bundles.set(l.k, { k: l.k, name: l.name, creator: l.creator, issuer: l.issuer, currency: l.currency, wallets: new Set([l.creator]), hold: new Map(), at: now() });
  }
  const inBundle = (b, a) => b.wallets.has(a) || (a !== b.issuer && bundleOf(a, b.creator, b.issuer));
  // validated: learn the bundle (wallets the dev sent the token to), see its holdings, catch its sells
  function bundleTx(tx, meta) {
    if (!bundles.size) return;
    const addsLiquidity = /^AMM(Create|Deposit|Vote|Bid)$/.test(tx.TransactionType); // tokens into the pool ≠ a sale
    for (const n of meta?.AffectedNodes || []) {
      const m = n.ModifiedNode || n.CreatedNode;
      const f = m?.FinalFields || m?.NewFields;
      if (m?.LedgerEntryType !== 'RippleState' || !f?.Balance) continue;
      for (const b of bundles.values()) {
        if (f.Balance.currency !== b.currency) continue;
        const hi = f.HighLimit?.issuer, lo = f.LowLimit?.issuer;
        if (hi !== b.issuer && lo !== b.issuer) continue;
        const holder = hi === b.issuer ? lo : hi;
        const after = Math.abs(Number(f.Balance.value));
        const before = n.CreatedNode ? 0 : Math.abs(Number(m.PreviousFields?.Balance?.value ?? f.Balance.value));
        // the dev / a bundle wallet sent tokens to someone (not a pool): that one is part of the bundle
        if (after > before && holder !== tx.Account && (inBundle(b, tx.Account) || tx.Account === b.issuer) && tx.Destination === holder) b.wallets.add(holder);
        if (inBundle(b, holder)) {
          b.wallets.add(holder);
          b.hold.set(holder, after);
          const toBundle = tx.Destination && tx.Destination !== tx.Account && inBundle(b, tx.Destination);
          if (!addsLiquidity && holder === tx.Account && before > 0 && after < before && !toBundle && (before - after) / before * 100 >= cfg.bundleSellPct) {
            bundleSelling(b, holder, `${Math.round((before - after) / before * 100)}% of its tokens`);
          }
        }
      }
    }
  }
  // open ledger: a bundle wallet sends a sell → out before it lands
  function bundleProposed(tx) {
    if (!bundles.size || !cfg.bundleExit) return;
    for (const b of bundles.values()) {
      if (!inBundle(b, tx.Account)) continue;
      const tok = (v) => v && typeof v === 'object' && v.currency === b.currency && v.issuer === b.issuer;
      const sells = (tx.TransactionType === 'Payment' && tok(tx.SendMax) && (typeof tx.Amount === 'string' || tx.Destination === tx.Account))
        || (tx.TransactionType === 'OfferCreate' && tok(tx.TakerGets) && typeof tx.TakerPays === 'string');
      if (!sells) continue;
      const amt = Number((tx.SendMax || tx.TakerGets).value);
      const held = b.hold.get(tx.Account);
      if (held && amt / held * 100 < cfg.bundleSellPct) continue; // a small sale
      bundleSelling(b, tx.Account, held ? `${Math.round(amt / held * 100)}% of its tokens, open ledger` : 'open ledger');
    }
  }
  function bundleSelling(b, who, what) {
    const why = `${who === b.creator ? 'the dev' : `bundle wallet ${who.slice(0, 8)}…`} sells ${what}`;
    stat('bundleSells');
    rec.event('bundle_sell', { k: b.k, name: b.name, wallet: who, what, wallets: b.wallets.size });
    const l = pending.get(b.k);
    if (l) l.bundleSold = why;
    const pos = S.positions[b.k];
    if (!pos || pos.bundleExit) return;
    pos.bundleExit = now();
    say(`🚨 ${pos.name}: ${why} – selling everything now`);
    locked(() => (S.positions[b.k] ? sell(pos, 1, `bundle is selling (${why})`) : null)).catch((e) => say(`⚠️ ${pos.name}: bundle exit failed – ${e.message}`));
  }

  async function checks(l) {
    const reasons = [];
    let small = '';
    let supplyPct = null;
    let supply = null;
    const t0 = now();
    // a launch seen in the open ledger isn't validated yet: check it on the open ledger
    const li = l.fast && !l.validated ? 'current' : 'validated';
    // everything at once – a big launch must be bought within seconds
    const [infoR, p, gb, funder] = await Promise.all([
      req('account_info', { account: l.issuer, ledger_index: li }),
      pool(l.currency, l.issuer, li),
      cfg.minPoolSupplyPct > 0 ? req('gateway_balances', { account: l.issuer, ledger_index: li }).catch(() => null) : null,
      cfg.skipRuggers && l.creator && l.funder === undefined ? funderOf(l.creator) : l.funder,
    ]);
    const info = infoR.account_data;
    if (l.funder === undefined && funder !== undefined) { l.funder = funder; rec.setFunder?.(l.k, funder); }
    const flags = info.Flags || 0;
    const blackholed = (flags & F.disableMaster) && (!info.RegularKey || BLACKHOLES.has(info.RegularKey));
    // Launch protections (anti-snipe phases) – freeze, transfer fee, authorized trust lines – can
    // still be lifted while the issuer is not blackholed, so they are waited for like the
    // blackhole. Once blackholed nothing can change any more and they are final.
    const wait = [];
    const soft = (text) => (blackholed ? reasons : wait).push(text);
    if (flags & F.clawback) reasons.push('clawback enabled'); // can never be turned off
    if (flags & F.globalFreeze) soft('issuer froze the token');
    if (flags & F.requireAuth) soft('trust lines need the issuer\'s approval');
    const fee = info.TransferRate ? (info.TransferRate / 1e9 - 1) * 100 : 0;
    if (fee > cfg.maxTransferFee + 1e-9) soft(`transfer fee ${fee.toFixed(2)}%`);
    if (!p) reasons.push('pool gone');
    else {
      if (p.xrp < (l.minPool ?? cfg.minPoolXrp)) small = `pool only ${p.xrp.toFixed(1)} XRP`;
      if (cfg.maxPoolXrp && p.xrp > cfg.maxPoolXrp) reasons.push(`pool ${p.xrp.toFixed(0)} XRP > max`);
      if (p.fee > cfg.maxAmmFee) reasons.push(`AMM fee ${p.fee}%`);
      if (gb) {
        supply = Number(gb.obligations?.[l.currency] || 0);
        const pct = supply > 0 ? (p.tok / supply) * 100 : 100;
        supplyPct = +pct.toFixed(1);
        if (pct < cfg.minPoolSupplyPct) reasons.push(`only ${pct.toFixed(0)}% of supply in the pool`);
      }
      l.big = p.xrp >= cfg.bigLaunchXrp;
    }
    const domain = info.Domain ? Buffer.from(info.Domain, 'hex').toString('utf8').slice(0, 80) : '';
    // socials: X / Telegram / … from the issuer's xrp-ledger.toml. They only hold up a buy if
    // SOCIALS_REQUIRED says so – otherwise they are read in the background and shown.
    if (cfg.socials !== 'off') {
      l.socials = domain ? await socials.get(domain) : { found: false };
      if (l.socials && !hasSocials(l.socials, cfg.socials)) reasons.push(`no socials (${cfg.socials === 'x' ? 'no X/Twitter' : 'none'}${l.socials.found ? '' : ', no token file'})`);
    } else if (!l.socialsAsked) {
      l.socialsAsked = true;
      (domain ? socials.get(domain) : Promise.resolve({ found: false })).then((so) => {
        l.socials = so;
        const pos = S.positions[l.k];
        if (pos && so) pos.socials = { x: so.x, telegram: so.telegram, website: so.website, discord: so.discord };
        rec.addChecks?.(l.k, { socials: socialsText(so), x: so?.x || '', telegram: so?.telegram || '', website: so?.website || '' });
      }).catch(() => {});
    }
    // the creator, the wallet that funded it, or the issuer rugged before?
    if (cfg.skipRuggers && l.creator) {
      const hit = [l.creator, l.funder, l.issuer].map((a) => ({ a, d: rec.devInfo?.(a) })).find((x) => x.d?.rugs > 0);
      if (hit) reasons.push(`dev rugged before (${hit.d.rugs}× – ${hit.a === l.creator ? 'this creator' : hit.a === l.funder ? 'funded by a rugger' : 'this issuer'}: ${hit.d.names.slice(0, 3).join(' ')})`);
    }
    if (l.bundleSold) reasons.push(`bundle is selling (${l.bundleSold})`);
    rec.checks(l.k, {
      blackholed: !!blackholed, clawback: !!(flags & F.clawback), frozen: !!(flags & F.globalFreeze), requireAuth: !!(flags & F.requireAuth),
      transferFee: +fee.toFixed(3), ammFee: p?.fee ?? null, poolAtCheck: p ? +p.xrp.toFixed(2) : null, supplyPct,
      domain, socials: socialsText(l.socials), x: l.socials?.x || '', telegram: l.socials?.telegram || '', website: l.socials?.website || '',
      funder: l.funder || '', checkedAfterS: Math.round((now() - l.at) / 1000), checkMs: now() - t0,
    });
    if (supply > 0) l.supply = supply;
    if (p) { l.lastPool = p; l.lastPoolAt = now(); }
    return { blackholed: !!blackholed, reasons, wait, small, pool: p, supply };
  }

  // Hard problems skip at once; a missing blackhole or a pool below the minimum is waited for.
  async function evaluate(l) {
    let told = false;
    for (;;) {
      if (stopped) return;
      const c = await checks(l);
      const hole = c.blackholed || !cfg.requireBlackhole;
      // a launch protection phase (frozen / approval-only / fee while not blackholed) gets the
      // longer PROTECT_WAIT_MIN – the bot buys the moment it is lifted
      if (c.wait.length && !l.protected) {
        l.protected = now();
        rec.event('protection', { k: l.k, name: l.name, what: c.wait });
      }
      if (l.protected && !c.wait.length && !l.liftedAt) {
        l.liftedAt = now();
        rec.event('protection_lifted', { k: l.k, name: l.name, afterS: Math.round((now() - l.at) / 1000) });
        say(`🔓 ${l.name}: launch protection lifted after ${Math.round((now() - l.at) / 1000)}s`);
      }
      const holeBy = l.at + (l.protected ? Math.max(cfg.blackholeWaitS, cfg.protectWaitMin * 60) : cfg.blackholeWaitS) * 1000;
      const poolBy = Math.max(l.at + (l.poolWait ?? cfg.poolWaitMin) * 60000, l.protected ? holeBy : 0);
      // waitable: the rest of the supply (FirstLedger deposit) and socials that may come a little later
      const waitS = (x) => (/of supply in the pool/.test(x) ? cfg.supplyWaitS : /no socials/.test(x) ? cfg.socialsWaitS : -1);
      const softOnly = c.reasons.length && c.reasons.every((x) => waitS(x) >= 0 && now() - l.at < waitS(x) * 1000);
      if (softOnly) {
        const sup = c.reasons.find((x) => /of supply/.test(x));
        if (sup) { l.supplyWait = true; if (!l.supplyTold) { l.supplyTold = true; say(`⏳ ${l.name}: ${sup} – waiting up to ${cfg.supplyWaitS}s for the rest to be deposited (FirstLedger launch)`); } }
        const soc = c.reasons.find((x) => /no socials/.test(x));
        if (soc && !l.socialsTold) { l.socialsTold = true; say(`⏳ ${l.name}: ${soc} – checking again for ${cfg.socialsWaitS}s`); }
      } else if (c.reasons.length) {
        pending.delete(l.k);
        stat(0, skipKind(c.reasons[0]));
        rec.decision(l.k, 'skipped', skipKind(c.reasons[0]));
        return say(`⛔ Skip ${l.name}: ${c.reasons.join(', ')}`);
      }
      if (c.wait.length && now() > holeBy) {
        pending.delete(l.k);
        stat(0, skipKind(c.wait[0]));
        rec.decision(l.k, 'skipped', skipKind(c.wait[0]));
        return say(`⛔ Skip ${l.name}: still ${c.wait.join(', ')} after ${Math.round((holeBy - l.at) / 1000)}s`);
      }
      // a buy that bounced off a protection without visible flags waits for the issuer to act
      const stillBlocked = l.blocked && !l.issuerMoved && !c.wait.length;
      if (stillBlocked && now() > holeBy) {
        pending.delete(l.k);
        stat(0, 'blocked at launch');
        rec.decision(l.k, 'skipped', 'blocked at launch');
        return say(`⛔ Skip ${l.name}: buy was blocked (${l.blocked}) and nothing changed for ${Math.round((holeBy - l.at) / 60000)} min`);
      }
      if (l.supplyWait && !c.reasons.length && c.pool && !l.supplyOk) {
        l.supplyOk = true;
        l.poolXrp = c.pool.xrp; l.poolTok = c.pool.tok; // the real launch price is after the deposit
        stat('supplyDeposited');
        rec.event('supply_deposited', { k: l.k, name: l.name, afterS: Math.round((now() - l.at) / 1000), poolXrp: c.pool.xrp, poolTok: c.pool.tok });
        say(`📥 ${l.name}: the rest of the supply is in the pool now (after ${Math.round((now() - l.at) / 1000)}s)`);
      }
      if (hole && !c.small && !c.wait.length && !c.reasons.length && !stillBlocked) {
        pending.delete(l.k);
        // bought late after a protection: the early buyers may have pumped it already
        const x0 = l.poolXrp && l.poolTok ? l.poolXrp / l.poolTok : null;
        const xNow = c.pool && x0 ? c.pool.xrp / c.pool.tok / x0 : null;
        if (l.protected && cfg.protectMaxX > 0 && xNow && xNow > cfg.protectMaxX) {
          stat(0, 'pumped during protection');
          rec.decision(l.k, 'skipped', 'pumped during protection');
          return say(`⛔ Skip ${l.name}: already ${xNow.toFixed(1)}× the launch price when the protection ended (max ${cfg.protectMaxX}×)`);
        }
        return buy(l, c.pool);
      }
      if (!hole && now() > holeBy) {
        pending.delete(l.k);
        stat(0, 'not blackholed');
        rec.decision(l.k, 'skipped', 'not blackholed');
        return say(`⛔ Skip ${l.name}: issuer not blackholed after ${Math.round((holeBy - l.at) / 1000)}s (can mint more)`);
      }
      if (c.small && now() >= poolBy) {
        pending.delete(l.k);
        stat(0, 'pool too small');
        rec.decision(l.k, 'skipped', 'pool too small');
        return say(`⛔ Skip ${l.name}: ${c.small} (min ${l.minPool ?? cfg.minPoolXrp})`);
      }
      if (c.wait.length && !told) { told = true; say(`⏳ ${l.name}: ${c.wait.join(', ')} – launch protection? Waiting up to ${Math.round((holeBy - l.at) / 60000)} min, buying the moment it is lifted`); }
      if (c.small && !told) { told = true; say(`⏳ ${l.name}: ${c.small} – watching for ${l.poolWait ?? cfg.poolWaitMin} min`); }
      // sleep until the next poll – or until the issuer sends a transaction (unfreeze, blackhole, …)
      const ms = (l.supplyWait && !l.supplyOk) || l.socialsTold ? 2000 : now() - l.at < 120000 ? 4000 : 15000;
      await new Promise((r) => {
        const t = setTimeout(done, ms);
        function done(fromIssuer) {
          if (fromIssuer === true) l.issuerMoved = now();
          clearTimeout(t); waiters.get(l.issuer)?.delete(done); waiters.get(l.k)?.delete(done); r();
        }
        for (const w of [l.issuer, l.k]) { if (!waiters.has(w)) waiters.set(w, new Set()); waiters.get(w).add(done); }
      });
    }
  }

  // ---------- buy ----------
  // Buys run one after another so limits and the balance floor see the previous buy.
  let buyChain = Promise.resolve();
  function buy(l, p) {
    if (l.big) { stat('bigLaunchBuys'); return buyNow(l, p); } // big launch: no waiting behind other buys
    const run = buyChain.then(() => buyNow(l, p));
    buyChain = run.catch(() => {});
    return run;
  }

  async function buyNow(l, p) {
    if (cfg.pauseBuys && !l.byHand) return stat(0, 'paused'), rec.decision(l.k, 'skipped', 'paused'), say(`⏸ ${l.name}: buying is paused`);
    if (S.day !== day()) { S.day = day(); S.buysToday = 0; }
    const open = Object.values(S.positions).filter((x) => !isMoonbag(x)).length; // moonbags don't count
    if (open >= cfg.maxOpen && !l.byHand) return stat(0, 'max open trades'), rec.decision(l.k, 'skipped', 'max open trades'), say(`⏸ ${l.name}: ${open} positions open (max ${cfg.maxOpen})`);
    let stake = l.buyXrp ?? (l.big ? cfg.bigBuyXrp : cfg.buyXrp);
    if (S.buysToday >= cfg.maxBuysPerDay && !l.byHand) return stat(0, 'daily buy limit'), rec.decision(l.k, 'skipped', 'daily buy limit'), say(`⏸ ${l.name}: daily buy limit reached`);
    // fresh price (the queue may have waited) and the free balance – both at once; a pool read
    // less than 1.5 s ago by the checks is fresh enough
    const freshPool = l.lastPool && now() - l.lastPoolAt < 1500 && p === l.lastPool;
    const [pNow, freeNow] = await Promise.all([
      freshPool ? p : pool(l.currency, l.issuer, l.fast && !l.validated ? 'current' : 'validated'),
      spendable(),
    ]);
    p = pNow || p;
    if (!p) return stat(0, 'pool gone'), rec.decision(l.k, 'skipped', 'pool gone'), say(`⛔ ${l.name}: pool gone`);
    // size by share of the supply: XRP needed for BUY_SUPPLY_PCT % of all tokens, capped at BUY_MAX_XRP
    if (cfg.buySupplyPct > 0 && !l.copy && !l.byHand && l.supply > 0) {
      const want = (l.supply * cfg.buySupplyPct) / 100;
      const need = want < p.tok * 0.95 ? (p.xrp * want) / (p.tok - want) / (1 - p.fee / 100) : Infinity;
      stake = Math.max(0.1, Math.min(need * 1.01, cfg.buyMaxXrp));
      l.sizing = need <= cfg.buyMaxXrp ? `${cfg.buySupplyPct}% of the supply` : `capped at ${cfg.buyMaxXrp} XRP (${cfg.buySupplyPct}% would cost ${need === Infinity ? 'more than the pool' : need.toFixed(1) + ' XRP'})`;
    }
    const free = freeNow;
    if (free - reserves.inc - stake < cfg.minBalanceXrp) {
      stat(0, 'balance floor');
      rec.decision(l.k, 'skipped', 'balance floor');
      return say(`⏸ ${l.name}: only ${free.toFixed(2)} XRP free – keeping ${cfg.minBalanceXrp} XRP floor`);
    }
    const expect = swapOut(stake, p.xrp, p.tok, p.fee);
    const min = expect * (1 - cfg.buySlippage / 100);
    S.buysToday++;
    if (cfg.dryRun) {
      S.positions[l.k] = position(l, stake, expect, p);
      save();
      rec.decision(l.k, 'bought', 'dry run');
      rec.trade(l.k, { dry: true, cost: stake, tokens: expect, entryPoolXrp: +p.xrp.toFixed(2), delayS: Math.round((now() - l.at) / 1000) });
      return say(`🧪 DRY buy ${l.name}: ${stake} XRP → ${expect.toPrecision(6)}`);
    }
    // One transaction: an immediate-or-cancel sell offer of exactly `stake` XRP for at least `min`
    // tokens. It crosses the AMM/order book in one go and creates the trust line by itself.
    const r = await submit({
      TransactionType: 'OfferCreate', Account: me, Flags: TF_IOC | TF_SELL,
      TakerGets: toDrops(stake),
      TakerPays: { currency: l.currency, issuer: l.issuer, value: iouValue(min) },
    }, !!l.fast);
    const fx = okResult(r) ? txEffects(r.meta, me, l.currency, l.issuer) : { tokDelta: 0, xrpDelta: 0 };
    const got = fx.tokDelta;
    if (!(got > 0)) {
      const code = r?.meta?.TransactionResult || 'no fill';
      // bought from the open ledger but landed before the pool existed: once more after the launch is validated
      if (l.fast && !l.fastRetried) {
        l.fastRetried = true;
        S.buysToday = Math.max(0, S.buysToday - 1);
        stat('fastRetry');
        if (!l.validated) await new Promise((res) => { const t = setTimeout(res, 15000); launchValidated.set(l.k, [...(launchValidated.get(l.k) || []), () => { clearTimeout(t); res(); }]); });
        l.validated = true;
        return buyNow(l, null);
      }
      // Did it bounce off a launch protection? Then don't give up: watch the token and buy once
      // the protection is lifted (one retry per token). A plain price move is not retried.
      if (!l.retried && !cfg.dryRun) {
        let blocked = PROTECT_CODES.test(code);
        if (!blocked) { try { blocked = (await checks(l)).wait.length > 0; } catch {} }
        if (blocked) {
          l.retried = true;
          l.blocked = code;
          l.protected ||= now();
          S.buysToday = Math.max(0, S.buysToday - 1);
          stat('buyBlocked');
          rec.event('buy_blocked', { k: l.k, name: l.name, result: code, delayS: (now() - l.at) / 1000 });
          await dropTrustLine(l.currency, l.issuer).catch(() => {});
          say(`🛡️ ${l.name}: buy blocked by a launch protection (${code}) – buying as soon as it is lifted`);
          pending.set(l.k, l);
          evaluate(l).catch((e) => { pending.delete(l.k); say(`⚠️ ${l.name}: check failed – ${e.message}`); });
          return;
        }
      }
      stat('buyFailed');
      rec.decision(l.k, 'buy failed', code);
      rec.event('buy_failed', { k: l.k, result: r?.meta?.TransactionResult || 'no fill', expected: expect, minTokens: min, poolXrp: p.xrp, slippage: cfg.buySlippage, delayS: (now() - l.at) / 1000 });
      await dropTrustLine(l.currency, l.issuer).catch(() => {});
      return say(`❌ Buy ${l.name} failed (${r?.meta?.TransactionResult || 'no fill'}) – price moved more than ${cfg.buySlippage}%`);
    }
    stat('bought');
    const cost = Math.max(0, -fx.xrpDelta) || stake;
    S.positions[l.k] = position(l, cost, got, p);
    save();
    const buyInfo = {
      fast: !!l.fast, big: !!l.big, sizing: l.sizing || '', supplyPct: l.supply ? +((got / l.supply) * 100).toFixed(3) : null,
      cost: +cost.toFixed(6), tokens: got, expected: expect, slipPct: +((1 - got / expect) * 100).toFixed(2),
      entryPoolXrp: +p.xrp.toFixed(2), entryPrice: cost / got, delayS: +((now() - l.at) / 1000).toFixed(1),
      ledger: r.ledger_index || null, hash: r.hash || r.tx_json?.hash || '',
    };
    rec.decision(l.k, 'bought', l.crowd ? `crowd entry: ${l.crowd}` : l.retried ? 'after launch protection' : '');
    rec.trade(l.k, buyInfo);
    rec.event('buy', { k: l.k, name: l.name, copy: l.copy || '', ...buyInfo });
    say(`🟢 Bought ${l.name}${l.byHand ? ' (by hand)' : ''}${l.crowd ? ` (crowd entry – ${l.crowd})` : l.copy ? ` (copy ${l.copy})` : ''}: ${cost.toFixed(4)} XRP → ${got.toPrecision(6)} tokens${buyInfo.supplyPct != null ? ` = ${buyInfo.supplyPct}% of the supply` : ''}${l.fast ? ' ⚡' : ''} after ${buyInfo.delayS}s`);
  }

  function position(l, cost, amount, p) {
    return {
      k: l.k, currency: l.currency, issuer: l.issuer, name: l.name, cost, amount, sold: 0, proceeds: 0,
      entryPoolXrp: p.xrp, peak: cost, value: cost, tp1Done: false, at: now(), fails: 0, copy: l.copy || '',
      startPoolXrp: l.copy ? null : l.poolXrp, launchedAt: l.at, // pool size at launch (unknown for copies)
      supply: l.supply || null, byHand: !!l.byHand,
      socials: l.socials ? { x: l.socials.x, telegram: l.socials.telegram, website: l.socials.website, discord: l.socials.discord } : null,
    };
  }

  // ---------- sell ----------
  // part = share of the bag; opt.tokens = exact amount; opt.minXrp = never accept less than this
  async function sell(pos, part, why, opt = {}) {
    const p = await pool(pos.currency, pos.issuer);
    if (!p) return close(pos, 'pool deleted – tokens worthless');
    let amount = opt.tokens ?? pos.amount * part;
    let exact = null; // the ledger's own balance string, so a full sale leaves no dust
    if (!cfg.dryRun && part >= 0.999) {
      // sell the exact balance so the trust line can be removed afterwards
      const lines = await req('account_lines', { account: me, peer: pos.issuer, ledger_index: 'validated' });
      const line = lines.lines?.find((x) => x.currency === pos.currency);
      amount = Number(line?.balance || 0);
      if (!(amount > 0)) return close(pos, why);
      exact = line.balance;
    }
    const expect = swapOut(amount, p.tok, p.xrp, p.fee);
    const slip = Math.min(90, cfg.sellSlippage + pos.fails * 15); // widen on repeated misses
    const min = opt.minXrp ?? expect * (1 - slip / 100);
    if (cfg.dryRun) return booked(pos, amount, expect, why, part);
    const r = await submit({
      TransactionType: 'Payment', Account: me, Destination: me, Flags: TF_PARTIAL,
      Amount: toDrops(expect * 1.5),
      SendMax: { currency: pos.currency, issuer: pos.issuer, value: exact || iouValue(amount, true) },
      DeliverMin: toDrops(min),
    }, true);
    if (!okResult(r)) {
      if (opt.minXrp) return say(`⚠️ ${pos.name}: price moved, stake not back yet – trying again`);
      pos.fails++;
      save();
      return say(`⚠️ Sell ${pos.name} failed (${r?.meta?.TransactionResult}), retrying with ${Math.min(90, slip + 15)}% slippage`);
    }
    const fx = txEffects(r.meta, me, pos.currency, pos.issuer);
    const got = xrp(r.meta.delivered_amount ?? 0) || Math.max(0, fx.xrpDelta);
    return booked(pos, Math.abs(fx.tokDelta) || amount, got, why, part);
  }

  async function booked(pos, amount, got, why, part) {
    rec.event('sell', { k: pos.k, name: pos.name, tokens: amount, xrp: got, why, share: +(amount / pos.amount).toFixed(4), gainPct: +((pos.value / pos.cost - 1) * 100).toFixed(1), mcap: pos.mcap ?? null });
    pos.fails = 0;
    pos.amount = Math.max(0, pos.amount - amount);
    pos.sold += amount;
    pos.proceeds += got;
    if (part >= 0.999 || pos.amount <= 0) return close(pos, why);
    pos.tp1Done = true; // the only partial sale is the first take profit
    save();
    const pct = Math.round((amount / (amount + pos.amount)) * 100);
    say(`🟡 Sold ${pct}% ${pos.name} for ${got.toFixed(4)} XRP (${why})${pos.proceeds >= pos.cost ? ` – stake back, ${100 - pct}% rides free 🌙` : ''}`);
  }

  async function close(pos, why) {
    delete S.positions[pos.k];
    const pnl = pos.proceeds - pos.cost;
    S.realized += pnl;
    S.history.unshift({ name: pos.name, k: pos.k, cost: pos.cost, proceeds: pos.proceeds, pnl, why, at: pos.at, closed: now() });
    S.history = S.history.slice(0, 500);
    save();
    rec.trade(pos.k, { proceeds: +pos.proceeds.toFixed(6), pnl: +pnl.toFixed(6), closeWhy: why, heldMin: Math.round((now() - pos.at) / 60000), peak: +pos.peak.toFixed(6), runner: !!pos.runner });
    rec.event('close', { k: pos.k, name: pos.name, cost: pos.cost, proceeds: pos.proceeds, pnl, why });
    say(`${pnl >= 0 ? '✅' : '🔴'} Closed ${pos.name}: ${pos.cost.toFixed(3)} → ${pos.proceeds.toFixed(3)} XRP (${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)}) – ${why}. Total ${S.realized >= 0 ? '+' : ''}${S.realized.toFixed(3)} XRP`);
    if (cfg.dryRun) return;
    // a dead pool leaves worthless tokens on the line: give them back to the issuer so the line can go
    if (/pool deleted|dead/.test(why) && cfg.cleanup) await clearLine(pos.currency, pos.issuer, pos.name, why).catch((e) => say(`⚠️ ${pos.name}: line not cleared – ${e.message}`));
    else await dropTrustLine(pos.currency, pos.issuer).catch(() => {});
  }

  // Send what's left of a token back to its issuer (that burns it) and delete the trust line.
  async function clearLine(currency, issuer, name, why) {
    const lines = await req('account_lines', { account: me, peer: issuer, ledger_index: 'validated' });
    const line = lines.lines?.find((x) => x.currency === currency);
    if (!line) return false;
    if (Number(line.balance) < 0) return false; // we'd be the issuer side – never touch
    if (Number(line.balance) > 0) {
      const pay = { TransactionType: 'Payment', Account: me, Destination: issuer, Amount: { currency, issuer, value: line.balance } };
      let r = await submit(pay, true);
      if (r?.meta?.TransactionResult === 'tecDST_TAG_NEEDED') r = await submit({ ...pay, DestinationTag: 0 }, true);
      if (!okResult(r)) { say(`⚠️ ${name}: couldn't send the tokens back to the issuer (${r?.meta?.TransactionResult}) – line stays`); return false; }
      rec.event('burned', { k: key(currency, issuer), name, tokens: line.balance, why });
    }
    const t = await submit({ TransactionType: 'TrustSet', Account: me, Flags: TF_SET_NO_RIPPLE, LimitAmount: { currency, issuer, value: '0' } }, true);
    if (!okResult(t)) return false;
    stat('linesCleared');
    S.stats.reserveFreed = +((S.stats.reserveFreed || 0) + reserves.inc).toFixed(2);
    save();
    say(`🧹 ${name}: ${Number(line.balance) > 0 ? 'worthless tokens sent back to the issuer, ' : ''}trust line deleted – ${reserves.inc} XRP reserve free (${why})`);
    return true;
  }

  // Every 30 min: lines that belong to no open trade – empty ones are deleted, dust (worth less than
  // DUST_XRP) is sold if it still fetches something and the rest goes back to the issuer.
  // Tokens worth more than that are never touched (they may be yours).
  let sweeping = false;
  async function cleanupSweep() {
    if (!cfg.cleanup || cfg.dryRun || sweeping || stopped) return 'off';
    sweeping = true;
    let n = 0;
    try {
      let marker;
      const all = [];
      do {
        const r = await req('account_lines', { account: me, ledger_index: 'validated', limit: 400, ...(marker ? { marker } : {}) });
        all.push(...(r.lines || []));
        marker = r.marker;
      } while (marker);
      for (const line of all) {
        const k = key(line.currency, line.account);
        if (S.positions[k] || pending.has(k) || Number(line.balance) < 0) continue;
        const name = currencyName(line.currency);
        const bal = Number(line.balance);
        if (bal === 0) { if (await clearLine(line.currency, line.account, name, 'empty line')) n++; continue; }
        const p = await pool(line.currency, line.account).catch(() => undefined);
        if (p === undefined) continue; // couldn't ask – next time
        const worth = p ? swapOut(bal, p.tok, p.xrp, p.fee) : 0;
        if (worth >= cfg.dustXrp) continue;
        if (p && worth >= 0.001) {
          // still fetches a little: sell it first
          await submit({ TransactionType: 'Payment', Account: me, Destination: me, Flags: TF_PARTIAL, Amount: toDrops(worth * 1.5), SendMax: { currency: line.currency, issuer: line.account, value: line.balance }, DeliverMin: toDrops(worth * 0.5) }, true).catch(() => {});
        }
        if (await clearLine(line.currency, line.account, name, p ? `dust worth ${worth.toFixed(4)} XRP` : 'pool gone')) n++;
      }
    } finally { sweeping = false; }
    return n;
  }

  // Frees the 0.2 XRP reserve of a trust line once its balance is zero.
  async function dropTrustLine(currency, issuer) {
    const lines = await req('account_lines', { account: me, peer: issuer, ledger_index: 'validated' });
    const line = lines.lines?.find((x) => x.currency === currency);
    if (!line || Number(line.balance) !== 0) return;
    await submit({ TransactionType: 'TrustSet', Account: me, Flags: TF_SET_NO_RIPPLE, LimitAmount: { currency, issuer, value: '0' } }, true);
  }

  // ---------- watching open positions ----------
  // Position checks and your answers take turns, so a click and a rule can't both sell.
  let lockChain = Promise.resolve();
  function locked(fn) {
    const r = lockChain.then(fn);
    lockChain = r.catch(() => {});
    return r;
  }

  // ---------- crowd entry ----------
  const CROWD_REASONS = new Set(['dev holds the supply', 'pool too small', 'not blackholed']);
  async function crowdScan() {
    if (!cfg.crowd || stopped) return;
    S.crowded ||= {};
    for (const r of rec.live ? rec.live() : []) {
      if (r.kind !== 'launch' || r.dead || !r.last || S.crowded[r.k] || S.positions[r.k] || pending.has(r.k)) continue;
      if (r.decision?.result !== 'skipped' || !CROWD_REASONS.has(r.decision.reason)) continue;
      if (r.decision.reason === 'not blackholed' && cfg.crowdRequireBlackhole) continue;
      if (now() - r.at > cfg.crowdWindowMin * 60000) continue;
      if (r.buyers < cfg.crowdMinBuyers || r.last.xrp < cfg.crowdMinPoolXrp) continue;
      S.crowded[r.k] = now();
      const why = `${r.buyers} buyers, pool ${r.last.xrp.toFixed(0)} XRP after ${Math.round((now() - r.at) / 60000)} min`;
      stat('crowdSignals');
      rec.event('crowd_signal', { k: r.k, name: r.name, buyers: r.buyers, poolXrp: r.last.xrp, ageMin: +((now() - r.at) / 60000).toFixed(1) });
      say(`👥 ${r.name}: ${why} – checking for a crowd entry`);
      const l = { k: r.k, currency: r.currency, issuer: r.issuer, name: r.name, at: r.at, poolXrp: r.start?.xrp, poolTok: r.start?.tok, copy: 'crowd', crowd: why, buyXrp: cfg.crowdBuyXrp, creator: r.creator };
      try {
        const c = await checks(l);
        // the reasons it was skipped for are what the crowd answers; anything else still counts
        const hard = c.reasons.filter((x) => !/supply|pool only/.test(x));  // socials, rug history, bundle selling still count
        if (!c.pool) hard.push('pool gone');
        if (c.wait.length) hard.push(...c.wait);
        if (cfg.crowdRequireBlackhole && !c.blackholed) hard.push('not blackholed');
        if (hard.length) { rec.event('crowd_skip', { k: r.k, why: hard.join(', ') }); say(`⛔ ${r.name}: no crowd entry – ${hard.join(', ')}`); continue; }
        await buy(l, c.pool);
      } catch (e) { say(`⚠️ ${r.name}: crowd entry failed – ${e.message}`); }
    }
  }

  async function tick() {
    if (ticking || stopped) return;
    ticking = true;
    crowdScan().catch(() => {});
    chart.evaluate(async (c, i) => { const q = await pool(c, i); return q ? q.xrp / q.tok : 0; })
      .then((res) => { for (const r of res) rec.event('chart_judged', r); })
      .catch(() => {});
    try {
      await locked(async () => {
        for (const pos of Object.values(S.positions)) {
          try { await watch(pos); } catch (e) { say(`⚠️ ${pos.name}: ${e.message}`); }
        }
      });
    } finally { ticking = false; }
  }

  async function watch(pos) {
    const p = await pool(pos.currency, pos.issuer);
    if (!p) return close(pos, 'pool deleted – tokens worthless');
    pos.value = swapOut(pos.amount, p.tok, p.xrp, p.fee) + pos.proceeds; // what the trade is worth now
    pos.peak = Math.max(pos.peak, pos.value);
    pos.mcap = await marketCap(pos, p);
    runnerCheck(pos, p);
    // the position's own chart: price + liquidity every tick, trading from the stream
    const price = p.xrp / p.tok;
    pos.hist ||= [];
    pos.hist.push({ at: now(), xrp: +p.xrp.toFixed(3), price, flow: rec.flowOf?.(pos.k) || null });
    while (pos.hist.length > 200 || (pos.hist.length && now() - pos.hist[0].at > 30 * 60e3)) pos.hist.shift();
    const h = chartHealth(pos.hist, now());
    pos.health = h ? h.score : null;
    pos.healthParts = h ? h.parts : null;
    const d = decide(pos, p);
    if (!d) { if (cfg.chartAdd && !pos.manual && !pos.ask) await maybeAdd(pos, p, price); return; }
    if (d.rug) { delete pos.ask; delete pos.holding; return sell(pos, d.part, d.why, d.opt); } // never wait on a rug
    if (!pos.manual && !pos.ask && holdForChart(pos, d, price)) return;
    delete pos.holding;
    if (pos.manual || pos.ask) return; // you decide for this one
    if (needsOk(pos) && !(d.first && cfg.autoFirstSale)) { stat('asks'); return ask(pos, d); }
    return sell(pos, d.part, d.why, d.opt);
  }

  // ---------- chart: hold / buy more ----------
  // A sale the rules want is postponed while the chart is healthy – except a rug, a loss beyond
  // HARD_STOP, or a value that already fell to half of its peak.
  function holdForChart(pos, d, price) {
    if (!cfg.chartSmart || pos.health == null || pos.health < chart.th('hold')) return false;
    const gain = (pos.value / pos.cost - 1) * 100;
    if (gain <= -cfg.hardStop) return false;
    if (pos.value < pos.peak * 0.5) return false;
    if (!pos.holding || pos.holding.why !== d.why) {
      pos.holding = { why: d.why, at: now(), score: pos.health };
      chart.note('hold', pos, price, pos.health);
      stat('chartHolds');
      rec.event('chart_hold', { k: pos.k, name: pos.name, why: d.why, score: pos.health, parts: pos.healthParts, gainPct: +gain.toFixed(1) });
      say(`📈 ${pos.name}: chart healthy (${pos.health}/100) – not selling yet (${d.why})`);
    }
    return true;
  }
  // Buy more once while the chart is very healthy and the trade is between −40 % and +200 %.
  async function maybeAdd(pos, p, price) {
    if (!cfg.chartSmart || cfg.pauseBuys || pos.tp1Done || (pos.adds || 0) >= cfg.chartMaxAdds) return;
    if (pos.health == null || pos.health < chart.th('add') || now() - pos.at < 3 * 60e3) return;
    const gain = (pos.value / pos.cost - 1) * 100;
    if (gain < -40 || gain > 200) return;
    const stake = cfg.chartAddXrp;
    const free = await spendable();
    if (free - stake < cfg.minBalanceXrp) return;
    pos.adds = (pos.adds || 0) + 1; // counted before the try: never twice
    const got = await addBuy(pos, stake, p);
    if (!got) return say(`❌ ${pos.name}: add-on buy didn't fill`);
    chart.note('add', pos, price, pos.health);
    stat('chartAdds');
    rec.event('chart_add', { k: pos.k, name: pos.name, cost: +got.cost.toFixed(6), tokens: got.tokens, score: pos.health, parts: pos.healthParts, gainPct: +gain.toFixed(1) });
    say(`➕ ${pos.name}: chart very healthy (${pos.health}/100) – bought more: ${got.cost.toFixed(3)} XRP`);
  }
  // buy more of an open position (add-on or by hand): one IOC offer, the position grows
  async function addBuy(pos, stake, p) {
    const expect = swapOut(stake, p.xrp, p.tok, p.fee);
    if (cfg.dryRun) { pos.cost += stake; pos.amount += expect; pos.peak += stake; pos.value += stake; save(); return { cost: stake, tokens: expect }; }
    const r = await submit({
      TransactionType: 'OfferCreate', Account: me, Flags: TF_IOC | TF_SELL,
      TakerGets: toDrops(stake), TakerPays: { currency: pos.currency, issuer: pos.issuer, value: iouValue(expect * (1 - cfg.buySlippage / 100)) },
    });
    const fx = okResult(r) ? txEffects(r.meta, me, pos.currency, pos.issuer) : { tokDelta: 0, xrpDelta: 0 };
    if (!(fx.tokDelta > 0)) return null;
    const cost = Math.max(0, -fx.xrpDelta) || stake;
    pos.cost += cost; pos.amount += fx.tokDelta; pos.peak += cost; pos.value += cost;
    pos.entryPoolXrp = Math.max(pos.entryPoolXrp, p.xrp); // rug alarm measured from the new entry
    save();
    return { cost, tokens: fx.tokDelta };
  }

  // What the rules want to do with a position right now: {part, why, opt?, rug?} or null.
  function decide(pos, p) {
    const gain = (pos.value / pos.cost - 1) * 100;
    const ageH = (now() - pos.at) / 3.6e6;
    const poolDrop = (1 - p.xrp / pos.entryPoolXrp) * 100;
    const all = (why, rug = false) => ({ part: 1, why, rug });

    if (pos.copy) {
      // copied buy: classic exit, the whole position is sold in the end
      const c = cfg.copyRules;
      if (c.rugDrop && poolDrop >= c.rugDrop) return all(`rug: pool XRP down ${Math.round(poolDrop)}%`, true);
      if (pos.manual) return null;
      if (!pos.tp1Done && gain >= c.tp1) return { part: c.tp1Part / 100, why: `take profit +${gain.toFixed(0)}%`, first: true };
      if (pos.tp1Done && c.trail && pos.value < pos.peak * (1 - c.trail / 100)) return all(`trailing stop (peak ${pos.peak.toFixed(3)} XRP)`);
      if (!pos.tp1Done && c.stopLoss && gain <= -c.stopLoss) return all(`stop loss ${gain.toFixed(0)}%`);
      if (c.maxHoldH && ageH >= c.maxHoldH) return all(`max hold ${c.maxHoldH}h`);
      return null;
    }
    if (pos.tp1Done) {
      // moonbag: rides for free. Only a dead pool is cleared (the trust line reserve is worth more).
      if (cfg.deadPoolDrop && poolDrop >= cfg.deadPoolDrop) return all(`moonbag dead: pool XRP down ${Math.round(poolDrop)}%`, true);
      if (pos.manual) return null;
      if (cfg.trail && pos.value < pos.peak * (1 - cfg.trail / 100)) return all(`trailing stop (peak ${pos.peak.toFixed(3)} XRP)`);
      return null;
    }
    if (cfg.rugDrop && poolDrop >= cfg.rugDrop) return all(`rug: pool XRP down ${Math.round(poolDrop)}%`, true);
    if (pos.manual) return null;
    if (gain >= cfg.tp1) {
      if (cfg.tp1Part !== 'auto') return { part: cfg.tp1Part / 100, why: `take profit +${gain.toFixed(0)}%`, first: true };
      return { ...stakeBack(pos, p, `stake back at +${gain.toFixed(0)}%`), first: true };
    }
    if (cfg.stopLoss && gain <= -cfg.stopLoss) return all(`stop loss ${gain.toFixed(0)}%`);
    if (cfg.maxHoldH && ageH >= cfg.maxHoldH) return all(`max hold ${cfg.maxHoldH}h, stake not back`);
    return null;
  }

  // Sell just enough to get the stake back; the rest becomes the moonbag.
  function stakeBack(pos, p, why) {
    const need = (pos.cost - pos.proceeds) * (1 + cfg.recoverBuffer / 100);
    const tokens = Math.min(pos.amount * 0.95, tokensFor(need, p));
    return { part: tokens / pos.amount, why, opt: { tokens, minXrp: Math.min(need, swapOut(tokens, p.tok, p.xrp, p.fee)) * 0.98 } };
  }

  // ---------- market cap + approval ----------
  let usd = { price: 0, at: 0 };
  const RLUSD = { currency: '524C555344000000000000000000000000000000', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' };
  async function xrpUsd() {
    if (now() - usd.at < 300000 && usd.price) return usd.price;
    try {
      const p = await pool(RLUSD.currency, RLUSD.issuer);
      if (p && p.xrp > 0) usd = { price: p.tok / p.xrp, at: now() };
    } catch {}
    return usd.price || cfg.xrpUsd;
  }

  // Market cap = all issued tokens × pool price, in XRP or USD. Supply is re-read every 10 min.
  async function marketCap(pos, p) {
    if (!cfg.mcapApproval) return 0;
    if (!pos.supply || now() - (pos.supplyAt || 0) > 600000) {
      try {
        const g = await req('gateway_balances', { account: pos.issuer, ledger_index: 'validated' });
        pos.supply = Number(g.obligations?.[pos.currency] || 0);
        pos.supplyAt = now();
      } catch {}
    }
    const mcapXrp = (pos.supply || 0) * (p.xrp / p.tok);
    if (cfg.mcapCurrency === 'XRP') return mcapXrp;
    const px = await xrpUsd();
    return px ? mcapXrp * px : NaN; // unknown → ask, to be safe
  }
  const needsOk = (pos) => pos.runner || (cfg.mcapApproval > 0 && !(pos.mcap < cfg.mcapApproval));

  // Big start + fast growth = possible runner. The mark stays for the life of the position.
  function runnerCheck(pos, p) {
    if (pos.runner || !cfg.runnerStartXrp || !(pos.startPoolXrp >= cfg.runnerStartXrp)) return;
    if (now() - (pos.launchedAt || pos.at) > cfg.runnerWindowMin * 60000) return;
    if (p.xrp < pos.startPoolXrp * (1 + cfg.runnerGrowth / 100)) return;
    pos.runner = true;
    rec.event('runner', { k: pos.k, name: pos.name, startPoolXrp: pos.startPoolXrp, poolXrp: p.xrp });
    save();
    say(`🚀 ${pos.name} looks like a runner: pool ${pos.startPoolXrp.toFixed(0)} → ${p.xrp.toFixed(0)} XRP in ${Math.round((now() - (pos.launchedAt || pos.at)) / 60000)} min. Sells now wait for your OK.`);
  }
  const fmtCap = (v) => (isNaN(v) ? '?' : `${cfg.mcapCurrency === 'USD' ? '$' : ''}${v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : (v / 1e3).toFixed(0) + 'k'}${cfg.mcapCurrency === 'XRP' ? ' XRP' : ''}`);

  async function ask(pos, d) {
    pos.ask = { part: d.part, why: d.why, at: now(), mcap: pos.mcap, stakeBack: !!d.opt };
    rec.event('ask', { k: pos.k, name: pos.name, part: d.part, why: d.why, mcap: pos.mcap ?? null, runner: !!pos.runner, valueXrp: pos.value });
    if (!pos.domain) {
      try {
        const info = (await req('account_info', { account: pos.issuer, ledger_index: 'validated' })).account_data;
        pos.domain = info.Domain ? Buffer.from(info.Domain, 'hex').toString('utf8').slice(0, 120) : '';
      } catch {}
    }
    save();
    const link = cfg.publicUrl ? `\n➡️ ${cfg.publicUrl}/` : '';
    say(`🙋 ${pos.name}${pos.runner ? ' 🚀 runner,' : ''} market cap ${fmtCap(pos.mcap)} – the bot wants to sell ${Math.round(d.part * 100)}% (${d.why}). Waiting for your OK.${pos.domain ? `\n🌐 ${pos.domain}` : ''}\n🔎 https://xrpscan.com/account/${pos.issuer}${link}`);
  }

  // Your answers from the status page.
  const answer = (k, what, o = {}) => (what === 'buy' ? buyByHand(k, o.xrp)
    : what === 'wpin' || what === 'wban' || what === 'wfree' ? walletAct(k, what)
    : what === 'analyze' ? analyzeLaunch(k)
    : what === 'cleanup' ? locked(cleanupSweep).then((n) => (n === 'off' ? 'clean-up is off (or already running)' : `🧹 clean-up done: ${n} trust line(s) deleted`))
    : locked(() => answerNow(k, what, o)));
  async function answerNow(k, what, o = {}) {
    rec.event('answer', { k, what, ...o, waitedMin: S.positions[k]?.ask ? Math.round((now() - S.positions[k].ask.at) / 60000) : null });
    const pos = S.positions[k];
    if (!pos) return 'gone';
    if (what === 'sellpct') {
      const pct = Math.max(1, Math.min(100, Number(o.pct) || 0));
      delete pos.ask;
      await sell(pos, pct >= 100 ? 1 : pct / 100, `sold ${pct}% by hand`);
      return `${pos.name}: sold ${pct}%`;
    }
    if (what === 'buymore') {
      const x = Number(o.xrp);
      if (!(x >= 0.1 && x <= 100000)) return 'amount: 0.1 XRP or more';
      const p = await pool(pos.currency, pos.issuer);
      if (!p) return `${pos.name}: pool gone`;
      const free = await spendable();
      if (free - x < cfg.minBalanceXrp) return `only ${free.toFixed(2)} XRP free (floor ${cfg.minBalanceXrp})`;
      const got = await addBuy(pos, x, p);
      if (!got) return `${pos.name}: buy didn't fill (price moved more than ${cfg.buySlippage}%)`;
      pos.addsByHand = (pos.addsByHand || 0) + 1;
      rec.event('buy_by_hand', { k, name: pos.name, cost: got.cost, tokens: got.tokens, more: true });
      say(`🛒 ${pos.name}: bought more by hand – ${got.cost.toFixed(3)} XRP`);
      return `${pos.name}: bought ${got.cost.toFixed(3)} XRP more`;
    }
    if (what === 'sell' && pos.ask) {
      const p = await pool(pos.currency, pos.issuer);
      const a = pos.ask;
      delete pos.ask;
      if (!p) return close(pos, 'pool deleted – tokens worthless');
      // a stake-back sale is re-sized at today's price
      const d = a.stakeBack && !pos.tp1Done ? stakeBack(pos, p, a.why + ' (approved)') : { part: a.part, why: a.why + ' (approved)' };
      await sell(pos, d.part, d.why, d.opt);
      return 'sold';
    }
    if (what === 'hold') {
      delete pos.ask;
      pos.manual = true;
      save();
      say(`✋ ${pos.name}: kept – the bot no longer sells it by itself (only on a rug). Sell it from the status page.`);
      return 'held';
    }
    if (what === 'auto') { delete pos.ask; pos.manual = false; save(); say(`🤖 ${pos.name}: back to automatic rules`); return 'auto'; }
    if (what === 'sellhalf' || what === 'sellall') {
      delete pos.ask;
      await sell(pos, what === 'sellall' ? 1 : 0.5, 'sold by hand');
      return 'sold';
    }
    return 'nothing to do';
  }

  // Read a launch's whole pool history from the ledger (also old ones, e.g. a big runner you saw)
  // and book its traders into the wallet table – the same way followed launches are booked.
  async function analyzeLaunch(spec) {
    const t = await parseToken(String(spec || '').trim());
    if (t.err) return t.err;
    const k = key(t.currency, t.issuer);
    const name = currencyName(t.currency);
    if (rec.booked?.(k)) return `${name}: already in the wallet table`;
    let a;
    try { a = (await req('amm_info', { asset: { currency: 'XRP' }, asset2: { currency: t.currency, issuer: t.issuer }, ledger_index: 'validated' })).amm; } catch { return `${name}: no XRP pool found`; }
    const amm = a.account;
    const xrpNow = typeof a.amount === 'string' ? Number(a.amount) / 1e6 : Number(a.amount2) / 1e6;
    const tokNow = Number((typeof a.amount === 'string' ? a.amount2 : a.amount).value);
    const priceNow = xrpNow / tokNow;
    const txs = [];
    let marker;
    do {
      const r = await req('account_tx', { account: amm, forward: true, limit: 400, ...(marker ? { marker } : {}) });
      txs.push(...(r.transactions || []));
      marker = r.marker;
    } while (marker && txs.length < 8000);
    if (!txs.length) return `${name}: no history`;
    const when = (x) => { const tx = x.tx_json || x.tx || {}; return tx.date != null ? tx.date + 946684800 : x.close_time_iso ? Date.parse(x.close_time_iso) / 1000 : 0; };
    const t0 = when(txs[0]);
    let creator = '', xrp = 0, tok = 0, start = null, maxP = 0, maxPool = 0;
    const wallets = {};
    for (const x of txs) {
      const tx = x.tx_json || x.tx;
      if (!tx || x.meta?.TransactionResult !== 'tesSUCCESS') continue;
      let dx = 0;
      for (const n of x.meta.AffectedNodes || []) {
        const m = n.ModifiedNode || n.CreatedNode;
        const f = m?.FinalFields || m?.NewFields;
        if (m?.LedgerEntryType === 'AccountRoot' && f?.Account === amm) dx = (Number(f.Balance) - Number(m.PreviousFields?.Balance ?? (n.CreatedNode ? 0 : f.Balance))) / 1e6;
      }
      const dt = ammTokDelta(x.meta, amm, t.currency);
      xrp += dx; tok += dt;
      const age = when(x) - t0;
      if (tx.TransactionType === 'AMMCreate') creator ||= tx.Account;
      if (/^AMM/.test(tx.TransactionType)) {
        // the create, and the FirstLedger deposit of the rest of the supply, set the launch price
        if (tok > 0 && (tx.TransactionType === 'AMMCreate' || (age <= 600 && dt > 0 && dt > (tok - dt)))) start = xrp / tok;
        continue;
      }
      start ??= tok > 0 ? xrp / tok : null;
      if (tok > 0) { maxP = Math.max(maxP, xrp / tok); maxPool = Math.max(maxPool, xrp); }
      const w = tx.Account;
      if (w === creator || w === t.issuer || w === me || bundleOf(w, creator, t.issuer)) continue;
      const e = (wallets[w] ||= { in: 0, out: 0, tokIn: 0, tokOut: 0, firstS: Math.round(age), buys: 0, sells: 0 });
      if (dx > 0) { e.in += dx; e.buys++; } else if (dx < 0) { e.out += -dx; e.sells++; }
      if (dt < 0) e.tokIn += -dt; else e.tokOut += dt;
    }
    const buyers = Object.values(wallets).filter((e) => e.in > 0).length;
    const maxX = start ? maxP / start : 0;
    const big = isBigLaunch({ maxX, maxPoolXrp: maxPool, buyers });
    const res = rec.bookLaunch?.({ k, name, wallets, price: priceNow, big });
    stat('launchesAnalyzed');
    rec.event('analyzed', { k, name, txs: txs.length, buyers, maxX: +maxX.toFixed(1), maxPoolXrp: +maxPool.toFixed(0), big });
    refreshSmart();
    const best = Object.entries(wallets).filter(([, e]) => e.in > 0.5 && e.firstS <= 120)
      .map(([w, e]) => ({ w, x: (e.out + Math.max(0, e.tokIn - e.tokOut) * priceNow * 0.9) / e.in, s: e.firstS }))
      .sort((p, q) => q.x - p.x).slice(0, 5);
    return `🔍 ${name}: ${txs.length} trades, ${buyers} buyers, best ${maxX.toFixed(1)}× from the start, pool up to ${maxPool.toFixed(0)} XRP${big ? ' – 🚀 big launch' : ''}; ${res?.booked ?? 0} wallets booked. Best early buyers: ${best.map((b) => `${b.w.slice(0, 8)}… ${b.x.toFixed(1)}× (${b.s}s)`).join(', ') || '–'}`;
  }

  function walletAct(a, what) {
    if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a)) return 'not a wallet address';
    delete S.walletPin[a]; delete S.walletBan[a];
    if (what === 'wpin') S.walletPin[a] = now();
    if (what === 'wban') S.walletBan[a] = now();
    save(); refreshSmart();
    return what === 'wpin' ? `📌 ${a.slice(0, 8)}…: copied from now on` : what === 'wban' ? `🚫 ${a.slice(0, 8)}…: never copied` : `${a.slice(0, 8)}…: automatic again`;
  }

  // Buy any token from the status page: a FirstLedger link, NAME.rIssuer, or only the issuer
  // address (if it issues one token). Hard problems (clawback, freeze, approval, no pool) refuse it;
  // the launch filters (supply share, blackhole, pool size) don't apply – it's your call.
  async function buyByHand(spec, xrpAmt) {
    const x = Number(xrpAmt);
    if (!(x >= 0.1 && x <= 100000)) return 'amount: 0.1 XRP or more';
    const t = await parseToken(String(spec || '').trim());
    if (t.err) return t.err;
    const k = key(t.currency, t.issuer);
    if (S.positions[k]) return answer(k, 'buymore', { xrp: x });
    const l = { k, currency: t.currency, issuer: t.issuer, name: currencyName(t.currency), at: now(), buyXrp: x, byHand: true };
    const c = await checks(l);
    const warn = c.reasons.filter((r) => /socials|rugged before|bundle/.test(r));
    const hard = [...c.reasons.filter((r) => !/supply|pool only|> max|socials|rugged before|bundle/.test(r)), ...c.wait];
    if (!c.pool) return `${l.name}: no XRP pool for this token`;
    if (hard.length) return `${l.name}: not bought – ${hard.join(', ')}`;
    l.poolXrp = c.pool.xrp; l.poolTok = c.pool.tok;
    rec.event('buy_by_hand', { k, name: l.name, xrp: x });
    await buy(l, c.pool);
    return S.positions[k] ? `${l.name}: bought${warn.length ? ` – careful: ${warn.join(', ')}` : ''}` : `${l.name}: buy didn't go through – see the log`;
  }
  async function parseToken(s) {
    let m = s.match(/firstledger\.net\/(?:[a-z]{2}\/)?token(?:-v\d)?\/(r[1-9A-HJ-NP-Za-km-z]{24,34})\/([0-9A-Fa-f]{40}|[A-Za-z0-9]{3})/);
    if (m) return { issuer: m[1], currency: m[2].length === 40 ? m[2].toUpperCase() : m[2] };
    m = s.match(/^([^.:\s]{1,40})[.:](r[1-9A-HJ-NP-Za-km-z]{24,34})$/);
    if (m) return { issuer: m[2], currency: m[1].length === 3 || /^[0-9A-F]{40}$/i.test(m[1]) ? m[1].toUpperCase() : Buffer.from(m[1], 'utf8').toString('hex').toUpperCase().padEnd(40, '0') };
    m = s.match(/(r[1-9A-HJ-NP-Za-km-z]{24,34})/);
    if (m) {
      try {
        const g = await req('gateway_balances', { account: m[1], ledger_index: 'validated' });
        const cur = Object.keys(g.obligations || {});
        if (cur.length === 1) return { issuer: m[1], currency: cur[0] };
        if (cur.length > 1) return { err: `${m[1]} issues ${cur.length} tokens – write NAME.${m[1]}` };
      } catch {}
      return { err: `${m[1]} issues no token` };
    }
    return { err: 'paste a FirstLedger link, NAME.rIssuer or the issuer address' };
  }

  // Tokens to sell into the pool to receive `out` XRP (inverse of swapOut).
  function tokensFor(out, p) {
    if (out >= p.xrp) return Infinity;
    return (p.tok * out) / ((p.xrp - out) * (1 - p.fee / 100));
  }

  // ---------- lifecycle ----------
  let timer;
  let sweepTimer;
  async function start() {
    await refreshReserves();
    client.on('transaction', onTransaction);
    await subscribe();
    timer = setInterval(() => { tick(); }, cfg.checkS * 1000);
    sweepTimer = setInterval(() => {
      locked(cleanupSweep).catch(() => {}); refreshSmart();
      for (const [k, b] of bundles) if (!S.positions[k] && now() - b.at > 48 * 3600e3) bundles.delete(k);
    }, 30 * 60e3);
    refreshSmart();
    setTimeout(() => { locked(cleanupSweep).catch(() => {}); }, 60e3);
    say(`🤖 Sniper running${cfg.dryRun ? ' (DRY RUN)' : ''} – wallet ${me}, ${cfg.buyXrp} XRP per launch, ${Object.keys(S.positions).length} open positions`);
  }
  // FAST_LAUNCH: transactions_proposed also carries the validated transactions (one stream)
  async function subscribe() {
    if (cfg.fastLaunch) {
      try { await client.request({ command: 'subscribe', streams: ['transactions_proposed'] }); return; } catch (e) { say(`⚠️ open-ledger stream refused (${e?.data?.error || e.message}) – validated launches only`); }
    }
    await client.request({ command: 'subscribe', streams: ['transactions'] });
  }
  async function resubscribe() {
    await refreshReserves();
    await subscribe();
  }
  function stop() { stopped = true; clearInterval(timer); clearInterval(sweepTimer); save(); rec.stop(); }

  function status() {
    const open = Object.values(S.positions);
    const all = [...open, ...S.history];
    return {
      wallet: me, dryRun: cfg.dryRun, realized: S.realized,
      unrealized: open.reduce((s, p) => s + (p.value - p.cost), 0),
      cash: all.reduce((s, p) => s + p.proceeds - p.cost, 0), // XRP in minus XRP out, all trades
      moonValue: open.filter(isMoonbag).reduce((s, p) => s + (p.value - p.proceeds), 0),
      tracking: [...cfg.track.values()],
      stats: S.stats, following: rec.following(),
      mcapApproval: cfg.mcapApproval, mcapCurrency: cfg.mcapCurrency, paused: cfg.pauseBuys,
      ruggers: (rec.devs ? rec.devs() : []).slice(0, 15),
      buysToday: S.buysToday, open: open.map((p) => ({ ...p, hist: undefined, bundle: bundles.get(p.k) ? { wallets: bundles.get(p.k).wallets.size, holds: [...bundles.get(p.k).hold.values()].reduce((a, b) => a + b, 0) } : null, spark: (p.hist || []).filter((_, i, a) => i % Math.ceil(a.length / 60) === 0 || i === a.length - 1).map((x) => x.price) })), history: S.history.slice(0, 50),
      chart: { ...chart.summary(), on: cfg.chartSmart, add: cfg.chartAdd },
      smart: { on: cfg.autoTrack, copying: [...auto.entries()].map(([wallet, label]) => ({ wallet, label })), list: (rec.wallets ? rec.wallets() : []).slice(0, 20).map((w) => ({ ...w, smart: isSmart(w), copied: auto.has(w.wallet), pinned: !!S.walletPin[w.wallet], banned: !!S.walletBan[w.wallet] })), rules: { launches: cfg.autoMinLaunches, win: cfg.autoMinWin, pnl: cfg.autoMinPnl, bigHits: cfg.autoBigHits } },
      cleanup: { on: cfg.cleanup, cleared: S.stats.linesCleared || 0, freed: S.stats.reserveFreed || 0 },
      wins: S.history.filter((h) => h.pnl > 0).length, losses: S.history.filter((h) => h.pnl <= 0).length,
    };
  }

  return { start, stop, resubscribe, tick, status, answer, say, rec, onTransaction, state: () => S, _pending: pending, _refreshSmart: refreshSmart };
}
