// Offline test of the arbitrage bot: a simulated ledger with AMM pools that understands the bot's
// signed Batch transactions (decoded from the blob) and runs them all-or-nothing.
//   node test/arb-sim.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet, decode } from 'xrpl';
import { createArb, readArbConfig } from '../arb/bot.mjs';
import { swapOut } from '../arb/engine.mjs';

const D = 1e6;
const key = (a) => (typeof a === 'string' || a.currency === 'XRP' ? 'XRP' : `${a.currency}.${a.issuer}`);

class Ledger {
  constructor(wallet, balance) {
    this.me = wallet.address;
    this.acct = { balance, seq: 100, owners: 0 };
    this.lines = new Map(); // token key → balance
    this.pools = new Map();
    this.handlers = {};
    this.index = 1000;
    this.sent = [];
    this.beforeApply = null;
  }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); }
  emit(ev, x) { for (const fn of this.handlers[ev] || []) fn(x); }
  pool(id, a, b, ra, rb, fee = 0.003) { this.pools.set(id, { id, a, b, ra, rb, fee }); }
  find(x, y) { for (const p of this.pools.values()) if ((p.a === x && p.b === y) || (p.a === y && p.b === x)) return p; return null; }
  res(p, k) { return p.a === k ? 'ra' : 'rb'; }
  nodesFor(p) {
    const nodes = [];
    for (const side of ['a', 'b']) {
      const k = p[side], v = p['r' + side];
      if (k === 'XRP') nodes.push({ ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: p.id, Balance: String(Math.round(v * D)) }, PreviousFields: { Balance: '1' } } });
      else { const [c, i] = k.split('.'); nodes.push({ ModifiedNode: { LedgerEntryType: 'RippleState', FinalFields: { Balance: { currency: c, value: String(-v) }, LowLimit: { issuer: i }, HighLimit: { issuer: p.id } }, PreviousFields: { Balance: { currency: c, value: '0' } } } }); }
    }
    return nodes;
  }
  // someone else trades `amount` of asset `from` into pool p
  trade(id, from, amount) {
    const p = this.pools.get(id);
    const to = p.a === from ? 'b' : 'a';
    const fr = p.a === from ? 'a' : 'b';
    const out = swapOut(amount, p['r' + fr], p['r' + to], p.fee);
    p['r' + fr] += amount; p['r' + to] -= out;
    this.index++;
    this.emit('transaction', { validated: true, ledger_index: this.index, hash: 'T' + this.index, tx_json: { TransactionType: 'Payment', Account: 'rSomeone' }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: this.nodesFor(p) } });
  }

  // run a path payment on a copy of the pools; returns {ok, spent, got, touched}
  pay(pools, route, { exactOut, maxIn, partialIn, minOut }) {
    const hops = [];
    for (let i = 0; i < route.length - 1; i++) {
      const p = [...pools.values()].find((q) => (q.a === route[i] && q.b === route[i + 1]) || (q.b === route[i] && q.a === route[i + 1]));
      if (!p) return { ok: false };
      hops.push({ p, from: route[i], to: route[i + 1] });
    }
    let input;
    if (exactOut != null) {
      let need = exactOut;
      for (const h of [...hops].reverse()) {
        const rin = h.p[this.res(h.p, h.from)], rout = h.p[this.res(h.p, h.to)];
        if (need >= rout) return { ok: false };
        need = (rin * need) / ((rout - need) * (1 - h.p.fee));
      }
      if (need > maxIn + 1e-9) return { ok: false };
      input = need;
    } else input = partialIn;
    let amt = input;
    for (const h of hops) {
      const fi = this.res(h.p, h.from), ti = this.res(h.p, h.to);
      const out = swapOut(amt, h.p[fi], h.p[ti], h.p.fee);
      h.p[fi] += amt; h.p[ti] -= out; amt = out;
    }
    if (minOut != null && amt < minOut) return { ok: false };
    return { ok: true, spent: input, got: exactOut ?? amt, touched: hops.map((h) => h.p) };
  }

  async request(r) {
    const c = r.command;
    const ok = (result) => ({ result });
    if (c === 'subscribe') return ok({});
    if (c === 'server_info') return ok({ info: { validated_ledger: { reserve_base_xrp: 1, reserve_inc_xrp: 0.2, seq: this.index } } });
    if (c === 'account_info' && r.account !== this.me) return ok({ account_data: { Account: r.account, Flags: 0, ...(this.issuerFee?.[r.account] ? { TransferRate: 1e9 * (1 + this.issuerFee[r.account]) } : {}) } });
    if (c === 'account_info') return ok({ account_data: { Account: this.me, Balance: String(Math.round(this.acct.balance * D)), Sequence: this.acct.seq, OwnerCount: this.acct.owners } });
    if (c === 'account_lines') return ok({ lines: [...this.lines.keys()].map((k) => ({ currency: k.split('.')[0], account: k.split('.')[1], balance: String(this.lines.get(k)) })) });
    if (c === 'ledger_data') {
      const as = (k) => (k === 'XRP' ? { currency: 'XRP' } : { currency: k.split('.')[0], issuer: k.split('.')[1] });
      return ok({ state: [...this.pools.values()].map((p) => ({ LedgerEntryType: 'AMM', Account: p.id, Asset: as(p.a), Asset2: as(p.b), TradingFee: Math.round(p.fee * 1e5) })) });
    }
    if (c === 'amm_info') {
      const p = this.pools.get(r.amm_account);
      const amt = (k, v) => (k === 'XRP' ? String(Math.round(v * D)) : { currency: k.split('.')[0], issuer: k.split('.')[1], value: String(v) });
      return ok({ amm: { amount: amt(p.a, p.ra), amount2: amt(p.b, p.rb), trading_fee: Math.round(p.fee * 1e5) } });
    }
    if (c === 'submit') return ok(this.submit(r.tx_blob));
    throw new Error('unknown ' + c);
  }

  submit(blob) {
    const tx = decode(blob);
    this.sent.push(tx);
    if (tx.Sequence !== this.acct.seq) return { engine_result: 'tefPAST_SEQ' };
    if (this.beforeApply) this.beforeApply(tx);
    // apply in the next ledger
    setTimeout(() => this.applyBatch(tx), 30);
    return { engine_result: 'tesSUCCESS' };
  }
  applyBatch(tx) {
    const clone = new Map([...this.pools].map(([k, p]) => [k, { ...p }]));
    const lines = new Map(this.lines);
    let xrp = this.acct.balance - Number(tx.Fee) / D;
    let ok = true;
    const touched = new Set();
    for (const { RawTransaction: p } of tx.RawTransactions) {
      const src = key(p.SendMax), dst = key(p.Amount);
      const route = [src, ...(p.Paths?.[0] || []).map(key), dst];
      const partial = (p.Flags & 0x00020000) !== 0;
      const val = (a) => (typeof a === 'string' ? Number(a) / D : Number(a.value));
      const have = src === 'XRP' ? xrp : lines.get(src) ?? -1;
      if (dst !== 'XRP' && !lines.has(dst)) { ok = false; break; }
      const r = partial
        ? this.pay(clone, route, { partialIn: Math.min(val(p.SendMax), have), minOut: val(p.DeliverMin) })
        : this.pay(clone, route, { exactOut: val(p.Amount), maxIn: Math.min(val(p.SendMax), have) });
      if (!r.ok) { ok = false; break; }
      r.touched.forEach((q) => touched.add(q.id));
      if (src === 'XRP') xrp -= r.spent; else lines.set(src, lines.get(src) - r.spent);
      if (dst === 'XRP') xrp += Math.min(r.got, val(p.Amount)); else lines.set(dst, (lines.get(dst) || 0) + r.got);
    }
    this.index++;
    const hash = tx.hash || 'B' + this.index;
    this.lastHash = hash;
    const meNode = (bal) => ({ ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: this.me, Balance: String(Math.round(bal * D)) }, PreviousFields: { Balance: String(Math.round(this.acct.balance * D)) } } });
    if (ok) {
      this.pools = clone; this.lines = lines;
      this.acct.seq += 1 + tx.RawTransactions.length;
    } else {
      xrp = this.acct.balance - Number(tx.Fee) / D;
      this.acct.seq += 1;
    }
    this.emit('transaction', { validated: true, ledger_index: this.index, hash: this.outerHash, tx_json: { TransactionType: 'Batch', Account: this.me }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [meNode(xrp)] } });
    if (ok) {
      for (const id of touched) this.emit('transaction', { validated: true, ledger_index: this.index, hash: 'I' + id + this.index, tx_json: { TransactionType: 'Payment', Account: this.me, ParentBatchID: this.outerHash }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: this.nodesFor(this.pools.get(id)) } });
    }
    this.acct.balance = xrp;
  }
  async submitAndWait(tx) {
    if (tx.TransactionType === 'TrustSet') {
      this.lines.set(key(tx.LimitAmount), 0);
      this.acct.owners++; this.acct.seq++;
      this.acct.balance -= 12 / D;
      return { result: { meta: { TransactionResult: 'tesSUCCESS' } } };
    }
    throw new Error('unexpected ' + tx.TransactionType);
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const IA = Wallet.generate().address, IB = Wallet.generate().address, RIVAL = Wallet.generate().address;
const A = `AAA.${IA}`, B = `BBB.${IB}`;
let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('✔', name); } catch (e) { console.log('✘', name); throw e; } }

