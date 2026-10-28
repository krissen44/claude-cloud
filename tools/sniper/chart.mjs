// Chart health of a position (0–100) from its own recent history: price trend, liquidity, higher
// lows, drawdown from the high, buy vs. sell pressure, new wallets and liquidity pulled. Used to
// hold instead of selling while the chart looks healthy, and to buy more once.
//
// The learner checks every hold / add-on 20 minutes later (was the price higher than at the
// decision?) and moves its score thresholds: up after mistakes, slowly down after good calls.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// hist: [{at, xrp, price, flow?: {buys, sells, buyers, lpRemove}}] oldest first
export function chartHealth(hist, t = Date.now(), windowMs = 600e3) {
  const h = (hist || []).filter((x) => t - x.at <= windowMs && x.price > 0);
  if (h.length < 4 || h.at(-1).at - h[0].at < 90e3) return null; // not enough chart yet
  const first = h[0];
  const last = h.at(-1);
  const mid = Math.floor(h.length / 2);
  const low1 = Math.min(...h.slice(0, mid).map((x) => x.price));
  const low2 = Math.min(...h.slice(mid).map((x) => x.price));
  const high = Math.max(...h.map((x) => x.price));
  const parts = {
    trend: +(clamp((last.price / first.price - 1) * 100, -25, 25) * 0.6).toFixed(1),
    liquidity: +(clamp((last.xrp / first.xrp - 1) * 100, -20, 20) * 0.5).toFixed(1),
    higherLows: low2 >= low1 ? 10 : -5,
    drawdown: +(-Math.min(20, (1 - last.price / high) * 40)).toFixed(1),
  };
  if (first.flow && last.flow) {
    const buys = last.flow.buys - first.flow.buys;
    const sells = last.flow.sells - first.flow.sells;
    if (buys + sells >= 5) parts.buyPressure = +((buys / (buys + sells) - 0.5) * 30).toFixed(1);
    parts.newWallets = +(Math.min(20, Math.max(0, last.flow.buyers - first.flow.buyers)) * 0.5).toFixed(1);
    if ((last.flow.lpRemove || 0) - (first.flow.lpRemove || 0) > 1) parts.liquidityPulled = -40;
  }
  const score = Math.round(clamp(50 + Object.values(parts).reduce((a, b) => a + b, 0), 0, 100));
  return { score, parts };
}

export function createChartLearner(state, cfg, { now = Date.now, log = () => {} } = {}) {
  const L = (state.chartLearn ||= { hold: { th: cfg.chartHoldScore, res: [] }, add: { th: cfg.chartAddScore, res: [] }, pending: [] });
  // score needed; a new value on the settings page starts the learning over from there
  function th(kind) {
    const base = kind === 'hold' ? cfg.chartHoldScore : cfg.chartAddScore;
    const k = L[kind];
    if (k.base !== base) { k.base = base; k.th = base; k.res = []; }
    return cfg.chartLearn === false ? base : k.th;
  }
  // a hold / add-on decision to be judged later
  function note(kind, pos, price, score) {
    L.pending.push({ kind, k: pos.k, name: pos.name, currency: pos.currency, issuer: pos.issuer, at: now(), price, score });
    if (L.pending.length > 200) L.pending.splice(0, L.pending.length - 200);
  }
  // judge decisions older than 20 min; priceOf(currency, issuer) → current price (0 = dead)
  async function evaluate(priceOf) {
    const due = L.pending.filter((d) => now() - d.at >= (cfg.chartJudgeMin ?? 20) * 60e3);
    if (!due.length) return [];
    const out = [];
    const touched = new Set();
    for (const d of due) {
      let p;
      try { p = await priceOf(d.currency, d.issuer); } catch { continue; }
      L.pending.splice(L.pending.indexOf(d), 1);
      const good = p >= d.price * (d.kind === 'add' ? 1.02 : 1);
      const k = L[d.kind];
      k.res.push(good ? 1 : 0);
      if (k.res.length > 12) k.res.shift();
      touched.add(d.kind);
      out.push({ ...d, later: p, good });
    }
    // one step per round, from the last 12 calls
    for (const kind of touched) {
      const k = L[kind];
      if (cfg.chartLearn === false || k.res.length < 4) continue;
      const rate = k.res.reduce((a, b) => a + b, 0) / k.res.length;
      const before = k.th;
      if (rate < 0.5) k.th = Math.min(95, k.th + 5);
      else if (rate > 0.75) k.th = Math.max(55, k.th - 3);
      if (k.th !== before) log(`🧠 chart ${kind}: ${Math.round(rate * 100)} % good calls → score needed ${before} → ${k.th}`);
    }
    return out;
  }
  const summary = () => ({
    hold: { th: th('hold'), good: L.hold.res.reduce((a, b) => a + b, 0), n: L.hold.res.length },
    add: { th: th('add'), good: L.add.res.reduce((a, b) => a + b, 0), n: L.add.res.length },
    pending: L.pending.length,
  });
  return { th, note, evaluate, summary };
}
