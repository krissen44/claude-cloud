// Entry point: loads .env, connects to the XRPL (with fallback servers), starts the bot and an
// optional status page (set PORT; protect it with STATUS_KEY → /?key=...).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'xrpl';
import { loadWallet } from './wallet.mjs';
import { createBot, readConfig } from './bot.js';

const here = path.dirname(fileURLToPath(import.meta.url));
try {
  for (const line of fs.readFileSync(path.join(here, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    // drop an inline comment ("value   # note"), then surrounding quotes
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/(^|\s+)#.*$/, '').trim().replace(/^["']|["']$/g, '');
  }
} catch {}

const cfg = readConfig();
const servers = (process.env.XRPL_WS || 'wss://xrplcluster.com,wss://s1.ripple.com,wss://s2.ripple.com').split(',').map((s) => s.trim()).filter(Boolean);

let wallet = null;
try { wallet = loadWallet(); } catch (e) { console.error('Wallet-Fehler: ' + e.message); process.exit(1); }
if (!wallet && !cfg.dryRun) {
  console.error('Kein Wallet-Schlüssel in .env (WALLET_SEED, WALLET_MNEMONIC oder WALLET_SECRET_NUMBERS) – oder DRY_RUN=1 setzen.');
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
function page(st, key) {
  const t = (d) => new Date(d).toISOString().slice(5, 16).replace('T', ' ');
  const cap = (v) => (!v && v !== 0 ? '' : isNaN(v) ? '?' : (st.mcapCurrency === 'USD' ? '$' : '') + (v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'k' : v.toFixed(0)) + (st.mcapCurrency === 'XRP' ? ' XRP' : ''));
  const btn = (k, what, label, cls = '') => `<form method="post" action="/act?key=${encodeURIComponent(key)}"><input type="hidden" name="k" value="${esc(k)}"><input type="hidden" name="do" value="${what}"><button class="${cls}">${label}</button></form>`;
  const name = (p) => `${esc(p.name)}${p.copy ? ` <small>👀 ${esc(p.copy)}</small>` : ''}${p.manual ? ' <small>✋ manuell</small>' : ''}${p.runner ? ' <small>🚀 Runner</small>' : ''}`;
  const manualBtns = (p) => (p.manual ? btn(p.k, 'sellhalf', 'Hälfte verkaufen') + btn(p.k, 'sellall', 'Alles verkaufen', 'no') + btn(p.k, 'auto', 'Wieder automatisch') : '');
  const asks = st.open.filter((p) => p.ask);
  const live = st.open.filter((p) => !p.ask && !(p.tp1Done && !p.copy));
  const moon = st.open.filter((p) => !p.ask && p.tp1Done && !p.copy);
  const askCards = asks.map((p) => `<div class="card"><b>${name(p)}</b> · Market Cap <b>${cap(p.mcap)}</b> · Einsatz ${p.cost.toFixed(3)} → Wert ${p.value.toFixed(3)} XRP<br>
Der Bot will <b>${Math.round(p.ask.part * 100)} %</b> verkaufen: ${esc(p.ask.why)} <small>(seit ${t(p.ask.at)})</small><br>
${p.domain ? `🌐 <a href="https://${esc(p.domain.replace(/^https?:\/\//, ''))}" target="_blank" rel="noopener">${esc(p.domain)}</a> · ` : '<small>keine Domain beim Issuer hinterlegt</small> · '}<a href="https://xrpscan.com/account/${esc(p.issuer)}" target="_blank" rel="noopener">XRPScan</a> · <a href="https://firstledger.net/token/${esc(p.issuer)}/${esc(p.currency)}" target="_blank" rel="noopener">FirstLedger</a> · <a href="https://x.com/search?q=${encodeURIComponent('$' + p.name)}" target="_blank" rel="noopener">X-Suche</a>
<div class="row">${btn(p.k, 'sell', '✅ Verkaufen', 'ok')}${btn(p.k, 'hold', '✋ Behalten (legit)', 'no')}</div></div>`).join('');
  const liveRows = live.map((p) => `<tr><td>${name(p)}</td><td>${p.cost.toFixed(3)}</td><td>${p.value.toFixed(3)}</td><td class="${p.value >= p.cost ? 'g' : 'r'}">${f((p.value / p.cost - 1) * 100, 0)}%${p.tp1Done ? ' · ½ verkauft' : ''}</td><td>${cap(p.mcap)}</td><td>${t(p.at)}</td><td>${manualBtns(p)}</td></tr>`).join('');
  const moonRows = moon.map((p) => { const bag = p.value - p.proceeds; return `<tr><td>${name(p)}</td><td>${p.cost.toFixed(3)}</td><td>${p.proceeds.toFixed(3)}</td><td class="g">${bag.toFixed(3)}</td><td>${(bag / p.cost).toFixed(1)}×</td><td>${cap(p.mcap)}</td><td>${manualBtns(p)}</td></tr>`; }).join('');
  const hist = st.history.map((h) => `<tr><td>${esc(h.name)}</td><td>${h.cost.toFixed(3)}</td><td>${h.proceeds.toFixed(3)}</td><td class="${h.pnl >= 0 ? 'g' : 'r'}">${f(h.pnl)}</td><td>${esc(h.why)}</td><td>${t(h.closed)}</td></tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="20"><title>XRPL Sniper</title>
<style>body{font:14px system-ui;margin:16px;background:#0e1726;color:#e6edf6}a{color:#6cb8ff}table{border-collapse:collapse;width:100%;margin:8px 0 24px}td,th{padding:4px 6px;border-bottom:1px solid #243247;text-align:left;vertical-align:top}.g{color:#3ad17a}.r{color:#ff6b6b}.k{display:inline-block;margin:0 16px 8px 0}small{color:#8aa0bb}form{display:inline}button{font:inherit;margin:2px 4px 2px 0;padding:4px 10px;border-radius:6px;border:1px solid #3a4d66;background:#1a2638;color:#e6edf6;cursor:pointer}button.ok{background:#1f6e43;border-color:#2c9a5e}button.no{background:#6e3a1f;border-color:#9a5a2c}.card{border:2px solid #f5b942;border-radius:10px;padding:10px 12px;margin:8px 0;line-height:1.7}.row{margin-top:6px}.wrap{overflow-x:auto}</style>
<h2>XRPL Sniper ${st.dryRun ? '(DRY RUN)' : ''}</h2>
<div><span class="k">Wallet ${esc(st.wallet)}</span><span class="k">Cash-Ergebnis <b class="${st.cash >= 0 ? 'g' : 'r'}">${f(st.cash)} XRP</b></span><span class="k">Moonbags wert <b class="g">${st.moonValue.toFixed(3)} XRP</b></span><span class="k">${st.wins} Gewinne / ${st.losses} Verluste</span><span class="k">Käufe heute ${st.buysToday}</span>${st.tracking.length ? `<span class="k">👀 ${st.tracking.map(esc).join(', ')}</span>` : ''}${st.mcapApproval ? `<span class="k">Genehmigung ab ${cap(st.mcapApproval)}</span>` : ''}</div>
${asks.length ? `<h3>🙋 Wartet auf deine Genehmigung (${asks.length})</h3>${askCards}` : ''}
<h3>Laufende Trades (${live.length})</h3><div class="wrap"><table><tr><th>Token</th><th>Einsatz</th><th>Wert</th><th>%</th><th>MCap</th><th>Kauf (UTC)</th><th></th></tr>${liveRows}</table></div>
<h3>🌙 Moonbags – Einsatz zurück, Rest läuft gratis (${moon.length})</h3><div class="wrap"><table><tr><th>Token</th><th>Einsatz</th><th>Zurück</th><th>Rest wert</th><th>×</th><th>MCap</th><th></th></tr>${moonRows}</table></div>
<h3>Abgeschlossen</h3><div class="wrap"><table><tr><th>Token</th><th>Einsatz</th><th>Erlös</th><th>XRP</th><th>Grund</th><th>Ende (UTC)</th></tr>${hist}</table></div>`;
}
if (process.env.PORT) {
  const keyOk = (u) => !process.env.STATUS_KEY || u.searchParams.get('key') === process.env.STATUS_KEY;
  http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (!keyOk(u)) { res.writeHead(403); return res.end('forbidden'); }
    if (!bot) { res.writeHead(503); return res.end('starting'); }
    const key = u.searchParams.get('key') || '';
    if (u.pathname === '/act' && req.method === 'POST') {
      // buttons only work with a STATUS_KEY, so nobody else can sell your tokens
      if (!process.env.STATUS_KEY) { res.writeHead(403); return res.end('set STATUS_KEY to use the buttons'); }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', async () => {
        const f = new URLSearchParams(body);
        const r = await bot.answer(f.get('k') || '', f.get('do') || '').catch((e) => e.message);
        console.log(`status page: ${f.get('do')} ${f.get('k')} → ${r}`);
        res.writeHead(303, { location: `/?key=${encodeURIComponent(key)}` });
        res.end();
      });
      return;
    }
    if (u.pathname === '/status.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(bot.status())); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page(bot.status(), key));
  }).listen(Number(process.env.PORT), () => console.log(`status page on :${process.env.PORT}`));
}

process.on('SIGINT', () => { bot?.stop(); process.exit(0); });
process.on('SIGTERM', () => { bot?.stop(); process.exit(0); });
process.on('unhandledRejection', (e) => console.log('unhandled', e?.message || e));
main();