function setup(env = {}) {
  const wallet = Wallet.generate();
  const L = new Ledger(wallet, 50);
  L.pool('rPoolXA', 'XRP', A, 500, 5e6);
  L.pool('rPoolAB', A, B, 5e6, 1e7);
  L.pool('rPoolBX', B, 'XRP', 1e7, 500);
  const logs = [];
  const cfg = readArbConfig({ ARB_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'arb-')), ARB_FETCH_PER_SEC: '200', ARB_WATCH: `${RIVAL}:Rival`, ...env });
  const bot = createArb({ client: L, wallet, cfg, log: (m) => logs.push(m), fetchFn: null });
  // the ledger reports the hash of what the bot signed, like the real stream does
  const sign = wallet.sign.bind(wallet);
  wallet.sign = (tx) => { const s = sign(tx); L.outerHash = s.hash; return s; };
  return { L, bot, cfg, logs, wallet };
}
const ready = async (bot) => { for (let i = 0; i < 50 && bot.status().poolsReady < 3; i++) await wait(20); };

await test('discovers pools, reads balances, finds a loop after a trade moves a pool', async () => {
  const { L, bot } = setup();
  await bot.start();
  await ready(bot);
  assert.equal(bot.status().poolsReady, 3);
  L.trade('rPoolAB', B, 2e6); // someone dumps BBB for AAA → AAA cheap in BBB, loop XRP→BBB→AAA→XRP pays
  await wait(250);
  const st = bot.status().stats;
  assert.ok(st.opportunities >= 1, 'opportunity found');
  assert.equal(st.skippedIssuerCheck, 1, 'first sight: issuers are checked first');
  L.trade('rPoolAB', B, 1e5); await wait(250);
  assert.equal(bot.status().stats.missedNoLine, 1, 'issuers clean, but no trust line yet → missed');
  bot.stop();
});

