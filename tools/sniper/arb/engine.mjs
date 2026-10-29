// Arbitrage engine (pure, no I/O): a graph of AMM pools kept exact from ledger metadata, cycle
// search XRP → … → XRP through the pools that just moved, and the best input size per cycle.
// Order books (DEX offers) of a pair are merged with its AMM like the ledger's payment engine
// does: each bit of input goes to whichever is better – the AMM at its current price or the best
// offer – so a cheap resting offer is bought first and the AMM takes the rest.
//
// Asset key: 'XRP' or '<currency>.<issuer>'. A pool joins two assets; reserves are what the AMM
// account holds. Swap math = XRPL AMM constant product with the trading fee taken from the input.

export const XRP = 'XRP';
export const assetKey = (a) => (typeof a === 'string' || a?.currency === 'XRP' || !a?.currency ? XRP : `${a.currency}.${a.issuer}`);
export const assetObj = (k) => (k === XRP ? { currency: 'XRP' } : { currency: k.split('.')[0], issuer: k.split('.')[1] });

export function swapOut(x, rin, rout, fee) {
  const i = x * (1 - fee);
  return (rout * i) / (rin + i);
}

export function createGraph() {
  const pools = new Map(); // amm account → {id, a, b, ra, rb, fee, ready}
  const adj = new Map(); // asset → Set(pool id)
  const xrpPool = new Map(); // token → pool id of its XRP pool (deepest one)

  const link = (asset, id) => { if (!adj.has(asset)) adj.set(asset, new Set()); adj.get(asset).add(id); };
  const unlink = (asset, id) => adj.get(asset)?.delete(id);

  function upsert({ id, a, b, ra, rb, fee }) {
    let p = pools.get(id);
    if (!p) {
      p = { id, a, b, ra: 0, rb: 0, fee: 0, ready: false };
      pools.set(id, p);
      link(a, id); link(b, id);
    }
    if (ra != null) p.ra = ra;
    if (rb != null) p.rb = rb;
    if (fee != null) p.fee = fee;
    p.ready = p.ra > 0 && p.rb > 0;
    if (p.a === XRP || p.b === XRP) {
      const tok = p.a === XRP ? p.b : p.a;
      const cur = pools.get(xrpPool.get(tok));
      if (!cur || cur === p || xrpSide(p) > xrpSide(cur)) xrpPool.set(tok, id);
    }
    return p;
  }
  function remove(id) {
    const p = pools.get(id);
    if (!p) return;
    pools.delete(id);
    unlink(p.a, id); unlink(p.b, id);
    for (const tok of [p.a, p.b]) if (xrpPool.get(tok) === id) xrpPool.delete(tok);
  }
  const xrpSide = (p) => (p.a === XRP ? p.ra : p.b === XRP ? p.rb : 0);
  // reserve of `asset` in pool p / of the other side
  const resOf = (p, asset) => (p.a === asset ? p.ra : p.rb);
  const other = (p, asset) => (p.a === asset ? p.b : p.a);

  // value of an amount of `asset` in XRP via its XRP pool (mid price), for liquidity filters
  function inXrp(asset, amount) {
    if (asset === XRP) return amount;
    const p = pools.get(xrpPool.get(asset));
    if (!p?.ready) return 0;
    return (amount * xrpSide(p)) / resOf(p, asset);
  }
  // pool depth in XRP (both sides valued)
  const depth = (p) => (p.a === XRP || p.b === XRP ? 2 * xrpSide(p) : inXrp(p.a, p.ra) + inXrp(p.b, p.rb));

  // order books: "from>to" → offers best first; a taker pays `in` of `from` and gets `out` of `to`
  const books = new Map();
  function setBook(from, to, offers) {
    const list = (offers || []).filter((o) => o.in > 0 && o.out > 0).map((o) => ({ ...o, q: o.out / o.in })).sort((a, b) => b.q - a.q);
    const k = `${from}>${to}`;
    const before = (books.get(k) || []).map((o) => `${o.in}:${o.out}`).join(',');
    if (list.length) books.set(k, list); else books.delete(k);
    return before !== list.map((o) => `${o.in}:${o.out}`).join(','); // changed?
  }
  const bestQ = (from, to) => books.get(`${from}>${to}`)?.[0]?.q || 0;

  return { pools, adj, xrpPool, upsert, remove, resOf, other, xrpSide, inXrp, depth, books, setBook, bestQ };
}

