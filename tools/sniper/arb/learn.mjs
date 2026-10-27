// Learning from our own batches: every landed batch is a win or a miss. The learner counts both per
// margin class (how far above break-even the loop looked), per route, per held token and per pool,
// with older results fading out (half-life). From that it estimates the chance that a new loop
// goes through and the bot only sends what clears the target win rate – or, within a daily
// exploration budget, routes it hasn't seen often enough to judge yet.
//
// Misses are classified: "beaten" = someone else moved one of our pools earlier in the same ledger
// (competition – that pool is contested), "model" = nothing moved and it still failed (our math is
// off for that route – it is blocked longer).

export const MARGIN_BP = [5, 15, 40, 100, 300]; // classes: <5, 5–15, 15–40, 40–100, 100–300, ≥300 bp
export const marginClass = (net, x) => {
  const bp = (net / x) * 1e4;
  let i = 0;
  while (i < MARGIN_BP.length && bp >= MARGIN_BP[i]) i++;
  return i;
};
export const marginLabel = (i) => (i === 0 ? `<${MARGIN_BP[0]} bp` : i === MARGIN_BP.length ? `≥${MARGIN_BP.at(-1)} bp` : `${MARGIN_BP[i - 1]}–${MARGIN_BP[i]} bp`);

export function createLearner(state, cfg, clock = Date.now) {
  const L = (state.learn ||= { k: {}, why: {} });
  const half = () => (cfg.learnHalfLifeH || 72) * 3600e3;
  const get = (key) => {
    const c = L.k[key];
    if (!c) return [0, 0];
    const f = Math.pow(0.5, (clock() - c[2]) / half());
    return [c[0] * f, c[1] * f];
  };
  const bump = (key, win, weight = 1) => {
    const [w, n] = get(key);
    L.k[key] = [w + (win ? weight : 0), n + weight, clock()];
  };
  const cls = (o) => `${o.hops.length}:${marginClass(o.net, o.x)}`;
  const S = 4; // how many own results it takes to outweigh the prior
  // rate with a prior: (wins + S·prior) / (tries + S)
  const rate = (key, prior) => { const [w, n] = get(key); return { r: (w + S * prior) / (n + S), n }; };
  const base = (key, a, b) => { const [w, n] = get(key); return (w + a) / (n + a + b); };

  // chance this loop goes through = (no pool moved by someone else before us) × (our math is right)
  //   pools: each pool's own record, unknown pools take the rate of their margin class
  //   math:  the route's and the held token's record, unknown ones take the class rate
  function estimate(o) {
    const c = cls(o);
    const poolPrior = rate(`mp:${c}`, base('gp', 9, 1)).r;
    const mathPrior = rate(`mm:${c}`, base('gm', 9, 1)).r;
    let pPools = 1;
    for (const h of o.hops) pPools *= rate(`p:${h.pool}`, poolPrior).r;
    const route = rate(`r:${o.key}`, mathPrior);
    const tok = rate(`t:${o.assets[o.held]}`, mathPrior);
    const pMath = Math.min(route.n ? route.r : mathPrior, tok.n ? tok.r : mathPrior);
    return { p: pPools * pMath, pPools, pMath, seen: route.n, cls: marginClass(o.net, o.x) };
  }

  // decision for one loop: 'go' (confident), 'explore' (unknown, within budget) or a reason to skip
  function decide(o, feeXrp, budget) {
    const e = estimate(o);
    const ev = e.p * o.net - (1 - e.p) * feeXrp;
    o.p = +e.p.toFixed(3);
    o.ev = ev;
    if (ev <= 0) return 'negativeEv';
    if (e.p >= cfg.targetWin) return 'go';
    // a route we haven't tried often enough: try it within the daily budget (costs only the fee),
    // unless what we know about its pools already says it will fail
    if (e.seen < (cfg.learnMinTries || 6) && e.p >= cfg.targetWin * 0.5 && budget > 0) return 'explore';
    return 'lowChance';
  }

  function record(o, outcome, why = '') {
    const win = outcome === 'win';
    const c = cls(o);
    const beaten = new Set(why === 'beaten' ? o.beatenPools || [] : []);
    for (const h of o.hops) {
      const ok = !beaten.has(h.pool);
      bump(`p:${h.pool}`, ok); bump(`mp:${c}`, ok); bump('gp', ok);
    }
    if (why !== 'beaten') { // the math is only tested when nobody got in the way
      const ok = win;
      bump(`r:${o.key}`, ok); bump(`t:${o.assets[o.held]}`, ok); bump(`mm:${c}`, ok); bump('gm', ok);
    }
    bump(`m:${c}`, win); // plain win rate per class, for the page
    if (!win) L.why[why || 'other'] = (L.why[why || 'other'] || 0) + 1;
    // forget keys that faded to nothing
    if (Math.random() < 0.02) for (const key of Object.keys(L.k)) if (get(key)[1] < 0.05) delete L.k[key];
  }

  // what the learner knows, for the page
  function table() {
    const rows = [];
    for (const key of Object.keys(L.k)) {
      if (!key.startsWith('m:')) continue;
      const [, hops, cls] = key.split(':');
      const [w, n] = get(key);
      if (n >= 0.5) rows.push({ hops: +hops, margin: marginLabel(+cls), cls: +cls, wins: +w.toFixed(1), tries: +n.toFixed(1), rate: +(w / n).toFixed(3) });
    }
    return rows.sort((a, b) => a.hops - b.hops || a.cls - b.cls);
  }
  function worst(prefix, n = 8) {
    return Object.keys(L.k).filter((k) => k.startsWith(prefix)).map((k) => { const [w, t] = get(k); return { key: k.slice(prefix.length), wins: +w.toFixed(1), tries: +t.toFixed(1), rate: t ? +(w / t).toFixed(3) : 0 }; })
      .filter((r) => r.tries >= 2).sort((a, b) => a.rate - b.rate || b.tries - a.tries).slice(0, n);
  }
  return { estimate, decide, record, table, worst, why: () => ({ ...L.why }) };
}
