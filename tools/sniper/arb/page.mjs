// HTML for /arb (served by arb.js, shown through the sniper's login at xrpsnipes.tech/arb)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const f = (n, d = 4) => (n == null || isNaN(n) ? '–' : (n >= 0 ? '+' : '') + Number(n).toFixed(d));
const t = (ms) => new Date(ms).toISOString().slice(5, 19).replace('T', ' ');

export function arbPage(st) {
  const s = st.stats || {};
  const net = st.startBalance != null ? st.balance - st.startBalance : null;
  const att = s.attempts || 0;
  const trades = (st.trades || []).map((r) => `<tr><td>${t(r.t)}</td><td>${esc(r.route)}</td><td>${r.x}</td><td>${f(r.expected, 5)}</td><td class="${r.applied ? (r.pnl >= 0 ? 'g' : 'r') : ''}">${r.applied ? f(r.pnl, 5) : esc(r.result)}</td><td>${esc(r.held || '')}</td></tr>`).join('');
  const rivals = (st.rivals || []).map((r) => `<tr><td>${t(r.t)}</td><td>${esc(r.who)}</td><td>${esc(r.route)}</td><td class="${r.applied ? 'g' : ''}">${r.applied ? f(r.pnl, 5) : 'failed'}</td></tr>`).join('');
  const hot = (st.hot || []).map((h) => `<tr><td>${esc(h.token)}</td><td>${h.score}</td><td>${h.line ? '🔗' : ''}</td></tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="15"><meta name="robots" content="noindex"><title>XRPL Arb</title>
<style>body{font:14px system-ui;margin:16px;background:#0e1726;color:#e6edf6}a{color:#6cb8ff}table{border-collapse:collapse;width:100%;margin:8px 0 24px}td,th{padding:4px 6px;border-bottom:1px solid #243247;text-align:left;vertical-align:top}.g{color:#3ad17a}.r{color:#ff6b6b}.k{display:inline-block;margin:0 16px 8px 0}small{color:#8aa0bb}button{font:inherit;padding:4px 10px;border-radius:6px;border:1px solid #3a4d66;background:#1a2638;color:#e6edf6;cursor:pointer}.card{border:2px solid #ff6b6b;border-radius:10px;padding:10px 12px;margin:8px 0}.wrap{overflow-x:auto}</style>
<h2>⇄ XRPL Arbitrage ${st.dryRun ? '(DRY RUN)' : ''} <span style="float:right"><a href="/"><button type="button">🎯 Sniper</button></a> <a href="/arb/settings"><button type="button">⚙️ Settings</button></a></span></h2>
${!st.activated && !st.dryRun ? '<div class="card">💰 <b>Wallet not activated yet</b> – send XRP (e.g. 50) to it. Watching and recording meanwhile; trading starts by itself within a minute after the XRP arrives.</div>' : ''}
${st.paused ? '<div class="card">⏸ <b>Paused</b> – still watching and recording. <a href="/arb/settings">Change</a></div>' : ''}
<div><span class="k">Wallet ${esc(st.wallet)}</span><span class="k">Balance <b>${st.balance?.toFixed(4)}</b> XRP</span><span class="k">Since start <b class="${net >= 0 ? 'g' : 'r'}">${f(net)}</b> XRP</span><span class="k">Usable <b>${st.available?.toFixed(2)}</b> XRP</span></div>
<div><span class="k">Won cycles <b>${s.wins || 0}</b> / ${att} tries</span><span class="k">Profit <b class="g">${f(s.profit || 0)}</b></span><span class="k">Fees <b>${(s.fees || 0).toFixed(5)}</b></span><span class="k">Fees today ${st.dayFees?.toFixed(4)} / ${st.maxFeesDay}</span>${st.inFlight ? `<span class="k">⏳ ${esc(st.inFlight)}</span>` : ''}</div>
<div><span class="k">Pools ${st.poolsReady}/${st.pools}${st.discovering ? ' (discovering…)' : ''}${st.queue ? `, ${st.queue} to read` : ''}</span><span class="k">Ledgers ${s.ledgers || 0}</span><span class="k">Loops checked ${s.cyclesSeen || 0}</span><span class="k">Opportunities ${s.opportunities || 0}</span><span class="k">Missed (no trust line) ${s.missedNoLine || 0}</span><span class="k">Not applied ${s.notApplied || 0}</span><span class="k">Search ${s.lastSearchMs ?? '–'} ms</span></div>
<div><span class="k">Watching ${esc((st.watching || []).join(', '))}: <b>${s.rivalWins || 0}</b> cycles, ${f(s.rivalProfit || 0)} XRP since start</span></div>
<h3>Our cycles</h3><div class="wrap"><table><tr><th>Time (UTC)</th><th>Route</th><th>Size</th><th>Expected</th><th>Result</th><th>Held</th></tr>${trades}</table></div>
<h3>Rival cycles</h3><div class="wrap"><table><tr><th>Time (UTC)</th><th>Bot</th><th>Route</th><th>Profit</th></tr>${rivals}</table></div>
<h3>Hot tokens <small>(trust lines are added for the top ones)</small></h3><div class="wrap"><table><tr><th>Token</th><th>Score</th><th>Line</th></tr>${hot}</table></div>
<p><small>Trust lines: ${esc((st.lines || []).join(', ') || '–')}</small></p>
<p><small>Download: <a href="/arb/export/trades.csv">trades.csv</a> · <a href="/arb/export/opps.csv">opportunities.csv</a> · <a href="/arb/export/rivals.csv">rivals.csv</a></small></p>`;
}
