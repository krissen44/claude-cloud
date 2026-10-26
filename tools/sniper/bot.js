// XRPL launch sniper: watches every new XRP/token AMM pool (FirstLedger, Horizon and any other
// launchpad create their pools with AMMCreate), checks the token for the usual rug signs,
// buys a fixed amount of XRP and sells by fixed rules (take profit, trailing stop, stop loss,
// rug exit, max hold time).
//
// The ledger connection is injected (`client`), so the same code runs against xrpl.js on
// mainnet and against the simulator in test/sim.mjs.

import fs from 'node:fs';
import path from 'node:path';

const DROPS = 1_000_000;
const F = {
  disableMaster: 0x00100000,
  noFreeze: 0x00200000,
  globalFreeze: 0x00400000,
  defaultRipple: 0x00800000,
  clawback: 0x80000000,
};
const TF_PARTIAL = 0x00020000;
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
    buyXrp: num('BUY_XRP', 1),
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
    minPoolSupplyPct: num('MIN_POOL_SUPPLY_PCT', 20), // share of the supply that sits in the pool
    buySlippage: num('BUY_SLIPPAGE', 25),
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
    mcapCurrency: /^xrp$/i.test(env.MCAP_CURRENCY || '') ? 'XRP' : 'USD',
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
export function createBot({ client, wallet, cfg, log = console.log, fetchFn = globalThis.fetch }) {
  const me = wallet?.address || 'rDRYRUN';
  const file = path.join(cfg.dataDir, 'state.json');
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  let S = { positions: {}, history: [], seen: {}, day: '', buysToday: 0, realized: 0, startedAt: now() };
  try { S = { ...S, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  const pending = new Map(); // token key → launch waiting for checks
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
  async function pump() {
    if (busy) return;
    const job = queue.shift();
    if (!job) return;
    busy = true;
    try {
      const r = await client.submitAndWait(job.tx, { wallet, autofill: true });
      job.resolve(r.result);
    } catch (e) { job.reject(e); }
    busy = false;
    pump();
  }
  const okResult = (r) => r?.meta?.TransactionResult === 'tesSUCCESS';

  async function req(command, params = {}) {
    const r = await client.request({ command, ...params });
    return r.result;
  }

  async function pool(currency, issuer) {
    try {
      const r = await req('amm_info', { asset: { currency: 'XRP' }, asset2: { currency, issuer }, ledger_index: 'validated' });
      const a = r.amm;
      const xrpSide = typeof a.amount === 'string' ? a.amount : a.amount2;
      const tokSide = typeof a.amount === 'string' ? a.amount2 : a.amount;
      return { xrp: xrp(xrpSide), tok: Number(tokSide.value), fee: (a.trading_fee || 0) / 1000 };
    } catch (e) {
      if (/actNotFound|ammNotFound|Account not found/i.test(String(e?.data?.error || e?.message))) return null;
      throw e;
    }
  }

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
  function onTransaction(ev) {
    const tx = ev.tx_json || ev.transaction;
    if (!tx || !ev.validated || ev.meta?.TransactionResult !== 'tesSUCCESS') return;
    if (cfg.track.has(tx.Account) && tx.Account !== me) onTracked(tx, ev);
    if (tx.TransactionType !== 'AMMCreate') return;
    const xrpAmt = typeof tx.Amount === 'string' ? tx.Amount : typeof tx.Amount2 === 'string' ? tx.Amount2 : null;
    const tok = typeof tx.Amount === 'object' ? tx.Amount : typeof tx.Amount2 === 'object' ? tx.Amount2 : null;
    if (!xrpAmt || !tok) return; // token/token pools are not launches against XRP
    const k = key(tok.currency, tok.issuer);
    if (S.seen[k] || pending.has(k) || S.positions[k]) return;
    S.seen[k] = now();
    const launch = {
      k, currency: tok.currency, issuer: tok.issuer, name: currencyName(tok.currency),
      creator: tx.Account, poolXrp: xrp(xrpAmt), poolTok: Number(tok.value), at: now(),
      hash: ev.hash || tx.hash,
    };
    pending.set(k, launch);
    say(`🆕 Launch ${launch.name} (${launch.issuer.slice(0, 8)}…) pool ${launch.poolXrp.toFixed(1)} XRP`);
    evaluate(launch).catch((e) => { pending.delete(k); say(`⚠️ ${launch.name}: check failed – ${e.message}`); });
  }

  // A tracked wallet bought a token → run the same checks and buy it too (once per token).
  function onTracked(tx, ev) {
    if (tx.TransactionType === 'AMMDeposit' || tx.TransactionType === 'AMMCreate') return;
    const who = cfg.track.get(tx.Account);
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
      say(`👀 ${who} bought ${l.name} for ${b.xrp.toFixed(1)} XRP – checking`);
      evaluate(l).catch((e) => { pending.delete(k); say(`⚠️ ${l.name}: check failed – ${e.message}`); });
    }
  }

  async function checks(l) {
    const reasons = [];
    let small = '';
    const info = (await req('account_info', { account: l.issuer, ledger_index: 'validated' })).account_data;
    const flags = info.Flags || 0;
    const blackholed = (flags & F.disableMaster) && (!info.RegularKey || BLACKHOLES.has(info.RegularKey));
    if (flags & F.globalFreeze) reasons.push('issuer froze the token');
    if (flags & F.clawback) reasons.push('clawback enabled');
    const fee = info.TransferRate ? (info.TransferRate / 1e9 - 1) * 100 : 0;
    if (fee > cfg.maxTransferFee + 1e-9) reasons.push(`transfer fee ${fee.toFixed(2)}%`);
    const p = await pool(l.currency, l.issuer);
    if (!p) reasons.push('pool gone');
    else {
      if (p.xrp < (l.minPool ?? cfg.minPoolXrp)) small = `pool only ${p.xrp.toFixed(1)} XRP`;
      if (cfg.maxPoolXrp && p.xrp > cfg.maxPoolXrp) reasons.push(`pool ${p.xrp.toFixed(0)} XRP > max`);
      if (p.fee > cfg.maxAmmFee) reasons.push(`AMM fee ${p.fee}%`);
      if (cfg.minPoolSupplyPct > 0) {
        try {
          const g = await req('gateway_balances', { account: l.issuer, ledger_index: 'validated' });
          const supply = Number(g.obligations?.[l.currency] || 0);
          const pct = supply > 0 ? (p.tok / supply) * 100 : 100;
          if (pct < cfg.minPoolSupplyPct) reasons.push(`only ${pct.toFixed(0)}% of supply in the pool`);
        } catch {}
      }
    }
    return { blackholed: !!blackholed, reasons, small, pool: p };
  }

  // Hard problems skip at once; a missing blackhole or a pool below the minimum is waited for.
  async function evaluate(l) {
    const holeBy = l.at + cfg.blackholeWaitS * 1000;
    const poolBy = l.at + (l.poolWait ?? cfg.poolWaitMin) * 60000;
    let told = false;
    for (;;) {
      if (stopped) return;
      const c = await checks(l);
      const hole = c.blackholed || !cfg.requireBlackhole;
      if (c.reasons.length) {
        pending.delete(l.k);
        return say(`⛔ Skip ${l.name}: ${c.reasons.join(', ')}`);
      }
      if (hole && !c.small) {
        pending.delete(l.k);
        return buy(l, c.pool);
      }
      if (!hole && now() > holeBy) {
        pending.delete(l.k);
        return say(`⛔ Skip ${l.name}: issuer not blackholed after ${cfg.blackholeWaitS}s (can mint more)`);
      }
      if (c.small && now() >= poolBy) {
        pending.delete(l.k);
        return say(`⛔ Skip ${l.name}: ${c.small} (min ${l.minPool ?? cfg.minPoolXrp})`);
      }
      if (c.small && !told) { told = true; say(`⏳ ${l.name}: ${c.small} – watching for ${l.poolWait ?? cfg.poolWaitMin} min`); }
      // poll fast while it is fresh, then slower so many waiting launches don't flood the server
      await new Promise((r) => setTimeout(r, now() - l.at < 120000 ? 4000 : 15000));
    }
  }

  // ---------- buy ----------
  // Buys run one after another so limits and the balance floor see the previous buy.
  let buyChain = Promise.resolve();
  function buy(l, p) {
    const run = buyChain.then(() => buyNow(l, p));
    buyChain = run.catch(() => {});
    return run;
  }

  async function buyNow(l, p) {
    if (S.day !== day()) { S.day = day(); S.buysToday = 0; }
    const open = Object.values(S.positions).filter((x) => !isMoonbag(x)).length; // moonbags don't count
    if (open >= cfg.maxOpen) return say(`⏸ ${l.name}: ${open} positions open (max ${cfg.maxOpen})`);
    const stake = l.buyXrp ?? cfg.buyXrp;
    if (S.buysToday >= cfg.maxBuysPerDay) return say(`⏸ ${l.name}: daily buy limit reached`);
    p = (await pool(l.currency, l.issuer)) || p; // fresh price, the queue may have waited
    const free = await spendable();
    if (free - reserves.inc - stake < cfg.minBalanceXrp) {
      return say(`⏸ ${l.name}: only ${free.toFixed(2)} XRP free – keeping ${cfg.minBalanceXrp} XRP floor`);
    }
    const expect = swapOut(stake, p.xrp, p.tok, p.fee);
    const min = expect * (1 - cfg.buySlippage / 100);
    S.buysToday++;
    if (cfg.dryRun) {
      S.positions[l.k] = position(l, stake, expect, p);
      save();
      return say(`🧪 DRY buy ${l.name}: ${stake} XRP → ${expect.toPrecision(6)}`);
    }
    const ts = await submit({
      TransactionType: 'TrustSet', Account: me, Flags: TF_SET_NO_RIPPLE,
      LimitAmount: { currency: l.currency, issuer: l.issuer, value: '9999999999999999e80' },
    });
    if (!okResult(ts)) return say(`❌ ${l.name}: trust line failed (${ts?.meta?.TransactionResult})`);
    const r = await submit({
      TransactionType: 'Payment', Account: me, Destination: me, Flags: TF_PARTIAL,
      Amount: { currency: l.currency, issuer: l.issuer, value: iouValue(expect * 1.5) },
      SendMax: toDrops(stake),
      DeliverMin: { currency: l.currency, issuer: l.issuer, value: iouValue(min) },
    });
    if (!okResult(r)) {
      await dropTrustLine(l.currency, l.issuer);
      return say(`❌ Buy ${l.name} failed (${r?.meta?.TransactionResult}) – price moved more than ${cfg.buySlippage}%`);
    }
    const fx = txEffects(r.meta, me, l.currency, l.issuer);
    const got = Number(r.meta.delivered_amount?.value ?? fx.tokDelta);
    const cost = Math.max(0, -fx.xrpDelta) || stake;
    S.positions[l.k] = position(l, cost, got, p);
    save();
    say(`🟢 Bought ${l.name}${l.copy ? ` (copy ${l.copy})` : ''}: ${cost.toFixed(4)} XRP → ${got.toPrecision(6)} tokens`);
  }

  function position(l, cost, amount, p) {
    return {
      k: l.k, currency: l.currency, issuer: l.issuer, name: l.name, cost, amount, sold: 0, proceeds: 0,
      entryPoolXrp: p.xrp, peak: cost, value: cost, tp1Done: false, at: now(), fails: 0, copy: l.copy || '',
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
    say(`${pnl >= 0 ? '✅' : '🔴'} Closed ${pos.name}: ${pos.cost.toFixed(3)} → ${pos.proceeds.toFixed(3)} XRP (${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)}) – ${why}. Total ${S.realized >= 0 ? '+' : ''}${S.realized.toFixed(3)} XRP`);
    if (!cfg.dryRun) await dropTrustLine(pos.currency, pos.issuer).catch(() => {});
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

  async function tick() {
    if (ticking || stopped) return;
    ticking = true;
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
    const d = decide(pos, p);
    if (!d) return;
    if (d.rug) { delete pos.ask; return sell(pos, d.part, d.why, d.opt); } // never wait on a rug
    if (pos.manual || pos.ask) return; // you decide for this one
    if (needsOk(pos)) return ask(pos, d);
    return sell(pos, d.part, d.why, d.opt);
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
      if (!pos.tp1Done && gain >= c.tp1) return { part: c.tp1Part / 100, why: `take profit +${gain.toFixed(0)}%` };
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
      if (cfg.tp1Part !== 'auto') return { part: cfg.tp1Part / 100, why: `take profit +${gain.toFixed(0)}%` };
      return stakeBack(pos, p, `stake back at +${gain.toFixed(0)}%`);
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
  const needsOk = (pos) => cfg.mcapApproval > 0 && !(pos.mcap < cfg.mcapApproval);
  const fmtCap = (v) => (isNaN(v) ? '?' : `${cfg.mcapCurrency === 'USD' ? '$' : ''}${v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : (v / 1e3).toFixed(0) + 'k'}${cfg.mcapCurrency === 'XRP' ? ' XRP' : ''}`);

  async function ask(pos, d) {
    pos.ask = { part: d.part, why: d.why, at: now(), mcap: pos.mcap, stakeBack: !!d.opt };
    if (!pos.domain) {
      try {
        const info = (await req('account_info', { account: pos.issuer, ledger_index: 'validated' })).account_data;
        pos.domain = info.Domain ? Buffer.from(info.Domain, 'hex').toString('utf8').slice(0, 120) : '';
      } catch {}
    }
    save();
    const link = cfg.publicUrl ? `\n➡️ ${cfg.publicUrl}/` : '';
    say(`🙋 ${pos.name} has a market cap of ${fmtCap(pos.mcap)} – the bot wants to sell ${Math.round(d.part * 100)}% (${d.why}). Waiting for your OK.${pos.domain ? `\n🌐 ${pos.domain}` : ''}\n🔎 https://xrpscan.com/account/${pos.issuer}${link}`);
  }

  // Your answers from the status page.
  const answer = (k, what) => locked(() => answerNow(k, what));
  async function answerNow(k, what) {
    const pos = S.positions[k];
    if (!pos) return 'gone';
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

  // Tokens to sell into the pool to receive `out` XRP (inverse of swapOut).
  function tokensFor(out, p) {
    if (out >= p.xrp) return Infinity;
    return (p.tok * out) / ((p.xrp - out) * (1 - p.fee / 100));
  }

  // ---------- lifecycle ----------
  let timer;
  async function start() {
    await refreshReserves();
    client.on('transaction', onTransaction);
    await client.request({ command: 'subscribe', streams: ['transactions'] });
    timer = setInterval(() => { tick(); }, cfg.checkS * 1000);
    say(`🤖 Sniper running${cfg.dryRun ? ' (DRY RUN)' : ''} – wallet ${me}, ${cfg.buyXrp} XRP per launch, ${Object.keys(S.positions).length} open positions`);
  }
  async function resubscribe() {
    await refreshReserves();
    await client.request({ command: 'subscribe', streams: ['transactions'] });
  }
  function stop() { stopped = true; clearInterval(timer); save(); }

  function status() {
    const open = Object.values(S.positions);
    const all = [...open, ...S.history];
    return {
      wallet: me, dryRun: cfg.dryRun, realized: S.realized,
      unrealized: open.reduce((s, p) => s + (p.value - p.cost), 0),
      cash: all.reduce((s, p) => s + p.proceeds - p.cost, 0), // XRP in minus XRP out, all trades
      moonValue: open.filter(isMoonbag).reduce((s, p) => s + (p.value - p.proceeds), 0),
      tracking: [...cfg.track.values()],
      mcapApproval: cfg.mcapApproval, mcapCurrency: cfg.mcapCurrency,
      buysToday: S.buysToday, open, history: S.history.slice(0, 50),
      wins: S.history.filter((h) => h.pnl > 0).length, losses: S.history.filter((h) => h.pnl <= 0).length,
    };
  }

  return { start, stop, resubscribe, tick, status, answer, onTransaction, state: () => S, _pending: pending };
}
