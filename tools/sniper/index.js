// Entry point: loads .env, connects to the XRPL (with fallback servers), starts the bot and an
// optional status page (set PORT): login with STATUS_PASSWORD (or STATUS_KEY), session cookie for 30 days.

import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'xrpl';
import { loadWallet } from './wallet.mjs';
import { loadOverrides, saveOverrides, fromForm, settingsPage } from './settings.mjs';
import { createBot, readConfig } from './bot.js';

const here = path.dirname(fileURLToPath(import.meta.url));
try {
  for (const line of fs.readFileSync(path.join(here, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    // drop an inline comment ("value   # note"), then surrounding quotes
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/(^|\s+)#.*$/, '').trim().replace(/^["']|["']$/g, '');
  }
} catch {}

// values changed on the settings page (DATA_DIR/settings.json) win over .env
const dataDir = readConfig().dataDir;
let overrides = loadOverrides(dataDir);
const cfg = readConfig({ ...process.env, ...overrides });
// apply new overrides to the running bot (it reads cfg on every decision)
function applyOverrides(next) {
  overrides = next;
  saveOverrides(dataDir, next);
  Object.assign(cfg, readConfig({ ...process.env, ...next }), { dataDir, dryRun: cfg.dryRun });
}
const servers = (process.env.XRPL_WS || 'wss://xrplcluster.com,wss://s1.ripple.com,wss://s2.ripple.com').split(',').map((s) => s.trim()).filter(Boolean);

let wallet = null;
try { wallet = loadWallet(); } catch (e) { console.error('Wallet error: ' + e.message); process.exit(1); }
if (!wallet && !cfg.dryRun) {
  console.error('No wallet key in .env (WALLET_SEED, WALLET_MNEMONIC or WALLET_SECRET_NUMBERS) – or set DRY_RUN=1.');
  process.exit(1);
}

let si = 0;
let client = new Client(servers[si], { connectionTimeout: 15000 });
let bot;

async function connect() {
  for (let i = 0; ; i++) {
    try {
      await client.connect();
      console.log(`connected to ${servers[si]}`);
      return;
    } catch (e) {
      console.log(`cannot reach ${servers[si]}: ${e.message}`);
      si = (si + 1) % servers.length;
      // xrpl.js binds a client to one URL, so switch by building a new client
      const old = client;
      client = new Client(servers[si], { connectionTimeout: 15000 });
      old.removeAllListeners();
      await new Promise((r) => setTimeout(r, Math.min(30000, 2000 * (i + 1))));
    }
  }
}

// The bot holds a reference to `client`; give it a stable proxy so a server switch is invisible.
const proxy = {
  request: (r) => client.request(r),
  submitAndWait: (tx, o) => client.submitAndWait(tx, o),
  on: (ev, fn) => { handlers.push([ev, fn]); client.on(ev, fn); },
};
const handlers = [];

async function main() {
  await connect();
  bot = createBot({ client: proxy, wallet, cfg });
  await bot.start();
  watchConnection();
}

function watchConnection() {
  client.on('disconnected', async () => {
    console.log('disconnected – reconnecting…');
    await reconnect();
  });
}

let reconnecting = false;
async function reconnect() {
  if (reconnecting) return;
  reconnecting = true;
  const old = client;
  old.removeAllListeners();
  try { await old.disconnect(); } catch {}
  si = (si + 1) % servers.length;
  client = new Client(servers[si], { connectionTimeout: 15000 });
  await connect();
  for (const [ev, fn] of handlers) client.on(ev, fn);
  watchConnection();
  reconnecting = false;
  try { await bot.resubscribe(); } catch (e) { console.log('resubscribe failed', e.message); setTimeout(reconnect, 5000); }
}

// A silent socket (no ledger for 60 s) counts as dead.
let lastLedger = Date.now();
setInterval(async () => {
  try {
    const r = await client.request({ command: 'ledger_current' });
    if (r.result.ledger_current_index) lastLedger = Date.now();
  } catch {}
  if (Date.now() - lastLedger > 60000) { lastLedger = Date.now(); reconnect(); }
}, 20000);

// ---------- status page ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const f = (n, d = 3) => (n >= 0 ? '+' : '') + Number(n).toFixed(d);
function statsBlock(s) {
  if (!s) return '';
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '–');
  const tries = (s.bought || 0) + (s.buyFailed || 0);
  const skips = Object.entries(s.skipped || {}).sort((a, b) => b[1] - a[1]);
  const total = skips.reduce((n, [, v]) => n + v, 0);
  return `<h3>📊 Stats <small>since ${new Date(s.since).toISOString().slice(0, 16).replace('T', ' ')} UTC</small></h3>
<div><span class="k">Launches seen <b>${s.launches || 0}</b></span><span class="k">Copy signals <b>${s.copySignals || 0}</b></span><span class="k">Bought <b>${s.bought || 0}</b></span><span class="k">Buys failed (slippage) <b>${s.buyFailed || 0}</b> <small>(${pct(s.buyFailed || 0, tries)} of tries)</small></span><span class="k">Blocked by launch protection <b>${s.buyBlocked || 0}</b></span><span class="k">Approval requests <b>${s.asks || 0}</b></span></div>
${skips.length ? `<div class="wrap"><table><tr><th>Skipped because</th><th>Count</th><th>Share</th></tr>${skips.map(([r, v]) => `<tr><td>${esc(r)}</td><td>${v}</td><td>${pct(v, total)}</td></tr>`).join('')}</table></div>` : ''}`;
}

function analysisBlock(an, following) {
  if (!an) return '';
  const pc = (v) => (v == null ? '–' : v + '%');
  const table = (title, rows) => `<div class="wrap"><table><tr><th>${title}</th><th>Launches</th><th>followed 1h+</th><th>reached 2×</th><th>5×</th><th>10×</th><th>above start after 1h</th><th>dead</th><th>median best ×</th></tr>${rows.map((g) => `<tr><td>${esc(g.name)}</td><td>${g.n}</td><td>${g.done}</td><td>${pc(g.x2)}</td><td>${pc(g.x5)}</td><td>${pc(g.x10)}</td><td>${pc(g.up1h)}</td><td>${pc(g.dead)}</td><td>${g.medMax == null ? '–' : g.medMax.toFixed(2) + '×'}</td></tr>`).join('')}</table></div>`;
  return `<h3>🔬 Launch outcomes – last ${an.days} days <small>(${an.total} launches, ${following} still followed; × = price vs. launch price)</small></h3>
${an.total ? table('Decision', an.byDecision) + table('Start liquidity', an.byStart) : '<p><small>No data yet – every launch is followed for 24 h, the table fills up from the first hour on.</small></p>'}
<p><small>Download: <a href="/export/launches.csv">launches.csv</a> (Excel) · <a href="/export/launches.json">launches.json</a> · <a href="/export/events.jsonl">events.jsonl</a> (every buy, sell, skip, approval, setting change)</small></p>`;
}

function page(st) {
  const t = (d) => new Date(d).toISOString().slice(5, 16).replace('T', ' ');
  const cap = (v) => (!v && v !== 0 ? '' : isNaN(v) ? '?' : (st.mcapCurrency === 'USD' ? '$' : '') + (v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'k' : v.toFixed(0)) + (st.mcapCurrency === 'XRP' ? ' XRP' : ''));
  const btn = (k, what, label, cls = '') => `<form method="post" action="/act"><input type="hidden" name="k" value="${esc(k)}"><input type="hidden" name="do" value="${what}"><button class="${cls}">${label}</button></form>`;
  const name = (p) => `${esc(p.name)}${p.copy ? ` <small>👀 ${esc(p.copy)}</small>` : ''}${p.manual ? ' <small>✋ manual</small>' : ''}${p.runner ? ' <small>🚀 Runner</small>' : ''}`;
  const manualBtns = (p) => (p.manual ? btn(p.k, 'sellhalf', 'Sell half') + btn(p.k, 'sellall', 'Sell all', 'no') + btn(p.k, 'auto', 'Back to automatic') : '');
  const asks = st.open.filter((p) => p.ask);
  const live = st.open.filter((p) => !p.ask && !(p.tp1Done && !p.copy));
  const moon = st.open.filter((p) => !p.ask && p.tp1Done && !p.copy);
  const askCards = asks.map((p) => `<div class="card"><b>${name(p)}</b> · Market Cap <b>${cap(p.mcap)}</b> · Stake ${p.cost.toFixed(3)} → value ${p.value.toFixed(3)} XRP<br>
The bot wants to sell <b>${Math.round(p.ask.part * 100)}%</b>: ${esc(p.ask.why)} <small>(since ${t(p.ask.at)})</small><br>
${p.domain ? `🌐 <a href="https://${esc(p.domain.replace(/^https?:\/\//, ''))}" target="_blank" rel="noopener">${esc(p.domain)}</a> · ` : '<small>no domain set on the issuer</small> · '}<a href="https://xrpscan.com/account/${esc(p.issuer)}" target="_blank" rel="noopener">XRPScan</a> · <a href="https://firstledger.net/token/${esc(p.issuer)}/${esc(p.currency)}" target="_blank" rel="noopener">FirstLedger</a> · <a href="https://x.com/search?q=${encodeURIComponent('$' + p.name)}" target="_blank" rel="noopener">X search</a>
<div class="row">${btn(p.k, 'sell', '✅ Sell', 'ok')}${btn(p.k, 'hold', '✋ Keep (legit)', 'no')}</div></div>`).join('');
  const liveRows = live.map((p) => `<tr><td>${name(p)}</td><td>${p.cost.toFixed(3)}</td><td>${p.value.toFixed(3)}</td><td class="${p.value >= p.cost ? 'g' : 'r'}">${f((p.value / p.cost - 1) * 100, 0)}%${p.tp1Done ? ' · ½ sold' : ''}</td><td>${cap(p.mcap)}</td><td>${t(p.at)}</td><td>${manualBtns(p)}</td></tr>`).join('');
  const moonRows = moon.map((p) => { const bag = p.value - p.proceeds; return `<tr><td>${name(p)}</td><td>${p.cost.toFixed(3)}</td><td>${p.proceeds.toFixed(3)}</td><td class="g">${bag.toFixed(3)}</td><td>${(bag / p.cost).toFixed(1)}×</td><td>${cap(p.mcap)}</td><td>${manualBtns(p)}</td></tr>`; }).join('');
  const hist = st.history.map((h) => `<tr><td>${esc(h.name)}</td><td>${h.cost.toFixed(3)}</td><td>${h.proceeds.toFixed(3)}</td><td class="${h.pnl >= 0 ? 'g' : 'r'}">${f(h.pnl)}</td><td>${esc(h.why)}</td><td>${t(h.closed)}</td></tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="20"><title>XRPL Sniper</title>
<style>body{font:14px system-ui;margin:16px;background:#0e1726;color:#e6edf6}a{color:#6cb8ff}table{border-collapse:collapse;width:100%;margin:8px 0 24px}td,th{padding:4px 6px;border-bottom:1px solid #243247;text-align:left;vertical-align:top}.g{color:#3ad17a}.r{color:#ff6b6b}.k{display:inline-block;margin:0 16px 8px 0}small{color:#8aa0bb}form{display:inline}button{font:inherit;margin:2px 4px 2px 0;padding:4px 10px;border-radius:6px;border:1px solid #3a4d66;background:#1a2638;color:#e6edf6;cursor:pointer}button.ok{background:#1f6e43;border-color:#2c9a5e}button.no{background:#6e3a1f;border-color:#9a5a2c}.card{border:2px solid #f5b942;border-radius:10px;padding:10px 12px;margin:8px 0;line-height:1.7}.row{margin-top:6px}.wrap{overflow-x:auto}</style>
<h2>XRPL Sniper ${st.dryRun ? '(DRY RUN)' : ''} <span style="float:right"><a href="/arb"><button type="button">⇄ Arbitrage</button></a> <a href="/settings"><button type="button">⚙️ Settings</button></a> <form method="post" action="/logout"><button>Log out</button></form></span></h2>
${st.paused ? '<div class="card" style="border-color:#ff6b6b">⏸ <b>Buying paused</b> – open positions are still sold by the rules. <a href="/settings">Change</a></div>' : ''}
<div><span class="k">Wallet ${esc(st.wallet)}</span><span class="k">Cash result <b class="${st.cash >= 0 ? 'g' : 'r'}">${f(st.cash)} XRP</b></span><span class="k">Moonbags worth <b class="g">${st.moonValue.toFixed(3)} XRP</b></span><span class="k">${st.wins} wins / ${st.losses} losses</span><span class="k">Buys today ${st.buysToday}</span>${st.tracking.length ? `<span class="k">👀 ${st.tracking.map(esc).join(', ')}</span>` : ''}${st.mcapApproval ? `<span class="k">Approval from ${cap(st.mcapApproval)}</span>` : ''}</div>
${asks.length ? `<h3>🙋 Waiting for your approval (${asks.length})</h3>${askCards}` : ''}
<h3>Open trades (${live.length})</h3><div class="wrap"><table><tr><th>Token</th><th>Stake</th><th>Value</th><th>%</th><th>MCap</th><th>Bought (UTC)</th><th></th></tr>${liveRows}</table></div>
<h3>🌙 Moonbags – stake back, the rest rides free (${moon.length})</h3><div class="wrap"><table><tr><th>Token</th><th>Stake</th><th>Returned</th><th>Bag worth</th><th>×</th><th>MCap</th><th></th></tr>${moonRows}</table></div>
${statsBlock(st.stats)}
${analysisBlock(st.analysis, st.following || 0)}
<h3>Closed</h3><div class="wrap"><table><tr><th>Token</th><th>Stake</th><th>Proceeds</th><th>XRP</th><th>Reason</th><th>Closed (UTC)</th></tr>${hist}</table></div>`;
}
// the outcome table reads all recorded launches – compute it at most once a minute
let anCache = { at: 0, v: null };
function analysisCached() {
  if (Date.now() - anCache.at > 60e3) {
    try { anCache = { at: Date.now(), v: bot.rec.analysis(7) }; } catch (e) { console.log('analysis failed', e.message); }
  }
  return anCache.v;
}

// ---------- login ----------
// Password = STATUS_PASSWORD, else STATUS_KEY. A successful login sets a signed cookie (30 days);
// changing the password logs every device out. Old ?key= bookmarks still work once and
// are turned into the cookie + a clean URL.
const secret = () => process.env.STATUS_PASSWORD || process.env.STATUS_KEY || '';
const sigKey = () => crypto.createHash('sha256').update('sniper-session:' + secret()).digest();
const DAYS30 = 30 * 864e5;
function makeToken() {
  const exp = String(Date.now() + DAYS30);
  return exp + '.' + crypto.createHmac('sha256', sigKey()).update(exp).digest('base64url');
}
function tokenOk(t) {
  const [exp, sig] = String(t || '').split('.');
  if (!exp || !sig || !(Number(exp) > Date.now())) return false;
  const want = crypto.createHmac('sha256', sigKey()).update(exp).digest('base64url');
  return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}
const same = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
const cookieOf = (req) => Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((c) => [c.split('=')[0], c.split('=').slice(1).join('=')]));
// behind the HTTPS proxy (BIND=127.0.0.1) the real client IP is in X-Forwarded-For
const clientIp = (req) => (process.env.BIND === '127.0.0.1' && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https';
const fails = new Map(); // ip → {n, until}
function blocked(ip) {
  const f = fails.get(ip);
  return f && f.n >= 8 && f.until > Date.now();
}
function failed(ip) {
  const f = fails.get(ip);
  const fresh = !f || f.until < Date.now();
  fails.set(ip, { n: fresh ? 1 : f.n + 1, until: Date.now() + 15 * 60000 });
}
function setSession(req, res, location) {
  res.writeHead(303, {
    'set-cookie': `sn_session=${makeToken()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${DAYS30 / 1000}${isHttps(req) ? '; Secure' : ''}`,
    location,
  });
  res.end();
}
function loginPage(msg = '') {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Log in</title>
<style>body{font:15px system-ui;margin:0;min-height:100vh;display:grid;place-items:center;background:#0e1726;color:#e6edf6}form{background:#152033;border:1px solid #243247;border-radius:12px;padding:24px;width:min(320px,calc(100vw - 32px));box-sizing:border-box}h1{font-size:18px;margin:0 0 16px}input,button{font:inherit;width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #3a4d66;background:#0e1726;color:#e6edf6}button{margin-top:12px;background:#1f6e43;border-color:#2c9a5e;cursor:pointer}p{color:#ff8a8a;margin:10px 0 0;font-size:14px}</style>
<form method="post" action="/login"><h1>🔒 Log in</h1><input type="text" name="username" value="admin" autocomplete="username" hidden><input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required><button>Log in</button>${msg ? `<p>${esc(msg)}</p>` : ''}</form>`;
}
// /arb/* → the arbitrage bot's own pages (arb.js on 127.0.0.1:ARB_PORT), behind this login
const arbToken = () => crypto.createHash('sha256').update('arb:' + secret()).digest('hex');
function proxyArb(req, res, u) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${process.env.ARB_PORT || 3101}${u.pathname.slice(4) || '/'}${u.search}`, {
        method: req.method,
        headers: { 'x-arb-token': arbToken(), 'content-type': req.headers['content-type'] || 'text/plain' },
        body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
        redirect: 'manual',
      });
      const headers = { 'content-type': r.headers.get('content-type') || 'text/html', 'cache-control': 'no-store' };
      if (r.headers.get('content-disposition')) headers['content-disposition'] = r.headers.get('content-disposition');
      res.writeHead(r.status, headers);
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<body style="font:15px system-ui;background:#0e1726;color:#e6edf6;padding:24px">The arbitrage bot is not running. On the server: <code>pm2 start arb</code> (or run <code>bash setup-arb.sh</code>). <a style="color:#6cb8ff" href="/">← Sniper</a></body>');
    }
  });
}

