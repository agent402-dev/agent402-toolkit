// Builds the seller and the job service. The agent does the work: doJob only reports "pending" until the agent
// submits a result with sell_submit. If the agent never does, the service gives up 30 minutes before the mark
// deadline and delivers a failure (neutral outcome), so the bond is not lost while this process keeps running.
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import * as bond from '@agent402-dev/bond-client';
import { bondJobService, createBondSeller, JobPending, type BondJobStore } from '@agent402-dev/pay-server/bond';
import { bondJobServiceV2, createBondSellerV2 } from '@agent402-dev/pay-server/bond-v2';
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import type { SellerConfig } from './config.js';
import { fileBondStore } from './file-store.js';

export function loadKeypair(path: string): Keypair {
  const bytes = Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]);
  if (bytes.length !== 64) throw new Error('the key file must be a Solana CLI key (64-number JSON array)');
  try { return Keypair.fromSecretKey(bytes); } finally { bytes.fill(0); }
}

export function buildSeller(cfg: SellerConfig, o: { keypair: Keypair; store?: BondJobStore; fetchImpl?: typeof fetch }) {
  if (!cfg.terms || !cfg.rpcUrl) throw new Error(cfg.problems.join('; '));
  const kp = o.keypair;
  const allowedV2 = cfg.buyers ? new Set(cfg.buyers) : null;
  if (cfg.protocol === 2) {
    if (!cfg.termsV2 || !cfg.v2Program) throw new Error(cfg.problems.join('; '));
    const preq = cfg.asset === 'PREQ';
    const seller = createBondSellerV2({
      rpcUrl: cfg.rpcUrl, programId: new PublicKey(cfg.v2Program), terms: cfg.termsV2, description: cfg.description,
      mint: preq ? bond.MINTS.mainnet.PREQ : bond.MINTS.mainnet.USDC, tokenProgram: preq ? bond.TOKEN_2022_PROGRAM_ID : bond.TOKEN_PROGRAM_ID,
      signer: {
        publicKey: kp.publicKey,
        async signTransaction(tx) { tx.partialSign(kp); return tx; },
        async signMessage(m) { return nacl.sign.detached(m, kp.secretKey); },
      },
      store: o.store ?? fileBondStore(cfg.storePath),
      fetchImpl: o.fetchImpl,
    });
    const service = bondJobServiceV2({
      seller, doJob: async () => { throw new JobPending(); },
      allowBuyer: allowedV2 ? (b) => allowedV2.has(b) : undefined,
      maxPending: cfg.maxPending, maxPendingPerBuyer: cfg.maxPendingPerBuyer, maxUnconfirmedPerBuyer: cfg.maxUnconfirmedPerBuyer,
      publicOrigin: cfg.http?.publicOrigin,
    });
    return { protocol: 2 as const, seller, service };
  }
  const seller = createBondSeller({
    rpcUrl: cfg.rpcUrl,
    signer: { publicKey: kp.publicKey, async signTransaction(tx) { tx.partialSign(kp); return tx; } },
    terms: cfg.terms,
    ...(cfg.asset === 'PREQ' ? { mint: bond.MINTS.mainnet.PREQ, tokenProgram: bond.TOKEN_2022_PROGRAM_ID } : {}),
    store: o.store ?? fileBondStore(cfg.storePath),
    fetchImpl: o.fetchImpl,
  });
  const allowed = cfg.buyers ? new Set(cfg.buyers) : null;
  const service = bondJobService({
    seller,
    description: cfg.description,
    doJob: async () => { throw new JobPending(); },
    allowBuyer: allowed ? (b) => allowed.has(b) : undefined,
    maxPending: cfg.maxPending,
    maxPendingPerBuyer: cfg.maxPendingPerBuyer,
    maxUnconfirmedPerBuyer: cfg.maxUnconfirmedPerBuyer,
    publicOrigin: cfg.http?.publicOrigin,
  });
  return { protocol: 1 as const, seller, service };
}
export type BuiltSeller = ReturnType<typeof buildSeller>;
