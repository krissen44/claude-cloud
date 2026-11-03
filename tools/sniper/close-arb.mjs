// Puts the arbitrage wallet to sleep and frees its XRP:
//   1. uses up its unused Tickets (each locks 0.2 XRP),
//   2. cancels open offers,
//   3. sells every token it still holds for XRP (whatever is left / unsellable goes back to the issuer),
//      LP tokens are withdrawn from their pool first,
//   4. deletes every trust line (each frees 0.2 XRP),
//   5. optionally sends everything above the 1 XRP base reserve to the sniper wallet (or any address).
//
//   node close-arb.mjs --dry               only show what it would do
//   node close-arb.mjs                     do it (asks for YES first)
//   node close-arb.mjs --send sniper       … and send the free XRP to the sniper wallet from .env
//   node close-arb.mjs --send rAddress…    … or to that address
// Use close-arb.sh – it stops the arb bot first.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { Client } from 'xrpl';
import { loadWallet } from './wallet.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = { ...process.env };
try {
  for (const line of fs.readFileSync(path.join(here, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/(^|\s+)#.*$/, '').trim().replace(/^["']|["']$/g, '');
  }
} catch {}

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const sendArg = args.includes('--send') ? args[args.indexOf('--send') + 1] : null;
const yes = args.includes('--yes');

const TF_PARTIAL = 0x00020000;
const TF_SET_NO_RIPPLE = 0x00020000;
const TF_CLEAR_NO_RIPPLE = 0x00040000;
const TF_CLEAR_FREEZE = 0x00200000;
const TF_WITHDRAW_ALL = 0x00020000;
const name = (c) => (c.length === 40 && !c.startsWith('03') ? Buffer.from(c, 'hex').toString('utf8').replace(/\0/g, '') || c : c.startsWith('03') ? 'LP token' : c);
const xrp = (d) => Number(d) / 1e6;

const wallet = loadWallet({ WALLET_SEED: env.ARB_WALLET_SEED, WALLET_MNEMONIC: env.ARB_WALLET_MNEMONIC, WALLET_PATH: env.ARB_WALLET_PATH, WALLET_SECRET_NUMBERS: env.ARB_WALLET_SECRET_NUMBERS, WALLET_ADDRESS: env.ARB_WALLET_ADDRESS });
if (!wallet) { console.error('No ARB_WALLET_* key in .env'); process.exit(1); }
const me = wallet.address;

let dest = null;
if (sendArg) {
  if (sendArg === 'sniper') {
    const sn = loadWallet(env);
    dest = sn?.address || env.WALLET_ADDRESS;
    if (!dest) { console.error('No sniper wallet (WALLET_*) in .env – give an address: --send rAddress'); process.exit(1); }
  } else if (/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(sendArg)) dest = sendArg;
  else { console.error('--send needs "sniper" or an XRPL address'); process.exit(1); }
  if (dest === me) { console.error('That is the arb wallet itself.'); process.exit(1); }
}

const servers = (env.ARB_XRPL_WS || 'wss://s2.ripple.com,wss://s1.ripple.com,wss://xrplcluster.com').split(',').map((s) => s.trim()).filter(Boolean);
let client;
for (const s of servers) {
  try { client = new Client(s, { connectionTimeout: 15000 }); await client.connect(); console.log(`connected to ${s}`); break; } catch (e) { console.log(`cannot reach ${s}: ${e.message}`); client = null; }
}
if (!client) process.exit(1);
const req = async (command, p = {}) => (await client.request({ command, ledger_index: 'validated', ...p })).result;

async function send(tx, what) {
  if (dry) { console.log(`  (dry) ${what}`); return 'dry'; }
  try {
    const r = await client.submitAndWait(tx, { wallet, autofill: true });
    const res = r.result.meta?.TransactionResult;
    console.log(`  ${res === 'tesSUCCESS' ? '✅' : '⚠️'} ${what}: ${res}`);
    return res;
  } catch (e) {
    console.log(`  ⚠️ ${what}: ${e.data?.error || e.message}`);
    return 'error';
  }
}
async function objects(type) {
  const out = [];
  let marker;
  do {
    const r = await req('account_objects', { account: me, type, limit: 400, ...(marker ? { marker } : {}) });
    out.push(...(r.account_objects || []));
    marker = r.marker;
  } while (marker);
  return out;
}
async function lines() {
  const out = [];
  let marker;
  do {
    const r = await req('account_lines', { account: me, limit: 400, ...(marker ? { marker } : {}) });
    out.push(...(r.lines || []));
    marker = r.marker;
  } while (marker);
  return out;
}
async function status() {
  const [a, info] = await Promise.all([req('account_info', { account: me }), req('server_info', {})]);
  const v = info.info.validated_ledger;
  const base = v.reserve_base_xrp, inc = v.reserve_inc_xrp;
  const bal = xrp(a.account_data.Balance), owners = a.account_data.OwnerCount || 0;
  return { bal, owners, base, inc, free: bal - base - inc * owners };
}

// ---------- plan ----------
const s0 = await status();
const tickets = await objects('ticket');
const offers = await objects('offer');
const ls = await lines();
console.log(`\nArb wallet ${me}`);
console.log(`Balance ${s0.bal.toFixed(6)} XRP · ${s0.owners} objects lock ${(s0.inc * s0.owners).toFixed(1)} XRP · free now ${s0.free.toFixed(6)} XRP`);
console.log(`→ ${tickets.length} tickets, ${offers.length} open offers, ${ls.length} trust lines (${ls.filter((l) => Number(l.balance) > 0).length} still hold tokens)`);
for (const l of ls.filter((x) => Number(x.balance) !== 0)) console.log(`   ${name(l.currency)} (${l.account.slice(0, 10)}…): ${l.balance}`);
console.log(`After the clean-up about ${(s0.free + s0.inc * (tickets.length + offers.length + ls.length)).toFixed(4)} XRP are free (+ whatever the tokens sell for)${dest ? ` and go to ${dest}` : ''}.`);
console.log('Stop the arb bot first (close-arb.sh does it), or it adds new lines and tickets again.\n');

if (!dry && !yes) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ok = await rl.question('Type YES to do it: ');
  rl.close();
  if (ok.trim() !== 'YES') { console.log('Cancelled.'); await client.disconnect(); process.exit(0); }
}

// ---------- 1. tickets ----------
if (tickets.length) console.log(`\n1) Using up ${tickets.length} tickets (no-op AccountSet each)`);
for (const t of tickets) await send({ TransactionType: 'AccountSet', Account: me, Sequence: 0, TicketSequence: t.TicketSequence }, `ticket ${t.TicketSequence}`);

// ---------- 2. offers ----------
if (offers.length) console.log(`\n2) Cancelling ${offers.length} offers`);
for (const o of offers) await send({ TransactionType: 'OfferCancel', Account: me, OfferSequence: o.Sequence }, `offer ${o.Sequence}`);

// ---------- 3. tokens out ----------
const held = ls.filter((l) => Number(l.balance) > 0);
if (held.length) console.log(`\n3) Selling ${held.length} token balances`);
for (const l of held) {
  const tok = { currency: l.currency, issuer: l.account };
  if (l.currency.startsWith('03')) {
    // LP token: take our share out of its pool, the tokens we get are sold in the next round
    try {
      const amm = (await req('amm_info', { amm_account: l.account })).amm;
      const asset = typeof amm.amount === 'string' ? { currency: 'XRP' } : { currency: amm.amount.currency, issuer: amm.amount.issuer };
      const asset2 = typeof amm.amount2 === 'string' ? { currency: 'XRP' } : { currency: amm.amount2.currency, issuer: amm.amount2.issuer };
      await send({ TransactionType: 'AMMWithdraw', Account: me, Asset: asset, Asset2: asset2, Flags: TF_WITHDRAW_ALL }, `withdraw LP tokens of ${l.account.slice(0, 10)}…`);
    } catch (e) { console.log(`  ⚠️ LP pool ${l.account}: ${e.message}`); }
    continue;
  }
  const r = await send({ TransactionType: 'Payment', Account: me, Destination: me, Amount: '100000000000', SendMax: { ...tok, value: l.balance }, Flags: TF_PARTIAL }, `sell ${l.balance} ${name(l.currency)}`);
  if (r !== 'tesSUCCESS' && r !== 'dry') console.log('    (no buyer – it goes back to the issuer below)');
}
// whatever is left (dust, unsellable, tokens from a withdrawn LP position) → sell again or back to the issuer
if (!dry) {
  for (const l of (await lines()).filter((x) => Number(x.balance) > 0 && !x.currency.startsWith('03'))) {
    const tok = { currency: l.currency, issuer: l.account };
    const r = await send({ TransactionType: 'Payment', Account: me, Destination: me, Amount: '100000000000', SendMax: { ...tok, value: l.balance }, Flags: TF_PARTIAL }, `sell rest ${l.balance} ${name(l.currency)}`);
    const left = (await lines()).find((x) => x.currency === l.currency && x.account === l.account);
    if (left && Number(left.balance) > 0) await send({ TransactionType: 'Payment', Account: me, Destination: l.account, Amount: { ...tok, value: left.balance } }, `give back ${left.balance} ${name(l.currency)} to the issuer${r === 'tesSUCCESS' ? ' (dust)' : ''}`);
  }
}

// ---------- 4. trust lines ----------
const now = dry ? ls : await lines();
if (now.length) console.log(`\n4) Deleting ${now.length} trust lines`);
const acct = (await req('account_info', { account: me })).account_data;
const defaultRipple = !!(acct.Flags & 0x00800000);
for (const l of now) {
  if (!dry && Number(l.balance) !== 0) { console.log(`  ⚠️ ${name(l.currency)}: still ${l.balance} – skipped`); continue; }
  // a line is removed once our side is back to its default: limit 0, no freeze, no-ripple as the account default
  let flags = 0;
  if (!defaultRipple && !l.no_ripple) flags |= TF_SET_NO_RIPPLE;
  if (defaultRipple && l.no_ripple) flags |= TF_CLEAR_NO_RIPPLE;
  if (l.freeze) flags |= TF_CLEAR_FREEZE;
  await send({ TransactionType: 'TrustSet', Account: me, LimitAmount: { currency: l.currency, issuer: l.account, value: '0' }, Flags: flags, QualityIn: 0, QualityOut: 0 }, `delete line ${name(l.currency)}`);
}

// ---------- 5. result / send ----------
const s1 = dry ? s0 : await status();
const leftLines = dry ? ls.length : (await lines()).length;
console.log(`\nNow: balance ${s1.bal.toFixed(6)} XRP · ${s1.owners} objects · ${leftLines} trust lines left · free ${s1.free.toFixed(6)} XRP`);
if (leftLines && !dry) console.log('Some lines are still there – the issuer side may hold a limit, or a balance could not be moved. Run the script again, or check them on xrpscan.');
if (dest) {
  const drops = Math.floor((s1.free - 0.0001) * 1e6); // a little for the fee
  if (drops <= 0) console.log('Nothing free to send.');
  else await send({ TransactionType: 'Payment', Account: me, Destination: dest, Amount: String(drops) }, `send ${(drops / 1e6).toFixed(6)} XRP to ${dest}`);
  if (!dry) { const s2 = await status(); console.log(`Arb wallet now ${s2.bal.toFixed(6)} XRP (the ${s2.base} XRP base reserve stays in the account).`); }
}
await client.disconnect();
console.log('\nDone. The arb bot stays stopped – start it again with: pm2 start arb');
