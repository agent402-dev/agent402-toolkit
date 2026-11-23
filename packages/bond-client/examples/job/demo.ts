// Runs seller and buyer end to end against a LOCAL mainnet fork. No real funds:
// throwaway keys are funded with Surfpool cheatcodes on your machine only.
//
//   surfpool start --network mainnet --no-tui
//   npx tsx examples/job/demo.ts
//
// The fork loads the real deployed program, config and USDC counter on demand.
import { Connection, Keypair, LAMPORTS_PER_SOL, type PublicKey } from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import * as bond from '../../src/index.js';
import { startSeller } from './seller.js';
import { buy } from './buyer.js';

const RPC = process.env.BOND_RPC ?? 'http://127.0.0.1:8899';
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(RPC)) throw new Error('demo runs only against a local Surfnet');
const conn = new Connection(RPC, 'confirmed');
const USDC = bond.MINTS.mainnet.USDC;
const U = 1_000_000n; // USDC has 6 decimals

async function cheat(method: string, params: unknown[]) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = (await r.json()) as { error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
}

const seller = Keypair.generate(), buyer = Keypair.generate();
for (const k of [seller, buyer]) {
  await cheat('surfnet_setAccount', [k.publicKey.toBase58(), { lamports: 2 * LAMPORTS_PER_SOL }]);
  await cheat('surfnet_setTokenAccount', [k.publicKey.toBase58(), USDC.toBase58(), { amount: Number(100n * U) }, TOKEN_PROGRAM_ID.toBase58()]);
}
if (!(await conn.getAccountInfo(bond.counterPda(USDC)))) throw new Error('USDC counter not found: start Surfpool with --network mainnet');

const usdc = async (owner: PublicKey) => (await getAccount(conn, getAssociatedTokenAddressSync(USDC, owner), 'confirmed')).amount;
const fmt = (v: bigint) => `${v < 0n ? '-' : '+'}${Number(v < 0n ? -v : v) / 1e6} USDC`;
const [s0, b0] = [await usdc(seller.publicKey), await usdc(buyer.publicKey)];

const PORT = 8787;
const server = await startSeller({
  rpcUrl: RPC,
  // The SDK takes a signer, not a key. Here a throwaway key signs; in production use your wallet or KMS.
  signer: { publicKey: seller.publicKey, async signTransaction(tx) { tx.partialSign(seller); return tx; } },
  terms: {
    price: 20n * U,        // 20 USDC
    sellerBond: 2n * U,    // 10% of the price, locked by the seller
    buyerDeposit: 5n * U,  // locked by the buyer, counts toward the price
    deliverSeconds: 600n,  // 10 minutes
    lateWindow: 0n,
    payWindow: 86_400n,    // 1 day to pay the balance after confirming
  },
  description: 'Counts the words in a text',
  doJob: async (text) => ({ words: text.trim().split(/\s+/).length, chars: text.length }),
}, PORT);

try {
  const out = await buy({
    conn, buyer, sellerUrl: `http://127.0.0.1:${PORT}`,
    input: 'Agents can lock a bond before doing paid work.',
    limits: { maxPrice: 25n * U, maxDeposit: 10n * U, minBondBps: 500n, maxDeliverSeconds: 3_600n },
    accept: (r) => typeof (r as { words?: unknown }).words === 'number',
  });
  console.log(`\n${out.status}: ${JSON.stringify(out.result)}`);
  console.log(`seller ${fmt((await usdc(seller.publicKey)) - s0)}, buyer ${fmt((await usdc(buyer.publicKey)) - b0)}`);
  console.log(`deal closed: ${(await conn.getAccountInfo(out.deal)) === null}`);
} finally {
  server.close();
}
