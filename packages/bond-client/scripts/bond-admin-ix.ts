// Agent402 bond: build an admin instruction for the Squads multisig to propose.
// Prints the instruction (program, accounts, data) and a base58/base64 legacy
// transaction message whose fee payer and only signer is the Squads vault.
// Nothing is signed or sent here; the multisig members approve it in Squads.
//
// Usage:
//   npx tsx scripts/bond-admin-ix.ts pause            # stop NEW deals
//   npx tsx scripts/bond-admin-ix.ts unpause
//   npx tsx scripts/bond-admin-ix.ts set-admin <NEW_ADMIN>      # step 1 of 2
//   npx tsx scripts/bond-admin-ix.ts caps <wsol|preq> <PER_DEAL> <TOTAL>   # smallest units, mode A only
//   npx tsx scripts/bond-admin-ix.ts v2-pause | v2-unpause      # Bond v2 (Dpvdw...)
// Env: BOND_ADMIN (default: mainnet Squads vault), BOND_RPC (for a recent blockhash; default mainnet).
import { Connection, PublicKey, Transaction, TransactionMessage } from '@solana/web3.js';
import * as bond from '../src/index.js';
import * as v2 from '../src/v2.js';

const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (bytes: Uint8Array) => {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s;
};

const VAULT = new PublicKey(process.env.BOND_ADMIN ?? '36PdTtqfp4vNvJjn9stRFoymRFdMZ1NHU9kLvb82mScc');
const RPC = process.env.BOND_RPC ?? 'https://api.mainnet-beta.solana.com';
const [cmd, a1, a2, a3] = process.argv.slice(2);

function build() {
  switch (cmd) {
    case 'v2-pause': return v2.setPausedV2(VAULT, true);
    case 'v2-unpause': return v2.setPausedV2(VAULT, false);
    case 'pause': return bond.setPaused(VAULT, true);
    case 'unpause': return bond.setPaused(VAULT, false);
    case 'set-admin': return bond.setAdmin(VAULT, new PublicKey(a1));
    case 'caps': {
      const mint = a1 === 'wsol' ? bond.MINTS.mainnet.WSOL : a1 === 'preq' ? bond.MINTS.mainnet.PREQ : null;
      if (!mint) throw new Error('caps: mint must be wsol or preq (USDC caps are fixed)');
      return bond.proposeCaps(VAULT, mint, BigInt(a2), BigInt(a3));
    }
    default:
      throw new Error('command: v2-pause | v2-unpause | pause | unpause | set-admin <pubkey> | caps <wsol|preq> <per_deal> <total>');
  }
}

const ix = build();
console.log(`command: ${cmd} ${[a1, a2, a3].filter(Boolean).join(' ')}`);
console.log(`signer (Squads vault): ${VAULT.toBase58()}`);
console.log(`program: ${ix.programId.toBase58()}`);
console.log('accounts:');
ix.keys.forEach((k, i) => console.log(`  ${i}. ${k.pubkey.toBase58()}  signer=${k.isSigner} writable=${k.isWritable}`));
console.log(`data (hex):    ${ix.data.toString('hex')}`);
console.log(`data (base58): ${b58(ix.data)}`);
const { blockhash } = await new Connection(RPC, 'confirmed').getLatestBlockhash();
const msg = new TransactionMessage({ payerKey: VAULT, recentBlockhash: blockhash, instructions: [ix] }).compileToLegacyMessage();
const tx = new Transaction({ feePayer: VAULT, recentBlockhash: blockhash }).add(ix);
const txBytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
console.log(`\nSquads: Developers -> TX Builder -> Create transaction -> Import a base58 encoded transaction`);
console.log(`unsigned transaction (base58), paste this first: ${b58(txBytes)}`);
console.log(`\nif Squads rejects it, try the message form instead:`);
console.log(`legacy message (base58): ${b58(msg.serialize())}`);
console.log(`legacy message (base64): ${Buffer.from(msg.serialize()).toString('base64')}`);
console.log('\nCheck in Squads before approving: program, accounts and data must match the lines above.');
