// Entry point of the arbitrage bot (separate process from the sniper: `pm2 start arb.js --name arb`).
// Reads the same .env (ARB_* values), its own wallet (ARB_WALLET_*), and serves its pages on
// 127.0.0.1:ARB_PORT – the sniper's status site shows them at /arb behind the same login.

import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'xrpl';
import { loadWallet } from './wallet.mjs';
import { makeSettings } from './settings.mjs';
import { toCsv } from './recorder.mjs';
import { createArb, readArbConfig, DEFAULT_WATCH } from './arb/bot.mjs';
import { arbPage } from './arb/page.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
try {
  for (const line of fs.readFileSync(path.join(here, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/(^|\s+)#.*$/, '').trim().replace(/^["']|["']$/g, '');
  }
} catch {}

export const ARB_GROUPS = [
  ['⏯ Control', [
    ['ARB_PAUSE', 'Pause trading', 'bool', '0', 'Keeps watching and recording, sends nothing'],
  ]],
  ['💰 Size & profit', [
    ['ARB_MIN_PROFIT', 'Min. profit per cycle after fees (XRP)', 'num', '0.002', '', 0, 100],
    ['ARB_MIN_SIZE', 'Min. size (XRP)', 'num', '0.1', '', 0.01, 1000],
    ['ARB_MAX_SIZE', 'Max. size (XRP)', 'num', '25', '', 0.1, 100000],
    ['ARB_FLOOR', 'Balance never used (XRP)', 'num', '5', '', 0, 1e6],
  ]],
  ['🔎 Search', [
    ['ARB_MAX_HOPS', 'Max. pools per cycle', 'num', '4', '3–5; more = more loops, slower', 2, 5],
    ['ARB_MIN_POOL_XRP', 'Min. pool depth (XRP, both sides)', 'num', '20', '', 0, 1e7],
    ['ARB_SLIP', 'Safety margin on the first leg (%)', 'num', '0.15', '', 0, 5],
  ]],
  ['⛽ Fees & lines', [
    ['ARB_FEE_DROPS', 'Fee per batch (drops)', 'num', '50', '1 XRP = 1,000,000 drops', 40, 100000],
    ['ARB_MAX_FEES_DAY', 'Max. fees per day (XRP)', 'num', '2', 'then it pauses until tomorrow', 0, 1000],
    ['ARB_MAX_LINES', 'Max. trust lines', 'num', '25', 'each locks 0.2 XRP', 0, 500],
  ]],
  ['👀 Watch', [
    ['ARB_WATCH', 'Rival bots to learn from', 'wallets', DEFAULT_WATCH, 'One per line: rAddress:Name'],
  ]],
  ['🔔 Notifications', [
    ['ARB_DISCORD_WEBHOOK', 'Discord webhook', 'text', '', 'empty = no messages'],
  ]],
];

const settings = makeSettings(ARB_GROUPS, { file: 'arb-settings.json', title: '⚙️ Arbitrage settings', action: '/arb/settings', back: '/arb' });
const dataDir = readArbConfig().dataDir;
let overrides = settings.loadOverrides(dataDir);
const cfg = readArbConfig({ ...process.env, ...overrides });

let wallet = null;
try {
  wallet = loadWallet({ WALLET_SEED: process.env.ARB_WALLET_SEED, WALLET_MNEMONIC: process.env.ARB_WALLET_MNEMONIC, WALLET_PATH: process.env.ARB_WALLET_PATH, WALLET_SECRET_NUMBERS: process.env.ARB_WALLET_SECRET_NUMBERS, WALLET_ADDRESS: process.env.ARB_WALLET_ADDRESS });
} catch (e) { console.error('Wallet error: ' + e.message); process.exit(1); }
if (!wallet && !cfg.dryRun) { console.error('No ARB_WALLET_* key in .env – run setup-arb.sh (or set ARB_DRY_RUN=1).'); process.exit(1); }

// ---------- connection (same fallback logic as the sniper) ----------
const servers = (process.env.ARB_XRPL_WS || process.env.XRPL_WS || 'wss://xrplcluster.com,wss://s1.ripple.com,wss://s2.ripple.com').split(',').map((s) => s.trim()).filter(Boolean);
let si = 0;
let client = new Client(servers[si], { connectionTimeout: 15000 });
const handlers = [];
const proxy = {
  request: (r) => client.request(r),
  submitAndWait: (tx, o) => client.submitAndWait(tx, o),
  on: (ev, fn) => { handlers.push([ev, fn]); client.on(ev, fn); },
};
async function connect() {
  for (let i = 0; ; i++) {
    try { await client.connect(); console.log(`connected to ${servers[si]}`); return; } catch (e) {
      console.log(`cannot reach ${servers[si]}: ${e.message}`);
      si = (si + 1) % servers.length;
      const old = client; client = new Client(servers[si], { connectionTimeout: 15000 }); old.removeAllListeners();
      await new Promise((r) => setTimeout(r, Math.min(30000, 2000 * (i + 1))));
    }
  }
}
let bot;
let reconnecting = false;
async function reconnect() {
  if (reconnecting) return;
  reconnecting = true;
  const old = client; old.removeAllListeners();
  try { await old.disconnect(); } catch {}
  si = (si + 1) % servers.length;
  client = new Client(servers[si], { connectionTimeout: 15000 });
  await connect();
  for (const [ev, fn] of handlers) client.on(ev, fn);
  client.on('disconnected', () => reconnect());
  reconnecting = false;
  try { await bot.resubscribe(); } catch { setTimeout(reconnect, 5000); }
}
let lastTx = Date.now();
setInterval(() => { if (Date.now() - lastTx > 60000) { lastTx = Date.now(); reconnect(); } }, 20000);

// ---------- internal pages (only via the sniper's login) ----------
const token = crypto.createHash('sha256').update('arb:' + (process.env.STATUS_PASSWORD || process.env.STATUS_KEY || '')).digest('hex');
function applyOverrides(next) {
  overrides = next;
  settings.saveOverrides(dataDir, next);
  Object.assign(cfg, readArbConfig({ ...process.env, ...next }), { dataDir, dryRun: cfg.dryRun });
}
const port = Number(process.env.ARB_PORT || 3101);
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.headers['x-arb-token'] !== token) { res.writeHead(403); return res.end('forbidden'); }
  const html = (code, body) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); };
  if (!bot) return html(503, 'Arb bot is starting …');
  if (u.pathname === '/settings' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      const { next, errors, changes } = settings.fromForm(new URLSearchParams(body), process.env, overrides);
      if (changes.length) { applyOverrides(next); bot.say(`⚙️ Arb settings changed: ${changes.join(' · ')}`); }
      html(errors.length ? 400 : 200, settings.settingsPage(process.env, overrides, changes.length ? `✅ Saved: ${changes.join('<br>')}` : 'Nothing changed.', errors));
    });
    return;
  }
  if (u.pathname === '/settings') return html(200, settings.settingsPage(process.env, overrides));
  const ex = u.pathname.match(/^\/export\/(trades|opps|rivals)\.csv$/);
  if (ex) {
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="arb-${new Date().toISOString().slice(0, 10)}-${ex[1]}.csv"` });
    return res.end(toCsv(bot.readJsonl(ex[1])));
  }
  if (u.pathname === '/status.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(bot.status())); }
  html(200, arbPage(bot.status()));
}).listen(port, '127.0.0.1', () => console.log(`arb pages on 127.0.0.1:${port}`));

async function main() {
  await connect();
  client.on('disconnected', () => reconnect());
  proxy.on('transaction', () => { lastTx = Date.now(); });
  bot = createArb({ client: proxy, wallet, cfg });
  await bot.start();
}
process.on('SIGINT', () => { bot?.stop(); process.exit(0); });
process.on('SIGTERM', () => { bot?.stop(); process.exit(0); });
process.on('unhandledRejection', (e) => console.log('unhandled', e?.message || e));
main();