await test('adds a trust line for the hot token, then runs the loop as one batch and earns', async () => {
  const { L, bot } = setup();
  await bot.start();
  await ready(bot);
  L.trade('rPoolAB', B, 2e6);
  await wait(250);
  await bot._manageLines();
  assert.equal(L.lines.size, 1, 'trust line added');
  L.trade('rPoolAB', B, 1e6); // fresh mispricing
  await wait(300);
  await wait(100);
  L.trade('rPoolXA', 'XRP', 0.001); // next ledger → bot settles its batch
  await wait(250);
  const st = bot.status();
  console.log('    trades:', st.trades.map((t) => `${t.route} x=${t.x} exp=${t.expected} pnl=${t.pnl} ${t.result}`).join(' | '), 'seqs', L.sent.map((t) => t.Sequence));
  assert.ok(L.sent.length >= 1, 'batch sent');
  assert.deepEqual(L.sent.map((t) => t.Sequence), [...new Set(L.sent.map((t) => t.Sequence))], 'no sequence used twice');
  const b = L.sent[0];
  assert.equal(b.TransactionType, 'Batch'); assert.equal(b.Flags & 0x00010000, 0x00010000, 'all-or-nothing');
  assert.equal(b.RawTransactions.length, 2);
  assert.ok(st.stats.wins >= 1, 'won: ' + JSON.stringify(st.trades[0]));
  assert.ok(st.trades.every((t) => !t.applied || t.pnl > 0), 'every applied cycle earned');
  assert.ok(st.balance > 50, 'balance grew: ' + st.balance);
  bot.stop();
});

await test('front-run: price fixed before our batch lands → nothing happens, only the fee is lost', async () => {
  const { L, bot } = setup();
  await bot.start();
  await ready(bot);
  L.trade('rPoolAB', B, 2e6); await wait(250);
  await bot._manageLines();
  // a rival fixes the price in the same ledger, just before our batch (silently: the bot only
  // learns from the failure – the cool-down must stop it from trying the same loop again)
  L.beforeApply = () => { L.beforeApply = null; const p = L.pools.get('rPoolAB'); p.ra = 5e6; p.rb = 1e7; L.pools.get('rPoolXA').ra = 500; };
  const before = L.acct.balance;
  L.trade('rPoolAB', B, 1e6); await wait(400);
  L.trade('rPoolXA', 'XRP', 0.001); await wait(250);
  const st = bot.status();
  console.log('    sent', L.sent.length, 'trades', st.trades.map((t) => `${t.result} applied=${t.applied} pnl=${t.pnl}`).join(' | '), 'diff', (before - L.acct.balance).toFixed(8));
  assert.equal(L.sent.length, 1, 'cool-down: the dead loop is not sent again');
  assert.equal(st.stats.notApplied, 1, JSON.stringify(st.stats));
  assert.ok(Math.abs(before - L.acct.balance - 50 / D) < 1e-6, 'lost exactly the fee');
  bot.stop();
});

