// Offline test of the arbitrage bot: a simulated ledger with AMM pools that understands the bot's
// signed Batch transactions (decoded from the blob) and runs them all-or-nothing.
//   node test/arb-sim.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet, decode, hashes } from 'xrpl';
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
    this.tickets = new Set();
    this.ticketErrors = 0;
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
  trade(id, from, amount, acct = 'rSomeone', sameLedger = false) {
    const p = this.pools.get(id);
    const to = p.a === from ? 'b' : 'a';
    const fr = p.a === from ? 'a' : 'b';
    const out = swapOut(amount, p['r' + fr], p['r' + to], p.fee);
    p['r' + fr] += amount; p['r' + to] -= out;
    const li = sameLedger ? this.index + 1 : ++this.index;
    this.emit('transaction', { validated: true, ledger_index: li, hash: 'T' + li + acct + amount, tx_json: { TransactionType: 'Payment', Account: acct }, meta: { TransactionResult: 'tesSUCCESS', TransactionIndex: 0, AffectedNodes: this.nodesFor(p) } });
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
    if (c === 'fee') { if (!this.openLevel) throw new Error('no fee info'); return ok({ drops: { base_fee: '10' }, levels: { open_ledger_level: String(this.openLevel), reference_level: '256' } }); }
    if (c === 'server_info') return ok({ info: { validated_ledger: { reserve_base_xrp: 1, reserve_inc_xrp: 0.2, seq: this.index } } });
    if (c === 'account_info' && this.rivalBal?.[r.account]) return ok({ account_data: { Account: r.account, Balance: String(Math.round(this.rivalBal[r.account][r.ledger_index] * D)) } });
    if (c === 'account_info' && r.account !== this.me) return ok({ account_data: { Account: r.account, Flags: 0, ...(this.issuerFee?.[r.account] ? { TransferRate: 1e9 * (1 + this.issuerFee[r.account]) } : {}) } });
    if (c === 'account_info') return ok({ account_data: { Account: this.me, Balance: String(Math.round(this.acct.balance * D)), Sequence: this.acct.seq, OwnerCount: this.acct.owners } });
    if (c === 'account_lines') return ok({ lines: [...this.lines.keys()].map((k) => ({ currency: k.split('.')[0], account: k.split('.')[1], balance: String(this.lines.get(k)) })) });
    if (c === 'ledger_data') {
      const as = (k) => (k === 'XRP' ? { currency: 'XRP' } : { currency: k.split('.')[0], issuer: k.split('.')[1] });
      return ok({ state: [...this.pools.values()].map((p) => ({ LedgerEntryType: 'AMM', Account: p.id, Asset: as(p.a), Asset2: as(p.b), TradingFee: Math.round(p.fee * 1e5) })) });
    }
    if (c === 'amm_info') {
      const p = r.amm_account ? this.pools.get(r.amm_account) : this.find(key(r.asset), key(r.asset2));
      if (!p) throw Object.assign(new Error('ammNotFound'), { data: { error: 'actNotFound' } });
      const amt = (k, v) => (k === 'XRP' ? String(Math.round(v * D)) : { currency: k.split('.')[0], issuer: k.split('.')[1], value: String(v) });
      return ok({ amm: { account: p.id, amount: amt(p.a, p.ra), amount2: amt(p.b, p.rb), trading_fee: Math.round(p.fee * 1e5) } });
    }
    if (c === 'submit') return ok(this.submit(r.tx_blob));
    if (c === 'account_tx' && r.account !== this.me) { if (this.rivalTxs?.[r.account]) return ok({ transactions: this.rivalTxs[r.account] }); throw new Error('no history'); }
    if (c === 'account_tx') return ok({ transactions: (this.history || []).filter((e) => e.ledger_index === r.ledger_index_min).map((e) => ({ tx: e.tx_json, meta: e.meta })) });
    if (c === 'account_objects') return ok({ account_objects: r.type === 'ticket' ? [...this.tickets].map((t) => ({ LedgerEntryType: 'Ticket', TicketSequence: t })) : [] });
    throw new Error('unknown ' + c);
  }

  submit(blob) {
    const tx = decode(blob);
    tx.hash = hashes.hashSignedTx(blob);
    this.sent.push(tx);
    if (tx.TicketSequence) {
      const all = [tx, ...tx.RawTransactions.map((r) => r.RawTransaction)];
      if (all.some((t) => !t.TicketSequence || t.Sequence !== 0 || !this.tickets.has(t.TicketSequence)) || new Set(all.map((t) => t.TicketSequence)).size !== all.length) { this.ticketErrors++; return { engine_result: 'tefNO_TICKET' }; }
      if (this.pending?.some((p) => all.some((t) => p.includes(t.TicketSequence)))) { this.ticketErrors++; return { engine_result: 'tefNO_TICKET' }; }
      (this.pending ||= []).push(all.map((t) => t.TicketSequence));
    } else if (tx.Sequence !== this.acct.seq) { this.pastSeq = (this.pastSeq || 0) + 1; return { engine_result: 'tefPAST_SEQ' }; }
    if (this.minFee && Number(tx.Fee) < this.minFee) { if (this.pending) this.pending.pop(); return { engine_result: 'telCAN_NOT_QUEUE' }; }
    if (this.refuseNext) { this.refuseNext--; if (this.pending) this.pending.pop(); return { engine_result: 'telCAN_NOT_QUEUE' }; }
    if (this.beforeApply) this.beforeApply(tx);
    // apply in the next ledger
    setTimeout(() => this.applyBatch(tx), this.applyDelay || 30);
    return { engine_result: 'tesSUCCESS' };
  }
  applyBatch(tx) {
    // a rival's trade lands in the same ledger just before our batch
    if (this.rivalFirst) { const r = this.rivalFirst; this.rivalFirst = null; this.trade(r.pool, r.from, r.amount, r.acct, true); }
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
        ? this.pay(clone, route, { partialIn: Math.min(val(p.SendMax), have), minOut: p.DeliverMin != null ? val(p.DeliverMin) : null })
        : this.pay(clone, route, { exactOut: val(p.Amount), maxIn: Math.min(val(p.SendMax), have) });
      if (!r.ok) { ok = false; break; }
      r.touched.forEach((q) => touched.add(q.id));
      if (src === 'XRP') xrp -= r.spent; else lines.set(src, lines.get(src) - r.spent);
      if (dst === 'XRP') xrp += Math.min(r.got, val(p.Amount)); else lines.set(dst, (lines.get(dst) || 0) + r.got);
    }
    this.index++;
    const hash = tx.hash;
    this.lastHash = hash;
    const meNode = (from, to) => ({ ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: this.me, Balance: String(Math.round(to * D)) }, PreviousFields: { Balance: String(Math.round(from * D)) } } });
    const afterFee = this.acct.balance - Number(tx.Fee) / D;
    const tks = tx.TicketSequence ? [tx.TicketSequence, ...tx.RawTransactions.map((r) => r.RawTransaction.TicketSequence)] : null;
    if (tks) this.pending = this.pending.filter((p) => p[0] !== tks[0]);
    const used = tks ? (ok ? tks : tks.slice(0, 1)) : [];
    for (const t of used) this.tickets.delete(t);
    this.acct.owners -= used.length;
    if (ok) {
      this.pools = clone; this.lines = lines;
      if (!tks) this.acct.seq += 1 + tx.RawTransactions.length;
    } else {
      xrp = afterFee;
      if (!tks) this.acct.seq += 1;
    }
    this.emit('transaction', { validated: true, ledger_index: this.index, hash, tx_json: { TransactionType: 'Batch', Account: this.me }, meta: { TransactionResult: 'tesSUCCESS', TransactionIndex: 5, AffectedNodes: [meNode(this.acct.balance, afterFee)] } });
    if (ok) {
      let first = true;
      for (const id of touched) {
        const ev = { validated: true, ledger_index: this.index, hash: 'I' + id + this.index, tx_json: { TransactionType: 'Payment', Account: this.me }, meta: { TransactionResult: 'tesSUCCESS', ParentBatchID: hash, AffectedNodes: [...this.nodesFor(this.pools.get(id)), ...(first ? [meNode(afterFee, xrp)] : [])] } };
        (this.history ||= []).push(ev);
        if (!this.hideInner) this.emit('transaction', ev);
        first = false;
      }
    }
    this.acct.balance = xrp;
  }
  async submitAndWait(tx) {
    if (tx.TransactionType === 'TrustSet') {
      if (tx.LimitAmount.value === '0') { this.lines.delete(key(tx.LimitAmount)); this.acct.owners--; } else { this.lines.set(key(tx.LimitAmount), 0); this.acct.owners++; }
      this.acct.seq++;
      this.acct.balance -= 12 / D;
      return { result: { meta: { TransactionResult: 'tesSUCCESS' } } };
    }
    if (tx.TransactionType === 'TicketCreate') {
      for (let i = 1; i <= tx.TicketCount; i++) this.tickets.add(this.acct.seq + i);
      this.acct.seq += tx.TicketCount + 1;
      this.acct.owners += tx.TicketCount;
      this.acct.balance -= 12 / D;
      this.ticketCreates = (this.ticketCreates || 0) + 1;
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

function setup(env = {}, opts = {}) {
  const wallet = Wallet.generate();
  const L = new Ledger(wallet, 50);
  L.pool('rPoolXA', 'XRP', A, 500, 5e6);
  L.pool('rPoolAB', A, B, 5e6, 1e7);
  L.pool('rPoolBX', B, 'XRP', 1e7, 500);
  const logs = [];
  const cfg = readArbConfig({ ARB_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'arb-')), ARB_FETCH_PER_SEC: '200', ARB_WATCH: `${RIVAL}:Rival`, ARB_TOKENS: `AAA.${IA},BBB.${IB}`, ...env });
  const bot = createArb({ client: opts.wrap ? opts.wrap(L) : L, wallet, cfg, log: (m) => logs.push(m), fetchFn: null, submitAlso: opts.also?.(L) });
  // the ledger reports the hash of what the bot signed, like the real stream does
  const sign = wallet.sign.bind(wallet);
  wallet.sign = (tx) => { const s = sign(tx); L.outerHash = s.hash; return s; };
  return { L, bot, cfg, logs, wallet };
}
const ready = async (bot) => {
  for (let i = 0; i < 50 && bot.status().poolsReady < 2; i++) await wait(20); // XRP pools first
  bot._refocus(); // focus known → the AAA/BBB pool between two focus tokens is read too
  for (let i = 0; i < 50 && bot.status().poolsReady < 3; i++) await wait(20);
  bot._refocus();
};

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
  assert.equal(L.ticketErrors, 0, 'tickets valid, never used twice');
  assert.ok(L.sent.every((t) => t.Sequence === 0 && t.TicketSequence && t.RawTransactions.every((r) => r.RawTransaction.TicketSequence)), 'outer + inner on tickets');
  assert.ok(L.sent.every((t) => Number(t.RawTransactions[0].RawTransaction.SendMax) <= 2e6), 'small size (max 2 XRP)');
  assert.ok(st.trades.every((t) => !t.applied || Math.abs(t.pnl - t.expected) < 1e-5), 'profit read from the inner payments');
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
  const tk = [L.sent[0].TicketSequence, ...L.sent[0].RawTransactions.map((r) => r.RawTransaction.TicketSequence)];
  assert.ok(!L.tickets.has(tk[0]) && L.tickets.has(tk[1]) && L.tickets.has(tk[2]), 'failed loop used up only the outer ticket');
  assert.equal(bot.status().tickets.free, L.tickets.size, 'bot knows its free tickets');
  assert.equal(st.stats.notApplied, 1, JSON.stringify(st.stats));
  assert.ok(Math.abs(before - L.acct.balance - Number(L.sent[0].Fee) / D) < 1e-6, 'lost exactly the fee');
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
  L.emit('transaction', { validated: true, ledger_index: 2000, hash: 'RIVi', tx_json: { TransactionType: 'Payment', Account: RIVAL }, meta: { TransactionResult: 'tesSUCCESS', ParentBatchID: 'RIV1', AffectedNodes: [{ ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: RIVAL, Balance: '10100000' }, PreviousFields: { Balance: '10000000' } } }] } });
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

