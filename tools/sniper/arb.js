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
import { createArb, readArbConfig, DEFAULT_WATCH, DEFAULT_TOKENS } from './arb/bot.mjs';
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
    ['ARB_MIN_PROFIT', 'Send a loop from this expected profit (XRP, after fees)', 'num', '0.0002', '', 0, 100],
    ['ARB_LOCK_PROFIT', 'Profit that must come back, else nothing happens (XRP)', 'num', '0', '0 = break-even: stake + fee back is enough (like bwif)', 0, 100],
    ['ARB_MIN_SIZE', 'Min. size (XRP)', 'num', '0.1', '', 0.01, 1000],
    ['ARB_MAX_SIZE', 'Max. size (XRP)', 'num', '2', 'small sizes: bwif’s small bot mostly uses 0.1–0.4', 0.1, 100000],
    ['ARB_PARALLEL', 'Batches per ledger', 'num', '5', 'different loops at once via tickets; 0 = one at a time', 0, 30],
    ['ARB_TICKETS', 'Tickets kept ready', 'num', '0', '0 = 3 per batch + 3; each locks 0.2 XRP until used', 0, 240],
    ['ARB_FLOOR', 'Balance never used (XRP)', 'num', '5', '', 0, 1e6],
  ]],
  ['🧠 Learning', [
    ['ARB_TARGET_WIN', 'Target win rate (%)', 'num', '90', 'only loops the bot expects to win this often are sent – higher = fewer but surer trades', 10, 99],
    ['ARB_EXPLORE_DAY', 'Learning tries per day', 'num', '300', 'routes it can’t judge yet are tried this often (each miss costs only the fee, ≈ 0.00005 XRP)', 0, 10000],
    ['ARB_EXPLORE_MIN_CHANCE', 'Learning tries: min. estimated chance (%)', 'num', '15', 'lower = more tries while it learns', 1, 99],
    ['ARB_LEARN_MIN_TRIES', 'Tries before a route is judged', 'num', '6', '', 1, 100],
    ['ARB_LEARN_HALF_LIFE_H', 'Results fade after (hours, half-life)', 'num', '72', 'the market changes – old results count less', 1, 2000],
  ]],
  ['📋 Token list', [
    ['ARB_LIST_ONLY', 'Trade only the list', 'bool', '1', 'Only these tokens, no others – loops, trust lines, everything. Other lines that hold nothing are given back'],
    ['ARB_TOKENS', 'The list', 'tokens', DEFAULT_TOKENS, 'One per line: NAME.rIssuer – suggestions to add are on the arb page'],
    ['ARB_LIVE', 'Live mode (react to the open ledger)', 'bool', '1', 'Sees trades ≈ 5 s before they are validated and sends into the same / next ledger'],
    ['ARB_LIVE_SEND', 'Live: when to send', 'text', 'next', '“next” = the moment the next ledger opens (lands right after the move, like bwif); “now” = into the same ledger'],
    ['ARB_MULTI_SUBMIT', 'Send every batch to all servers at once', 'bool', '1', 'Each batch goes to every server in ARB_XRPL_WS in parallel (s1, s2, xrplcluster) – whichever relays fastest gets it to the validators'],
    ['ARB_LIVE_MAX_PER_LEDGER', 'Live pool reads per ledger', 'num', '15', 'server load', 1, 200],
    ['ARB_BRIDGE', 'Loops may pass through big tokens', 'bool', '1', 'Inside the same all-or-nothing batch only – never held, no trust line (e.g. FUZZY → WIND → DROP). Off = only list tokens in a loop'],
    ['ARB_BRIDGE_MIN_XRP', 'Bridge token: min. XRP in its pool', 'num', '1000', 'bwif’s bridges (WIND, CRAP, CABAL, POOL) have ≈ 1,400', 0, 1e8],
  ]],
  ['🎯 Focus (only when “Trade only the list” is off)', [
    ['ARB_FOCUS', 'Focus mode', 'bool', '1', 'Trust lines for the top tokens + hyped ones + the rivals’ + your list'],
    ['ARB_FOCUS_ONLY', 'Search only focus tokens', 'bool', '1', 'Off = loops may run through any token; only the held one needs a line'],
    ['ARB_TOP_N', 'Top tokens by XRP liquidity', 'num', '50', '', 0, 500],
    ['ARB_HOT_GROWTH', 'Hype: pool XRP growth (%)', 'num', '30', '', 1, 10000],
    ['ARB_HOT_WINDOW_H', 'Hype: within (hours)', 'num', '6', '', 1, 72],
    ['ARB_HOT_MIN_TRADES', 'Hype: min. trades in that time', 'num', '20', '', 0, 100000],
    ['ARB_HOT_KEEP_H', 'Keep a hyped / rival token for (hours)', 'num', '24', '', 1, 720],
  ]],
  ['🔎 Search', [
    ['ARB_MAX_HOPS', 'Max. pools per cycle', 'num', '5', '3–5; more = more loops, slower', 2, 5],
    ['ARB_MIN_POOL_XRP', 'Min. pool depth (XRP, both sides)', 'num', '20', '', 0, 1e7],
    ['ARB_SLIP', 'Safety margin on the first leg (%)', 'num', '0.15', '', 0, 5],
  ]],
  ['⛽ Fees & lines', [
    ['ARB_FEE_DROPS', 'Min. fee per batch (drops)', 'num', '50', 'raised automatically when the ledger is busy; 1 XRP = 1,000,000 drops', 40, 100000],
    ['ARB_MAX_FEE_DROPS', 'Max. fee per batch (drops)', 'num', '200000', 'busy ledgers cost 20–30k drops – the fee also never exceeds the share below', 40, 10000000],
    ['ARB_FEE_SHARE', 'Max. fee as share of the expected gain (%)', 'num', '50', 'expected gain = chance × profit; a big loop may pay more to get in', 1, 100],
    ['ARB_MAX_FEES_DAY', 'Max. fees per day (XRP)', 'num', '2', 'then it pauses until tomorrow', 0, 1000],
    ['ARB_MAX_LINES', 'Max. trust lines', 'num', '50', 'each locks 0.2 XRP', 0, 500],
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
// Ripple's servers first: xrplcluster.com rate-limits heavy use (amm_info lookups)
const servers = (process.env.ARB_XRPL_WS || 'wss://s2.ripple.com,wss://s1.ripple.com,wss://xrplcluster.com').split(',').map((s) => s.trim()).filter(Boolean);
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
// extra connections, only for sending: every batch also goes to the other servers (multi-submit)
const extras = new Map(); // url → { c, up }
function extraConnect(url) {
  const e = extras.get(url) || { c: null, up: false, tries: 0 };
  extras.set(url, e);
  if (e.c) { e.c.removeAllListeners(); e.c.disconnect().catch(() => {}); }
  e.up = false;
  e.c = new Client(url, { connectionTimeout: 15000 });
  e.c.on('disconnected', () => { e.up = false; setTimeout(() => extraConnect(url), Math.min(60000, 5000 * ++e.tries)); });
  e.c.connect().then(() => { e.up = true; e.tries = 0; }, () => { setTimeout(() => extraConnect(url), Math.min(60000, 5000 * ++e.tries)); });
}
const submitAlso = (r) => [...extras].filter(([url, e]) => e.up && url !== servers[si]).map(([, e]) => e.c.request(r));
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
  if (servers.length > 1 && !/^(0|false|no|off)$/i.test(process.env.ARB_MULTI_SUBMIT || '')) for (const url of servers) extraConnect(url);
  bot = createArb({ client: proxy, wallet, cfg, submitAlso });
  await bot.start();
}
process.on('SIGINT', () => { bot?.stop(); process.exit(0); });
process.on('SIGTERM', () => { bot?.stop(); process.exit(0); });
process.on('unhandledRejection', (e) => console.log('unhandled', e?.message || e));
main();
