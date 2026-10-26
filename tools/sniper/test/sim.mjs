// Offline test: a tiny simulated XRPL (accounts, trust lines, constant-product AMM pools) that
// speaks the requests and transactions the bot uses. Runs launch scenarios and checks the outcome.
//   node test/sim.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBot, readConfig, swapOut } from '../bot.js';

const ME = 'rME1111111111111111111111111111';
const D = 1e6;
const hex = (s) => Buffer.from(s).toString('hex').toUpperCase().padEnd(40, '0');

class Sim {
  constructor(balanceXrp) {
    this.acc = { [ME]: { Balance: String(balanceXrp * D), Flags: 0, OwnerCount: 0 } };
    this.lines = {}; // currency.issuer → my balance (number)
    this.amm = {}; // currency.issuer → {xrp, tok, fee}
    this.supply = {};
    this.handlers = {};
    this.txs = [];
  }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); }
  emit(ev, x) { for (const fn of this.handlers[ev] || []) fn(x); }
  k(c, i) { return `${c}.${i}`; }

  launch({ name, issuer, poolXrp, poolTok, supply = poolTok, flags = 0x00800000 | 0x00100000, regularKey, transferRate, fee = 500, silent = false }) {
    const currency = hex(name);
    this.acc[issuer] = { Balance: '50000000', Flags: flags, OwnerCount: 0, RegularKey: regularKey, TransferRate: transferRate };
    this.amm[this.k(currency, issuer)] = { xrp: poolXrp, tok: poolTok, fee };
    this.supply[this.k(currency, issuer)] = supply;
    if (silent) return currency;
    this.emit('transaction', {
      validated: true, hash: 'H' + name,
      tx_json: { TransactionType: 'AMMCreate', Account: 'rDEV', Amount: String(poolXrp * D), Amount2: { currency, issuer, value: String(poolTok) }, TradingFee: fee },
      meta: { TransactionResult: 'tesSUCCESS' },
    });
    return currency;
  }
  // other traders: positive xrp = buy pressure, negative = selling tokens worth that much XRP
  trade(currency, issuer, xrpIn) {
    const p = this.amm[this.k(currency, issuer)];
    if (xrpIn > 0) { const out = swapOut(xrpIn, p.xrp, p.tok, p.fee / 1000); p.xrp += xrpIn; p.tok -= out; }
    else { const tokIn = (p.tok * -xrpIn) / (p.xrp + xrpIn); p.tok += tokIn; p.xrp += xrpIn; }
  }

  async request(r) {
    const c = r.command;
    if (c === 'subscribe' || c === 'ledger_current') return { result: { ledger_current_index: 1 } };
    if (c === 'server_info') return { result: { info: { validated_ledger: { reserve_base_xrp: 1, reserve_inc_xrp: 0.2 } } } };
    if (c === 'account_info') {
      const a = this.acc[r.account];
      if (!a) throw Object.assign(new Error('actNotFound'), { data: { error: 'actNotFound' } });
      return { result: { account_data: { Account: r.account, ...a } } };
    }
    if (c === 'amm_info') {
      const p = this.amm[this.k(r.asset2.currency, r.asset2.issuer)];
      if (!p) throw Object.assign(new Error('actNotFound'), { data: { error: 'actNotFound' } });
      return { result: { amm: { amount: String(Math.round(p.xrp * D)), amount2: { ...r.asset2, value: String(p.tok) }, trading_fee: p.fee } } };
    }
    if (c === 'account_lines') {
      const lines = Object.entries(this.lines).filter(([k]) => k.endsWith('.' + r.peer)).map(([k, b]) => ({ currency: k.split('.')[0], account: r.peer, balance: String(b) }));
      return { result: { lines } };
    }
    if (c === 'gateway_balances') {
      const obligations = {};
      for (const [k, v] of Object.entries(this.supply)) if (k.endsWith('.' + r.account)) obligations[k.split('.')[0]] = String(v);
      return { result: { obligations } };
    }
    throw new Error('unknown ' + c);
  }

  async submitAndWait(tx) {
    this.txs.push(tx);
    const me = this.acc[ME];
    const fee = 12;
    const prevBal = me.Balance;
    const res = (code, extra = {}) => ({ result: { meta: { TransactionResult: code, ...extra } } });
    if (tx.TransactionType === 'TrustSet') {
      const k = this.k(tx.LimitAmount.currency, tx.LimitAmount.issuer);
      me.Balance = String(Number(me.Balance) - fee);
      if (tx.LimitAmount.value === '0') {
        if (this.lines[k] === 0) { delete this.lines[k]; me.OwnerCount--; }
      } else if (!(k in this.lines)) { this.lines[k] = 0; me.OwnerCount++; }
      return res('tesSUCCESS');
    }
    if (tx.TransactionType === 'OfferCreate') {
      // buy: IOC sell offer of TakerGets XRP for at least TakerPays tokens; creates the trust line itself
      const iou = tx.TakerPays;
      const k = this.k(iou.currency, iou.issuer);
      const p = this.amm[k];
      const spend = Number(tx.TakerGets) / D;
      me.Balance = String(Number(me.Balance) - fee);
      if (!p) return res('tesSUCCESS', { AffectedNodes: [] });
      const out = swapOut(spend, p.xrp, p.tok, p.fee / 1000);
      if (out < Number(iou.value)) return res('tesSUCCESS', { AffectedNodes: [] }); // nothing crossed, offer cancelled
      p.xrp += spend; p.tok -= out;
      const fresh = !(k in this.lines);
      if (fresh) { this.lines[k] = 0; me.OwnerCount++; }
      const before = this.lines[k];
      this.lines[k] = before + out;
      const after = String(Math.round(Number(prevBal) - spend * D - fee));
      me.Balance = after;
      const line = { Balance: { currency: iou.currency, value: String(this.lines[k]) }, LowLimit: { issuer: ME }, HighLimit: { issuer: iou.issuer } };
      return res('tesSUCCESS', {
        AffectedNodes: [
          { ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: ME, Balance: after }, PreviousFields: { Balance: prevBal } } },
          fresh ? { CreatedNode: { LedgerEntryType: 'RippleState', NewFields: line } }
            : { ModifiedNode: { LedgerEntryType: 'RippleState', FinalFields: line, PreviousFields: { Balance: { currency: iou.currency, value: String(before) } } } },
        ],
      });
    }
    if (tx.TransactionType === 'Payment') {
      const buy = typeof tx.Amount === 'object';
      const iou = buy ? tx.Amount : tx.SendMax;
      const k = this.k(iou.currency, iou.issuer);
      const p = this.amm[k];
      if (!p) return res('tecPATH_DRY');
      let xrpDelta, tokDelta, delivered;
      if (buy) {
        const spend = Number(tx.SendMax) / D;
        const out = swapOut(spend, p.xrp, p.tok, p.fee / 1000);
        if (out < Number(tx.DeliverMin.value)) return res('tecPATH_PARTIAL');
        p.xrp += spend; p.tok -= out;
        xrpDelta = -spend; tokDelta = out; delivered = { ...iou, value: String(out) };
      } else {
        const sell = Number(tx.SendMax.value);
        if (sell > (this.lines[k] || 0) + 1e-9) return res('tecPATH_PARTIAL');
        const out = swapOut(sell, p.tok, p.xrp, p.fee / 1000);
        if (out * D < Number(tx.DeliverMin)) return res('tecPATH_PARTIAL');
        p.tok += sell; p.xrp -= out;
        xrpDelta = out; tokDelta = -sell; delivered = String(Math.floor(out * D));
      }
      const before = this.lines[k] || 0;
      this.lines[k] = Math.max(0, before + tokDelta);
      if (this.lines[k] < 1e-12) this.lines[k] = 0;
      me.Balance = String(Math.round(Number(me.Balance) + xrpDelta * D - fee));
      return res('tesSUCCESS', {
        delivered_amount: delivered,
        AffectedNodes: [
          { ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: ME, Balance: me.Balance }, PreviousFields: { Balance: prevBal } } },
          { ModifiedNode: { LedgerEntryType: 'RippleState', FinalFields: { Balance: { currency: iou.currency, value: String(this.lines[k]) }, LowLimit: { issuer: ME }, HighLimit: { issuer: iou.issuer } }, PreviousFields: { Balance: { currency: iou.currency, value: String(before) } } } },
        ],
      });
    }
    throw new Error('unknown tx ' + tx.TransactionType);
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (bot) => { for (let i = 0; i < 20; i++) { await wait(5); } await bot.tick(); for (let i = 0; i < 20; i++) await wait(5); };
const logs = [];

