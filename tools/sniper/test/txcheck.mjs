// Every transaction the bot builds must pass xrpl.js validation and sign cleanly.
import { validate, Wallet } from 'xrpl';
const w = Wallet.generate();
const cur = '50554D5000000000000000000000000000000000', iss = Wallet.generate().address;
const txs = [
  { TransactionType: 'TrustSet', Account: w.address, Flags: 0x00020000, LimitAmount: { currency: cur, issuer: iss, value: '9999999999999999e80' } },
  { TransactionType: 'Payment', Account: w.address, Destination: w.address, Flags: 0x00020000, Amount: { currency: cur, issuer: iss, value: '14777955.2512345' }, SendMax: '1000000', DeliverMin: { currency: cur, issuer: iss, value: '7.38897e6' } },
  { TransactionType: 'Payment', Account: w.address, Destination: w.address, Flags: 0x00020000, Amount: '4561834', SendMax: { currency: cur, issuer: iss, value: '4925986.43497203' }, DeliverMin: '2128856' },
  { TransactionType: 'TrustSet', Account: w.address, Flags: 0x00020000, LimitAmount: { currency: cur, issuer: iss, value: '0' } },
];
for (const tx of txs) {
  validate(tx);
  const signed = w.sign({ ...tx, Fee: '12', Sequence: 5, LastLedgerSequence: 100 });
  if (!signed.tx_blob) throw new Error('no blob');
}
console.log('all', txs.length, 'transactions valid + signed');
