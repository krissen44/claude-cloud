// Trading profile of a wallet from its own ledger history: which tokens it bought, how big the pool
// was when it bought, how long it held until its first sale, what came out (sales + tokens still
// held at today's price −10 %). Used to decide if a wallet can be copied at all:
//   - a scalper / flipper sells minutes after its buy – we buy after it and would be its exit liquidity
//   - a holder that makes its money in big pools but loses in small ones → copy only big-pool buys
//
// req(command, params) → result (like client.request(...).result)

const BUCKETS = [[0, 100, '<100'], [100, 300, '100–300'], [300, 1000, '300–1000'], [1000, Infinity, '1000+']];
export const poolBucket = (x) => BUCKETS.find(([a, b]) => x >= a && x < b)?.[2] || '?';
const med = (a) => { const s = a.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

// one transaction → {xrp: change (fee left out), tokens: {key: change}, pool: XRP in the AMM it hit}
export function walletMove(tx, meta, w) {
  let dx = 0;
  const dt = {};
  const bal = {}; // token balances after the transaction
  let pool = 0;
  for (const n of meta?.AffectedNodes || []) {
    const nd = n.ModifiedNode || n.CreatedNode || n.DeletedNode;
    if (!nd) continue;
    const f = nd.FinalFields || nd.NewFields || {};
    const pf = nd.PreviousFields || {};
    if (nd.LedgerEntryType === 'AccountRoot') {
      if (f.Account === w && pf.Balance != null) dx += (Number(f.Balance) - Number(pf.Balance)) / 1e6;
      if (f.AMMID && f.Balance != null) pool = Math.max(pool, Number(f.Balance) / 1e6);
    }
    if (nd.LedgerEntryType === 'RippleState' && f.Balance && !n.DeletedNode) {
      const lo = f.LowLimit?.issuer, hi = f.HighLimit?.issuer;
      if (lo !== w && hi !== w) continue;
      const cur = f.Balance.currency;
      if (/^03/.test(cur) && cur.length === 40) continue; // LP tokens
      const sign = lo === w ? 1 : -1;
      const now = sign * Number(f.Balance.value);
      const prev = n.CreatedNode ? 0 : sign * Number((pf.Balance || f.Balance).value);
      const k = `${cur}.${lo === w ? hi : lo}`;
      dt[k] = (dt[k] || 0) + now - prev;
      bal[k] = now;
    }
  }
  if (tx.Account === w) dx += Number(tx.Fee || 0) / 1e6;
  return { xrp: dx, tokens: dt, pool, bal };
}

export async function profileWallet(req, w, { maxTx = 1200, maxPrices = 30, now = Date.now() } = {}) {
  const txs = [];
  let marker;
  do {
    const r = await req('account_tx', { account: w, limit: 400, ...(marker ? { marker } : {}) });
    txs.push(...(r?.transactions || []));
    marker = r?.marker;
  } while (marker && txs.length < maxTx);
  const T = {};
  for (const t of txs) {
    const tx = t.tx || t.tx_json || {};
    const meta = t.meta;
    if (!meta || meta.TransactionResult !== 'tesSUCCESS' || tx.Account !== w || !/^(Payment|OfferCreate)$/.test(tx.TransactionType)) continue;
    const m = walletMove(tx, meta, w);
    const ks = Object.keys(m.tokens).filter((k) => m.tokens[k] !== 0);
    if (ks.length !== 1 || Math.abs(m.xrp) < 0.01) continue;
    const k = ks[0], d = m.tokens[k];
    const at = (tx.date || 0) + 946684800; // ripple epoch → unix s
    const s = (T[k] ||= { k, in: 0, out: 0, tokIn: 0, tokOut: 0, buys: 0, sells: 0, pools: [], buySizes: [], first: Infinity, firstSell: null });
    if (m.xrp < 0 && d > 0) { s.in += -m.xrp; s.tokIn += d; s.buys++; s.pools.push(m.pool); s.buySizes.push(-m.xrp); s.first = Math.min(s.first, at); }
    if (m.xrp > 0 && d < 0) { s.out += m.xrp; s.tokOut += -d; s.sells++; s.firstSell = Math.min(s.firstSell ?? Infinity, at); }
  }
  const toks = Object.values(T).filter((s) => s.buys);
  // value of what it still holds (most recent tokens first, a limited number of price reads)
  toks.sort((a, b) => b.first - a.first);
  let priced = 0;
  for (const s of toks) {
    s.held = Math.max(0, s.tokIn - s.tokOut);
    s.val = 0;
    if (s.held <= 0 || s.tokOut / s.tokIn > 0.98 || priced >= maxPrices) continue;
    priced++;
    const [currency, issuer] = s.k.split('.');
    try {
      const a = (await req('amm_info', { asset: { currency: 'XRP' }, asset2: { currency, issuer } })).amm;
      const x = Number(typeof a.amount === 'string' ? a.amount : a.amount2) / 1e6;
      const tk = Number((typeof a.amount === 'string' ? a.amount2 : a.amount).value);
      if (x > 0 && tk > 0) s.val = s.held * (x / tk) * 0.9;
    } catch {}
  }
  for (const s of toks) {
    s.pnl = s.out + s.val - s.in;
    s.x = (s.out + s.val) / s.in;
    s.pool = Math.max(...s.pools);
    s.holdMin = s.firstSell != null && s.firstSell >= s.first ? (s.firstSell - s.first) / 60 : null;
  }
  if (!toks.length) return { wallet: w, at: now, txs: txs.length, tokens: 0, style: 'unknown', copyable: false, why: 'no token trades found' };
  const days = Math.max(1, (Math.max(...toks.map((s) => s.first)) - Math.min(...toks.map((s) => s.first))) / 86400 + 1);
  const sum = (f, l = toks) => l.reduce((a, s) => a + f(s), 0);
  const holds = toks.map((s) => s.holdMin);
  const byPool = BUCKETS.map(([, , name]) => {
    const l = toks.filter((s) => poolBucket(s.pool) === name);
    return { name, tokens: l.length, wins: l.filter((s) => s.x >= 1.1).length, in: +sum((s) => s.in, l).toFixed(1), pnl: +sum((s) => s.pnl, l).toFixed(1) };
  }).filter((b) => b.tokens);
  const sold = holds.filter((h) => h != null);
  const p = {
    wallet: w, at: now, txs: txs.length, tokens: toks.length, perDay: +(toks.length / days).toFixed(1),
    holdMin: med(holds), fastShare: sold.length ? +(sold.filter((h) => h < 10).length / sold.length).toFixed(2) : 0,
    medX: +(med(toks.map((s) => s.x)) || 0).toFixed(2), wins: toks.filter((s) => s.x >= 1.1).length,
    in: +sum((s) => s.in).toFixed(1), realized: +sum((s) => s.out - s.in).toFixed(1), held: +sum((s) => s.val).toFixed(1), pnl: +sum((s) => s.pnl).toFixed(1),
    medBuy: +(med(toks.flatMap((s) => s.buySizes)) || 0).toFixed(2),
    top3: +[...toks].sort((a, b) => b.pnl - a.pnl).slice(0, 3).reduce((a, s) => a + s.pnl, 0).toFixed(1),
    byPool,
    recent: toks.slice(0, 12).map((s) => ({ k: s.k, in: +s.in.toFixed(1), x: +s.x.toFixed(2), pool: Math.round(s.pool), holdMin: s.holdMin == null ? null : Math.round(s.holdMin) })),
  };
  // style: how it trades, and whether copying it can work for us (we always buy after it)
  if (p.holdMin != null && p.holdMin < 15 && p.fastShare >= 0.5) p.style = p.perDay >= 8 ? 'scalper' : 'flipper';
  else if (p.perDay >= 15) p.style = 'scalper';
  else p.style = 'holder';
  // pool sizes where it makes ≥ 10 % on what it put in, over ≥ 3 tokens
  p.goodPools = byPool.filter((b) => b.tokens >= 3 && b.pnl >= 0.1 * b.in).map((b) => b.name);
  p.lucky = p.pnl > 0 && p.top3 >= 0.9 * p.pnl && p.medX < 1; // almost all profit from 3 tokens, most trades lose
  if (p.style !== 'holder') { p.copyable = false; p.why = `${p.style}: sells after ~${Math.round(p.holdMin ?? 0)} min (${Math.round(p.fastShare * 100)} % within 10 min) – we would buy after it and be its exit`; }
  else if (p.pnl <= 0) { p.copyable = false; p.why = `loses overall (${p.pnl} XRP)`; }
  else if (!p.goodPools.length) { p.copyable = false; p.why = 'no pool size where it makes money on ≥ 3 tokens'; }
  else { p.copyable = true; p.why = `holder (median ${Math.round(p.holdMin ?? 0)} min), earns in pools ${p.goodPools.join(', ')} XRP${p.lucky ? ' – but ⚠️ almost all of it from 3 tokens, most of its trades lose' : ''}`; }
  return p;
}

export function profileText(p) {
  if (!p) return 'not analysed yet';
  if (!p.tokens) return `${p.wallet.slice(0, 8)}…: ${p.why}`;
  const pools = p.byPool.map((b) => `${b.name}: ${b.tokens} tok, ${b.wins} wins, ${b.pnl >= 0 ? '+' : ''}${b.pnl}`).join(' · ');
  return `${p.copyable ? '✅ copyable' : '⚠️ not copyable'} – ${p.why}. ${p.tokens} tokens (${p.perDay}/day), median hold ${p.holdMin == null ? '–' : Math.round(p.holdMin) + ' min'}, median ${p.medX}×, ${p.wins} wins, result ${p.pnl >= 0 ? '+' : ''}${p.pnl} XRP (realized ${p.realized}, held ${p.held}; top 3 tokens ${p.top3}), median buy ${p.medBuy} XRP. By pool size at its buy: ${pools}`;
}
