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

  launch({ name, issuer, poolXrp, poolTok, supply = poolTok, flags = 0x00800000 | 0x00100000, regularKey, transferRate, fee = 500 }) {
    const currency = hex(name);
    this.acc[issuer] = { Balance: '50000000', Flags: flags, OwnerCount: 0, RegularKey: regularKey, TransferRate: transferRate };
    this.amm[this.k(currency, issuer)] = { xrp: poolXrp, tok: poolTok, fee };
    this.supply[this.k(currency, issuer)] = supply;
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

function setup(balance = 50, env = {}) {
  const sim = new Sim(balance);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snipe-'));
  const cfg = readConfig({ DATA_DIR: dir, BLACKHOLE_WAIT_S: '6', ...env });
  const bot = createBot({ client: sim, wallet: { address: ME }, cfg, log: (m) => logs.push(m), fetchFn: null });
  return { sim, bot, cfg };
}

let passed = 0;
async function test(name, fn) {
  logs.length = 0;
  try { await fn(); passed++; console.log('✔', name); }
  catch (e) { console.log('✘', name, '\n', logs.join('\n')); throw e; }
}

await test('pump: take profit 50 %, then trailing stop, trust line removed', async () => {
  const { sim, bot } = setup();
  await bot.start();
  const cur = sim.launch({ name: 'PUMP', issuer: 'rIss1', poolXrp: 100, poolTok: 1e9 });
  await settle(bot);
  const pos = bot.state().positions[`${cur}.rIss1`];
  assert.ok(pos, 'bought');
  assert.ok(Math.abs(pos.cost - 1) < 1e-4, 'spent 1 XRP');
  sim.trade(cur, 'rIss1', 150); // price ~6x
  await settle(bot);
  assert.equal(bot.state().positions[`${cur}.rIss1`].tp1Done, true, 'first take profit');
  sim.trade(cur, 'rIss1', 200); // keeps pumping → peak rises
  await settle(bot);
  assert.ok(bot.state().positions[`${cur}.rIss1`], 'still riding');
  sim.trade(cur, 'rIss1', -300); // dump
  await settle(bot);
  assert.equal(bot.state().positions[`${cur}.rIss1`], undefined, 'closed by trailing stop');
  const h = bot.state().history[0];
  assert.ok(h.pnl > 0, 'profit ' + h.pnl);
  assert.ok(/trailing/.test(h.why));
  assert.equal(sim.lines[`${cur}.rIss1`], undefined, 'trust line deleted');
  assert.equal(sim.acc[ME].OwnerCount, 0);
  bot.stop();
});

await test('rug: dev pulls the pool → sell everything', async () => {
  const { sim, bot } = setup();
  await bot.start();
  const cur = sim.launch({ name: 'RUG', issuer: 'rIss2', poolXrp: 80, poolTok: 5e8 });
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
  for (const r of ['clawback', 'transfer fee 5.00%', 'pool only 5.0 XRP', '1% of supply', 'froze']) assert.ok(text.includes(r), 'reason ' + r);
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
  sim.submitAndWait = async (tx) => { if (tx.TransactionType === 'Payment') sim.trade(cur, 'rR', 100); return orig(tx); };
  await settle(bot);
  assert.equal(bot.state().positions[`${cur}.rR`], undefined);
  assert.equal(sim.lines[`${cur}.rR`], undefined, 'line removed');
  assert.ok(logs.join('\n').includes('Buy RUN failed'));
  bot.stop();
});

console.log(`\n${passed} scenarios passed`);
process.exit(0);
