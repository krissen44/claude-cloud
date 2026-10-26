// Entry point: loads .env, connects to the XRPL (with fallback servers), starts the bot and an
// optional status page (set PORT; protect it with STATUS_KEY → /?key=...).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, Wallet } from 'xrpl';
import { createBot, readConfig } from './bot.js';

const here = path.dirname(fileURLToPath(import.meta.url));
try {
  for (const line of fs.readFileSync(path.join(here, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const cfg = readConfig();
const servers = (process.env.XRPL_WS || 'wss://xrplcluster.com,wss://s1.ripple.com,wss://s2.ripple.com').split(',').map((s) => s.trim()).filter(Boolean);

let wallet = null;
if (process.env.WALLET_SEED) wallet = Wallet.fromSeed(process.env.WALLET_SEED.trim());
else if (!cfg.dryRun) {
  console.error('WALLET_SEED fehlt in .env (oder DRY_RUN=1 setzen).');
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
function page(st) {
  const t = (d) => new Date(d).toISOString().slice(5, 16).replace('T', ' ');
  const live = st.open.filter((p) => !(p.tp1Done && !p.copy));
  const moon = st.open.filter((p) => p.tp1Done && !p.copy);
  const liveRows = live.map((p) => `<tr><td>${esc(p.name)}${p.copy ? ` <small>👀 ${esc(p.copy)}</small>` : ''}</td><td>${p.cost.toFixed(3)}</td><td>${p.value.toFixed(3)}</td><td class="${p.value >= p.cost ? 'g' : 'r'}">${f((p.value / p.cost - 1) * 100, 0)}%${p.tp1Done ? ' · ½ verkauft' : ''}</td><td>${t(p.at)}</td></tr>`).join('');
  const moonRows = moon.map((p) => { const bag = p.value - p.proceeds; return `<tr><td>${esc(p.name)}${p.copy ? ` <small>👀 ${esc(p.copy)}</small>` : ''}</td><td>${p.cost.toFixed(3)}</td><td>${p.proceeds.toFixed(3)}</td><td class="g">${bag.toFixed(3)}</td><td>${(bag / p.cost).toFixed(1)}×</td><td>${t(p.at)}</td></tr>`; }).join('');
  const hist = st.history.map((h) => `<tr><td>${esc(h.name)}</td><td>${h.cost.toFixed(3)}</td><td>${h.proceeds.toFixed(3)}</td><td class="${h.pnl >= 0 ? 'g' : 'r'}">${f(h.pnl)}</td><td>${esc(h.why)}</td><td>${t(h.closed)}</td></tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="15"><title>XRPL Sniper</title>
<style>body{font:14px system-ui;margin:16px;background:#0e1726;color:#e6edf6}table{border-collapse:collapse;width:100%;margin:8px 0 24px}td,th{padding:4px 6px;border-bottom:1px solid #243247;text-align:left}.g{color:#3ad17a}.r{color:#ff6b6b}.k{display:inline-block;margin:0 16px 8px 0}small{color:#8aa0bb}</style>
<h2>XRPL Sniper ${st.dryRun ? '(DRY RUN)' : ''}</h2>
<div><span class="k">Wallet ${esc(st.wallet)}</span><span class="k">Cash-Ergebnis <b class="${st.cash >= 0 ? 'g' : 'r'}">${f(st.cash)} XRP</b></span><span class="k">Moonbags wert <b class="g">${st.moonValue.toFixed(3)} XRP</b></span><span class="k">${st.wins} Gewinne / ${st.losses} Verluste</span><span class="k">Käufe heute ${st.buysToday}</span>${st.tracking.length ? `<span class="k">👀 ${st.tracking.map(esc).join(', ')}</span>` : ''}</div>
<h3>Laufende Trades (${live.length})</h3><table><tr><th>Token</th><th>Einsatz</th><th>Wert</th><th>%</th><th>Kauf (UTC)</th></tr>${liveRows}</table>
<h3>🌙 Moonbags – Einsatz zurück, Rest läuft gratis (${moon.length})</h3><table><tr><th>Token</th><th>Einsatz</th><th>Zurück</th><th>Rest wert</th><th>×</th><th>Kauf (UTC)</th></tr>${moonRows}</table>
<h3>Abgeschlossen</h3><table><tr><th>Token</th><th>Einsatz</th><th>Erlös</th><th>XRP</th><th>Grund</th><th>Ende (UTC)</th></tr>${hist}</table>`;
}
if (process.env.PORT) {
  const keyOk = (u) => !process.env.STATUS_KEY || u.searchParams.get('key') === process.env.STATUS_KEY;
  http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (!keyOk(u)) { res.writeHead(403); return res.end('forbidden'); }
    if (!bot) { res.writeHead(503); return res.end('starting'); }
    if (u.pathname === '/status.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(bot.status())); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page(bot.status()));
  }).listen(Number(process.env.PORT), () => console.log(`status page on :${process.env.PORT}`));
}

process.on('SIGINT', () => { bot?.stop(); process.exit(0); });
process.on('SIGTERM', () => { bot?.stop(); process.exit(0); });
process.on('unhandledRejection', (e) => console.log('unhandled', e?.message || e));
main();