const RLUSD = '524C555344000000000000000000000000000000.rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
function setup(balance = 50, env = {}, usd = true) {
  const sim = new Sim(balance);
  if (usd) sim.amm[RLUSD] = { xrp: 1e6, tok: 2.5e6, fee: 0 }; // 1 XRP = $2.50
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snipe-'));
  const cfg = readConfig({ DATA_DIR: dir, BLACKHOLE_WAIT_S: '6', POOL_WAIT_MIN: '0', ...env });
  const bot = createBot({ client: sim, wallet: { address: ME }, cfg, log: (m) => logs.push(m), fetchFn: null });
  return { sim, bot, cfg };
}

let passed = 0;
async function test(name, fn) {
  logs.length = 0;
  try { await fn(); passed++; console.log('✔', name); }
  catch (e) { console.log('✘', name, '\n', logs.join('\n')); throw e; }
}

await test('pump: stake back at +100 %, moonbag never sold on a dump, cleared when the pool dies', async () => {
  const { sim, bot } = setup();
  await bot.start();
  const cur = sim.launch({ name: 'PUMP', issuer: 'rIss1', poolXrp: 100, poolTok: 1e9 });
  const k = `${cur}.rIss1`;
  await settle(bot);
  const pos = bot.state().positions[k];
  assert.ok(pos, 'bought');
  assert.ok(Math.abs(pos.cost - 1) < 1e-4, 'spent 1 XRP');
  const bought = pos.amount;
  sim.trade(cur, 'rIss1', 150); // price ~6x
  await settle(bot);
  const m = bot.state().positions[k];
  assert.equal(m.tp1Done, true, 'first sale done');
  assert.ok(m.proceeds >= m.cost, `stake back: ${m.proceeds} >= ${m.cost}`);
  assert.ok(m.proceeds < m.cost * 1.1, 'sold only what was needed');
  assert.ok(m.amount > bought * 0.7, `most of the bag rides: ${(m.amount / bought * 100).toFixed(0)}%`);
  sim.trade(cur, 'rIss1', -200); // big dump
  await settle(bot);
  assert.ok(bot.state().positions[k], 'moonbag kept through the dump');
  sim.amm[k].xrp = 5; // pool drained → dead
  await settle(bot);
  assert.equal(bot.state().positions[k], undefined, 'dead moonbag cleared');
  const h = bot.state().history[0];
  assert.ok(/moonbag dead/.test(h.why), h.why);
  assert.ok(h.pnl >= 0, 'never below zero once the stake is back ' + h.pnl);
  assert.equal(sim.lines[k], undefined, 'trust line deleted');
  assert.equal(sim.acc[ME].OwnerCount, 0);
  bot.stop();
});

