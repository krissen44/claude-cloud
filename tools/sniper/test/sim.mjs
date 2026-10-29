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
      return { result: { amm: { account: p.account, amount: String(Math.round(p.xrp * D)), amount2: { ...r.asset2, value: String(p.tok) }, trading_fee: p.fee } } };
    }
    if (c === 'account_lines') {
      const lines = Object.entries(this.lines).filter(([k]) => !r.peer || k.endsWith('.' + r.peer)).map(([k, b]) => ({ currency: k.split('.')[0], account: k.split('.')[1], balance: String(b) }));
      return { result: { lines } };
    }
    if (c === 'account_tx') return { result: { transactions: (this.history?.[r.account] || []) } };
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
    if (tx.TransactionType === 'Payment' && tx.Destination !== ME) {
      // tokens back to their issuer (burn)
      const k = this.k(tx.Amount.currency, tx.Amount.issuer);
      me.Balance = String(Number(me.Balance) - fee);
      if (tx.Destination !== tx.Amount.issuer || !(this.lines[k] > 0)) return res('tecPATH_DRY');
      if (this.needTag?.has(tx.Destination) && tx.DestinationTag == null) return res('tecDST_TAG_NEEDED');
      this.burned = (this.burned || 0) + Number(tx.Amount.value);
      this.lines[k] = Math.max(0, this.lines[k] - Number(tx.Amount.value));
      return res('tesSUCCESS');
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
  const cfg = readConfig({ DATA_DIR: dir, BLACKHOLE_WAIT_S: '6', POOL_WAIT_MIN: '0', SUPPLY_WAIT_S: '0', ...env });
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

await test('crowd entry: a skipped launch (dev holds the supply, not blackholed) that draws 100+ buyers and 500+ XRP is bought; a rug-sized crowd is not', async () => {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const { sim, bot } = setup(100, { BUY_XRP: '5' });
    await bot.start();
    const ammOf = {};
    const launchWithAmm = (name, issuer, xrp, extra = {}) => {
      ammOf[issuer] = 'rAmm' + name;
      const currency = sim.launch({ name, issuer, poolXrp: xrp, poolTok: 1e7, silent: true, ...extra });
      sim.emit('transaction', {
        validated: true, ledger_index: 2000,
        tx_json: { TransactionType: 'AMMCreate', Account: 'rDEV', Amount: String(xrp * 1e6), Amount2: { currency, issuer, value: '10000000' } },
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
    // like UBER: 1 % of the supply in the pool, issuer not blackholed
    const u = launchWithAmm('UBERX', 'rUber', 140, { supply: 1e9, flags: 0x00800000 });
    const r = launchWithAmm('RUGGY', 'rRug', 50, { supply: 1e9 });
    await settle(bot);
    assert.equal(bot.state().positions[`${u}.rUber`], undefined, 'skipped at launch');
    assert.equal(bot.rec.rows().find((x) => x.name === 'UBERX').reason, 'dev holds the supply');
    for (let i = 0; i < 120; i++) poolTrade('rUber', u, 6, 'rB' + i); // a real crowd
    for (let i = 0; i < 15; i++) poolTrade('rRug', r, 3, 'rR' + i); // the rugs in the data had 11–23 buyers
    offset = 5 * 60e3; await bot.rec.sample();
    await bot.tick(); await settle(bot);
    const pos = bot.state().positions[`${u}.rUber`];
    assert.ok(pos, 'crowd entry bought it');
    assert.equal(pos.copy, 'crowd', 'classic exits');
    assert.equal(bot.state().positions[`${r}.rRug`], undefined, 'no entry for a small crowd');
    assert.match(bot.rec.rows().find((x) => x.name === 'UBERX').reason, /^crowd entry: 120 buyers/);
    assert.ok(logs.join('\n').includes('👥 UBERX'));
    // once only
    await bot.tick(); await settle(bot);
    assert.equal(sim.txs.filter((t) => t.TransactionType === 'OfferCreate' && t.TakerPays.issuer === 'rUber').length, 1);
    bot.stop();
  } finally { Date.now = realNow; }
});

await test('after a launch protection: skipped if the early buyers already pumped it above PROTECT_MAX_X', async () => {
  const { sim, bot } = setup(50, { BLACKHOLE_WAIT_S: '1' });
  await bot.start();
  const cur = sim.launch({ name: 'PUMPD', issuer: 'rPmp', poolXrp: 50, poolTok: 1e9, flags: 0x00800000 | 0x00040000 });
  await settle(bot);
  sim.trade(cur, 'rPmp', 200); // authorized early buyers: pool 50 → 250 XRP ≈ 25× the price
  sim.acc.rPmp.Flags = 0x00800000 | 0x00100000;
  sim.emit('transaction', { validated: true, tx_json: { TransactionType: 'AccountSet', Account: 'rPmp' }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [] } });
  await settle(bot);
  assert.equal(bot.state().positions[`${cur}.rPmp`], undefined, 'not bought at the top');
  assert.ok(logs.join('\n').includes('when the protection ended (max 12×)'));
  assert.equal(bot.status().stats.skipped['pumped during protection'], 1);
  bot.stop();
});

const openLedgerLaunch = (sim, name, issuer, poolXrp, poolTok, extra = {}) => {
  const currency = sim.launch({ name, issuer, poolXrp, poolTok, silent: true, ...extra });
  const tx = { TransactionType: 'AMMCreate', Account: 'rDEV', Amount: String(poolXrp * D), Amount2: { currency, issuer, value: String(poolTok) }, TradingFee: 500 };
  sim.emit('transaction', { validated: false, engine_result: 'tesSUCCESS', ledger_current_index: 5001, tx_json: tx });
  return { currency, validate: () => sim.emit('transaction', { validated: true, ledger_index: 5001, hash: 'V' + name, tx_json: tx, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [] } }) };
};

await test('first buyers: a launch seen in the open ledger is checked there and bought before it is validated', async () => {
  const { sim, bot } = setup();
  const subs = [];
  const orig = sim.request.bind(sim);
  sim.request = async (r) => { if (r.command === 'subscribe') subs.push(...r.streams); return orig(r); };
  await bot.start();
  assert.deepEqual(subs, ['transactions_proposed']);
  const { currency, validate } = openLedgerLaunch(sim, 'FIRST', 'rFst', 200, 1e9);
  await settle(bot);
  assert.ok(bot.state().positions[`${currency}.rFst`], 'bought from the open ledger');
  assert.ok(logs.join('\n').includes('⚡'));
  validate(); await settle(bot); // the validated copy is not a second launch
  assert.equal(sim.txs.filter((t) => t.TransactionType === 'OfferCreate').length, 1);
  assert.equal(bot.status().stats.launches, 1);
  bot.stop();
});

await test('first buyers: landed before the pool existed → once more right after the launch is validated', async () => {
  const { sim, bot } = setup();
  await bot.start();
  let first = true;
  const orig = sim.submitAndWait.bind(sim);
  sim.submitAndWait = async (tx) => {
    if (tx.TransactionType === 'OfferCreate' && first) { first = false; sim.txs.push(tx); return { result: { meta: { TransactionResult: 'tecKILLED' } } }; }
    return orig(tx);
  };
  const { currency, validate } = openLedgerLaunch(sim, 'EARLY', 'rEar', 200, 1e9);
  await settle(bot);
  assert.equal(bot.state().positions[`${currency}.rEar`], undefined, 'first try missed');
  validate(); await settle(bot);
  assert.ok(bot.state().positions[`${currency}.rEar`], 'bought on the second try');
  assert.equal(bot.status().stats.fastRetry, 1);
  bot.stop();
});

await test('buy by share of the supply: 1 % of all tokens, capped at BUY_MAX_XRP', async () => {
  const { sim, bot } = setup(100, { BUY_SUPPLY_PCT: '1', BUY_MAX_XRP: '10' });
  await bot.start();
  const a = sim.launch({ name: 'ONEPCT', issuer: 'rOne', poolXrp: 200, poolTok: 1e9 }); // whole supply in the pool
  await settle(bot);
  const pa = bot.state().positions[`${a}.rOne`];
  assert.ok(pa && Math.abs(pa.amount / 1e9 - 0.01) < 0.0005, '≈ 1 % of the supply: ' + (pa && pa.amount));
  assert.ok(pa.cost > 2 && pa.cost < 2.2, 'cost ≈ 2 XRP for 1 % of a 200 XRP pool: ' + pa.cost);
  const b = sim.launch({ name: 'BIGPOOL', issuer: 'rBig', poolXrp: 3000, poolTok: 1e9 }); // 1 % would cost ≈ 30 XRP
  await settle(bot);
  const pb = bot.state().positions[`${b}.rBig`];
  assert.ok(pb && pb.cost <= 10.01, 'capped: ' + (pb && pb.cost));
  assert.ok(logs.join('\n').includes('% of the supply'));
  bot.stop();
});

await test('chart health: steady climb with buyers is healthy; a dump, lower lows or pulled liquidity are not', async () => {
  const { chartHealth } = await import('../chart.mjs');
  const T = 1e12;
  const mk = (prices, xrps, flows) => prices.map((pr, i) => ({ at: T + i * 30e3, price: pr, xrp: xrps[i], flow: flows ? flows[i] : null }));
  const n = 12;
  const up = mk([...Array(n)].map((_, i) => 1 + i * 0.03), [...Array(n)].map((_, i) => 200 + i * 5), [...Array(n)].map((_, i) => ({ buys: i * 4, sells: i, buyers: i * 3, lpRemove: 0 })));
  const healthy = chartHealth(up, T + (n - 1) * 30e3).score;
  assert.ok(healthy >= 80, 'climb: ' + healthy);
  const dump = mk([...Array(n)].map((_, i) => 1.3 - i * 0.05), [...Array(n)].map((_, i) => 260 - i * 8), [...Array(n)].map((_, i) => ({ buys: i, sells: i * 4, buyers: i, lpRemove: 0 })));
  assert.ok(chartHealth(dump, T + (n - 1) * 30e3).score < 40, 'dump');
  const pulled = up.map((x, i) => ({ ...x, flow: { ...x.flow, lpRemove: i > 8 ? 50 : 0 } }));
  assert.ok(chartHealth(pulled, T + (n - 1) * 30e3).score < healthy - 30, 'liquidity pulled');
  assert.equal(chartHealth(up.slice(0, 2), T + 30e3), null, 'too little chart → no opinion');
});

await test('chart learner: bad holds raise the score needed, good ones lower it slowly; a settings change restarts', async () => {
  const { createChartLearner } = await import('../chart.mjs');
  let t = 0;
  const cfg = { chartHoldScore: 70, chartAddScore: 80, chartLearn: true };
  const state = {};
  const L = createChartLearner(state, cfg, { now: () => t });
  assert.equal(L.th('hold'), 70);
  for (let i = 0; i < 4; i++) L.note('hold', { k: 'K' + i, currency: 'C', issuer: 'I' }, 1, 75);
  t += 21 * 60e3;
  await L.evaluate(async () => 0.5); // price halved after every hold → bad calls
  assert.equal(L.th('hold'), 75);
  for (let i = 0; i < 12; i++) L.note('hold', { k: 'G' + i, currency: 'C', issuer: 'I' }, 1, 80);
  t += 21 * 60e3;
  await L.evaluate(async () => 2);
  assert.ok(L.th('hold') < 75, 'good calls lower it: ' + L.th('hold'));
  cfg.chartHoldScore = 60;
  assert.equal(L.th('hold'), 60, 'new setting = new start');
});

await test('chart in the bot: healthy climb → buys more once and holds instead of taking the stake back; the dump sells', async () => {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const { sim, bot } = setup(100, { BUY_XRP: '2', CHART_ADD_XRP: '1' });
    await bot.start();
    const cur = sim.launch({ name: 'HEALTH', issuer: 'rHlt', poolXrp: 200, poolTok: 1e9 });
    await settle(bot);
    const k = `${cur}.rHlt`;
    assert.ok(bot.state().positions[k], 'bought');
    for (let i = 0; i < 16; i++) { offset += 30e3; sim.trade(cur, 'rHlt', 14); await bot.tick(); await settle(bot); }
    const pos = bot.state().positions[k];
    assert.equal(pos.adds, 1, 'bought more exactly once');
    assert.ok(pos.cost > 2.9, 'stake grew: ' + pos.cost);
    assert.ok(pos.value / pos.cost >= 2, 'over +100 %: ' + (pos.value / pos.cost));
    assert.equal(pos.tp1Done, false, 'stake back postponed – chart healthy');
    assert.ok(pos.holding, 'holding');
    assert.ok(logs.join('\n').includes('chart healthy'));
    for (let i = 0; i < 6; i++) { offset += 30e3; sim.trade(cur, 'rHlt', -60); await bot.tick(); await settle(bot); }
    const after = bot.state().positions[k];
    assert.ok(!after || after.tp1Done, 'sold once the chart turned');
    assert.ok(bot.status().stats.chartHolds >= 1 && bot.status().stats.chartAdds === 1);
    bot.stop();
  } finally { Date.now = realNow; }
});

