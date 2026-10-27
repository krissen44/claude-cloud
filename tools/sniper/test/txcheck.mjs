// Every transaction the bot builds must pass xrpl.js validation and sign cleanly.
import { validate, Wallet } from 'xrpl';
const w = Wallet.generate();
const cur = '50554D5000000000000000000000000000000000', iss = Wallet.generate().address;
const txs = [
  { TransactionType: 'OfferCreate', Account: w.address, Flags: 0x00020000 | 0x00080000, TakerGets: '1000000', TakerPays: { currency: cur, issuer: iss, value: '6.40378e6' } },
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
// a Batch on tickets (outer + both inner payments), the shape bwif's bots use on mainnet
const tok = { currency: cur, issuer: iss };
const batch = {
  TransactionType: 'Batch', Account: w.address, Flags: 0x00010000, Sequence: 0, TicketSequence: 501, Fee: '50', LastLedgerSequence: 100,
  RawTransactions: [
    { RawTransaction: { TransactionType: 'Payment', Account: w.address, Destination: w.address, Amount: { ...tok, value: '9999999999999999e80' }, SendMax: '250000', Flags: 0x40000000 | 0x00020000, Sequence: 0, TicketSequence: 502, Fee: '0', SigningPubKey: '' } },
    { RawTransaction: { TransactionType: 'Payment', Account: w.address, Destination: w.address, Amount: '999999999999999', DeliverMin: '250050', SendMax: { ...tok, value: '9999999999999999e80' }, Flags: 0x40000000 | 0x00020000, Sequence: 0, TicketSequence: 503, Fee: '0', SigningPubKey: '' } },
  ],
};
const sb = w.sign(batch);
if (!sb.tx_blob) throw new Error('batch not signed');
const tc = w.sign({ TransactionType: 'TicketCreate', Account: w.address, TicketCount: 18, Fee: '12', Sequence: 5, LastLedgerSequence: 100 });
if (!tc.tx_blob) throw new Error('TicketCreate not signed');
console.log('all', txs.length + 2, 'transactions valid + signed (incl. ticket batch + TicketCreate)');