// ---------- reading pool balances from transaction metadata ----------
// Returns the AMM accounts whose reserves/fee changed, after applying the new values to the graph.
export function applyMeta(g, meta, onNewPool) {
  const changed = new Set();
  const nodes = meta?.AffectedNodes || [];
  // pass 1: AMM objects (a new pool must exist before its balances are read in pass 2)
  for (const n of nodes) {
    const node = n.ModifiedNode || n.CreatedNode || n.DeletedNode;
    if (!node || node.LedgerEntryType !== 'AMM') continue;
    const f = node.FinalFields || node.NewFields || {};
    if (n.DeletedNode) { g.remove(f.Account); changed.add(f.Account); continue; }
    if (n.CreatedNode) {
      g.upsert({ id: f.Account, a: assetKey(f.Asset), b: assetKey(f.Asset2), fee: (f.TradingFee || 0) / 1e5 });
      onNewPool?.(f.Account);
      changed.add(f.Account);
    } else if (!g.pools.has(f.Account) && f.Asset && f.Asset2) {
      // a pool we didn't know (deposit/withdraw/vote touches its AMM object) – learn it now
      g.upsert({ id: f.Account, a: assetKey(f.Asset), b: assetKey(f.Asset2), fee: (f.TradingFee || 0) / 1e5 });
      onNewPool?.(f.Account);
    } else if (g.pools.has(f.Account) && f.TradingFee != null) { g.upsert({ id: f.Account, fee: f.TradingFee / 1e5 }); changed.add(f.Account); }
  }
  // pass 2: balances of AMM accounts
  for (const n of nodes) {
    const node = n.ModifiedNode || n.CreatedNode || n.DeletedNode;
    if (!node || node.LedgerEntryType === 'AMM') continue;
    const f = node.FinalFields || node.NewFields || {};
    if (node.LedgerEntryType === 'AccountRoot') {
      const p = g.pools.get(f.Account);
      if (!p && f.AMMID) { onNewPool?.(f.Account); continue; } // an AMM account we don't know yet: read it
      if (p && f.Balance != null && (p.a === XRP || p.b === XRP)) {
        const v = Number(f.Balance) / 1e6;
        g.upsert(p.a === XRP ? { id: p.id, ra: v } : { id: p.id, rb: v });
        changed.add(p.id);
      }
      continue;
    }
    if (node.LedgerEntryType === 'RippleState' && f.Balance) {
      const lo = f.LowLimit?.issuer;
      const hi = f.HighLimit?.issuer;
      for (const [acct, issuer, sign] of [[lo, hi, 1], [hi, lo, -1]]) {
        const p = g.pools.get(acct);
        if (!p) continue;
        const asset = `${f.Balance.currency}.${issuer}`;
        const v = n.DeletedNode ? 0 : sign * Number(f.Balance.value);
        if (p.a === asset) g.upsert({ id: p.id, ra: v });
        else if (p.b === asset) g.upsert({ id: p.id, rb: v });
        else continue;
        changed.add(p.id);
      }
    }
  }
  return changed;
}

// ---------- one hop: AMM + order book ----------
// st = what the hops before already did (pool reserves, offers taken), so a pool or book used twice
// in one loop sees its own earlier effect. books=false → AMM only.
export const newState = () => ({ r: new Map(), u: new Map() });
export function hopOut(g, h, x, st, books = true) {
  const p = g.pools.get(h.pool);
  let s = st.r.get(p.id);
  if (!s) { s = { ra: p.ra, rb: p.rb }; st.r.set(p.id, s); }
  const fi = p.a === h.from ? 'ra' : 'rb', fo = fi === 'ra' ? 'rb' : 'ra';
  const amm = (dx) => { const d = swapOut(dx, s[fi], s[fo], p.fee); s[fi] += dx; s[fo] -= d; return d; };
  const bk = `${h.from}>${h.to}`;
  const book = books ? g.books?.get(bk) : null;
  if (!book?.length) return amm(x);
  let u = st.u.get(bk);
  if (!u) { u = { i: 0, left: book[0].in }; st.u.set(bk, u); }
  const k = 1 - p.fee;
  let rest = x, out = 0;
  while (rest > 1e-12) {
    while (u.i < book.length && u.left <= 1e-12) { u.i++; u.left = book[u.i]?.in || 0; }
    const o = book[u.i];
    if (!o) { out += amm(rest); break; }
    // AMM better than this offer: AMM until its price has come down to the offer's
    if ((s[fo] * k) / s[fi] > o.q) {
      const dx = Math.min(rest, Math.max(0, (Math.sqrt((s[fo] * s[fi] * k) / o.q) - s[fi]) / k));
      if (dx > 0) { out += amm(dx); rest -= dx; }
      if (rest <= 1e-12) break;
    }
    const take = Math.min(rest, u.left);
    out += take * o.q; rest -= take; u.left -= take;
  }
  return out;
}
// marginal rate of a hop at size 0: the better of AMM and best offer
export function hopRate(g, h) {
  const p = g.pools.get(h.pool);
  return Math.max((g.resOf(p, h.to) / g.resOf(p, h.from)) * (1 - p.fee), g.bestQ ? g.bestQ(h.from, h.to) : 0);
}

