// Data recorder: follows EVERY launch (and copy signal) for 24 h, bought or not, so filters and
// sell rules can be judged on real outcomes. Also keeps an append-only event log of everything
// the bot does. All files live in DATA_DIR/data/:
//   watch.json              launches still being followed (survives restarts)
//   launches-YYYY-MM.jsonl  one finished record per launch (after 24 h)
//   events-YYYY-MM.jsonl    every event: launch, check, decision, buy, sell, ask, answer, settings, …
//
// Price samples: 1/5/15/30 min, 1/3/6/24 h after the launch, plus max/min in between.
// Pool trading (buys, sells, buyers, volume, liquidity adds/removes) comes from the live
// transaction stream, so it costs no extra requests.

import fs from 'node:fs';
import path from 'node:path';

const MARKS = [['m1', 60e3], ['m5', 300e3], ['m15', 900e3], ['m30', 1800e3], ['h1', 3600e3], ['h3', 3 * 3600e3], ['h6', 6 * 3600e3], ['h24', 24 * 3600e3]];
export const MARK_KEYS = MARKS.map(([k]) => k);
const FOLLOW_MS = 24 * 3600e3 + 120e3;
const month = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);

// how often to sample a launch, by age
const every = (age) => (age < 10 * 60e3 ? 30e3 : age < 3600e3 ? 120e3 : age < 6 * 3600e3 ? 600e3 : 1800e3);

const WALLET_SETTLE_MS = 3 * 3600e3; // a launch's traders are scored 3 h after it started

