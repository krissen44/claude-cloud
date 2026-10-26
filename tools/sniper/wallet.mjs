// Loads the bot wallet from .env: WALLET_SEED (s…), WALLET_MNEMONIC (12/24 words, BIP39) with
// WALLET_PATH, or WALLET_SECRET_NUMBERS (Xaman's 8 × 6 digits). WALLET_ADDRESS, if set, must match.
//
// CLI used by setup-vps.sh:  SECRET="…" ADDRESS="r…" node wallet.mjs find
//   → prints "<kind>\t<path>\t<address>" for the key that belongs to ADDRESS, exit 1 if none.

import { Wallet } from 'xrpl';

const words = (s) => s.trim().toLowerCase().split(/\s+/);
export const kindOf = (secret) => {
  const s = secret.trim();
  if (/^s[1-9A-HJ-NP-Za-km-z]{20,40}$/.test(s)) return 'seed';
  if (/^(\d{6}\s*){8}$/.test(s.replace(/[^\d\s]/g, ' ').trim()) && !/[a-z]/i.test(s)) return 'numbers';
  const w = words(s);
  if ((w.length === 12 || w.length === 24) && w.every((x) => /^[a-z]+$/.test(x))) return 'mnemonic';
  return null;
};

export function fromSecret(kind, secret, path) {
  if (kind === 'seed') return Wallet.fromSeed(secret.trim());
  if (kind === 'numbers') return Wallet.fromSecretNumbers(secret.trim().split(/\D+/).filter(Boolean));
  if (kind === 'mnemonic') return Wallet.fromMnemonic(words(secret).join(' '), { derivationPath: path || "m/44'/144'/0'/0/0" });
  throw new Error('unknown secret');
}

// Wallet apps differ in which branch of the phrase they use, so search the usual ones.
export function find(secret, address) {
  const kind = kindOf(secret);
  if (!kind) return null;
  if (kind !== 'mnemonic') {
    const w = fromSecret(kind, secret);
    return !address || w.address === address ? { kind, path: '', wallet: w } : null;
  }
  for (let a = 0; a < 5; a++) {
    for (let i = 0; i < 5; i++) {
      const path = `m/44'/144'/${a}'/0/${i}`;
      const w = fromSecret(kind, secret, path);
      if (!address || w.address === address) return { kind, path, wallet: w };
    }
  }
  return null;
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

if (process.argv[2] === 'find') {
  try {
    const r = find(process.env.SECRET || '', (process.env.ADDRESS || '').trim());
    if (!r) process.exit(1);
    console.log(`${r.kind}\t${r.path}\t${r.wallet.address}`);
  } catch { process.exit(1); }
}
