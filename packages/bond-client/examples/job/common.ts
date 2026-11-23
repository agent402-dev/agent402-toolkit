// Shared helpers for the bonded-job example: sending by polling, and the buyer's signed delivery request
// (Agent402 Bond Job Protocol v1, see docs/bond/JOB-PROTOCOL.md).
import { createPrivateKey, sign } from 'node:crypto';
import type { Connection, Keypair, Transaction } from '@solana/web3.js';
import { deliverMessage, type JobOpen, type JobQuote, type Terms, toBase64 } from '../../src/index.js';

export type Quote = JobQuote;
export type OpenResponse = JobOpen;

export const termsToJson = (t: Terms) =>
  Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.toString()])) as Record<keyof Terms, string>;
export const termsFromJson = (j: Record<keyof Terms, string>): Terms => ({
  price: BigInt(j.price),
  sellerBond: BigInt(j.sellerBond),
  buyerDeposit: BigInt(j.buyerDeposit),
  deliverBy: BigInt(j.deliverBy),
  lateWindow: BigInt(j.lateWindow),
  payWindow: BigInt(j.payWindow),
});

/** Network clock (the program's clock), not the local machine's. */
export async function chainNow(conn: Connection): Promise<bigint> {
  const t = await conn.getBlockTime(await conn.getSlot('confirmed'));
  if (t === null) throw new Error('no block time from RPC');
  return BigInt(t);
}

/** Sends a fully signed transaction and waits by polling (works on local Surfnet too). */
export async function sendSigned(conn: Connection, tx: Transaction): Promise<string> {
  const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
  for (let i = 0; i < 120; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return sig;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`transaction ${sig} not confirmed in time`);
}

/** Sets blockhash and fee payer (first signer), signs, sends. */
export async function send(conn: Connection, tx: Transaction, signers: Keypair[]): Promise<string> {
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  return sendSigned(conn, tx);
}

// ed25519 via node:crypto, using the raw Solana key bytes.
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * The buyer's delivery request: ed25519 over deliverMessage(deal, origin, expires) (starts with 0xff, never a transaction).
 * Bound to the seller's origin and valid for 5 minutes.
 */
export function signDeliver(kp: Keypair, deal: string, sellerUrl: string, expires = Math.floor(Date.now() / 1000) + 300) {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(kp.secretKey.slice(0, 32))]), format: 'der', type: 'pkcs8' });
  const signature = toBase64(new Uint8Array(sign(null, Buffer.from(deliverMessage(deal, new URL(sellerUrl).origin, expires)), key)));
  return { deal, expires, signature };
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(`${url}: ${j.error ?? r.status}`);
  return j;
}

export async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return (await r.json()) as T;
}