await test('status page actions: sell 25 %, buy more, buy a token by link / NAME.rIssuer / issuer, clawback refused', async () => {
  const { sim, bot } = setup(100);
  await bot.start();
  const cur = sim.launch({ name: 'HANDY', issuer: 'rHnd', poolXrp: 200, poolTok: 1e9 });
  await settle(bot);
  const k = `${cur}.rHnd`;
  const a0 = bot.state().positions[k].amount;
  assert.match(await bot.answer(k, 'sellpct', { pct: '25' }), /sold 25%/);
  assert.ok(Math.abs(bot.state().positions[k].amount - a0 * 0.75) < a0 * 0.01, '25 % gone');
  const c0 = bot.state().positions[k].cost;
  assert.match(await bot.answer(k, 'buymore', { xrp: '2' }), /bought 2\.\d+ XRP more/);
  assert.ok(bot.state().positions[k].cost > c0 + 1.9, 'stake grew');
  assert.match(await bot.answer(k, 'buymore', { xrp: 'abc' }), /amount/);
  // buy by hand – not launched while we watched, launch filters don't apply (only 5 % of the supply in the pool)
  const c2 = sim.launch({ name: 'OLDIE', issuer: 'rHandBuy1111111111111111111111', poolXrp: 300, poolTok: 1e8, supply: 2e9, silent: true });
  assert.match(await bot.answer('OLDIE.rHandBuy1111111111111111111111', 'buy', { xrp: '3' }), /OLDIE: bought/);
  const p2 = bot.state().positions[`${c2}.rHandBuy1111111111111111111111`];
  assert.ok(p2 && p2.byHand && Math.abs(p2.cost - 3) < 0.01);
  const c3 = sim.launch({ name: 'LINKY', issuer: 'rLinkBuy1111111111111111111111', poolXrp: 300, poolTok: 1e8, silent: true });
  assert.match(await bot.answer(`https://firstledger.net/token/rLinkBuy1111111111111111111111/${c3}`, 'buy', { xrp: '1' }), /LINKY: bought/);
  // the link format FirstLedger uses today (language + token-v2): already held → buys more
  assert.match(await bot.answer(`https://firstledger.net/de/token-v2/rLinkBuy1111111111111111111111/${c3}`, 'buy', { xrp: '1' }), /LINKY: bought 1\.\d+ XRP more/);
  const c4 = sim.launch({ name: 'SOLO', issuer: 'rSoBuy111111111111111111111111', poolXrp: 300, poolTok: 1e8, silent: true });
  assert.match(await bot.answer('rSoBuy111111111111111111111111', 'buy', { xrp: '1' }), /SOLO: bought/);
  assert.ok(bot.state().positions[`${c4}.rSoBuy111111111111111111111111`]);
  sim.launch({ name: 'CLAWY', issuer: 'rCawzBuy1111111111111111111111', poolXrp: 300, poolTok: 1e8, flags: 0x00100000 | 0x80000000, silent: true });
  assert.match(await bot.answer('CLAWY.rCawzBuy1111111111111111111111', 'buy', { xrp: '1' }), /not bought – clawback/);
  assert.match(await bot.answer('nonsense', 'buy', { xrp: '1' }), /paste a FirstLedger link/);
  assert.match(await bot.answer(k, 'hold'), /held/);
  assert.equal(bot.state().positions[k].manual, true);
  const st = bot.status();
  assert.ok(Array.isArray(st.open[0].spark) && st.open[0].hist === undefined, 'page gets a small price line, not the whole history');
  bot.stop();
});