// ---------- cycles ----------
// A cycle = list of hops {pool, from, to}, starting and ending at XRP.
export function cycleOut(g, hops, x, books = true, st = newState()) {
  let amt = x;
  for (const h of hops) amt = hopOut(g, h, amt, st, books);
  return amt;
}
// product of marginal rates – > 1 means the loop pays at very small size
export function cycleRate(g, hops) {
  let r = 1;
  for (const h of hops) r *= hopRate(g, h);
  return r;
}
// best input in [lo, hi] (profit is concave in x for constant-product chains)
export function bestSize(g, hops, lo, hi) {
  const f = (x) => cycleOut(g, hops, x) - x;
  if (hi <= lo) return { x: lo, profit: f(lo) };
  let a = lo, b = hi;
  const k = (Math.sqrt(5) - 1) / 2;
  let c = b - k * (b - a), d = a + k * (b - a), fc = f(c), fd = f(d);
  for (let i = 0; i < 60 && b - a > 1e-6; i++) {
    if (fc > fd) { b = d; d = c; fd = fc; c = b - k * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + k * (b - a); fd = f(d); }
  }
  const x = (a + b) / 2;
  return { x, profit: f(x) };
}

// Paths from XRP to `target` (and from `source` back to XRP) with 0..maxLen pools, as hop lists.
function pathsTo(g, target, maxLen, ok) {
  const out = [];
  const walk = (asset, tail, seen) => {
    if (asset === XRP) { out.push(tail); return; }
    if (tail.length >= maxLen) return;
    for (const id of g.adj.get(asset) || []) {
      const p = g.pools.get(id);
      if (!ok(p)) continue;
      const from = g.other(p, asset);
      if (seen.has(from) && from !== XRP) continue;
      if (from !== XRP && tail.length + 1 >= maxLen) continue; // would need one more hop to reach XRP
      walk(from, [{ pool: id, from, to: asset }, ...tail], new Set([...seen, from]));
    }
  };
  walk(target, [], new Set([target]));
  return out;
}
function pathsFrom(g, source, maxLen, ok) {
  return pathsTo(g, source, maxLen, ok).map((hops) => hops.slice().reverse().map((h) => ({ pool: h.pool, from: h.to, to: h.from })));
}

// All cycles of up to maxHops pools that use at least one of the `changed` pools.
export function findCycles(g, changed, { maxHops = 4, minDepthXrp = 0, minRate = 1, maxPairs = 200000, allow = null } = {}) {
  const ok = (p) => p?.ready && (!minDepthXrp || g.depth(p) >= minDepthXrp) && (!allow || (allow(p.a) && allow(p.b)));
  const found = new Map();
  for (const id of changed) {
    const p = g.pools.get(id);
    if (!ok(p)) continue;
    // one pair, two ways: buy from an offer, sell into the AMM (or the other way round)
    if ((p.a === XRP || p.b === XRP) && g.books?.size) {
      const t = p.a === XRP ? p.b : p.a;
      if (g.books.has(`${XRP}>${t}`) || g.books.has(`${t}>${XRP}`)) {
        const hops = [{ pool: id, from: XRP, to: t }, { pool: id, from: t, to: XRP }];
        const rate = cycleRate(g, hops);
        const key = `${id}:${t}>${id}:${XRP}`;
        if (rate > minRate) found.set(key, { key, hops, rate, book: true });
      }
    }
    for (const [u, v] of [[p.a, p.b], [p.b, p.a]]) {
      const lefts = u === XRP ? [[]] : pathsTo(g, u, maxHops - 1, ok);
      const rights = v === XRP ? [[]] : pathsFrom(g, v, maxHops - 1, ok);
      if (lefts.length * rights.length > maxPairs) continue; // a hub on both sides – too many combinations
      for (const L of lefts) {
        for (const R of rights) {
          if (L.length + R.length + 1 > maxHops || L.length + R.length < 1) continue;
          const hops = [...L, { pool: id, from: u, to: v }, ...R];
          const poolsUsed = new Set(hops.map((h) => h.pool));
          if (poolsUsed.size !== hops.length) continue;
          const assets = hops.map((h) => h.to).slice(0, -1);
          if (new Set(assets).size !== assets.length || assets.includes(XRP)) continue;
          const key = hops.map((h) => `${h.pool}:${h.to}`).join('>');
          if (found.has(key)) continue;
          const rate = cycleRate(g, hops);
          if (rate > minRate) found.set(key, { key, hops, rate });
        }
      }
    }
  }
  return [...found.values()];
}