await test('busy ledger: fee follows the open-ledger level, too expensive = skipped', async () => {
  const { L, bot } = setup({ ARB_MAX_FEE_DROPS: '500' });
  L.openLevel = 256 * 5; // ledger is busy: 5× the normal cost
  await bot.start();
  await ready(bot);
  L.trade('rPoolAB', B, 2e6); await wait(250);
  await bot._manageLines(); await bot._manageLines();
  L.trade('rPoolAB', B, 1e6); await wait(400);
  assert.ok(L.sent.length >= 1);
  assert.ok(Number(L.sent[0].Fee) >= Math.ceil(10 * 4 * 5 * 1.25) && Number(L.sent[0].Fee) <= 500, 'fee raised to get into the open ledger, never above the max: ' + L.sent[0].Fee);
  L.openLevel = 256 * 50; // way too busy
  L.trade('rPoolXA', 'XRP', 0.001); await wait(300);
  const sentBefore = L.sent.length;
  L.trade('rPoolAB', B, 1e6); await wait(300);
  L.trade('rPoolAB', B, 1e6); await wait(300);
  assert.ok(bot.status().stats.skippedFeeHigh >= 1);
  assert.equal(L.sent.length, sentBefore, 'nothing sent while the fee is above the max');
  bot.stop();
});

