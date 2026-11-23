// Builds the seller and the job service. The agent does the work: doJob only reports "pending" until the agent
// submits a result with sell_submit. If the agent never does, the service gives up 30 minutes before the mark
// deadline and delivers a failure (neutral outcome), so the bond is not lost while this process keeps running.
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { bondJobService, createBondSeller, JobPending, type BondJobStore } from '@agent402-dev/pay-server/bond';
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
  const seller = createBondSeller({
    rpcUrl: cfg.rpcUrl,
    signer: { publicKey: kp.publicKey, async signTransaction(tx) { tx.partialSign(kp); return tx; } },
    terms: cfg.terms,
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
  return { seller, service };
}
export type BuiltSeller = ReturnType<typeof buildSeller>;