await test('clean-up: a dead pool\'s tokens go back to the issuer and the line is deleted; dust and empty lines too; real holdings stay', async () => {
  const { sim, bot } = setup(100);
  await bot.start();
  const cur = sim.launch({ name: 'SWELLY', issuer: 'rSwl', poolXrp: 300, poolTok: 1e9 });
  await settle(bot);
  const k = `${cur}.rSwl`;
  assert.ok(sim.lines[k] > 0, 'holding tokens');
  const owners = sim.acc[ME].OwnerCount;
  delete sim.amm[k]; // rug: the dev withdrew the whole pool
  await bot.tick(); await settle(bot);
  assert.equal(bot.state().positions[k], undefined, 'closed');
  assert.equal(k in sim.lines, false, 'line deleted');
  assert.ok(sim.burned > 0, 'tokens sent back to the issuer');
  assert.equal(sim.acc[ME].OwnerCount, owners - 1, 'reserve free');
  // leftovers from before: an empty line, dust, a dead token with a tag-requiring issuer, and a real holding
  const mk = (name, iss, xrp, bal) => { const c = sim.launch({ name, issuer: iss, poolXrp: xrp, poolTok: 1e9, silent: true }); sim.lines[`${c}.${iss}`] = bal; sim.acc[ME].OwnerCount++; return `${c}.${iss}`; };
  const empty = mk('EMPTYL', 'rEmp', 100, 0);
  const dust = mk('DUSTY', 'rDst', 100, 1e5); // worth ≈ 0.01 XRP
  const dead = mk('DEADY', 'rDed', 100, 5e6); delete sim.amm[dead];
  sim.needTag = new Set(['rDed']);
  const keep = mk('KEEPER', 'rKep', 1000, 5e7); // worth ≈ 47 XRP – could be yours
  assert.match(await bot.answer('-', 'cleanup'), /3 trust line/);
  for (const x of [empty, dust, dead]) assert.equal(x in sim.lines, false, 'cleared ' + x);
  assert.ok(sim.lines[keep] === 5e7, 'real holding untouched');
  assert.equal(bot.status().cleanup.cleared, 4);
  assert.ok(Math.abs(bot.status().cleanup.freed - 0.8) < 1e-9);
  bot.stop();
});