await test('one-at-a-time mode (no tickets): refused batch / trust line → sequence re-read, never tefPAST_SEQ', async () => {
  const { L, bot } = setup({ ARB_PARALLEL: '0' });
  await bot.start();
  await ready(bot);
  L.trade('rPoolAB', B, 2e6); await wait(250);
  await bot._manageLines(); // trust line uses a sequence number
  L.refuseNext = 1;
  L.trade('rPoolAB', B, 1e6); await wait(300); // refused (telCAN_NOT_QUEUE)
  await bot._manageLines(); // second trust line
  L.trade('rPoolAB', B, 1e6); await wait(400);
  L.trade('rPoolXA', 'XRP', 0.001); await wait(300);
  assert.equal(L.pastSeq || 0, 0, 'no stale sequence');
  assert.ok(bot.status().stats.rejected === 1);
  assert.ok(bot.status().stats.wins >= 1, JSON.stringify(bot.status().stats));
  bot.stop();
});

await test('rival: inner payments arriving before the batch still count', async () => {
  const { L, bot } = setup();
  await bot.start();
  L.emit('transaction', { validated: true, ledger_index: 2001, hash: 'RIVi2', tx_json: { TransactionType: 'Payment', Account: RIVAL, ParentBatchID: 'RIV2' }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [{ ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: RIVAL, Balance: '10200000' }, PreviousFields: { Balance: '10000000' } } }] } });
  L.emit('transaction', { validated: true, ledger_index: 2001, hash: 'RIV2', tx_json: { TransactionType: 'Batch', Account: RIVAL, Fee: '50', RawTransactions: [] }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [] } });
  await wait(10200);
  const r = bot.status().rivals[0];
  assert.ok(r.applied && Math.abs(r.pnl - 0.19995) < 1e-6, JSON.stringify(r));
  bot.stop();
});

await test('focus: top by liquidity, hype detection, other tokens ignored, lines follow the focus', async () => {
  const { L, bot } = setup({ ARB_LIST_ONLY: '0', ARB_TOKENS: '-', ARB_TOP_N: '2', ARB_HOT_MIN_TRADES: '3', ARB_MAX_LINES: '2' });
  const IC = Wallet.generate().address;
  const C = `CCC.${IC}`;
  L.pool('rPoolXC', 'XRP', C, 50, 1e6); // small pool, not top 2
  await bot.start();
  for (let i = 0; i < 50 && bot.status().poolsReady < 3; i++) await wait(20);
  bot._uni.snapshot(); bot._refocus();
  let list = bot.status().focusList.map((x) => x.token);
  assert.deepEqual(list.sort(), ['AAA', 'BBB'], 'top 2 by XRP liquidity');
  // CCC gets hyped: lots of buying, pool XRP +100 %
  for (let i = 0; i < 5; i++) L.trade('rPoolXC', 'XRP', 10);
  await wait(200);
  bot._uni.snapshot(); bot._refocus();
  const hot = bot.status().focusList.find((x) => x.token === 'CCC');
  assert.ok(hot && /liquidity/.test(hot.why), 'CCC is hot: ' + JSON.stringify(bot.status().focusList));
  await bot._manageLines(); await bot._manageLines();
  assert.ok(L.lines.has(C), 'line for the hot token first');
  bot.stop();
});

