import { PublicKey } from '@solana/web3.js';
import { Reader } from '../bytes.js';
import { decodeMint, programKind } from '../mint.js';
import { DISCLAIMER_EN, MintNotFoundError } from '../summary.js';
import type { ChainReader } from '../chain.js';
import {
  POOL_AUTHORITIES,
  POOL_STATE_PROGRAMS,
  STREAMFLOW_ESCROW_OFFSET,
  STREAMFLOW_MINT_OFFSET,
  STREAMFLOW_PROGRAM,
  streamflowEscrow,
} from './registry.js';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/** @deprecated Use ChainReader */
export type HolderReader = ChainReader;

export type HolderCategory = 'pool' | 'lock' | 'wallet' | 'program' | 'pda';

export interface HolderEntry {
  rank: number;
  tokenAccount: string;
  /** Owner (transfer authority) address of the token account */
  owner: string;
  amount: string;
  /** % of total supply */
  percent: number;
  category: HolderCategory;
  /** Known program name (pool/lock). null if unknown */
  label: string | null;
  /** If owner is a data account, the program that owns that account */
  ownerProgram: string | null;
  /** Extra account used as classification evidence (e.g. Streamflow contract address) */
  reference: string | null;
  /** Basis for the classification (factual description) */
  basis: string;
}

export interface HoldersReport {
  mint: string;
  checkedAt: string;
  slot: number;
  method: string;
  supply: string;
  decimals: number;
  accountsExamined: number;
  top: HolderEntry[];
  /** Total share of supply held by the 10 largest token accounts (%) */
  top10Percent: number;
  /** Total share by category for the accounts examined (%) */
  categoryPercent: Record<HolderCategory, number>;
  /** Top 5 wallets (on-curve addresses) merged by owner. pool, lock and unsupported program accounts are not included */
  excludingPoolsAndLocksTop5: { owner: string; category: HolderCategory; percent: number; tokenAccounts: string[] }[];
  /** Accounts owned by programs this reader does not support (DEXes, lockups, multisigs, etc.): category program or pda, merged by owner */
  unsupportedProgramAccounts: {
    owner: string;
    category: HolderCategory;
    ownerProgram: string | null;
    percent: number;
    tokenAccounts: string[];
  }[];
  evidence: { account: string; role: string }[];
  notes: string[];
}

interface TokenAccount {
  address: string;
  mint: string;
  owner: string;
  amount: bigint;
}

function decodeTokenAccount(address: string, data: Buffer): TokenAccount {
  if (data.length < 165) throw new Error(`token account ${address} too small (${data.length})`);
  const r = new Reader(data);
  const mint = r.pubkey().toBase58();
  const owner = r.pubkey().toBase58();
  const amount = r.u64();
  return { address, mint, owner, amount };
}

/** % of supply (6 decimals) */
export function percentOf(amount: bigint, supply: bigint): number {
  if (supply === 0n) return 0;
  return Number((amount * 100_000_000n) / supply) / 1_000_000;
}
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

