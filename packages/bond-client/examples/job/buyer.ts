// Buyer side: an agent that hires a seller for one job.
//
// The one rule that matters: never sign a transaction someone else built until
// you have rebuilt it yourself from terms you accept and compared it byte for byte.
import { type Connection, type Keypair, PublicKey, Transaction } from '@solana/web3.js';
import * as bond from '../../src/index.js';
import {
  chainNow, deliverMessage, getJson, type OpenResponse, postJson, type Quote, send, sendSigned, signMessage, termsFromJson,
} from './common.js';

export interface BuyerLimits {
  maxPrice: bigint;
  maxDeposit: bigint;
  /** Minimum seller bond as a share of the price, in basis points (500 = 5%). */
  minBondBps: bigint;
  maxDeliverSeconds: bigint;
}

export interface BuyOptions {
  conn: Connection;
  buyer: Keypair;
  sellerUrl: string;
  input: string;
  limits: BuyerLimits;
  /** Your own acceptance test. Return false and nothing is paid beyond the deposit, which comes back. */
  accept: (result: unknown) => boolean;
  log?: (msg: string) => void;
}

export type BuyResult =
  | { status: 'paid'; result: unknown; deal: PublicKey }
  | { status: 'rejected'; result: unknown; deal: PublicKey };

export function checkQuote(q: Quote, l: BuyerLimits) {
  const price = BigInt(q.price), bondAmt = BigInt(q.sellerBond), dep = BigInt(q.buyerDeposit);
  if (price > l.maxPrice) throw new Error(`price ${price} above limit`);
  if (dep > l.maxDeposit || dep > price) throw new Error(`deposit ${dep} not acceptable`);
  if (bondAmt * 10_000n < price * l.minBondBps) throw new Error(`seller bond ${bondAmt} below limit`);
  if (BigInt(q.deliverSeconds) > l.maxDeliverSeconds) throw new Error('delivery time above limit');
}

/** Rebuilds the expected `open` instruction and refuses anything else. */
export function checkOpenTx(tx: Transaction, expected: ReturnType<typeof bond.open>, seller: PublicKey) {
  if (!tx.feePayer?.equals(seller)) throw new Error('fee payer is not the seller');
  if (tx.instructions.length !== 1) throw new Error('unexpected extra instructions');
  const got = tx.instructions[0];
  const same =
    got.programId.equals(bond.BOND_PROGRAM_ID) &&
    got.data.equals(expected.data) &&
    got.keys.length === expected.keys.length &&
    got.keys.every((k, i) => {
      const e = expected.keys[i];
      return k.pubkey.equals(e.pubkey) && k.isSigner === e.isSigner && k.isWritable === e.isWritable;
    });
  if (!same) throw new Error('open transaction does not match the agreed terms');
  if (!tx.verifySignatures(false)) throw new Error('seller signature invalid');
}

export async function buy(o: BuyOptions): Promise<BuyResult> {
  const log = o.log ?? console.log;

  // 1. Quote, checked against our own limits.
  const q = await getJson<Quote>(`${o.sellerUrl}/quote`);
  checkQuote(q, o.limits);
  const seller = new PublicKey(q.seller);

  // 2. Ask the seller to prepare the deal, then verify before signing.
  const res = await postJson<OpenResponse>(`${o.sellerUrl}/open`, { buyer: o.buyer.publicKey.toBase58(), input: o.input });
  const terms = termsFromJson(res.terms);
  const now = await chainNow(o.conn);
  if (
    terms.price !== BigInt(q.price) || terms.sellerBond !== BigInt(q.sellerBond) || terms.buyerDeposit !== BigInt(q.buyerDeposit) ||
    terms.lateWindow !== BigInt(q.lateWindow) || terms.payWindow !== BigInt(q.payWindow) ||
    terms.deliverBy <= now || terms.deliverBy > now + o.limits.maxDeliverSeconds + 120n
  ) throw new Error('terms differ from the quote');
  const ref: bond.DealRef = { seller, buyer: o.buyer.publicKey, mint: new PublicKey(q.mint), tokenProgram: new PublicKey(q.tokenProgram), nonce: BigInt(res.nonce) };
  const tx = Transaction.from(Buffer.from(res.tx, 'base64'));
  checkOpenTx(tx, bond.open(ref, terms), seller);
  tx.partialSign(o.buyer);
  const deal = bond.dealOf(ref);
  log(`open: ${await sendSigned(o.conn, tx)} (deal ${deal.toBase58()})`);

  // 3. Ask for the result. Only the buyer's signature unlocks it.
  const { result } = await postJson<{ result: unknown }>(`${o.sellerUrl}/deliver`, {
    deal: deal.toBase58(),
    signature: signMessage(o.buyer, deliverMessage(deal)),
  });

  // 4. Our own check. The program never judges quality.
  if (!o.accept(result)) {
    log('result rejected: not confirming. After the deadlines anyone can settle and each side gets its own money back.');
    return { status: 'rejected', result, deal };
  }

  // 5. Confirm and pay the balance (price minus deposit) straight to the seller.
  log(`confirm + pay balance: ${await send(o.conn, new Transaction().add(bond.confirmReceipt(ref), bond.payBalance(ref)), [o.buyer])}`);

  // 6. Close the deal: settle, buyer's claim, seller's claim. Anyone may send this.
  log(`settle + claims: ${await send(o.conn, new Transaction().add(...bond.settleAndClaim(ref)), [o.buyer])}`);
  return { status: 'paid', result, deal };
}