await test('ARB_TOKENS: names and hex codes are understood', async () => {
  const { parseTokens } = await import('../arb/bot.mjs');
  const iss = Wallet.generate().address;
  const t = parseTokens(`FUZZY.${iss}, USD:${iss} 4655A5A5A5000000000000000000000000000000.${iss} junk`);
  assert.equal(t.length, 3);
  assert.equal(t[0], `${Buffer.from('FUZZY').toString('hex').toUpperCase().padEnd(40, '0')}.${iss}`);
  assert.equal(t[1], `USD.${iss}`);
});

await test('rival without inner payments in the stream: result from the balance, route checked against our pools', async () => {
  const { L, bot } = setup();
  await bot.start();
  await ready(bot);
  L.rivalBal = { [RIVAL]: { 4999: 100, 5000: 100.3 } };
  const amt = (k, v) => ({ currency: k.split('.')[0], issuer: k.split('.')[1], value: v });
  L.emit('transaction', { validated: true, ledger_index: 5000, hash: 'RIV3', tx_json: { TransactionType: 'Batch', Account: RIVAL, Fee: '50', RawTransactions: [
    { RawTransaction: { TransactionType: 'Payment', SendMax: '1000000', Amount: amt(B, '9000'), Paths: [[{ currency: 'AAA', issuer: IA }]] } },
    { RawTransaction: { TransactionType: 'Payment', SendMax: amt(B, '9000'), Amount: '1100000' } },
  ] }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [] } });
  const IZ = Wallet.generate().address;
  L.emit('transaction', { validated: true, ledger_index: 5000, hash: 'RIV4', tx_json: { TransactionType: 'Batch', Account: RIVAL, Fee: '50', RawTransactions: [
    { RawTransaction: { TransactionType: 'Payment', SendMax: '1000000', Amount: { currency: 'ZZZ', issuer: IZ, value: '5' } } },
    { RawTransaction: { TransactionType: 'Payment', SendMax: { currency: 'ZZZ', issuer: IZ, value: '5' }, Amount: '1100000' } },
  ] }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [] } });
  await wait(10300);
  const rs = bot.status().rivals;
  const r3 = rs.find((r) => r.route === 'XRP → AAA → BBB → XRP');
  assert.ok(r3.applied && r3.byBalance, JSON.stringify(r3));
  assert.ok(r3.ammOnly && r3.hops === 3 && r3.ourRateAfter > 0);
  const r4 = rs.find((r) => r.route.includes('ZZZ'));
  assert.equal(r4.ammOnly, false); assert.match(r4.missingAmm, /XRP\/ZZZ/);
  bot.stop();
});

await test('rival: two batches in one ledger, no inner payments in the stream → each gets its own result from the ledger', async () => {
  const { L, bot } = setup();
  await bot.start();
  const node = (from, to) => ({ ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: RIVAL, Balance: String(to) }, PreviousFields: { Balance: String(from) } } });
  L.rivalTxs = { [RIVAL]: [
    { tx: { TransactionType: 'Payment' }, meta: { ParentBatchID: 'RB1', AffectedNodes: [node(10000000, 9000000)] } },
    { tx: { TransactionType: 'Payment' }, meta: { ParentBatchID: 'RB1', AffectedNodes: [node(9000000, 10003000)] } },
    { tx: { TransactionType: 'Payment' }, meta: { ParentBatchID: 'RB2', AffectedNodes: [node(10003000, 9503000)] } },
    { tx: { TransactionType: 'Payment' }, meta: { ParentBatchID: 'RB2', AffectedNodes: [node(9503000, 10004000)] } },
  ] };
  const pay = { TransactionType: 'Payment', SendMax: '1000000', Amount: { currency: 'AAA', issuer: IA, value: '1' } };
  for (const h of ['RB1', 'RB2', 'RB3']) L.emit('transaction', { validated: true, ledger_index: 6000, hash: h, tx_json: { TransactionType: 'Batch', Account: RIVAL, Fee: '50', RawTransactions: [{ RawTransaction: pay }] }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [] } });
  await wait(10300);
  const rs = bot.status().rivals;
  const by = (h) => rs.find((r) => r.ledger === 6000 && Math.abs(r.pnl - h) < 1e-6);
  assert.ok(by(0.003 - 0.00005), 'RB1 +0.003: ' + JSON.stringify(rs.map((r) => r.pnl)));
  assert.ok(by(0.001 - 0.00005), 'RB2 +0.001');
  assert.equal(rs.filter((r) => r.applied).length, 2, 'RB3 failed');
  bot.stop();
});

await test('token/token pools unknown to the stream are found by asking for focus pairs', async () => {
  const { L, bot } = setup();
  const orig = L.request.bind(L);
  // the pool list only shows the XRP pools – the AAA/BBB pool must be found by its pair
  L.request = async (r) => { if (r.command === 'ledger_data') { const res = await orig(r); res.result.state = res.result.state.filter((o) => o.Account !== 'rPoolAB'); return res; } return orig(r); };
  await bot.start();
  for (let i = 0; i < 50 && bot.status().poolsReady < 2; i++) await wait(20);
  bot._refocus();
  for (let i = 0; i < 50 && bot.status().poolsReady < 3; i++) await wait(20);
  assert.equal(bot.status().poolsReady, 3, 'AAA/BBB pool found via amm_info by pair');
  assert.equal(bot.status().stats.poolsFromPairs, 1);
  bot.stop();
});