await test('small launch: watched, bought once the pool passes 100 XRP', async () => {
  const { sim, bot } = setup(50, { POOL_WAIT_MIN: '1' });
  await bot.start();
  const cur = sim.launch({ name: 'GROW', issuer: 'rGr', poolXrp: 60, poolTok: 1e9 });
  await settle(bot);
  assert.equal(bot.state().positions[`${cur}.rGr`], undefined, 'not yet');
  assert.ok(logs.join('\n').includes('watching'));
  sim.trade(cur, 'rGr', 50);
  await wait(4500); await settle(bot);
  assert.ok(bot.state().positions[`${cur}.rGr`], 'bought at 110 XRP');
  bot.stop();
});

await test('copy trade: a tracked wallet buys a token → the bot buys it too, once', async () => {
  const { sim, bot } = setup(50, { TRACK_WALLETS: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh:Whale', COPY_BUY_XRP: '2' });
  await bot.start();
  const cur = sim.launch({ name: 'OLD', issuer: 'rOld', poolXrp: 400, poolTok: 1e9, silent: true });
  const whaleBuy = () => sim.emit('transaction', {
    validated: true,
    tx_json: { TransactionType: 'Payment', Account: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', Fee: '12' },
    meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [
      { ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', Balance: '80000000' }, PreviousFields: { Balance: '100000012' } } },
      { ModifiedNode: { LedgerEntryType: 'RippleState', FinalFields: { Balance: { currency: cur, value: '-50000000' }, LowLimit: { issuer: 'rOld' }, HighLimit: { issuer: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh' } }, PreviousFields: { Balance: { currency: cur, value: '0' } } } },
    ] },
  });
  whaleBuy();
  await settle(bot);
  const pos = bot.state().positions[`${cur}.rOld`];
  assert.ok(pos, 'copied');
  assert.equal(pos.copy, 'Whale');
  assert.ok(Math.abs(pos.cost - 2) < 1e-3, 'COPY_BUY_XRP used');
  whaleBuy();
  await settle(bot);
  assert.equal(sim.txs.filter((t) => t.TransactionType === 'OfferCreate').length, 1, 'bought only once');
  // copy rules: half at +100 %, rest on a 30 % trailing stop
  const k = `${cur}.rOld`;
  const bag = pos.amount;
  sim.trade(cur, 'rOld', 300); // ~4x
  await settle(bot);
  const p1 = bot.state().positions[k];
  assert.ok(p1.tp1Done && Math.abs(p1.amount / bag - 0.5) < 0.01, 'half sold');
  sim.trade(cur, 'rOld', 300);
  await settle(bot);
  assert.ok(bot.state().positions[k], 'rides up');
  sim.trade(cur, 'rOld', -350); // > 30 % off the peak
  await settle(bot);
  assert.equal(bot.state().positions[k], undefined, 'rest sold – no moonbag for copies');
  assert.ok(/trailing/.test(bot.state().history[0].why));
  assert.ok(bot.state().history[0].pnl > 0);
  bot.stop();
});

await test('copy trade: sold after the max hold time', async () => {
  const { sim, bot } = setup(50, { TRACK_WALLETS: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh:W', COPY_MAX_HOLD_H: '0.0001' });
  await bot.start();
  const cur = sim.launch({ name: 'SLOW', issuer: 'rSl', poolXrp: 300, poolTok: 1e9, silent: true });
  sim.emit('transaction', {
    validated: true,
    tx_json: { TransactionType: 'OfferCreate', Account: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', Fee: '12' },
    meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [
      { ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', Balance: '80000000' }, PreviousFields: { Balance: '100000012' } } },
      { CreatedNode: { LedgerEntryType: 'RippleState', NewFields: { Balance: { currency: cur, value: '3000000' }, LowLimit: { issuer: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh' }, HighLimit: { issuer: 'rSl' } } } },
    ] },
  });
  await settle(bot);
  assert.ok(bot.state().positions[`${cur}.rSl`], 'copied (OfferCreate, new trust line)');
  await wait(500); await settle(bot);
  assert.equal(bot.state().positions[`${cur}.rSl`], undefined);
  assert.ok(/max hold/.test(bot.state().history[0].why));
  bot.stop();
});

await test('rug: dev pulls the pool → sell everything', async () => {
  const { sim, bot } = setup();
  await bot.start();
  const cur = sim.launch({ name: 'RUG', issuer: 'rIss2', poolXrp: 200, poolTok: 5e8 });
  await settle(bot);
  assert.ok(bot.state().positions[`${cur}.rIss2`]);
  sim.amm[`${cur}.rIss2`].xrp = 30; sim.amm[`${cur}.rIss2`].tok = 1.3e9; // liquidity withdrawn / dumped
  await settle(bot);
  const h = bot.state().history[0];
  assert.ok(/rug/.test(h.why), h.why);
  assert.ok(h.pnl < 0);
  bot.stop();
});

await test('filters: clawback, transfer fee, small pool, dev holds the supply, freeze', async () => {
  const { sim, bot } = setup();
  await bot.start();
  sim.launch({ name: 'CLAW', issuer: 'rC', poolXrp: 100, poolTok: 1e6, flags: 0x00100000 | 0x80000000 });
  sim.launch({ name: 'TAX', issuer: 'rT', poolXrp: 100, poolTok: 1e6, transferRate: 1050000000 });
  sim.launch({ name: 'TINY', issuer: 'rS', poolXrp: 5, poolTok: 1e6 });
  sim.launch({ name: 'WHALE', issuer: 'rW', poolXrp: 100, poolTok: 1e6, supply: 1e8 });
  sim.launch({ name: 'ICE', issuer: 'rF', poolXrp: 100, poolTok: 1e6, flags: 0x00100000 | 0x00400000 });
  await settle(bot);
  assert.equal(Object.keys(bot.state().positions).length, 0);
  const text = logs.join('\n');
  for (const r of ['clawback', 'transfer fee 5.00%', 'pool only 5.0 XRP (min 100)', '1% of supply', 'froze']) assert.ok(text.includes(r), 'reason ' + r);
  assert.equal(sim.txs.length, 0, 'no transactions sent');
  bot.stop();
});

await test('not blackholed: waits, buys once the master key is disabled', async () => {
  const { sim, bot } = setup();
  await bot.start();
  const cur = sim.launch({ name: 'LATE', issuer: 'rL', poolXrp: 100, poolTok: 1e9, flags: 0x00800000 });
  await settle(bot);
  assert.equal(bot.state().positions[`${cur}.rL`], undefined, 'waits');
  sim.acc.rL.Flags |= 0x00100000;
  await wait(4500);
  await settle(bot);
  assert.ok(bot.state().positions[`${cur}.rL`], 'bought after blackhole');
  bot.stop();
});

await test('never blackholed: skipped after the wait', async () => {
  const { sim, bot } = setup(50, { BLACKHOLE_WAIT_S: '1' });
  await bot.start();
  sim.launch({ name: 'MINT', issuer: 'rM', poolXrp: 100, poolTok: 1e9, flags: 0x00800000 });
  await wait(4500); await settle(bot);
  assert.ok(logs.join('\n').includes('not blackholed'));
  bot.stop();
});

await test('regular key to a blackhole address counts as blackholed', async () => {
  const { sim, bot } = setup();
  await bot.start();
  const cur = sim.launch({ name: 'RK', issuer: 'rRK', poolXrp: 100, poolTok: 1e9, regularKey: 'rrrrrrrrrrrrrrrrrrrrBZbvji' });
  await settle(bot);
  assert.ok(bot.state().positions[`${cur}.rRK`]);
  bot.stop();
});

await test('stop loss and pool deletion', async () => {
  const { sim, bot } = setup();
  await bot.start();
  const a = sim.launch({ name: 'DIP', issuer: 'rD', poolXrp: 100, poolTok: 1e9 });
  const b = sim.launch({ name: 'GONE', issuer: 'rG', poolXrp: 100, poolTok: 1e9 });
  await settle(bot);
  sim.trade(a, 'rD', -35); // slow bleed, pool still > 60 % so not a "rug" — price −55 %
  delete sim.amm[`${b}.rG`];
  await settle(bot);
  const why = bot.state().history.map((h) => h.why).join(' | ');
  assert.ok(/stop loss/.test(why), why);
  assert.ok(/pool deleted/.test(why), why);
  bot.stop();
});

await test('balance floor and max open positions', async () => {
  const { sim, bot } = setup(13, { MIN_BALANCE_XRP: '10', MAX_OPEN: '5' });
  await bot.start();
  for (let i = 0; i < 4; i++) sim.launch({ name: 'F' + i, issuer: 'rF' + i, poolXrp: 100, poolTok: 1e9 });
  await settle(bot);
  const n = Object.keys(bot.state().positions).length;
  // 13 XRP − 1 base reserve − 10 floor ≈ 2 XRP room → at most one buy (1 XRP + 0.2 line reserve)
  assert.equal(n, 1, 'positions ' + n);
  assert.ok(logs.join('\n').includes('floor'));
  bot.stop();
});

await test('buy slippage: price ran away → no buy, trust line removed again', async () => {
  const { sim, bot } = setup();
  await bot.start();
  const cur = sim.launch({ name: 'RUN', issuer: 'rR', poolXrp: 100, poolTok: 1e9 });
  // front-runners buy between our check and our payment
  const orig = sim.submitAndWait.bind(sim);
  sim.submitAndWait = async (tx) => { if (tx.TransactionType === 'OfferCreate') sim.trade(cur, 'rR', 100); return orig(tx); };
  await settle(bot);
  assert.equal(bot.state().positions[`${cur}.rR`], undefined);
  assert.equal(sim.lines[`${cur}.rR`], undefined, 'line removed');
  assert.ok(logs.join('\n').includes('Buy RUN failed'));
  bot.stop();
});

await test('market cap over the limit: sale waits for OK, "sell" executes it', async () => {
  const { sim, bot } = setup(50, { MCAP_APPROVAL: '1000', AUTO_FIRST_SALE: '0' });
  await bot.start();
  const cur = sim.launch({ name: 'BIG', issuer: 'rBig', poolXrp: 100, poolTok: 1e9 });
  const k = `${cur}.rBig`;
  await settle(bot);
  sim.trade(cur, 'rBig', 150); // mcap ≈ 630 XRP ≈ $1,575
  await settle(bot);
  const pos = bot.state().positions[k];
  assert.ok(pos.ask, 'asks');
  assert.ok(pos.mcap > 1000 && pos.mcap < 3000, 'mcap in USD ' + pos.mcap);
  assert.equal(pos.tp1Done, false, 'nothing sold yet');
  assert.equal(sim.txs.filter((t) => t.TransactionType === 'Payment').length, 0, 'no sale yet');
  assert.ok(logs.join('\n').includes('Waiting for your OK'));
  await settle(bot);
  assert.equal(sim.txs.filter((t) => t.TransactionType === 'Payment').length, 0, 'still waiting');
  assert.equal(await bot.answer(k, 'sell'), 'sold');
  const m = bot.state().positions[k];
  assert.ok(m.tp1Done && m.proceeds >= m.cost && !m.ask, 'stake back after OK');
  bot.stop();
});

await test('"hold" makes it manual: no rule sells, a rug still does, buttons sell by hand', async () => {
  const { sim, bot } = setup(50, { MCAP_APPROVAL: '1000', AUTO_FIRST_SALE: '0' });
  await bot.start();
  const a = sim.launch({ name: 'LEGIT', issuer: 'rLeg', poolXrp: 100, poolTok: 1e9 });
  const b = sim.launch({ name: 'FAKE', issuer: 'rFak', poolXrp: 100, poolTok: 1e9 });
  await settle(bot);
  sim.trade(a, 'rLeg', 150); sim.trade(b, 'rFak', 150);
  await settle(bot);
  assert.equal(await bot.answer(`${a}.rLeg`, 'hold'), 'held');
  assert.equal(await bot.answer(`${b}.rFak`, 'hold'), 'held');
  sim.trade(a, 'rLeg', -130); // −50 % from entry value region, but the user owns the decision now
  await settle(bot);
  assert.ok(bot.state().positions[`${a}.rLeg`], 'manual: not sold by rules');
  assert.equal(await bot.answer(`${a}.rLeg`, 'sellall'), 'sold');
  assert.equal(bot.state().positions[`${a}.rLeg`], undefined, 'sold by hand');
  sim.amm[`${b}.rFak`].xrp = 50; // rug: pool XRP far below entry
  await settle(bot);
  assert.equal(bot.state().positions[`${b}.rFak`], undefined, 'rug sells even when manual');
  assert.ok(/rug/.test(bot.state().history[0].why));
  bot.stop();
});

await test('runner: big start + pool doubles fast → sale waits for OK; a small start does not', async () => {
  const { sim, bot } = setup(50, { AUTO_FIRST_SALE: '0' });
  await bot.start();
  const big = sim.launch({ name: 'RUNR', issuer: 'rRun', poolXrp: 350, poolTok: 1e9 });
  const small = sim.launch({ name: 'SMLL', issuer: 'rSml', poolXrp: 150, poolTok: 1e9 });
  await settle(bot);
  sim.trade(big, 'rRun', 400); // 350 → 750 XRP
  sim.trade(small, 'rSml', 200); // 150 → 350 XRP, but started below 300
  await settle(bot);
  const r = bot.state().positions[`${big}.rRun`];
  assert.ok(r.runner, 'marked as runner');
  assert.ok(r.mcap < 100000, 'market cap alone would not ask: $' + r.mcap.toFixed(0));
  assert.ok(r.ask && !r.tp1Done, 'waits for OK');
  assert.ok(logs.join('\n').includes('looks like a runner'));
  const s = bot.state().positions[`${small}.rSml`];
  assert.ok(!s.runner && s.tp1Done, 'small start sells by itself');
  bot.stop();
});

await test('no USD price available: asks to be safe; under the limit: sells by itself', async () => {
  const { sim, bot } = setup(50, { MCAP_APPROVAL: '1000', AUTO_FIRST_SALE: '0' }, false);
  await bot.start();
  const cur = sim.launch({ name: 'NOUSD', issuer: 'rNu', poolXrp: 100, poolTok: 1e9 });
  await settle(bot);
  sim.trade(cur, 'rNu', 150);
  await settle(bot);
  assert.ok(bot.state().positions[`${cur}.rNu`].ask, 'asks when USD is unknown');
  const t2 = setup(50, { MCAP_APPROVAL: '100000' });
  await t2.bot.start();
  const c2 = t2.sim.launch({ name: 'SMALL', issuer: 'rSm', poolXrp: 100, poolTok: 1e9 });
  await settle(t2.bot);
  t2.sim.trade(c2, 'rSm', 150);
  await settle(t2.bot);
  assert.equal(t2.bot.state().positions[`${c2}.rSm`].tp1Done, true, '$1.6k < $100k → automatic');
  bot.stop(); t2.bot.stop();
});

await test('auto first sale: stake back without asking, later sales of a big token still ask', async () => {
  const { sim, bot } = setup(50, { MCAP_APPROVAL: '1000', TRACK_WALLETS: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh:W' });
  await bot.start();
  const cur = sim.launch({ name: 'AUTO', issuer: 'rAu', poolXrp: 400, poolTok: 1e9, silent: true });
  sim.emit('transaction', {
    validated: true,
    tx_json: { TransactionType: 'Payment', Account: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', Fee: '12' },
    meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [
      { ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', Balance: '80000000' }, PreviousFields: { Balance: '100000012' } } },
      { CreatedNode: { LedgerEntryType: 'RippleState', NewFields: { Balance: { currency: cur, value: '3000000' }, LowLimit: { issuer: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh' }, HighLimit: { issuer: 'rAu' } } } },
    ] },
  });
  await settle(bot);
  const k = `${cur}.rAu`;
  sim.trade(cur, 'rAu', 300); // ~4x, market cap far above $1,000
  await settle(bot);
  const p1 = bot.state().positions[k];
  assert.ok(p1.tp1Done && !p1.ask, 'first sale went through without asking');
  sim.trade(cur, 'rAu', 300);
  await settle(bot);
  sim.trade(cur, 'rAu', -400); // trailing stop wants to sell the rest
  await settle(bot);
  const p2 = bot.state().positions[k];
  assert.ok(p2 && p2.ask, 'the second sale waits for OK');
  const st = bot.status().stats;
  assert.equal(st.copySignals, 1); assert.equal(st.bought, 1); assert.ok(st.asks >= 1);
  bot.stop();
});

await test('stats: launches, skips by reason, failed buys', async () => {
  const { sim, bot } = setup();
  await bot.start();
  sim.launch({ name: 'OK1', issuer: 'rOk1', poolXrp: 200, poolTok: 1e9 });
  sim.launch({ name: 'TINYS', issuer: 'rTs', poolXrp: 20, poolTok: 1e9 });
  sim.launch({ name: 'CLAWS', issuer: 'rCs', poolXrp: 200, poolTok: 1e9, flags: 0x00100000 | 0x80000000 });
  await settle(bot);
  const st = bot.status().stats;
  assert.equal(st.launches, 3);
  assert.equal(st.bought, 1);
  assert.equal(st.skipped['pool too small'], 1);
  assert.equal(st.skipped.clawback, 1);
  bot.stop();
});

await test('recorder: follows bought AND skipped launches, counts pool trades, samples over time, exports', async () => {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const { sim, bot } = setup();
    await bot.start();
    const ammOf = { rA1: 'rAmmA1', rB1: 'rAmmB1' };
    const launchWithAmm = (name, issuer, xrp, extra = {}) => {
      const currency = sim.launch({ name, issuer, poolXrp: xrp, poolTok: 1e9, silent: true, ...extra });
      sim.emit('transaction', {
        validated: true, ledger_index: 1000,
        tx_json: { TransactionType: 'AMMCreate', Account: 'rDEV', Amount: String(xrp * 1e6), Amount2: { currency, issuer, value: '1000000000' } },
        meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [{ CreatedNode: { LedgerEntryType: 'AccountRoot', NewFields: { Account: ammOf[issuer], AMMID: 'X', Balance: String(xrp * 1e6) } } }] },
      });
      return currency;
    };
    const poolTrade = (issuer, cur, xrp, who) => {
      const before = Math.round(sim.amm[`${cur}.${issuer}`].xrp * 1e6);
      sim.trade(cur, issuer, xrp);
      const after = Math.round(sim.amm[`${cur}.${issuer}`].xrp * 1e6);
      sim.emit('transaction', { validated: true, tx_json: { TransactionType: 'Payment', Account: who }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [{ ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: ammOf[issuer], Balance: String(after) }, PreviousFields: { Balance: String(before) } } }] } });
    };
    const a = launchWithAmm('GOOD', 'rA1', 200);
    const b = launchWithAmm('CLAWX', 'rB1', 200, { flags: 0x00100000 | 0x80000000 });
    await settle(bot);
    poolTrade('rA1', a, 50, 'rBuyer1'); poolTrade('rA1', a, 30, 'rBuyer2'); poolTrade('rA1', a, -20, 'rSeller');
    poolTrade('rB1', b, 300, 'rBuyer3'); // the skipped one runs 3x+ – exactly what the data should show
    offset = 2 * 60e3; await bot.rec.sample();
    offset = 61 * 60e3; await bot.rec.sample();
    const rows = bot.rec.rows();
    const ra = rows.find((r) => r.name === 'GOOD');
    const rb = rows.find((r) => r.name === 'CLAWX');
    assert.equal(ra.decision, 'bought'); assert.ok(ra.my_cost > 0 && ra.my_entryPrice > 0, 'my trade in the row');
    assert.equal(rb.decision, 'skipped'); assert.equal(rb.reason, 'clawback'); assert.equal(rb.clawback, true);
    assert.equal(ra.buys, 2, 'other traders (our own buy is not streamed in the sim)'); assert.equal(ra.sells, 1); assert.equal(ra.buyers, 2);
    assert.ok(rb.x_m1 > 3 && rb.x_h1 > 3 && rb.maxX > 3, 'skipped token outcome recorded: ' + rb.maxX);
    assert.ok(ra.x_h1 != null && ra.buys1h === 2);
    const csv = bot.rec.csv(rows);
    assert.ok(csv.split('\n')[0].includes('x_h1') && csv.includes('CLAWX'));
    const an = bot.rec.analysis(7);
    assert.ok(an.byDecision.find((g) => g.name === 'skipped: clawback').x2 === 100);
    assert.ok(an.byStart.find((g) => g.name === '200–300 XRP').n === 2);
    const ev = bot.rec.events().map((e) => e.type);
    for (const t of ['launch', 'decision', 'buy']) assert.ok(ev.includes(t), 'event ' + t);
    bot.stop();
  } finally { Date.now = realNow; }
});

await test('launch protection phase: frozen + fee + auth while not blackholed → waits, buys when lifted', async () => {
  const { sim, bot } = setup(50, { BLACKHOLE_WAIT_S: '1' }); // protection gets PROTECT_WAIT_MIN instead
  await bot.start();
  const cur = sim.launch({ name: 'SAFE', issuer: 'rSafe', poolXrp: 200, poolTok: 1e9, flags: 0x00800000 | 0x00400000 | 0x00040000, transferRate: 1200000000 });
  await settle(bot);
  await wait(1500); await settle(bot);
  assert.equal(bot.state().positions[`${cur}.rSafe`], undefined, 'still waiting after BLACKHOLE_WAIT_S');
  assert.ok(!logs.join('\n').includes('Skip SAFE'), 'not skipped');
  assert.ok(logs.join('\n').includes('launch protection?'));
  sim.acc.rSafe.Flags = 0x00800000 | 0x00100000; delete sim.acc.rSafe.TransferRate; // lifted + blackholed
  const t0 = Date.now();
  sim.emit('transaction', { validated: true, tx_json: { TransactionType: 'AccountSet', Account: 'rSafe' }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [] } });
  await settle(bot);
  assert.ok(bot.state().positions[`${cur}.rSafe`], 'bought right after the issuer tx');
  assert.ok(Date.now() - t0 < 2000, 'woke up at once, not at the next 4 s poll');
  assert.ok(logs.join('\n').includes('protection lifted'));
  const c2 = sim.launch({ name: 'AUTHX', issuer: 'rAuth', poolXrp: 200, poolTok: 1e9, flags: 0x00800000 | 0x00100000 | 0x00040000 });
  await settle(bot);
  assert.equal(bot.state().positions[`${c2}.rAuth`], undefined);
  assert.equal(bot.status().stats.skipped['trust lines need approval'], 1, 'blackholed + RequireAuth = final skip');
  bot.stop();
});

await test('buy blocked by a protection (no flags visible) → buys once the issuer lifts it; slippage is not retried', async () => {
  const { sim, bot } = setup();
  await bot.start();
  const blocked = new Set(['rBlk']);
  const orig = sim.submitAndWait.bind(sim);
  sim.submitAndWait = async (tx) => {
    if (tx.TransactionType === 'OfferCreate' && blocked.has(tx.TakerPays.issuer)) { sim.txs.push(tx); return { result: { meta: { TransactionResult: 'tecFROZEN' } } }; }
    return orig(tx);
  };
  const cur = sim.launch({ name: 'BLK', issuer: 'rBlk', poolXrp: 200, poolTok: 1e9 });
  await settle(bot);
  assert.equal(bot.state().positions[`${cur}.rBlk`], undefined);
  assert.ok(logs.join('\n').includes('buy blocked by a launch protection (tecFROZEN)'));
  await wait(4500); await settle(bot);
  assert.equal(bot.state().positions[`${cur}.rBlk`], undefined, 'no new try before the issuer acts');
  assert.equal(sim.txs.filter((t) => t.TransactionType === 'OfferCreate').length, 1);
  blocked.delete('rBlk');
  sim.emit('transaction', { validated: true, tx_json: { TransactionType: 'AccountSet', Account: 'rBlk' }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [] } });
  await settle(bot);
  assert.ok(bot.state().positions[`${cur}.rBlk`], 'bought after the protection');
  assert.equal(bot.status().stats.buyBlocked, 1);
  const row = bot.rec.rows().find((r) => r.name === 'BLK');
  assert.equal(row.decision, 'bought'); assert.equal(row.reason, 'after launch protection');
  bot.stop();
});

await test('settings change live: pause stops buys, unpause buys again, open trades still sell', async () => {
  const { sim, bot, cfg } = setup();
  await bot.start();
  const a = sim.launch({ name: 'PRE', issuer: 'rPre', poolXrp: 100, poolTok: 1e9 });
  await settle(bot);
  Object.assign(cfg, readConfig({ DATA_DIR: cfg.dataDir, PAUSE_BUYS: '1' }), { dataDir: cfg.dataDir });
  const b = sim.launch({ name: 'PAUSED', issuer: 'rPau', poolXrp: 100, poolTok: 1e9 });
  await settle(bot);
  assert.equal(bot.state().positions[`${b}.rPau`], undefined, 'no buy while paused');
  assert.ok(logs.join('\n').includes('buying is paused'));
  sim.trade(a, 'rPre', 150);
  await settle(bot);
  assert.ok(bot.state().positions[`${a}.rPre`].tp1Done, 'still sells while paused');
  Object.assign(cfg, readConfig({ DATA_DIR: cfg.dataDir, BUY_XRP: '2' }), { dataDir: cfg.dataDir });
  const c = sim.launch({ name: 'AFTER', issuer: 'rAft', poolXrp: 100, poolTok: 1e9 });
  await settle(bot);
  assert.ok(Math.abs(bot.state().positions[`${c}.rAft`].cost - 2) < 1e-3, 'buys again with the new stake');
  bot.stop();
});

console.log(`\n${passed} scenarios passed`);
process.exit(0);