function readBody(req, cb) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
  req.on('end', () => cb(new URLSearchParams(body)));
}

if (process.env.PORT) {
  http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const html = (code, body) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); };
    if (!secret()) return html(403, 'Set STATUS_KEY or STATUS_PASSWORD in .env.');
    const ip = clientIp(req);

    if (u.pathname === '/login' && req.method === 'POST') {
      if (blocked(ip)) return html(429, loginPage('Too many attempts – try again in 15 minutes.'));
      return readBody(req, (f) => {
        if (same(f.get('password') || '', secret())) { fails.delete(ip); return setSession(req, res, '/'); }
        failed(ip);
        console.log(`status page: failed login from ${ip}`);
        html(401, loginPage('Wrong password.'));
      });
    }
    if (u.pathname === '/logout' && req.method === 'POST') {
      res.writeHead(303, { 'set-cookie': 'sn_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0', location: '/' });
      return res.end();
    }
    // old bookmark with ?key= → cookie + clean address
    if (u.searchParams.has('key')) {
      if (!blocked(ip) && same(u.searchParams.get('key'), process.env.STATUS_KEY || '\0')) return setSession(req, res, '/');
      failed(ip);
      return html(403, loginPage());
    }
    if (!tokenOk(cookieOf(req).sn_session)) return html(u.pathname === '/' ? 200 : 403, loginPage());

    if (u.pathname === '/arb' || u.pathname.startsWith('/arb/')) return proxyArb(req, res, u);
    if (!bot) return html(503, 'Bot is starting …');
    if (u.pathname === '/act' && req.method === 'POST') {
      return readBody(req, async (f) => {
        const r = await bot.answer(f.get('k') || '', f.get('do') || '').catch((e) => e.message);
        console.log(`status page: ${f.get('do')} ${f.get('k')} → ${r}`);
        res.writeHead(303, { location: '/' });
        res.end();
      });
    }
    if (u.pathname === '/settings' && req.method === 'POST') {
      return readBody(req, (f) => {
        const { next, errors, changes } = fromForm(f, process.env, overrides);
        if (changes.length) {
          applyOverrides(next);
          bot.say(`⚙️ Settings changed: ${changes.join(' · ')}`);
          bot.rec.event('settings', { changes, overrides: next });
        }
        html(errors.length ? 400 : 200, settingsPage(process.env, overrides, changes.length ? `✅ Saved: ${changes.map((c) => esc(c)).join('<br>')}` : 'Nothing changed.', errors));
      });
    }
    if (u.pathname === '/settings') return html(200, settingsPage(process.env, overrides));
    if (u.pathname.startsWith('/export/')) {
      const name = u.pathname.slice(8);
      const send = (type, body) => { res.writeHead(200, { 'content-type': type, 'content-disposition': `attachment; filename="sniper-${new Date().toISOString().slice(0, 10)}-${name}"`, 'cache-control': 'no-store' }); res.end(body); };
      if (name === 'launches.csv') return send('text/csv; charset=utf-8', bot.rec.csv(bot.rec.rows()));
      if (name === 'launches.json') return send('application/json', JSON.stringify(bot.rec.rows()));
      if (name === 'events.jsonl') return send('application/x-ndjson', bot.rec.events().map((e) => JSON.stringify(e)).join('\n'));
      return html(404, 'not found');
    }
    if (u.pathname === '/status.json') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(bot.status())); }
    html(200, page({ ...bot.status(), analysis: analysisCached() }));
  // BIND=127.0.0.1 when a reverse proxy (HTTPS) sits in front, so the page is not reachable directly
  }).listen(Number(process.env.PORT), process.env.BIND || undefined, () => console.log(`status page on ${process.env.BIND || '*'}:${process.env.PORT}`));
}

process.on('SIGINT', () => { bot?.stop(); process.exit(0); });
process.on('SIGTERM', () => { bot?.stop(); process.exit(0); });
process.on('unhandledRejection', (e) => console.log('unhandled', e?.message || e));
main();
