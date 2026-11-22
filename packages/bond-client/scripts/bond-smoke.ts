// Agent402 bond smoke test against a real RPC (local validator or devnet).
// Uses throwaway keys created in memory; never reads keys/.
// Env: BOND_RPC (default http://127.0.0.1:8899, a Surfpool devnet fork).
// Funds the throwaway keys with Surfpool cheatcodes (surfnet_setAccount /
// surfnet_setTokenAccount), so it only runs against a local Surfnet.
// Optional BOND_MINT_AUTHORITY: keypair that can mint the test USDC instead.
// Run: (WSL) surfpool start --network devnet   then   npx tsx scripts/bond-smoke.ts
import { readFileSync } from 'node:fs';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, type TransactionInstruction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import * as bond from '../src/index.js';

/** Sends and waits by polling (no websocket), so it works on Surfpool too. */
async function sendAndPoll(conn: Connection, tx: Transaction, signers: Keypair[]): Promise<string> {
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
  for (let i = 0; i < 120; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return sig;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`transaction ${sig} not confirmed in time`);
}

const RPC = process.env.BOND_RPC ?? 'http://127.0.0.1:8899';
const conn = new Connection(RPC, 'confirmed');
// BOND_CLUSTER=mainnet: a local MAINNET fork with the mainnet build (real USDC mint).
const CLUSTER = process.env.BOND_CLUSTER === 'mainnet' ? 'mainnet' : 'devnet';
const USDC = bond.MINTS[CLUSTER].USDC;
const U = 1_000_000n;
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(RPC)) throw new Error('bond-smoke runs only against a local Surfnet');
const results: string[] = [];
const ok = (m: string) => { results.push(`ok   ${m}`); console.log(`ok   ${m}`); };
const fail = (m: string) => { results.push(`FAIL ${m}`); console.log(`FAIL ${m}`); process.exitCode = 1; };

async function send(label: string, ixs: TransactionInstruction[], signers: Keypair[]) {
  const tx = new Transaction().add(...ixs);
  const sig = await sendAndPoll(conn, tx, signers);
  const info = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  const size = tx.serialize().length;
  console.log(`  ${label}: ${info?.meta?.computeUnitsConsumed ?? '?'} CU, ${size} bytes`);
  return sig;
}
async function expectFail(label: string, ixs: TransactionInstruction[], signers: Keypair[]) {
  try { await send(label, ixs, signers); fail(`${label} should have failed`); } catch { ok(`${label} refused`); }
}
const bal = async (a: PublicKey) => (await getAccount(conn, a, 'confirmed')).amount;

async function rpc(method: string, params: unknown[]) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = (await r.json()) as { error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
}
const payer = Keypair.generate(), seller = Keypair.generate(), buyer = Keypair.generate();
const mintAuthPath = process.env.BOND_MINT_AUTHORITY;
for (const k of [payer, seller, buyer]) {
  if (mintAuthPath) {
    await conn.requestAirdrop(k.publicKey, 5 * LAMPORTS_PER_SOL);
    while ((await conn.getBalance(k.publicKey)) === 0) await new Promise((r) => setTimeout(r, 500));
  } else {
    await rpc('surfnet_setAccount', [k.publicKey.toBase58(), { lamports: 5 * LAMPORTS_PER_SOL }]);
  }
}
const prog = await conn.getAccountInfo(bond.BOND_PROGRAM_ID);
prog?.executable ? ok('program is deployed') : fail('program missing');

// Test USDC balances: Surfpool cheatcode, or a mint authority we hold.
const sAta = getAssociatedTokenAddressSync(USDC, seller.publicKey), bAta = getAssociatedTokenAddressSync(USDC, buyer.publicKey);
if (mintAuthPath) {
  const auth = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(mintAuthPath, 'utf8'))));
  await send('token accounts + mint', [
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, sAta, seller.publicKey, USDC),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, bAta, buyer.publicKey, USDC),
    createMintToInstruction(USDC, sAta, auth.publicKey, 1_000n * U),
    createMintToInstruction(USDC, bAta, auth.publicKey, 1_000n * U),
  ], [payer, auth]);
} else {
  for (const k of [seller, buyer]) {
    await rpc('surfnet_setTokenAccount', [k.publicKey.toBase58(), USDC.toBase58(), { amount: Number(1_000n * U) }, TOKEN_PROGRAM_ID.toBase58()]);
  }
}

for (const [label, addr, ix] of [
  ['config', bond.configPda(), bond.initConfig(payer.publicKey)],
  ['counter USDC', bond.counterPda(USDC), bond.initCounter(payer.publicKey, USDC)],
  ['counter wSOL', bond.counterPda(bond.MINTS[CLUSTER].WSOL), bond.initCounter(payer.publicKey, bond.MINTS[CLUSTER].WSOL)],
] as const) {
  if (!(await conn.getAccountInfo(addr))) await send(`init ${label}`, [ix], [payer]);
}
ok('setup accounts exist');

const now = BigInt(Math.floor(Date.now() / 1000));
const terms = (bondAmt: bigint, dep: bigint): bond.Terms => ({ price: 50n * U, sellerBond: bondAmt, buyerDeposit: dep, deliverBy: now + 3600n, lateWindow: 0n, payWindow: 86_400n });
const ref = (nonce: bigint): bond.DealRef => ({ seller: seller.publicKey, buyer: buyer.publicKey, mint: USDC, tokenProgram: TOKEN_PROGRAM_ID, nonce });

// Cap: 10 + 91 = 101 USDC locked > 100 per deal.
await expectFail('open above the per-deal cap', [bond.open(ref(1n), terms(10n * U, 91n * U))], [seller, buyer]);

// Delivered path.
const d = ref(2n);
const [s0, b0] = [await bal(sAta), await bal(bAta)];
await send('open', [bond.open(d, terms(5n * U, 10n * U))], [seller, buyer]);
(await bal(bond.vaultPda(bond.dealOf(d)))) === 15n * U ? ok('vault holds bond + deposit') : fail('vault amount');
await expectFail('stranger confirms', [bond.confirmReceipt({ ...d, buyer: payer.publicKey })], [payer]);
await send('mark delivered', [bond.markDelivered(d)], [seller]);
await send('confirm + pay balance', [bond.confirmReceipt(d), bond.payBalance(d)], [buyer]);
await send('settle + claims', bond.settleAndClaim(d), [payer]);
(await bal(sAta)) - s0 === 50n * U ? ok('seller received the price') : fail(`seller delta ${(await bal(sAta)) - s0}`);
b0 - (await bal(bAta)) === 50n * U ? ok('buyer paid the price') : fail('buyer delta');
(await conn.getAccountInfo(bond.dealOf(d))) === null ? ok('deal and vault closed') : fail('deal still open');

// Cancel path: each side gets its own money back.
const c = ref(3n);
const [s1, b1] = [await bal(sAta), await bal(bAta)];
await send('open', [bond.open(c, terms(5n * U, 10n * U))], [seller, buyer]);
await expectFail('seller alone cancels', [bond.cancel({ ...c, buyer: payer.publicKey })], [seller, payer]);
await send('cancel + claims', bond.cancelAndClaim(c), [seller, buyer]);
(await bal(sAta)) === s1 && (await bal(bAta)) === b1 ? ok('cancel refunded both sides') : fail('cancel balances');

console.log(`\n${results.filter((r) => r.startsWith('ok')).length} ok, ${results.filter((r) => r.startsWith('FAIL')).length} failed`);