export async function checkHolders(
  mintAddress: string,
  reader: ChainReader,
  now: () => Date = () => new Date(),
): Promise<HoldersReport> {
  const mint = new PublicKey(mintAddress).toBase58();
  const notes: string[] = [DISCLAIMER_EN];
  const evidence: HoldersReport['evidence'] = [{ account: mint, role: 'mint' }];

  // 1) Mint → token program
  const m0 = (await reader.fetch([mint])).accounts[0];
  if (!m0) throw new MintNotFoundError(`account ${mint} not found`);
  decodeMint(m0.data, new PublicKey(m0.owner));

  // 2) Largest token accounts
  const { addresses, method } = await reader.largestTokenAccounts(mint, m0.owner);

  // 3) Read the mint and token accounts again at the same slot (so supply and balances share a point in time)
  const snap = await reader.fetch([mint, ...addresses]);
  const mintAcc = snap.accounts[0]!;
  const decoded = decodeMint(mintAcc.data, new PublicKey(mintAcc.owner));
  const supply = decoded.supply;
  const tokenAccounts: TokenAccount[] = [];
  addresses.forEach((a, i) => {
    const acc = snap.accounts[i + 1];
    if (!acc || !programKind(new PublicKey(acc.owner))) return; // account closed in between
    const ta = decodeTokenAccount(a, acc.data);
    if (ta.mint !== mint) throw new Error(`token account ${a} is for ${ta.mint}`);
    tokenAccounts.push(ta);
  });
  tokenAccounts.sort((x, y) => (y.amount > x.amount ? 1 : y.amount < x.amount ? -1 : 0));

  // 4) Look up owner accounts
  const owners = [...new Set(tokenAccounts.map((t) => t.owner))];
  const ownerInfo = new Map<string, { owner: string; dataLen: number } | null>();
  if (owners.length) {
    const res = await reader.fetch(owners);
    owners.forEach((o, i) => {
      const a = res.accounts[i];
      ownerInfo.set(o, a ? { owner: a.owner, dataLen: a.data.length } : null);
    });
  }

  // 5) Classify
  const top: HolderEntry[] = [];
  for (const [i, t] of tokenAccounts.entries()) {
    const info = ownerInfo.get(t.owner) ?? null;
    const ownerProgram = info && info.dataLen > 0 ? info.owner : null;
    const onCurve = PublicKey.isOnCurve(new PublicKey(t.owner).toBuffer());
    const base = {
      rank: i + 1,
      tokenAccount: t.address,
      owner: t.owner,
      amount: t.amount.toString(),
      percent: percentOf(t.amount, supply),
      ownerProgram,
      reference: null as string | null,
    };

    const poolAuth = POOL_AUTHORITIES[t.owner];
    if (poolAuth) {
      top.push({ ...base, category: 'pool', label: poolAuth.label, reference: poolAuth.program,
        basis: `Owner is the pool authority address of the ${poolAuth.label} program (${poolAuth.program})` });
      continue;
    }
    if (ownerProgram && POOL_STATE_PROGRAMS[ownerProgram]) {
      const label = POOL_STATE_PROGRAMS[ownerProgram];
      top.push({ ...base, category: 'pool', label, basis: `Owner is a pool state account owned by the ${label} program (${ownerProgram})` });
      continue;
    }
    if (!onCurve && t.owner === t.address) {
      // Streamflow escrow candidate: find the contract that records this escrow address and check the re-derived PDA matches
      const contracts = await reader.programAccounts(STREAMFLOW_PROGRAM.toBase58(), {
        memcmp: [{ offset: STREAMFLOW_ESCROW_OFFSET, bytes: t.address }],
      });
      const hit = contracts.find((c) => {
        const cMint = new PublicKey(c.data.subarray(STREAMFLOW_MINT_OFFSET, STREAMFLOW_MINT_OFFSET + 32)).toBase58();
        return cMint === mint && streamflowEscrow(new PublicKey(c.address)).toBase58() === t.address;
      });
      if (hit) {
        top.push({ ...base, category: 'lock', label: 'streamflow', reference: hit.address,
          basis: `Escrow account of Streamflow contract ${hit.address} (re-derived PDA ["strm", contract] matches)` });
        evidence.push({ account: hit.address, role: 'streamflow-contract' });
        continue;
      }
    }
    if (onCurve) {
      top.push({ ...base, category: 'wallet', label: null,
        basis: info?.owner === SYSTEM_PROGRAM || !info ? 'Owner is an on-curve address (a regular wallet address that signs with a private key)' : `Owner is an on-curve address and the account's owner program is ${info.owner}` });
    } else if (ownerProgram) {
      top.push({ ...base, category: 'program', label: null,
        basis: `Owner is a data account owned by program ${ownerProgram} (a program this reader does not name)` });
    } else {
      top.push({ ...base, category: 'pda', label: null,
        basis: 'Owner is a program-derived address (PDA), and the program could not be identified' });
    }
  }

  // 6) Tally
  const categoryPercent: Record<HolderCategory, number> = { pool: 0, lock: 0, wallet: 0, program: 0, pda: 0 };
  const catAmount: Record<HolderCategory, bigint> = { pool: 0n, lock: 0n, wallet: 0n, program: 0n, pda: 0n };
  for (const [i, h] of top.entries()) catAmount[h.category] += tokenAccounts[i].amount;
  for (const k of Object.keys(catAmount) as HolderCategory[]) categoryPercent[k] = percentOf(catAmount[k], supply);

  const top10Amount = tokenAccounts.slice(0, 10).reduce((s, t) => s + t.amount, 0n);

  type Agg = { owner: string; category: HolderCategory; ownerProgram: string | null; amount: bigint; tokenAccounts: string[] };
  const aggregate = (cats: HolderCategory[]): Agg[] => {
    const byOwner = new Map<string, Agg>();
    for (const [i, h] of top.entries()) {
      if (!cats.includes(h.category)) continue;
      const e = byOwner.get(h.owner) ?? { owner: h.owner, category: h.category, ownerProgram: h.ownerProgram, amount: 0n, tokenAccounts: [] };
      e.amount += tokenAccounts[i].amount;
      e.tokenAccounts.push(h.tokenAccount);
      byOwner.set(h.owner, e);
    }
    return [...byOwner.values()]
      .filter((e) => e.amount > 0n)
      .sort((x, y) => (y.amount > x.amount ? 1 : y.amount < x.amount ? -1 : 0));
  };
  const excludingPoolsAndLocksTop5 = aggregate(['wallet'])
    .slice(0, 5)
    .map((e) => ({ owner: e.owner, category: e.category, percent: percentOf(e.amount, supply), tokenAccounts: e.tokenAccounts }));
  const unsupportedProgramAccounts = aggregate(['program', 'pda']).map((e) => ({
    owner: e.owner,
    category: e.category,
    ownerProgram: e.ownerProgram,
    percent: percentOf(e.amount, supply),
    tokenAccounts: e.tokenAccounts,
  }));

  notes.push(
    `Only the ${tokenAccounts.length} largest token accounts were examined (${method}). Other accounts are not included in the classification`,
    'The classification is based on the form of the token account owner address (on-curve or PDA) and its owner program. Whether it is an actual user or exchange is unknown',
    'excludingPoolsAndLocksTop5 merges only on-curve addresses (wallets) by owner',
  );
  if (unsupportedProgramAccounts.length) {
    notes.push('unsupportedProgramAccounts are accounts owned by programs this reader does not support (other DEXes, lockups, multisigs, etc.). They are shown separately because whether they are pools or lockups was not checked (unavailable)');
  }

  return {
    mint,
    checkedAt: now().toISOString(),
    slot: snap.slot,
    method,
    supply: supply.toString(),
    decimals: decoded.decimals,
    accountsExamined: tokenAccounts.length,
    top,
    top10Percent: percentOf(top10Amount, supply),
    categoryPercent: Object.fromEntries(Object.entries(categoryPercent).map(([k, v]) => [k, round6(v)])) as Record<HolderCategory, number>,
    excludingPoolsAndLocksTop5,
    unsupportedProgramAccounts,
    evidence,
    notes,
  };
}