await test('pool list unavailable: active pools are learned from the stream', async () => {
  const { L, bot } = setup();
  const orig = L.request.bind(L);
  L.request = async (r) => { if (r.command === 'ledger_data') throw new Error('not supported'); return orig(r); };
  await bot.start();
  await wait(100);
  assert.equal(bot.status().pools, 0);
  // swaps touch the AMM accounts (which carry AMMID) → the bot reads them with amm_info
  for (const id of ['rPoolXA', 'rPoolAB', 'rPoolBX']) {
    L.emit('transaction', { validated: true, ledger_index: 3000, hash: 'S' + id, tx_json: { TransactionType: 'Payment', Account: 'rX' }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [{ ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: id, AMMID: 'X', Balance: '1' } } }] } });
  }
  await ready(bot);
  assert.equal(bot.status().poolsReady, 3);
  assert.equal(bot.status().stats.poolsFromStream, 3);
  bot.stop();
});

await test('unfunded wallet: keeps watching, starts trading once XRP arrives', async () => {
  const { L, bot } = setup();
  let funded = false;
  const orig = L.request.bind(L);
  L.request = async (r) => {
    if (r.command === 'account_info' && r.account === L.me && !funded) throw Object.assign(new Error('Account not found.'), { data: { error: 'actNotFound' } });
    return orig(r);
  };
  await bot.start();
  await ready(bot);
  assert.equal(bot.status().poolsReady, 3, 'discovery runs anyway');
  assert.equal(bot.status().activated, false);
  L.trade('rPoolAB', B, 2e6); await wait(250);
  assert.ok(bot.status().stats.ledgers >= 1, 'stream is processed');
  assert.equal(L.sent.length, 0);
  funded = true;
  await bot._loadWallet();
  assert.equal(bot.status().activated, true);
  assert.ok(bot.status().balance > 0);
  bot.stop();
});

await test('token with a transfer fee is never traded', async () => {
  const { L, bot } = setup();
  L.issuerFee = { [IB]: 0.01 };
  await bot.start();
  await ready(bot);
  L.trade('rPoolAB', B, 2e6); await wait(250);
  await bot._manageLines();
  L.trade('rPoolAB', B, 1e6); await wait(300);
  L.trade('rPoolAB', B, 1e5); await wait(300);
  assert.equal(L.sent.length, 0, 'nothing sent');
  assert.ok(bot.status().stats.skippedIssuerCheck >= 1);
  bot.stop();
});

await test('rival batches are recorded with their profit; their held token gets hot', async () => {
  const { L, bot } = setup();
  await bot.start();
  await ready(bot);
  L.emit('transaction', { validated: true, ledger_index: 2000, hash: 'RIV1', tx_json: { TransactionType: 'Batch', Account: RIVAL, Fee: '50', RawTransactions: [
    { RawTransaction: { TransactionType: 'Payment', SendMax: '1000000', Amount: { currency: 'AAA', issuer: IA, value: '9000' } } },
    { RawTransaction: { TransactionType: 'Payment', SendMax: { currency: 'AAA', issuer: IA, value: '9000' }, Amount: '1100000', Paths: [[{ currency: 'BBB', issuer: IB }]] } },
  ] }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [] } });
  L.emit('transaction', { validated: true, ledger_index: 2000, hash: 'RIVi', tx_json: { TransactionType: 'Payment', Account: RIVAL, ParentBatchID: 'RIV1' }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [{ ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: RIVAL, Balance: '10100000' }, PreviousFields: { Balance: '10000000' } } }] } });
  await wait(10200);
  const st = bot.status();
  assert.equal(st.rivals.length, 1);
  assert.equal(st.rivals[0].route, 'XRP → AAA → BBB → XRP');
  assert.ok(Math.abs(st.rivals[0].pnl - 0.09995) < 1e-6, 'pnl ' + st.rivals[0].pnl);
  assert.ok(st.hot.find((h) => h.token === 'AAA'));
  bot.stop();
});

await test('fee cap and pause stop sending but keep recording', async () => {
  const { L, bot, cfg } = setup({ ARB_MAX_FEES_DAY: '0' });
  await bot.start();
  await ready(bot);
  L.trade('rPoolAB', B, 2e6); await wait(250);
  await bot._manageLines();
  L.trade('rPoolAB', B, 1e6); await wait(300);
  assert.equal(L.sent.length, 0);
  assert.ok(bot.status().stats.skippedFeeCap >= 1);
  cfg.maxFeesDay = 2; cfg.paused = true;
  L.trade('rPoolAB', B, 1e6); await wait(300);
  assert.equal(L.sent.length, 0);
  assert.ok(bot.status().stats.skippedPaused >= 1);
  assert.ok(bot.readJsonl('opps').length >= 2, 'opportunities recorded');
  bot.stop();
});

console.log(`\n${passed} arb scenarios passed`);
process.exit(0);
