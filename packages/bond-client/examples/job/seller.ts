// Seller side: an HTTP service that takes a job, locks a performance bond with
// the buyer, does the work, marks delivery on-chain and hands over the result.
//
//   GET  /quote    terms the seller offers
//   POST /open     { buyer, input }        -> open transaction signed by the seller
//   POST /deliver  { deal, signature }     -> runs the job, marks delivery, returns the result
//
// The seller never holds the buyer's money: the deposit sits in the deal vault and
// the balance goes straight from buyer to seller when the buyer confirms.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { type Connection, type Keypair, PublicKey, Transaction } from '@solana/web3.js';
import * as bond from '../../src/index.js';
import {
  chainNow, deliverMessage, type OpenResponse, type Quote, send, termsToJson, verifyMessage,
} from './common.js';

export interface SellerOptions {
  conn: Connection;
  seller: Keypair;
  mint: PublicKey;
  tokenProgram: PublicKey;
  price: bigint;
  sellerBond: bigint;
  buyerDeposit: bigint;
  deliverSeconds: bigint;
  lateWindow: bigint;
  payWindow: bigint;
  /** The actual work. Keep it shorter than deliverSeconds. */
  doJob: (input: string) => Promise<unknown>;
}

interface Job { ref: bond.DealRef; terms: bond.Terms; input: string; result?: unknown }

const readJson = async (req: IncomingMessage) => {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 64_000) throw new Error('body too large'); }
  return JSON.parse(s || '{}') as Record<string, unknown>;
};

export function startSeller(o: SellerOptions, port: number): Promise<Server> {
  const jobs = new Map<string, Job>(); // by deal address. Use a database in production.

  const quote: Quote = {
    seller: o.seller.publicKey.toBase58(),
    mint: o.mint.toBase58(),
    tokenProgram: o.tokenProgram.toBase58(),
    price: o.price.toString(),
    sellerBond: o.sellerBond.toString(),
    buyerDeposit: o.buyerDeposit.toString(),
    deliverSeconds: o.deliverSeconds.toString(),
    lateWindow: o.lateWindow.toString(),
    payWindow: o.payWindow.toString(),
  };

  async function openDeal(body: Record<string, unknown>): Promise<OpenResponse> {
    const buyer = new PublicKey(String(body.buyer));
    const input = String(body.input ?? '');
    if (!input) throw new Error('input required');
    const nonce = randomBytes(8).readBigUInt64LE();
    const ref: bond.DealRef = { seller: o.seller.publicKey, buyer, mint: o.mint, tokenProgram: o.tokenProgram, nonce };
    const terms: bond.Terms = {
      price: o.price,
      sellerBond: o.sellerBond,
      buyerDeposit: o.buyerDeposit,
      deliverBy: (await chainNow(o.conn)) + o.deliverSeconds,
      lateWindow: o.lateWindow,
      payWindow: o.payWindow,
    };
    // The seller pays the fee and the deal rent (returned when the deal closes).
    const tx = new Transaction().add(bond.open(ref, terms));
    tx.recentBlockhash = (await o.conn.getLatestBlockhash('confirmed')).blockhash;
    tx.feePayer = o.seller.publicKey;
    tx.partialSign(o.seller);
    jobs.set(bond.dealOf(ref).toBase58(), { ref, terms, input });
    return { nonce: nonce.toString(), terms: termsToJson(terms), tx: tx.serialize({ requireAllSignatures: false }).toString('base64') };
  }

  async function deliver(body: Record<string, unknown>) {
    const dealKey = String(body.deal);
    const job = jobs.get(dealKey);
    if (!job) throw new Error('unknown deal');
    if (!verifyMessage(job.ref.buyer, deliverMessage(new PublicKey(dealKey)), String(body.signature))) throw new Error('bad signature');
    if (job.result !== undefined) return { result: job.result }; // already delivered

    // Work only once the buyer's deposit is really locked on-chain.
    const acc = await o.conn.getAccountInfo(new PublicKey(dealKey), 'confirmed');
    if (!acc || !acc.owner.equals(bond.BOND_PROGRAM_ID)) throw new Error('deal is not open on-chain');
    const d = bond.decodeDeal(acc.data);
    if (d.outcome !== 'open' || !d.seller.equals(o.seller.publicKey) || d.terms.deliverBy !== job.terms.deliverBy) {
      throw new Error('deal does not match');
    }

    job.result = await o.doJob(job.input);
    // Mark before the deadline. With no mark and no confirmation, the bond goes to the buyer.
    const markSig = await send(o.conn, new Transaction().add(bond.markDelivered(job.ref)), [o.seller]);
    return { result: job.result, markSig };
  }

  const server = createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && req.url === '/quote') return reply(200, quote);
      if (req.method === 'POST' && req.url === '/open') return reply(200, await openDeal(await readJson(req)));
      if (req.method === 'POST' && req.url === '/deliver') return reply(200, await deliver(await readJson(req)));
      reply(404, { error: 'not found' });
    } catch (e) {
      reply(400, { error: (e as Error).message });
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