// a second, separate triangle XRP → CCC → DDD → XRP (no pool shared with AAA/BBB)
function twoLoops(env = {}) {
  const IC = Wallet.generate().address, ID = Wallet.generate().address;
  const t = setup({ ARB_MAX_LINES: '4', ARB_TOKENS: `AAA.${IA},BBB.${IB},CCC.${IC},DDD.${ID}`, ...env });
  t.C = `CCC.${IC}`; t.Dk = `DDD.${ID}`;
  t.L.pool('rPoolXC', 'XRP', t.C, 400, 4e6);
  t.L.pool('rPoolCD', t.C, t.Dk, 4e6, 8e6);
  t.L.pool('rPoolDX', t.Dk, 'XRP', 8e6, 400);
  return t;
}
const ready6 = async (bot) => {
  for (let i = 0; i < 80 && bot.status().poolsReady < 4; i++) await wait(20);
  bot._uni.snapshot(); bot._refocus();
  for (let i = 0; i < 80 && bot.status().poolsReady < 6; i++) await wait(20);
  bot._refocus();
};

await test('tickets: two separate loops go into the same ledger, both win', async () => {
  const { L, bot, C, Dk } = twoLoops();
  await bot.start();
  await ready6(bot);
  assert.equal(bot.status().poolsReady, 6);
  // issuers checked, lines + tickets ready
  L.trade('rPoolAB', B, 2e6); L.trade('rPoolCD', Dk, 2e6); await wait(300);
  for (let i = 0; i < 4; i++) await bot._manageLines();
  assert.ok(L.lines.has(A) || L.lines.has(B)); assert.ok(L.lines.has(C) || L.lines.has(Dk));
  assert.equal(L.tickets.size, 18, 'tickets created: 5 batches × 3 + 3');
  const sent0 = L.sent.length;
  L.trade('rPoolAB', B, 1e6); L.trade('rPoolCD', Dk, 1e6); // both in the same ledger
  await wait(160);
  const now = L.sent.slice(sent0);
  console.log('    same ledger:', now.length, 'batches, tickets', now.map((t) => [t.TicketSequence, ...t.RawTransactions.map((r) => r.RawTransaction.TicketSequence)].join('/')).join(' '));
  assert.equal(now.length, 2, 'two batches in one ledger');
  const pools = now.map((t) => t.RawTransactions.map((r) => key(r.RawTransaction.Amount)).join());
  assert.notEqual(pools[0], pools[1], 'different loops');
  await wait(300);
  L.trade('rPoolXA', 'XRP', 0.001); await wait(300);
  const st = bot.status();
  assert.equal(L.ticketErrors, 0);
  assert.ok(st.stats.wins >= 2, JSON.stringify(st.stats));
  assert.ok(st.stats.multiLedgers >= 1);
  assert.ok(st.trades.filter((t) => t.applied).every((t) => t.pnl > 0));
  bot.stop();
});

await test('tickets: a loop on a pool already in flight waits; tickets refill; a lost ticket is re-synced', async () => {
  const { L, bot } = setup({ ARB_PARALLEL: '2' });
  await bot.start();
  await ready(bot);
  L.trade('rPoolAB', B, 2e6); await wait(300);
  await bot._manageLines();
  assert.equal(L.tickets.size, 9, '2 × 3 + 3 tickets');
  // the ticket the bot would take next disappears (used by someone with the same key elsewhere)
  const lowest = Math.min(...L.tickets); L.tickets.delete(lowest); L.acct.owners--;
  L.beforeApply = null;
  L.trade('rPoolAB', B, 1e6); await wait(200);
  assert.equal(bot.status().stats.rejected, 1, 'tefNO_TICKET');
  await wait(100);
  assert.ok(!bot.status().tickets.free || !L.tickets.has(lowest), 're-synced');
  L.applyDelay = 500; // our batch is slow to land
  L.trade('rPoolAB', B, 1e6); await wait(160);
  const n = L.sent.length;
  L.trade('rPoolAB', B, 1e6); await wait(200); // next ledger: same pools, batch still on its way → not sent again
  assert.equal(L.sent.length, n, 'no second batch on a pool that is in flight');
  await wait(400); L.applyDelay = 0;
  L.trade('rPoolXA', 'XRP', 0.001); await wait(300);
  assert.ok(bot.status().stats.wins >= 1, JSON.stringify(bot.status().stats));
  await bot._manageLines();
  assert.ok(L.tickets.size >= 6, 'tickets topped up: ' + L.tickets.size);
  assert.ok(n >= 2);
  bot.stop();
});

await test('inner payments missing from the stream: result read from the ledger', async () => {
  const { L, bot } = setup();
  L.hideInner = true;
  await bot.start();
  await ready(bot);
  L.trade('rPoolAB', B, 2e6); await wait(250);
  await bot._manageLines();
  L.trade('rPoolAB', B, 1e6); await wait(300);
  L.trade('rPoolXA', 'XRP', 0.001); await wait(300);
  const st = bot.status();
  assert.ok(st.stats.wins >= 1 && st.stats.innerFromLedger >= 1, JSON.stringify(st.stats));
  assert.ok(st.trades[0].applied && st.trades[0].pnl > 0, JSON.stringify(st.trades[0]));
  bot.stop();
});

