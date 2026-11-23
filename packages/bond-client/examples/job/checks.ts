// Offline checks for the buyer's safety logic (no network). Run: npx tsx examples/job/checks.ts
import { Keypair, Transaction, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import * as bond from '../../src/index.js';
import { checkOpenTx, checkQuote } from './buyer.js';
import { signDeliver } from './common.js';

const seller = Keypair.generate(), buyer = Keypair.generate(), evil = Keypair.generate();
const U = 1_000_000n;
const ref: bond.DealRef = { seller: seller.publicKey, buyer: buyer.publicKey, mint: bond.MINTS.mainnet.USDC, tokenProgram: TOKEN_PROGRAM_ID, nonce: 7n };
const terms: bond.Terms = { price: 20n * U, sellerBond: 2n * U, buyerDeposit: 5n * U, deliverBy: 2_000_000_000n, lateWindow: 0n, payWindow: 86_400n };
const BH = '11111111111111111111111111111111';
let pass = 0, failN = 0;
const t = (name: string, f: () => void, shouldThrow: boolean) => {
  let threw = false; try { f(); } catch { threw = true; }
  if (threw === shouldThrow) { pass++; console.log(`ok   ${name}`); } else { failN++; console.log(`FAIL ${name}`); }
};
const mk = (ixs: ReturnType<typeof bond.open>[], payer = seller) => {
  const tx = new Transaction().add(...ixs); tx.recentBlockhash = BH; tx.feePayer = payer.publicKey; tx.partialSign(payer);
  return Transaction.from(tx.serialize({ requireAllSignatures: false }));
};
const expected = bond.open(ref, terms);
t('honest open tx accepted', () => checkOpenTx(mk([bond.open(ref, terms)]), expected, seller.publicKey), false);
t('higher deposit rejected', () => checkOpenTx(mk([bond.open(ref, { ...terms, buyerDeposit: 50n * U })]), expected, seller.publicKey), true);
t('smaller bond rejected', () => checkOpenTx(mk([bond.open(ref, { ...terms, sellerBond: 1n })]), expected, seller.publicKey), true);
t('other buyer token account rejected', () => checkOpenTx(mk([bond.open(ref, terms, undefined, new PublicKey(evil.publicKey))]), expected, seller.publicKey), true);
t('extra instruction rejected', () => checkOpenTx(mk([bond.open(ref, terms), bond.open({ ...ref, nonce: 8n }, terms)]), expected, seller.publicKey), true);
t('buyer as fee payer rejected', () => { const tx = new Transaction().add(bond.open(ref, terms)); tx.recentBlockhash = BH; tx.feePayer = buyer.publicKey; tx.partialSign(seller); checkOpenTx(Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })), expected, seller.publicKey); }, true);
t('forged seller signature rejected', () => { const tx = mk([bond.open(ref, terms)]); tx.signatures[0].signature = Buffer.alloc(64, 1); checkOpenTx(tx, expected, seller.publicKey); }, true);
const lim = { maxPrice: 25n * U, maxDeposit: 10n * U, minBondBps: 500n, maxDeliverSeconds: 3600n };
const q = { protocol: bond.JOB_PROTOCOL as typeof bond.JOB_PROTOCOL, program: '', seller: '', mint: '', tokenProgram: '', price: String(20n * U), sellerBond: String(2n * U), buyerDeposit: String(5n * U), deliverSeconds: '600', lateWindow: '0', payWindow: '86400' };
t('fair quote accepted', () => checkQuote(q, lim), false);
t('quote over price limit rejected', () => checkQuote({ ...q, price: String(30n * U) }, lim), true);
t('quote with bond under 5% rejected', () => checkQuote({ ...q, sellerBond: String(U / 2n) }, lim), true);
t('quote with deposit over limit rejected', () => checkQuote({ ...q, buyerDeposit: String(11n * U) }, lim), true);
const deal = bond.dealOf(ref);
const ORIGIN = 'https://seller.example';
const mine = signDeliver(buyer, deal.toBase58(), ORIGIN);
const okSig = await bond.verifyDeliverSignature(buyer.publicKey.toBytes(), deal.toBase58(), ORIGIN, mine.expires, mine.signature);
t('buyer signature verifies', () => { if (!okSig) throw 0; }, false);
const evil1 = signDeliver(evil, deal.toBase58(), ORIGIN);
const evilSig = await bond.verifyDeliverSignature(buyer.publicKey.toBytes(), deal.toBase58(), ORIGIN, evil1.expires, evil1.signature);
t('other key signature refused', () => { if (!evilSig) throw 0; }, true);
const otherHost = await bond.verifyDeliverSignature(buyer.publicKey.toBytes(), deal.toBase58(), 'https://other.example', mine.expires, mine.signature);
t('signature for another server refused', () => { if (!otherHost) throw 0; }, true);
console.log(`\n${pass} ok, ${failN} failed`); if (failN) process.exit(1);