export function createRecorder({ dir, pool, log = () => {}, ignore = [] }) {
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const watchFile = path.join(dataDir, 'watch.json');
  // every wallet that traded the launches we followed: launches, how early, XRP in/out, wins
  const walletFile = path.join(dataDir, 'wallets.json');
  let WL = {};
  try { WL = JSON.parse(fs.readFileSync(walletFile, 'utf8')); } catch {}
  let wlDirty = false;
  const skipWallet = new Set(ignore);
  let W = {}; // k → record
  try { W = JSON.parse(fs.readFileSync(watchFile, 'utf8')); } catch {}
  const byAmm = new Map(Object.values(W).filter((r) => r.amm).map((r) => [r.amm, r.k]));
  let dirty = false;

  const append = (name, obj) => {
    try { fs.appendFileSync(path.join(dataDir, `${name}-${month()}.jsonl`), JSON.stringify(obj) + '\n'); } catch (e) { log(`recorder: ${e.message}`); }
  };
  const event = (type, data = {}) => append('events', { t: Date.now(), type, ...data });
  const flush = () => {
    if (!dirty) return;
    dirty = false;
    try {
      fs.writeFileSync(watchFile + '.tmp', JSON.stringify(W));
      fs.renameSync(watchFile + '.tmp', watchFile);
    } catch (e) { log(`recorder: ${e.message}`); }
  };

  // ---------- start following ----------
  function follow({ k, kind, name, currency, issuer, creator = '', poolXrp, poolTok, amm = '', ledger = 0, hash = '', copy = '' }) {
    if (W[k]) return;
    W[k] = {
      k, kind, name, currency, issuer, creator, at: Date.now(), ledger, hash, copy, amm,
      start: { xrp: poolXrp ?? null, tok: poolTok ?? null, price: poolXrp && poolTok ? poolXrp / poolTok : null },
      checks: null, decision: null, trade: null,
      marks: {}, max: null, min: null, last: null, dead: false, nextAt: Date.now() + 30e3,
      flow: { buys: 0, sells: 0, buyers: [], xrpIn: 0, xrpOut: 0, lpAdd: 0, lpRemove: 0, h1: null },
    };
    if (amm) byAmm.set(amm, k);
    dirty = true;
    event(kind, { k, name, issuer, creator, poolXrp, poolTok, amm, ledger, hash, copy });
  }

  // pool account learned later (a launch first seen in the open ledger has no metadata yet)
  function setAmm(k, amm) { if (amm && W[k] && !W[k].amm) { W[k].amm = amm; byAmm.set(amm, k); dirty = true; } }
  const checks = (k, c) => { if (W[k]) { W[k].checks = c; dirty = true; } };
  function decision(k, result, reason = '') {
    // first decision counts – except a buy that finally works after a blocked/failed try
    if (W[k] && (!W[k].decision || (result === 'bought' && W[k].decision.result !== 'bought'))) { W[k].decision = { result, reason, at: Date.now() }; dirty = true; }
    event('decision', { k, result, reason });
  }
  function trade(k, data) {
    if (W[k]) { W[k].trade = { ...(W[k].trade || {}), ...data }; dirty = true; }
  }

  // ---------- live stream: trading in followed pools ----------
  // FirstLedger: the rest of the supply is deposited seconds after the create – the real start is after it
  function earlyDeposit(ev) {
    for (const m of ev.meta?.AffectedNodes || []) {
      const rs = m.ModifiedNode;
      const ff = rs?.FinalFields;
      if (rs?.LedgerEntryType !== 'RippleState' || !ff?.Balance) continue;
      const k = byAmm.get(ff.HighLimit?.issuer) || byAmm.get(ff.LowLimit?.issuer);
      const r = k && W[k];
      if (!r || r.startFixed || Date.now() - r.at > 10 * 60e3 || !r.start.tok) continue;
      const tokNow = Math.abs(Number(ff.Balance.value));
      const tokBefore = Math.abs(Number(rs.PreviousFields?.Balance?.value ?? tokNow));
      if (tokNow > tokBefore * 2) {
        r.start = { xrp: r.start.xrp, tok: tokNow, price: r.start.xrp / tokNow };
        r.startFixed = true; r.max = null; r.min = null; dirty = true;
      }
    }
  }
  function tx(ev) {
    if (!byAmm.size) return;
    const t = ev.tx_json || ev.transaction;
    if (t?.TransactionType === 'AMMDeposit') earlyDeposit(ev);
    for (const n of ev.meta?.AffectedNodes || []) {
      const node = n.ModifiedNode || n.DeletedNode;
      if (!node || node.LedgerEntryType !== 'AccountRoot') continue;
      const acct = (node.FinalFields || {}).Account;
      const k = byAmm.get(acct);
      if (!k || !W[k]) continue;
      const r = W[k];
      const before = node.PreviousFields?.Balance;
      if (before === undefined) continue;
      const d = (Number(node.FinalFields.Balance) - Number(before)) / 1e6;
      const f = r.flow;
      if (t.TransactionType === 'AMMDeposit') f.lpAdd += Math.max(0, d);
      else if (t.TransactionType === 'AMMWithdraw') f.lpRemove += Math.max(0, -d);
      else if (d > 0) {
        f.buys++; f.xrpIn += d;
        if (f.buyers.length < 5000 && !f.buyers.includes(t.Account)) f.buyers.push(t.Account);
      } else if (d < 0) { f.sells++; f.xrpOut += -d; }
      // per wallet (not the dev / issuer): XRP paid in, XRP taken out, seconds after the launch
      if (d !== 0 && !/^AMM/.test(t.TransactionType) && t.Account !== r.creator && t.Account !== r.issuer && !skipWallet.has(t.Account)) {
        const ws = (r.wallets ||= {});
        if (ws[t.Account] || Object.keys(ws).length < 400) {
          const e = (ws[t.Account] ||= { in: 0, out: 0, firstS: Math.round((Date.now() - r.at) / 1000), buys: 0, sells: 0 });
          if (d > 0) { e.in += d; e.buys++; } else { e.out += -d; e.sells++; }
        }
      }
      dirty = true;
    }
  }

  // ---------- sampling ----------
  let busy = false;
  async function sample() {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now();
      for (const r of Object.values(W)) {
        const age = now - r.at;
        if (age > FOLLOW_MS) { finish(r); continue; }
        if (age >= WALLET_SETTLE_MS && !r.walletsDone) settleWallets(r);
        if (r.dead || now < r.nextAt) continue;
        r.nextAt = now + every(age);
        let p;
        try { p = await pool(r.currency, r.issuer); } catch { continue; }
        if (!p) { r.dead = true; r.deadAt = now; r.last = { at: now, xrp: 0, price: 0 }; dirty = true; continue; }
        const price = p.xrp / p.tok;
        if (r.start.price == null) r.start = { xrp: p.xrp, tok: p.tok, price };
        const snap = { at: now, xrp: +p.xrp.toFixed(3), price };
        r.last = snap;
        if (!r.max || price > r.max.price) r.max = snap;
        if (!r.min || price < r.min.price) r.min = snap;
        for (const [m, ms] of MARKS) if (!r.marks[m] && age >= ms) r.marks[m] = snap;
        if (!r.flow.h1 && age >= 3600e3) r.flow.h1 = { buys: r.flow.buys, sells: r.flow.sells, buyers: r.flow.buyers.length, xrpIn: r.flow.xrpIn, xrpOut: r.flow.xrpOut };
        dirty = true;
      }
    } finally { busy = false; flush(); }
  }

  // book a launch's traders into the wallet table: a "win" took out at least 10 % more than it put in
  function settleWallets(r) {
    r.walletsDone = true;
    dirty = true;
    for (const [a, e] of Object.entries(r.wallets || {})) {
      if (!(e.in > 0.5)) continue; // dust / sell-only (got tokens elsewhere)
      const w = (WL[a] ||= { n: 0, early: 0, in: 0, out: 0, wins: 0, last: 0, tokens: [] });
      w.n++; w.in += e.in; w.out += e.out; w.last = Date.now();
      if (e.firstS <= 120) w.early++;
      if (e.out >= e.in * 1.1) w.wins++;
      w.tokens = [`${r.name}${e.out >= e.in * 1.1 ? '+' : '−'}`, ...w.tokens].slice(0, 6);
      wlDirty = true;
    }
    if (wlDirty) {
      // keep the table small: drop one-launch wallets not seen for 14 days
      for (const [a, w] of Object.entries(WL)) if (w.n < 2 && Date.now() - w.last > 14 * 864e5) delete WL[a];
      try { fs.writeFileSync(walletFile + '.tmp', JSON.stringify(WL)); fs.renameSync(walletFile + '.tmp', walletFile); wlDirty = false; } catch (e) { log(`recorder: ${e.message}`); }
    }
  }
  // wallets with derived numbers, best first
  function walletList() {
    return Object.entries(WL).map(([wallet, w]) => ({
      wallet, launches: w.n, early: w.early, winRate: w.n ? w.wins / w.n : 0, pnl: +(w.out - w.in).toFixed(2), in: +w.in.toFixed(2), last: w.last, tokens: w.tokens,
    })).sort((a, b) => b.pnl - a.pnl);
  }

  function finish(r) {
    if (!r.walletsDone) settleWallets(r);
    delete W[r.k];
    if (r.amm) byAmm.delete(r.amm);
    append('launches', summary(r));
    dirty = true;
  }

  // one flat row per launch, also used for the CSV
  function summary(r) {
    const p0 = r.start.price;
    const mult = (s) => (s && p0 ? +(s.price / p0).toFixed(4) : null);
    const f = r.flow;
    return {
      k: r.k, kind: r.kind, name: r.name, issuer: r.issuer, creator: r.creator, copy: r.copy, at: r.at,
      startXrp: r.start.xrp, startPrice: p0,
      ...(r.checks || {}),
      decision: r.decision?.result || 'pending', reason: r.decision?.reason || '',
      ...Object.fromEntries(MARKS.map(([m]) => [`x_${m}`, mult(r.marks[m])])),
      ...Object.fromEntries(MARKS.map(([m]) => [`pool_${m}`, r.marks[m]?.xrp ?? null])),
      maxX: mult(r.max), maxAfterMin: r.max ? Math.round((r.max.at - r.at) / 60e3) : null,
      minX: mult(r.min), lastX: mult(r.last), dead: r.dead, deadAfterMin: r.deadAt ? Math.round((r.deadAt - r.at) / 60e3) : null,
      buys: f.buys, sells: f.sells, buyers: f.buyers.length, volIn: +f.xrpIn.toFixed(2), volOut: +f.xrpOut.toFixed(2),
      lpAdd: +f.lpAdd.toFixed(2), lpRemove: +f.lpRemove.toFixed(2),
      buys1h: f.h1?.buys ?? null, buyers1h: f.h1?.buyers ?? null, volIn1h: f.h1 ? +f.h1.xrpIn.toFixed(2) : null,
      ...(r.trade ? Object.fromEntries(Object.entries(r.trade).map(([key, v]) => [`my_${key}`, v])) : {}),
    };
  }

  // ---------- reading the data ----------
  function files(prefix) {
    try { return fs.readdirSync(dataDir).filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl')).sort(); } catch { return []; }
  }
  function readJsonl(prefix, since = 0) {
    const out = [];
    for (const f of files(prefix)) {
      for (const line of fs.readFileSync(path.join(dataDir, f), 'utf8').split('\n')) {
        if (!line) continue;
        try { const o = JSON.parse(line); if ((o.at ?? o.t ?? 0) >= since) out.push(o); } catch {}
      }
    }
    return out;
  }
  // finished + still followed launches
  const rows = (since = 0) => [...readJsonl('launches', since), ...Object.values(W).filter((r) => r.at >= since).map(summary)];

  function csv(list) {
    const cols = [...new Set(list.flatMap((r) => Object.keys(r)))];
    const cell = (v) => {
      if (v == null) return '';
      if (k(v)) return new Date(v).toISOString();
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const k = (v) => typeof v === 'number' && v > 1.6e12 && v < 2.2e12; // epoch ms → ISO time
    return [cols.join(','), ...list.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
  }

  // Outcome table for the status page: how did launches do, grouped two ways.
  function analysis(days = 7) {
    const list = rows(Date.now() - days * 864e5).filter((r) => r.kind === 'launch' && r.startPrice);
    const group = (key) => {
      const g = {};
      for (const r of list) (g[key(r)] ||= []).push(r);
      return Object.entries(g).map(([name, rs]) => {
        const done = rs.filter((r) => r.x_h1 != null);
        const pct = (fn) => (done.length ? Math.round((done.filter(fn).length / done.length) * 100) : null);
        const maxes = rs.map((r) => r.maxX).filter((x) => x != null).sort((a, b) => a - b);
        return {
          name, n: rs.length, done: done.length,
          x2: pct((r) => r.maxX >= 2), x5: pct((r) => r.maxX >= 5), x10: pct((r) => r.maxX >= 10),
          up1h: pct((r) => r.x_h1 >= 1), dead: pct((r) => r.dead),
          medMax: maxes.length ? maxes[Math.floor(maxes.length / 2)] : null,
        };
      }).sort((a, b) => b.n - a.n);
    };
    const bucket = (x) => (x < 100 ? '< 100' : x < 200 ? '100–200' : x < 300 ? '200–300' : x < 500 ? '300–500' : x < 1000 ? '500–1000' : '1000+');
    return {
      days, total: list.length,
      byDecision: group((r) => (r.decision === 'skipped' ? `skipped: ${r.reason}` : r.decision)),
      byStart: group((r) => `${bucket(r.startXrp)} XRP`),
    };
  }

  const timer = setInterval(sample, 10e3);
  const flusher = setInterval(flush, 60e3);
  return {
    follow, setAmm, checks, decision, wallets: walletList, ignoreWallet: (a) => skipWallet.add(a), trade, tx, event, sample, flush, rows, csv, analysis,
    events: (since) => readJsonl('events', since),
    following: () => Object.keys(W).length,
    // trading so far in one followed pool (for the chart health of a position)
    flowOf: (k) => (W[k] ? { buys: W[k].flow.buys, sells: W[k].flow.sells, buyers: W[k].flow.buyers.length, lpRemove: W[k].flow.lpRemove, xrpIn: W[k].flow.xrpIn, xrpOut: W[k].flow.xrpOut } : null),
    // live view of followed launches (for the crowd entry): start, last sample, trading so far
    live: () => Object.values(W).map((r) => ({
      k: r.k, kind: r.kind, name: r.name, currency: r.currency, issuer: r.issuer, at: r.at, start: r.start, last: r.last, max: r.max, dead: r.dead,
      buyers: r.flow.buyers.length, buys: r.flow.buys, sells: r.flow.sells, xrpIn: r.flow.xrpIn, decision: r.decision, checks: r.checks,
    })),
    stop() { clearInterval(timer); clearInterval(flusher); flush(); },
  };
}

// AMM account created by an AMMCreate (from the metadata), so pool trades can be counted.
// Rows (objects) → CSV text; epoch-ms numbers become ISO times.
export function toCsv(list) {
  const cols = [...new Set(list.flatMap((r) => Object.keys(r)))];
  const isTime = (v) => typeof v === 'number' && v > 1.6e12 && v < 2.2e12;
  const cell = (v) => {
    if (v == null) return '';
    if (isTime(v)) return new Date(v).toISOString();
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...list.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
}

export function ammAccountOf(meta) {
  for (const n of meta?.AffectedNodes || []) {
    const c = n.CreatedNode;
    if (c?.LedgerEntryType === 'AccountRoot' && c.NewFields?.AMMID) return c.NewFields.Account;
  }
  return '';
}