await test('miss analysis: a rival moved our pool first in the same ledger → "beaten" by Rival; silent miss → "model"', async () => {
  const { L, bot } = setup();
  await bot.start();
  await ready(bot);
  L.trade('rPoolAB', B, 2e6); await wait(250);
  await bot._manageLines();
  // the rival fixes the mispricing in the same ledger, before our batch
  L.rivalFirst = { pool: 'rPoolAB', from: A, amount: 1.2e6, acct: RIVAL };
  L.trade('rPoolAB', B, 1e6); await wait(400);
  L.trade('rPoolXA', 'XRP', 0.001); await wait(300);
  const st = bot.status();
  const miss = st.trades.find((t) => !t.applied);
  assert.ok(miss, JSON.stringify(st.trades));
  assert.equal(miss.why, 'beaten');
  assert.equal(miss.by, 'Rival');
  assert.equal(st.stats.missBeaten, 1);
  assert.equal(st.learn.why.beaten, 1);
  assert.ok(st.learn.classes.length >= 1, 'margin class learned');
  bot.stop();
});

await test('learner: wins make a margin class confident, a contested pool and a broken route are avoided', async () => {
  const { createLearner } = await import('../arb/learn.mjs');
  let t = 0;
  const cfg = { targetWin: 0.9, learnMinTries: 6, learnHalfLifeH: 72 };
  const lr = createLearner({}, cfg, () => t);
  const mk = (key, pools, net = 0.002, x = 0.5) => ({ key, hops: pools.map((pool) => ({ pool })), assets: ['TOK'], held: 0, net, x });
  const fee = 0.00005;
  const good = mk('good', ['p1', 'p2', 'p3']);
  assert.equal(lr.decide(good, fee, 10), 'explore', 'unknown → explore');
  assert.equal(lr.decide(good, fee, 0), 'lowChance', 'no exploration budget left → not sent');
  for (let i = 0; i < 30; i++) lr.record(good, 'win');
  assert.equal(lr.decide(good, fee, 0), 'go', 'p=' + good.p);
  // a route through a contested pool: someone is faster there every time
  const hot = mk('hot', ['p1', 'pX', 'p3']);
  for (let i = 0; i < 8; i++) { hot.beatenPools = ['pX']; lr.record(hot, 'miss', 'beaten'); }
  const other = mk('other', ['p9', 'pX', 'p8']);
  assert.notEqual(lr.decide(other, fee, 0), 'go', 'another route through the contested pool is not confident: p=' + other.p);
  // same margin class, clean pools → still confident
  assert.equal(lr.decide(mk('fresh', ['p1', 'p2', 'p7']), fee, 0), 'go');
  // a route our math gets wrong
  const broken = mk('broken', ['p1', 'p2', 'p3']);
  for (let i = 0; i < 6; i++) lr.record(broken, 'miss', 'model');
  assert.notEqual(lr.decide(broken, fee, 0), 'go', 'broken route p=' + broken.p);
  // old results fade: after 3 weeks the contested pool is unknown again
  t += 21 * 24 * 3600e3;
  assert.equal(lr.decide(mk('other2', ['p9', 'pX', 'p8']), fee, 5), 'explore');
  // a loop whose expected value is negative is never sent
  assert.equal(lr.decide(mk('tiny', ['q1', 'q2'], -0.0001), fee, 10), 'negativeEv');
});

await test('list only: tokens off the list are never traded, their empty lines are given back, they show as suggestions', async () => {
  const { L, bot } = setup({ ARB_TOKENS: `AAA.${IA}` }); // BBB is not on the list
  const IZ = Wallet.generate().address;
  L.lines.set(`ZZZ.${IZ}`, 0); L.acct.owners++; // an old line from before the wipe
  L.pool('rPoolXZ', 'XRP', `ZZZ.${IZ}`, 900, 9e6);
  await bot.start();
  for (let i = 0; i < 80 && bot.status().poolsReady < 4; i++) await wait(20);
  bot._uni.snapshot(); bot._refocus();
  await wait(100);
  assert.deepEqual(bot.status().focusList.map((x) => x.token), ['AAA']);
  L.trade('rPoolAB', B, 2e6); await wait(300); // the loop needs BBB → not allowed
  assert.equal(bot.status().stats.opportunities || 0, 0, 'no loop through BBB');
  for (let i = 0; i < 3; i++) await bot._manageLines();
  assert.ok(!L.lines.has(`ZZZ.${IZ}`), 'old line removed');
  assert.ok(L.lines.has(A), 'line for the list token');
  assert.ok(!L.lines.has(B), 'no line for BBB');
  const cand = bot.status().candidates.map((x) => x.token);
  assert.ok(cand.includes('ZZZ') && cand.includes('BBB'), 'suggestions: ' + cand);
  bot.stop();
});

await test('bridge: a loop may pass through a big token off the list – held is always a list token, no line for the bridge', async () => {
  const { L, bot } = setup({ ARB_TOKENS: `AAA.${IA}`, ARB_BRIDGE_MIN_XRP: '400' }); // BBB has 500 XRP in its pool
  await bot.start();
  await ready(bot);
  L.trade('rPoolAB', B, 2e6); await wait(300); // issuers checked
  for (let i = 0; i < 3; i++) await bot._manageLines();
  assert.ok(L.lines.has(A) && !L.lines.has(B), 'line only for the list token');
  L.trade('rPoolAB', B, 1e6); await wait(400);
  L.trade('rPoolXA', 'XRP', 0.001); await wait(300);
  const st = bot.status();
  assert.ok(st.bridges.includes('BBB'), 'BBB is a bridge');
  assert.ok(st.stats.wins >= 1, JSON.stringify(st.stats));
  assert.ok(st.trades.every((t) => t.held === 'AAA'));
  bot.stop();
  const t2 = setup({ ARB_TOKENS: `AAA.${IA}`, ARB_BRIDGE_MIN_XRP: '400', ARB_BRIDGE: '0' });
  await t2.bot.start(); await ready(t2.bot);
  t2.L.trade('rPoolAB', B, 2e6); await wait(300);
  assert.equal(t2.bot.status().stats.opportunities || 0, 0, 'bridges off → no loop through BBB');
  t2.bot.stop();
});