await test('smart wallets: a wallet that buys early and sells with profit across launches is found and copied; a loser is not', async () => {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const SMART = 'rSmartTrader11111111111111111111', DUMB = 'rDumbTrader111111111111111111111';
    const { sim, bot } = setup(100, { COPY_BUY_XRP: '2', AUTO_MIN_LAUNCHES: '3', AUTO_MIN_PNL: '5', MIN_POOL_SUPPLY_PCT: '0' });
    await bot.start();
    const amm = {};
    const trade = (issuer, cur, xrp, who) => {
      const before = Math.round(sim.amm[`${cur}.${issuer}`].xrp * 1e6);
      sim.trade(cur, issuer, xrp);
      const after = Math.round(sim.amm[`${cur}.${issuer}`].xrp * 1e6);
      sim.emit('transaction', { validated: true, tx_json: { TransactionType: 'Payment', Account: who }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [{ ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: amm[issuer], Balance: String(after) }, PreviousFields: { Balance: String(before) } } }] } });
    };
    for (let i = 0; i < 3; i++) {
      const iss = `rLaunch${i}xxxxxxxxxxxxxxxxxxxxx`;
      amm[iss] = 'rAmmL' + i;
      const cur = sim.launch({ name: 'LCH' + i, issuer: iss, poolXrp: 50, poolTok: 1e9, silent: true });
      sim.emit('transaction', { validated: true, ledger_index: 3000 + i, tx_json: { TransactionType: 'AMMCreate', Account: 'rDEV', Amount: String(50e6), Amount2: { currency: cur, issuer: iss, value: '1000000000' } }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [{ CreatedNode: { LedgerEntryType: 'AccountRoot', NewFields: { Account: amm[iss], AMMID: 'X', Balance: String(50e6) } } }] } });
      trade(iss, cur, 10, SMART); // early buy
      trade(iss, cur, 40, 'rCrowd' + i); // others pump it
      trade(iss, cur, 30, DUMB); // late buy at the top
      trade(iss, cur, -18, SMART); // smart sells: out 18 > in 10
      trade(iss, cur, -10, DUMB); // dumb sells at a loss: out 10 < in 30
    }
    await settle(bot);
    offset = 3.1 * 3600e3; await bot.rec.sample();
    const ws = bot.rec.wallets();
    const smart = ws.find((w) => w.wallet === SMART), dumb = ws.find((w) => w.wallet === DUMB);
    assert.ok(smart && smart.launches === 3 && smart.winRate === 1 && smart.pnl > 20 && smart.early === 3, JSON.stringify(smart));
    assert.ok(dumb && dumb.pnl < 0 && dumb.winRate === 0);
    bot._refreshSmart();
    const sm = bot.status().smart;
    assert.deepEqual(sm.copying.map((c) => c.wallet), [SMART], 'only the good trader is copied');
    // the smart wallet buys a new token → the bot copies it
    const cur = sim.launch({ name: 'NEXTUP', issuer: 'rNext', poolXrp: 400, poolTok: 1e9, silent: true });
    sim.emit('transaction', { validated: true, hash: 'SMARTBUY', tx_json: { TransactionType: 'Payment', Account: SMART, Fee: '12' }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [
      { ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: SMART, Balance: '80000000' }, PreviousFields: { Balance: '100000012' } } },
      { ModifiedNode: { LedgerEntryType: 'RippleState', FinalFields: { Balance: { currency: cur, value: '-50000000' }, LowLimit: { issuer: 'rNext' }, HighLimit: { issuer: SMART } }, PreviousFields: { Balance: { currency: cur, value: '0' } } } },
    ] } });
    await settle(bot);
    const pos = bot.state().positions[`${cur}.rNext`];
    assert.ok(pos && /🕵️/.test(pos.copy), 'copied the smart wallet: ' + (pos && pos.copy));
    // never: ban → no longer copied; pin works for any wallet
    assert.match(await bot.answer(SMART, 'wban'), /never copied/);
    assert.equal(bot.status().smart.copying.length, 0);
    assert.match(await bot.answer(DUMB, 'wpin'), /copied from now on/);
    assert.deepEqual(bot.status().smart.copying.map((c) => c.wallet), [DUMB]);
    bot.stop();
  } finally { Date.now = realNow; }
});

