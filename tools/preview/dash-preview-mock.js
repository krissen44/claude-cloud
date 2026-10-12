/* ===== Scrappy Dash test build: a stand-in server inside the page (tools/preview/dash-preview.mjs) ===== */
window.PREVIEW = true;
const PV = (() => {
  const day = k => new Date(Date.now() + k * 864e5).toISOString().slice(0, 10);
  const st = (() => { try { return JSON.parse(localStorage.getItem('pv_dash')) || {}; } catch(e){ return {}; } })();
  if (st.day !== day(0)) { st.day = day(0); st.best = 0; st.runs = 0; }
  const keep = () => { try { localStorage.setItem('pv_dash', JSON.stringify(st)); } catch(e){} };
  const runs = {}, R = ['Common', 'Uncommon', 'Common', 'Rare', 'Common', 'Uncommon'];
  const rivals = [['SnowPup', 420], ['Barkley', 980], ['Rookie', 1650], ['Dasher', 2900], ['Fluffy', 4400]];
  const overall0 = [['Dasher', 15200], ['Rookie', 12100], ['SnowPup', 9800], ['Barkley', 7600], ['Fluffy', 5100], ['Pip', 3000]];
  const me = 'You (test)', mine0 = 4100;   // your four earlier Advent days
  const sortS = (a, b) => b.score - a.score;
  const P = {theme: location.hash === '#rocket' ? 'rocket' : 'sleigh'};
  P.board = () => {
    const today = rivals.map(([name, score]) => ({name, score})).concat(st.best ? [{name: me, score: st.best, you: true}] : []).sort(sortS);
    const overall = overall0.map(([name, score]) => ({name, score})).concat([{name: me, score: mine0 + (st.best || 0), you: true}]).sort(sortS);
    const days = Array.from({length: 24}, (_, k) => ({day: day(k - 4), n: k + 1, state: k < 4 ? 'past' : k === 4 ? 'today' : 'future',
      prize: {token: k, rarity: R[k % 6]},
      ...(k < 4 ? {won: {name: ['Dasher', 'Rookie', 'SnowPup', 'Barkley'][k], score: 3000 + k * 211, token: k, status: k < 2 ? 'claimed' : 'offered', key: 'x', place: '1'}, mine: 900 + k * 100} : {}),
      ...(k === 4 ? {winner: {name: today[0].name, score: today[0].score}, ...(st.best ? {mine: st.best} : {})} : {})}));
    return {theme: P.theme, day: day(0),
      today: {top: today, players: today.length, mine: {best: st.best || 0, runs: st.runs || 0, rank: st.best ? today.findIndex(r => r.you) + 1 : null}},
      yesterday: {day: day(-1), top: [{name: 'Rookie', score: 3211}, {name: 'Dasher', score: 2950}, {name: 'Pip', score: 1200}]},
      week: {top: []},
      advent: {from: day(-4), to: day(19), n: 5, on: true, done: false, dayPrize: 'a Pixel Scrappy', dayPlaces: 1,
        grand: ['Epic', 'Rare', 'Rare', 'Uncommon', 'Uncommon'], grandPlaces: 5, days,
        grandPrizes: ['Epic', 'Rare', 'Rare', 'Uncommon', 'Uncommon'].map((rarity, i) => ({place: i + 1, rarity, token: 24 + i})),
        overall: {top: overall, players: overall.length, mine: {total: mine0 + (st.best || 0), days: 5, rank: overall.findIndex(r => r.you) + 1}}}};
  };
  P.start = b => {
    const id = Array.from(crypto.getRandomValues(new Uint8Array(9)), x => x.toString(16).padStart(2, '0')).join('');
    const f = DATA.fighters.find(x => x.id === b.dogId) || {};
    runs[id] = {seed: crypto.getRandomValues(new Uint32Array(1))[0], at: Date.now(), bonus: DASH_BONUS[f.rarity] || DASH_BONUS.Common};
    return {id, seed: runs[id].seed, bonus: runs[id].bonus, theme: P.theme};
  };
  // like the server: replay the run from its seed and inputs, book the replay's score (+ the Scrappy bonus)
  P.end = b => {
    const run = runs[b.id]; delete runs[b.id];
    if (!run) return {error: 'no_run'};
    const inp = []; for (let i = 0, t = 0; i < b.inp.length; i += 2){ t += b.inp[i]; inp.push(t, b.inp[i + 1]); }
    const W = b.w === 340 ? 340 : 480, r = dashReplay(run.seed, W, W === 340 ? 84 : 110, inp, b.ticks);
    if (!r.over || r.ticks !== b.ticks || r.score !== b.score) return {error: 'desync'};
    const score = Math.floor(r.score * (100 + run.bonus) / 100), pb = score > (st.best || 0);
    st.runs = (st.runs || 0) + 1; if (pb) st.best = score; keep();
    const B = P.board();
    return {ok: true, score, raw: r.score, bonus: run.bonus, pb, best: st.best, rank: B.today.mine.rank, players: B.today.players,
      total: B.advent.overall.mine.total, totalRank: B.advent.overall.mine.rank};
  };
  return P;
})();
api = async (path, opt) => {
  const b = opt && opt.body, out = path.startsWith('/dash/board') ? PV.board() : path === '/dash/start' ? PV.start(b || {})
    : path === '/dash/end' ? PV.end(b || {}) : path === '/prizes' ? {prizes: []} : {error: 'test build'};
  await new Promise(r => setTimeout(r, 60));
  return new Response(JSON.stringify(out), {status: out.error ? 400 : 200, headers: {'content-type': 'application/json'}});
};
chatSync = () => {};
nav = () => `<div class="card pvbar"><b>🧪 Test build</b> — the game runs for real, the server is a stand-in inside this page:
  rankings, winners and prizes are examples (Advent day 5), your runs are replayed and checked like on the server, nothing goes online.
  <span class="pvrow"><button data-pv="sleigh" class="${PV.theme === 'sleigh' ? 'on' : ''}">🛷 Sleigh Dash</button><button data-pv="rocket" class="${PV.theme === 'rocket' ? 'on' : ''}">🚀 Rocket Dash</button></span></div>`;
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-pv]'); if (!b || DASH.g) return;
  PV.theme = b.dataset.pv; DASH.board = null; menu(); dashLoad();
});
document.head.insertAdjacentHTML('beforeend', `<style>
.pvbar{font-size:11px;line-height:1.6;color:var(--ink2);border-style:dashed}
.pvbar b{color:var(--ink)}
.pvrow{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
.pvrow button{font:inherit;font-size:11px;padding:7px 12px;border-radius:7px;border:2px solid var(--panelB);background:transparent;color:var(--ink);cursor:pointer}
.pvrow button.on{border-color:var(--accent);font-weight:700}
</style>`);
WALLET.demo = false; WALLET.token = 'preview'; tab = 'dash';
menu(); dashLoad();
