// Loads the bot wallet from .env: WALLET_SEED (s…), WALLET_MNEMONIC (12/24 words, BIP39) with
// WALLET_PATH, or WALLET_SECRET_NUMBERS (Xaman's 8 × 6 digits). WALLET_ADDRESS, if set, must match.
//
// CLI used by setup-vps.sh:  SECRET="…" ADDRESS="r…" node wallet.mjs find
//   → prints "<kind>\t<path>\t<address>" for the key that belongs to ADDRESS, exit 1 if none.

import { Wallet } from 'xrpl';

import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

const words = (s) => s.trim().toLowerCase().split(/\s+/);
const hex = (u8) => Buffer.from(u8).toString('hex').toUpperCase();
export const kindOf = (secret) => {
  const s = secret.trim();
  if (/^s[1-9A-HJ-NP-Za-km-z]{20,40}$/.test(s)) return 'seed';
  if (/^(\d{6}\s*){8}$/.test(s.replace(/[^\d\s]/g, ' ').trim()) && !/[a-z]/i.test(s)) return 'numbers';
  const w = words(s);
  if ((w.length === 12 || w.length === 24) && w.every((x) => /^[a-z]+$/.test(x))) return 'mnemonic';
  return null;
};

// BIP39 key at a derivation path, same result as Wallet.fromMnemonic but from a seed computed once.
const fromHd = (root, path) => {
  const node = root.derive(path);
  return new Wallet(hex(node.publicKey), '00' + hex(node.privateKey));
};

// path: a BIP44 path, or "entropy:<alg>" (phrase = the family seed's entropy), or "rfc1751:<alg>"
export function fromSecret(kind, secret, path) {
  if (kind === 'seed') return Wallet.fromSeed(secret.trim());
  if (kind === 'numbers') return Wallet.fromSecretNumbers(secret.trim().split(/\D+/).filter(Boolean));
  if (kind === 'mnemonic') {
    const phrase = words(secret).join(' ');
    const p = path || "m/44'/144'/0'/0/0";
    if (p.startsWith('entropy:')) return Wallet.fromEntropy(mnemonicToEntropy(phrase, wordlist), { algorithm: p.slice(8) });
    if (p.startsWith('rfc1751:')) return Wallet.fromMnemonic(phrase.toUpperCase(), { mnemonicEncoding: 'rfc1751', algorithm: p.slice(8) });
    return fromHd(HDKey.fromMasterSeed(mnemonicToSeedSync(phrase)), p);
  }
  throw new Error('unknown secret');
}

const ALGS = ['ecdsa-secp256k1', 'ed25519'];

// Wallet apps differ in how they turn the phrase into a key, so try the usual ways.
export function find(secret, address) {
  const kind = kindOf(secret);
  if (!kind) return null;
  if (kind !== 'mnemonic') {
    const w = fromSecret(kind, secret);
    return !address || w.address === address ? { kind, path: '', wallet: w } : null;
  }
  const phrase = words(secret).join(' ');
  const tries = [];
  if (validateMnemonic(phrase, wordlist)) {
    const root = HDKey.fromMasterSeed(mnemonicToSeedSync(phrase));
    for (let a = 0; a < 10; a++) for (let i = 0; i < 10; i++) tries.push([`m/44'/144'/${a}'/0/${i}`, () => fromHd(root, `m/44'/144'/${a}'/0/${i}`)]);
    if (words(phrase).length === 12) for (const alg of ALGS) tries.push([`entropy:${alg}`, () => fromSecret(kind, phrase, `entropy:${alg}`)]);
  }
  for (const alg of ALGS) tries.push([`rfc1751:${alg}`, () => fromSecret(kind, phrase, `rfc1751:${alg}`)]);
  for (const [path, make] of tries) {
    let w;
    try { w = make(); } catch { continue; }
    if (!address || w.address === address) return { kind, path, wallet: w };
  }
  return null;
}

// Why a phrase didn't match – without ever printing a word.
export function diagnose(secret) {
  const w = words(secret);
  if (kindOf(secret) !== 'mnemonic') return `Erkannt wurden ${w.length} Wörter – erwartet sind 12 oder 24 (oder ein Seed s…).`;
  const unknown = w.map((x, i) => (wordlist.includes(x) ? 0 : i + 1)).filter(Boolean);
  if (unknown.length) return `Wort Nr. ${unknown.join(', ')} gibt es nicht in der Wortliste → Tippfehler an dieser Stelle.`;
  if (!validateMnemonic(w.join(' '), wordlist)) return 'Alle Wörter sind gültig, aber die Prüfsumme stimmt nicht → ein Wort vertauscht/verwechselt oder falsche Reihenfolge.';
  const def = fromSecret('mnemonic', w.join(' '));
  return `Die Wörter sind gültig, gehören aber zu einer anderen Adresse (z. B. ${def.address}). Ist das evtl. eine andere Wallet von dir?`;
}

export function loadWallet(env = process.env) {
  let w = null;
  if (env.WALLET_SEED) w = fromSecret('seed', env.WALLET_SEED);
  else if (env.WALLET_MNEMONIC) w = fromSecret('mnemonic', env.WALLET_MNEMONIC, env.WALLET_PATH);
  else if (env.WALLET_SECRET_NUMBERS) w = fromSecret('numbers', env.WALLET_SECRET_NUMBERS);
  if (w && env.WALLET_ADDRESS && w.address !== env.WALLET_ADDRESS.trim()) {
    throw new Error(`the key in .env belongs to ${w.address}, not to WALLET_ADDRESS ${env.WALLET_ADDRESS}`);
  }
  return w;
}

// `node wallet.mjs check`: is there a working key in .env? Prints the address, exit 1 if not.
if (process.argv[2] === 'check') {
  const fs = await import('node:fs');
  const env = {};
  try {
    for (const line of fs.readFileSync(new URL('./.env', import.meta.url), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/(^|\s+)#.*$/, '').trim().replace(/^["']|["']$/g, '');
    }
    const w = loadWallet(env);
    if (!w || !env.WALLET_ADDRESS) process.exit(1);
    console.log(w.address);
  } catch { process.exit(1); }
}

if (process.argv[2] === 'find') {
  try {
    const r = find(process.env.SECRET || '', (process.env.ADDRESS || '').trim());
    if (!r) { console.error(diagnose(process.env.SECRET || '')); process.exit(1); }
    console.log(`${r.kind}\t${r.path}\t${r.wallet.address}`);
  } catch { process.exit(1); }
}