await test('FirstLedger two-step launch: pool created with 1 % of the supply, the rest deposited seconds later → bought right after the deposit', async () => {
  const { sim, bot } = setup(100, { SUPPLY_WAIT_S: '30', MIN_POOL_XRP: '20' });
  await bot.start();
  const iss = 'rCross11111111111111111111111111';
  const cur = sim.launch({ name: 'CROSSY', issuer: iss, poolXrp: 30, poolTok: 1000, supply: 100000, silent: true });
  const create = { TransactionType: 'AMMCreate', Account: 'rDEV', Amount: '30000000', Amount2: { currency: cur, issuer: iss, value: '1000' } };
  sim.emit('transaction', { validated: true, ledger_index: 7000, hash: 'CR1', tx_json: create, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [{ CreatedNode: { LedgerEntryType: 'AccountRoot', NewFields: { Account: 'rAmmCross', AMMID: 'X', Balance: '30000000' } } }] } });
  await settle(bot);
  const k = `${cur}.${iss}`;
  assert.equal(bot.state().positions[k], undefined, 'not bought at the 1 % pool (100× too expensive)');
  assert.ok(!logs.join('\n').includes('Skip CROSSY'), 'not skipped either');
  assert.ok(logs.join('\n').includes('waiting up to 30s'));
  // the dev deposits the other 99 % – seen in the open ledger first
  sim.amm[k].tok += 99000;
  const dep = { TransactionType: 'AMMDeposit', Account: 'rDEV', Asset: { currency: 'XRP' }, Asset2: { currency: cur, issuer: iss }, Amount: { currency: cur, issuer: iss, value: '99000' } };
  const t0 = Date.now();
  sim.emit('transaction', { validated: false, engine_result: 'tesSUCCESS', ledger_current_index: 7002, tx_json: dep });
  await settle(bot);
  const pos = bot.state().positions[k];
  assert.ok(pos, 'bought right after the deposit');
  assert.ok(Date.now() - t0 < 1500, 'at once, not at the next poll');
  assert.ok(pos.amount > 1000, 'at the real price: ' + pos.amount);
  // the recorder takes the price after the deposit as the start
  sim.emit('transaction', { validated: true, ledger_index: 7002, hash: 'DEP1', tx_json: dep, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [{ ModifiedNode: { LedgerEntryType: 'RippleState', FinalFields: { Balance: { currency: cur, value: '-100000' }, LowLimit: { issuer: iss }, HighLimit: { issuer: 'rAmmCross' } }, PreviousFields: { Balance: { currency: cur, value: '-1000' } } } }] } });
  const row = bot.rec.rows().find((r) => r.name === 'CROSSY');
  assert.ok(Math.abs(row.startPrice - 30 / 100000) < 1e-9, 'start price after the deposit: ' + row.startPrice);
  assert.equal(bot.status().stats.supplyDeposited, 1);
  bot.stop();
});