await test('live (send now): a trade entering the open ledger → live pool state read → batch for this ledger, wins; an older validated update does not undo it', async () => {
  const { L, bot } = setup({ ARB_LIVE_SEND: 'now' });
  const subs = [];
  const orig = L.request.bind(L);
  L.request = async (r) => { if (r.command === 'subscribe') subs.push(...r.streams); return orig(r); };
  await bot.start();
  assert.deepEqual(subs, ['transactions_proposed'], 'one stream: proposed + validated');
  await ready(bot);
  L.trade('rPoolAB', B, 2e6); await wait(300); // issuers checked
  await bot._manageLines();
  const sent0 = L.sent.length;
  // someone dumps BBB for AAA in the OPEN ledger: the pool moved, nothing validated yet
  const p = L.pools.get('rPoolAB');
  const out = swapOut(1e6, p.rb, p.ra, p.fee); p.rb += 1e6; p.ra -= out;
  const open = L.index + 1;
  L.applyDelay = 600; // our batch lands a bit later
  L.emit('transaction', { validated: false, ledger_current_index: open, engine_result: 'tesSUCCESS', tx_json: { TransactionType: 'Payment', Account: 'rDumper', Amount: { currency: 'AAA', issuer: IA, value: '1' }, SendMax: { currency: 'BBB', issuer: IB, value: '1000000' } } });
  await wait(120);
  const now = L.sent.slice(sent0);
  assert.equal(now.length, 1, 'sent straight from the open ledger');
  assert.equal(now[0].LastLedgerSequence, open + 1, 'valid for this open ledger and the next');
  assert.ok(bot.status().stats.liveSeen >= 1 && bot.status().stats.liveReads >= 1);
  // a validated update from an older ledger must not put the old reserves back
  const ra = bot.graph.pools.get('rPoolAB').ra;
  L.emit('transaction', { validated: true, ledger_index: open - 1, hash: 'OLD1', tx_json: { TransactionType: 'Payment', Account: 'rOld' }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [{ ModifiedNode: { LedgerEntryType: 'RippleState', FinalFields: { Balance: { currency: 'AAA', value: String(-5e6) }, LowLimit: { issuer: IA }, HighLimit: { issuer: 'rPoolAB' } }, PreviousFields: { Balance: { currency: 'AAA', value: '0' } } } }] } });
  assert.ok(Math.abs(bot.graph.pools.get('rPoolAB').ra - ra) < 1e-6, 'live state kept');
  await wait(700); L.applyDelay = 0;
  L.trade('rPoolXA', 'XRP', 0.001); await wait(300);
  const st = bot.status();
  assert.ok(st.stats.wins >= 1, JSON.stringify(st.stats));
  assert.ok(st.trades.find((t) => t.applied).live, 'marked live');
  bot.stop();
});

await test('live (send next, default): the gap is read and sent the moment the next ledger opens', async () => {
  const { L, bot } = setup();
  await bot.start();
  await ready(bot);
  L.trade('rPoolAB', B, 2e6); await wait(300);
  await bot._manageLines();
  const sent0 = L.sent.length;
  const p = L.pools.get('rPoolAB');
  const out = swapOut(1e6, p.rb, p.ra, p.fee); p.rb += 1e6; p.ra -= out;
  const open = L.index + 1;
  const dump = { TransactionType: 'Payment', Account: 'rDumper', Amount: { currency: 'AAA', issuer: IA, value: '1' }, SendMax: { currency: 'BBB', issuer: IB, value: '1000000' } };
  L.emit('transaction', { validated: false, ledger_current_index: open, engine_result: 'tesSUCCESS', tx_json: dump });
  await wait(120);
  assert.equal(L.sent.length, sent0, 'not into the same ledger');
  // any transaction of the next open ledger shows the previous one closed
  L.emit('transaction', { validated: false, ledger_current_index: open + 1, engine_result: 'tesSUCCESS', tx_json: { TransactionType: 'AccountSet', Account: 'rX' } });
  await wait(120);
  const now = L.sent.slice(sent0);
  assert.equal(now.length, 1, 'sent at the rollover');
  assert.equal(now[0].LastLedgerSequence, open + 2, 'for the new ledger and the one after');
  assert.ok(bot.status().stats.liveRollover >= 1);
  bot.stop();
});

await test('fee too low for a busy open ledger → fee read again, sent once more with more', async () => {
  const { L, bot } = setup({ ARB_LIVE: '0', ARB_MAX_FEE_DROPS: '1000000' });
  await bot.start();
  await ready(bot);
  L.trade('rPoolAB', B, 2e6); await wait(300);
  await bot._manageLines();
  L.refuseNext = 1;
  L.openLevel = 256 * 3;
  const sent0 = L.sent.length;
  L.trade('rPoolAB', B, 1e6); await wait(400);
  const now = L.sent.slice(sent0);
  assert.ok(now.length >= 2, 'refused, then again');
  assert.ok(Number(now[1].Fee) > Number(now[0].Fee) && now[1].TicketSequence === now[0].TicketSequence, `same tickets, higher fee ${now[0].Fee} → ${now[1].Fee}`);
  assert.equal(bot.status().stats.feeRetry, 1);
  L.trade('rPoolXA', 'XRP', 0.001); await wait(300);
  assert.ok(bot.status().stats.wins >= 1, JSON.stringify(bot.status().stats));
  bot.stop();
});

