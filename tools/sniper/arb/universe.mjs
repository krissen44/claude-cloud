// Focus set of the arbitrage bot: which tokens it trades (and keeps trust lines for).
//   top    – the tokens with the deepest XRP pools (≈ the top of a "by liquidity" list)
//   hot    – pools whose XRP grew fast with lots of trading (hype, fresh launches); kept for a while
//   rival  – tokens the watched bots (bwif) just used
//   manual – your own list (ARB_TOKENS)
// Everything is computed from the graph and the live stream – no outside data source.

import { XRP } from './engine.mjs';

export function createUniverse(g, cfg) {
  const hist = new Map(); // token → [{t, x}] XRP-side snapshots of its XRP pool
  const trades = new Map(); // token → [timestamps of trades in its XRP pool]
  const hotSince = new Map(); // token → {at, why}
  const rivalAt = new Map(); // token → last time a watched bot used it
  let top = [];
  let set = new Set();
  const now = () => Date.now();
  const H = 3600e3;
  const tokenOf = (p) => (p.a === XRP ? p.b : p.b === XRP ? p.a : null);

  // a tx changed these pools → count trades for tokens with an XRP pool
  function noteChanged(ids) {
    const t = now();
    for (const id of ids) {
      const p = g.pools.get(id);
      const tok = p && tokenOf(p);
      if (!tok) continue;
      let a = trades.get(tok);
      if (!a) trades.set(tok, (a = []));
      a.push(t);
      if (a.length > 2000) a.splice(0, a.length - 2000);
    }
  }
  const noteRival = (tok) => { if (tok && tok !== XRP) rivalAt.set(tok, now()); };

  // every few minutes: remember each XRP pool's size
  function snapshot() {
    const t = now();
    const keep = (cfg.hotWindowH + 1) * H;
    for (const [tok, id] of g.xrpPool) {
      const p = g.pools.get(id);
      if (!p?.ready) continue;
      let a = hist.get(tok);
      if (!a) hist.set(tok, (a = []));
      a.push({ t, x: g.xrpSide(p) });
      while (a.length && t - a[0].t > keep) a.shift();
    }
  }

  function growthOf(tok) {
    const a = hist.get(tok);
    const p = g.pools.get(g.xrpPool.get(tok));
    if (!a?.length || !p?.ready) return null;
    const then = a[0].x; // oldest snapshot inside the window (= first sight for a fresh launch)
    return then > 0 ? (g.xrpSide(p) / then - 1) * 100 : null;
  }
  const tradesIn = (tok, ms) => (trades.get(tok) || []).filter((t) => now() - t <= ms).length;

  function recompute() {
    const t = now();
    // top by XRP liquidity
    const deep = [];
    for (const [tok, id] of g.xrpPool) {
      const p = g.pools.get(id);
      if (p?.ready && g.xrpSide(p) * 2 >= cfg.minPoolXrp) deep.push([tok, g.xrpSide(p)]);
    }
    deep.sort((a, b) => b[1] - a[1]);
    top = deep.slice(0, cfg.topN).map(([tok]) => tok);
    // hype: fast liquidity growth + trading
    for (const [tok] of deep) {
      const gr = growthOf(tok);
      const n = tradesIn(tok, cfg.hotWindowH * H);
      if (gr != null && gr >= cfg.hotGrowth && n >= cfg.hotMinTrades) hotSince.set(tok, { at: t, why: `+${gr.toFixed(0)}% liquidity, ${n} trades / ${cfg.hotWindowH}h` });
    }
    for (const [tok, h] of hotSince) if (t - h.at > cfg.hotKeepH * H) hotSince.delete(tok);
    for (const [tok, at] of rivalAt) if (t - at > cfg.hotKeepH * H) rivalAt.delete(tok);
    set = cfg.listOnly ? new Set(cfg.tokens) : new Set([...cfg.tokens, ...top, ...hotSince.keys(), ...rivalAt.keys()]);
    return set;
  }

  // order for trust lines: own list, rivals, hot, then top by liquidity
  function priority() {
    const out = [];
    if (cfg.listOnly) { // the list, deepest XRP pool first
      const x = (k) => { const p = g.pools.get(g.xrpPool.get(k)); return p?.ready ? g.xrpSide(p) : 0; };
      return [...cfg.tokens].sort((a, b) => x(b) - x(a));
    }
    const add = (k) => { if (!out.includes(k)) out.push(k); };
    cfg.tokens.forEach(add);
    [...rivalAt.entries()].sort((a, b) => b[1] - a[1]).forEach(([k]) => add(k));
    [...hotSince.entries()].sort((a, b) => b[1].at - a[1].at).forEach(([k]) => add(k));
    top.forEach(add);
    return out;
  }

  // tokens worth adding to the list (shown on the page, never traded by themselves):
  // deep pools, hype and the rivals' tokens that aren't on it yet
  function candidates() {
    const xrpOf = (tok) => { const p = g.pools.get(g.xrpPool.get(tok)); return p?.ready ? +g.xrpSide(p).toFixed(0) : 0; };
    const out = new Map();
    const add = (tok, why) => { if (cfg.tokens.includes(tok) || tok === XRP) return; const o = out.get(tok) || { tok, why: [] }; o.why.push(why); out.set(tok, o); };
    top.slice(0, 15).forEach((tok, i) => add(tok, `top ${i + 1} by liquidity`));
    for (const [tok, h] of hotSince) add(tok, h.why);
    for (const [tok] of rivalAt) add(tok, 'used by the rivals');
    return [...out.values()].map((o) => ({ tok: o.tok, xrp: xrpOf(o.tok), growth: growthOf(o.tok), trades1h: tradesIn(o.tok, H), why: o.why.join(' · ') })).sort((a, b) => b.xrp - a.xrp);
  }

  function list() {
    const xrpOf = (tok) => { const p = g.pools.get(g.xrpPool.get(tok)); return p?.ready ? +g.xrpSide(p).toFixed(0) : null; };
    const why = (tok) => [cfg.tokens.includes(tok) && (cfg.listOnly ? 'list' : 'yours'), rivalAt.has(tok) && 'rival', hotSince.has(tok) && hotSince.get(tok).why, top.includes(tok) && `top ${top.indexOf(tok) + 1}`].filter(Boolean).join(' · ');
    return priority().map((tok) => ({ tok, xrp: xrpOf(tok), growth: growthOf(tok), trades1h: tradesIn(tok, H), why: why(tok) }));
  }

  return { noteChanged, noteRival, snapshot, recompute, priority, list, candidates, has: (a) => a === XRP || set.has(a), size: () => set.size, set: () => set };
}