await test('low supply share and no deposit comes → skipped after SUPPLY_WAIT_S', async () => {
  const { sim, bot } = setup(100, { SUPPLY_WAIT_S: '1', MIN_POOL_XRP: '20' });
  await bot.start();
  const cur = sim.launch({ name: 'NODEP', issuer: 'rNoDep1111111111111111111111111', poolXrp: 50, poolTok: 1e7, supply: 1e9 });
  await settle(bot);
  assert.ok(!logs.join('\n').includes('Skip NODEP'));
  await wait(2500); await settle(bot);
  assert.ok(logs.join('\n').includes('Skip NODEP: only 1% of supply'), 'skipped after the wait');
  assert.equal(bot.state().positions[`${cur}.rNoDep1111111111111111111111111`], undefined);
  bot.stop();
});

await test('analyze a launch: whole pool history → early sniper of a big launch gets a big hit (held tokens count), dev bundle is ignored', async () => {
  const { sim, bot } = setup(100, { AUTO_BIG_HITS: '1' });
  await bot.start();
  const iss = 'rBigssuer11111111111111111111111', AMM = 'rAmmBigPoo1111111111111111111111', DEV = 'rDevWa11etAAAAAAAAAAAAAAAAAAAAAA';
  const SNIPER = 'rSnipe1111111111111111111111111', BUNDLE = 'rDevWa1zzzzzzzzzzzzzzzzzzzzzzzz', LATE = 'rLateBuyer11111111111111111111111';
  const cur = sim.launch({ name: 'BIGGY', issuer: iss, poolXrp: 1000, poolTok: 1e6, silent: true });
  sim.amm[`${cur}.${iss}`].account = AMM;
  let xrp = 0, tok = 0, t = 800000000;
  const step = (type, who, dx, dt, dtS = 5) => {
    const nodes = [];
    nodes.push(xrp === 0 && dx > 0 ? { CreatedNode: { LedgerEntryType: 'AccountRoot', NewFields: { Account: AMM, Balance: String(dx * D) } } } : { ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: AMM, Balance: String((xrp + dx) * D) }, PreviousFields: { Balance: String(xrp * D) } } });
    nodes.push(tok === 0 ? { CreatedNode: { LedgerEntryType: 'RippleState', NewFields: { Balance: { currency: cur, value: String(-(tok + dt)) }, LowLimit: { issuer: iss }, HighLimit: { issuer: AMM } } } } : { ModifiedNode: { LedgerEntryType: 'RippleState', FinalFields: { Balance: { currency: cur, value: String(-(tok + dt)) }, LowLimit: { issuer: iss }, HighLimit: { issuer: AMM } }, PreviousFields: { Balance: { currency: cur, value: String(-tok) } } } });
    xrp += dx; tok += dt; t += dtS;
    return { tx: { TransactionType: type, Account: who, date: t }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: nodes } };
  };
  const hist = [
    step('AMMCreate', DEV, 50, 1e4),
    step('AMMDeposit', DEV, 0, 99e4), // FirstLedger: the rest of the supply
    step('Payment', BUNDLE, 40, -440000), // the dev's own bundle buys first
    step('Payment', SNIPER, 10, -60000), // our sniper, 10 s in – and keeps them
    step('Payment', 'rCrowdA1111111111111111111111111', 400, -250000, 300),
    step('Payment', 'rCrowdB1111111111111111111111111', 500, -110000, 600),
    step('Payment', LATE, 50, -8000, 900), // late at the top …
    step('Payment', LATE, -20, 8000, 60), // … and out at a loss
  ];
  sim.history = { [AMM]: hist };
  sim.amm[`${cur}.${iss}`].xrp = xrp; sim.amm[`${cur}.${iss}`].tok = tok;
  const r = await bot.answer(`https://firstledger.net/de/token-v2/${iss}/${cur}`, 'analyze');
  assert.match(r, /BIGGY: .*🚀 big launch/, r);
  const ws = bot.rec.wallets();
  const sn = ws.find((w) => w.wallet === SNIPER);
  assert.ok(sn && sn.bigHits === 1 && sn.pnl > 50, 'held tokens count at today\'s price: ' + JSON.stringify(sn));
  assert.equal(ws.find((w) => w.wallet === BUNDLE), undefined, 'dev bundle ignored');
  assert.equal(ws.find((w) => w.wallet === DEV), undefined);
  const late = ws.find((w) => w.wallet === LATE);
  assert.ok(late && late.bigHits === 0 && late.pnl < 0);
  assert.ok(bot.status().smart.copying.some((c) => c.wallet === SNIPER), 'sniper copied');
  assert.match(await bot.answer(`BIGGY.${iss}`, 'analyze'), /already/);
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
