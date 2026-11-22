// Agent402 bond: one-time setup after `solana program deploy`.
//  1) checks the program is deployed at the expected id
//  2) creates the config account (the admin is fixed in each build)
//  3) creates the per-mint counters: devnet = Circle devnet USDC + wSOL,
//     mainnet = USDC + wSOL + PREQ
// Anyone may pay for these accounts; they hold no funds and no powers.
// Prints public addresses and signatures only, never key material.
// Env: BOND_CLUSTER=devnet|mainnet (default devnet), BOND_RPC, BOND_PAYER (key file path).
// Run: npx tsx scripts/bond-init.ts   (local rehearsal: $env:BOND_RPC='http://127.0.0.1:8899')
import { readFileSync } from 'node:fs';
import { Connection, Keypair, Transaction } from '@solana/web3.js';
import * as bond from '../src/index.js';

/** Sends and waits by polling (no websocket), so it works on Surfpool too. */
async function sendAndPoll(conn: Connection, tx: Transaction, signers: Keypair[]): Promise<string> {
  // Public RPC nodes can briefly disagree about a fresh blockhash; retry a few times.
  for (let attempt = 1; ; attempt++) {
    try {
      return await sendOnce(conn, tx, signers);
    } catch (e) {
      if (attempt >= 4 || !String(e).includes('simulation failed')) throw e;
      console.log(`  retrying (${attempt}): ${String(e).split('\n')[0]}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

async function sendOnce(conn: Connection, tx: Transaction, signers: Keypair[]): Promise<string> {
  const { blockhash } = await conn.getLatestBlockhash('finalized');
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

const CLUSTER = process.env.BOND_CLUSTER === 'mainnet' ? 'mainnet' : 'devnet';
// BOND_RPC lets the same script run against a local Surfpool fork first.
const RPC = process.env.BOND_RPC ?? (CLUSTER === 'mainnet' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');
const KEY = process.env.BOND_PAYER ?? (CLUSTER === 'mainnet' ? 'keys/agent402-mainnet-deployer.json' : 'keys/agent402-devnet-admin.json');

const conn = new Connection(RPC, 'confirmed');
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEY, 'utf8'))));
const genesis = await conn.getGenesisHash();
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
if (CLUSTER === 'mainnet' && genesis !== MAINNET_GENESIS) throw new Error(`BOND_CLUSTER=mainnet but ${RPC} is not mainnet`);
if (CLUSTER === 'devnet' && genesis === MAINNET_GENESIS) throw new Error(`BOND_CLUSTER=devnet but ${RPC} is mainnet`);
console.log(`cluster: ${CLUSTER} (${RPC})`);

const prog = await conn.getAccountInfo(bond.BOND_PROGRAM_ID);
if (!prog?.executable) throw new Error(`program ${bond.BOND_PROGRAM_ID.toBase58()} is not deployed on devnet yet`);
console.log(`program ok: ${bond.BOND_PROGRAM_ID.toBase58()}`);
console.log(`payer: ${payer.publicKey.toBase58()} balance ${(await conn.getBalance(payer.publicKey)) / 1e9} SOL`);

async function once(label: string, address: import('@solana/web3.js').PublicKey, make: () => import('@solana/web3.js').TransactionInstruction) {
  if (await conn.getAccountInfo(address)) {
    console.log(`${label}: already exists (${address.toBase58()})`);
    return;
  }
  const sig = await sendAndPoll(conn, new Transaction().add(make()), [payer]);
  console.log(`${label}: created ${address.toBase58()} tx ${sig}`);
}

await once('config', bond.configPda(), () => bond.initConfig(payer.publicKey));
const EXPECTED_ADMIN = CLUSTER === 'mainnet' ? '36PdTtqfp4vNvJjn9stRFoymRFdMZ1NHU9kLvb82mScc' : 'BBbLANpYSs8L4SVKrZQ3fq62EdEcVLiiM3VrAvc5rLjz';
const cfg = await conn.getAccountInfo(bond.configPda());
const admin = cfg ? new (await import('@solana/web3.js')).PublicKey(cfg.data.subarray(8, 40)).toBase58() : '(missing)';
console.log(`config admin: ${admin} ${admin === EXPECTED_ADMIN ? '(as expected)' : '(UNEXPECTED: stop and check the build)'}`);
if (admin !== EXPECTED_ADMIN) process.exit(1);
const mints: [string, import('@solana/web3.js').PublicKey][] = CLUSTER === 'mainnet'
  ? [['USDC', bond.MINTS.mainnet.USDC], ['wSOL', bond.MINTS.mainnet.WSOL], ['PREQ', bond.MINTS.mainnet.PREQ]]
  : [['USDC (devnet)', bond.MINTS.devnet.USDC], ['wSOL', bond.MINTS.devnet.WSOL]];
for (const [name, mint] of mints) {
  await once(`counter ${name}`, bond.counterPda(mint), () => bond.initCounter(payer.publicKey, mint));
}
console.log('done. Next: npx tsx scripts/bond-smoke.ts (local Surfnet only).');