await test('fee spike: a big loop pays what the open ledger asks (above the old 20k cap) and gets in; a loop that would not earn it is not sent', async () => {
  const { L, bot, cfg } = setup({ ARB_LIVE: '0' });
  await bot.start();
  await ready(bot);
  L.trade('rPoolAB', B, 2e6); await wait(300);
  await bot._manageLines();
  L.openLevel = 256 * 750; // ledger full: 10 × 4 × 750 × 1.25 = 37,500 drops for a batch
  L.minFee = 37500;
  const sent0 = L.sent.length;
  L.trade('rPoolAB', B, 1e6); await wait(500);
  const now = L.sent.slice(sent0);
  assert.ok(now.length >= 1 && Number(now.at(-1).Fee) >= 37500, 'paid the spike fee: ' + now.map((t) => t.Fee));
  L.trade('rPoolXA', 'XRP', 0.001); await wait(300);
  assert.ok(bot.status().stats.wins >= 1, JSON.stringify(bot.status().stats));
  // the same spike, but the loop may only spend 1 % of its expected gain → not sent at all
  cfg.feeShare = 0.01;
  const sent1 = L.sent.length;
  const skipped0 = bot.status().stats.skippedFeeHigh || 0;
  L.trade('rPoolAB', B, 1e6); await wait(400);
  assert.equal(L.sent.length, sent1, 'not sent');
  assert.ok((bot.status().stats.skippedFeeHigh || 0) > skipped0);
  bot.stop();
});

await test('late: our pool was moved in a ledger between our view and ours → "beaten", flagged late', async () => {
  const { L, bot } = setup({ ARB_LIVE: '0' });
  await bot.start();
  await ready(bot);
  L.trade('rPoolAB', B, 2e6); await wait(300);
  await bot._manageLines();
  L.applyDelay = 400; // our batch takes one more ledger …
  L.trade('rPoolAB', B, 1e6); await wait(200);
  L.trade('rPoolAB', A, 1.3e6, RIVAL); // … and the rival fixes the price in the ledger between
  await wait(400);
  L.applyDelay = 0;
  L.trade('rPoolXA', 'XRP', 0.001); await wait(300);
  const miss = bot.status().trades.find((t) => !t.applied);
  assert.ok(miss && miss.why === 'beaten' && miss.late && miss.by === 'Rival', JSON.stringify(bot.status().trades));
  assert.ok(bot.status().stats.missLate >= 1);
  bot.stop();
});

await test('default list: 38 FirstLedger top tokens, settings field parses back', async () => {
  const { DEFAULT_TOKENS, parseTokens } = await import('../arb/bot.mjs');
  const t = parseTokens(DEFAULT_TOKENS);
  assert.equal(t.length, 38);
  assert.ok(t.includes('46555A5A59000000000000000000000000000000.rhCAT4hRdi2Y9puNdkpMzxrdKa5wkppR62'), 'FUZZY');
  assert.ok(t.includes('666.rhvf9fe6PP3GC8Bku2Ug7iQPjPDxYZfrxN'), '666 (deepest pool, not the copy)');
  assert.equal(readArbConfig({ ARB_TOKENS: '' }).tokens.length, 38, 'empty value = the default list');
  assert.equal(readArbConfig({}).listOnly, true);
});

await test('multi-submit: the batch goes to every server at once; a slow / refusing main server does not lose it', async () => {
  // main server: refuses submits (busy) or has lost its connection; the second server takes it
  let mode = 'refuse';
  let alsoCalls = 0;
  const wrap = (L) => ({ on: (e, f) => L.on(e, f), submitAndWait: (tx, o) => L.submitAndWait(tx, o), request: async (r) => {
    if (r.command !== 'submit') return L.request(r);
    if (mode === 'down') throw new Error('websocket closed');
    return { result: { engine_result: 'telCAN_NOT_QUEUE' } };
  } });
  const also = (L) => (r) => { alsoCalls++; return [L.request(r)]; };
  const { L, bot } = setup({ ARB_LIVE: '0' }, { wrap, also });
  await bot.start();
  await ready(bot);
  L.trade('rPoolAB', B, 2e6); await wait(300);
  await bot._manageLines();
  L.trade('rPoolAB', B, 1e6); await wait(400);
  L.trade('rPoolXA', 'XRP', 0.001); await wait(300);
  let st = bot.status().stats;
  assert.ok(alsoCalls >= 1 && st.multiSubmit >= 1, 'sent to the second server too');
  assert.ok(st.wins >= 1 && !st.feeRetry && !st.rejected, JSON.stringify(st));
  mode = 'down';
  const w0 = st.wins;
  L.trade('rPoolAB', B, 1e6); await wait(400);
  L.trade('rPoolXA', 'XRP', 0.001); await wait(300);
  st = bot.status().stats;
  assert.ok(st.wins > w0, 'main connection down → the other server still gets it in');
  bot.stop();
  // off: only the main server
  const r2 = setup({ ARB_LIVE: '0', ARB_MULTI_SUBMIT: '0' }, { also: () => () => { throw new Error('must not be called'); } });
  assert.equal(r2.cfg.multiSubmit, false);
  r2.bot.stop();
});

console.log(`\n${passed} arb scenarios passed`);
process.exit(0);
