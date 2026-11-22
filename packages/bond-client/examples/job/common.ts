// Shared helpers for the bonded-job example: wire format, sending, and
// a small ed25519 message signature so only the deal's buyer can fetch the result.
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { type Connection, type Keypair, PublicKey, type Transaction } from '@solana/web3.js';
import type { Terms } from '../../src/index.js';

/** What the seller advertises before any money moves. Amounts are strings (bigint over JSON). */
export interface Quote {
  seller: string;
  mint: string;
  tokenProgram: string;
  price: string;
  sellerBond: string;
  buyerDeposit: string;
  /** How long after opening the seller promises to deliver. */
  deliverSeconds: string;
  lateWindow: string;
  payWindow: string;
}

export interface OpenResponse {
  nonce: string;
  terms: Record<keyof Terms, string>;
  /** `open` transaction, signed by the seller only, base64. */
  tx: string;
}

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
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');

export const deliverMessage = (deal: PublicKey) => `agent402-bond-job:deliver:${deal.toBase58()}`;

export function signMessage(kp: Keypair, msg: string): string {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(kp.secretKey.slice(0, 32))]), format: 'der', type: 'pkcs8' });
  return sign(null, Buffer.from(msg), key).toString('base64');
}

export function verifyMessage(signer: PublicKey, msg: string, sigB64: string): boolean {
  const key = createPublicKey({ key: Buffer.concat([SPKI, signer.toBuffer()]), format: 'der', type: 'spki' });
  return verify(null, Buffer.from(msg), key, Buffer.from(sigB64, 'base64'));
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
