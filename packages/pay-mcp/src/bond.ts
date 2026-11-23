// Agent402 Bond, read-only: decode a deal account and explain its deadlines, possible actions and settlement.
// Never signs. Deadlines and settlement come from the program's rules (ported in @agent402-dev/bond-client/rules);
// the program on chain is the source of truth.
import { getBase58Decoder } from '@solana/kit';
import { buyerDeadline, lateDeduction, possibleActions, type RuleDeal, settleBy, settleableFrom, settlePreview, t2 } from '@agent402-dev/bond-client/rules';
import type { AccountsFetcher } from './locks.js';
import { formatUnits } from './units.js';

export const BOND_PROGRAM = '9hiCZZ6ddFG9oJBR1Su43Pj4JRFHeHC5cGiCgXtTuAaK';
/** sha256("account:Deal")[..8] */
export const DEAL_DISCRIMINATOR = [125, 223, 160, 234, 71, 162, 182, 219];
const DEAL_SIZE = 8 + 32 * 3 + 8 * 4 + 8 * 6 + 1 + 2 + 1 + 8;
const OUTCOMES = ['open', 'delivered', 'buyer_default', 'disputed', 'seller_default', 'cancelled'] as const;

/** Mints the program accepts on mainnet (symbol, decimals). */
export const BOND_MINTS: Record<string, { symbol: string; decimals: number }> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', decimals: 6 },
  So11111111111111111111111111111111111111112: { symbol: 'wSOL', decimals: 9 },
  aTbGw3gU5JyJkAdXLj8rYZ3mCXkPbyHjtTAyCX3jQLX: { symbol: 'PREQ', decimals: 6 },
  // devnet USDC (Circle)
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU': { symbol: 'USDC', decimals: 6 },
};

export interface DealAccount extends RuleDeal {
  seller: string;
  buyer: string;
  mint: string;
  nonce: bigint;
  outcome: (typeof OUTCOMES)[number];
  owedSeller: bigint;
}

/** Decodes a Deal account (Anchor layout). Null if the bytes are not a Deal. */
export function decodeDealAccount(data: Uint8Array): DealAccount | null {
  if (data.length < DEAL_SIZE || DEAL_DISCRIMINATOR.some((b, i) => data[i] !== b)) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const b58 = getBase58Decoder();
  let o = 8;
  const key = () => b58.decode(data.subarray(o, (o += 32)));
  const u64 = () => { const x = v.getBigUint64(o, true); o += 8; return x; };
  const i64 = () => { const x = v.getBigInt64(o, true); o += 8; return x; };
  const seller = key(), buyer = key(), mint = key();
  const nonce = u64(), price = u64(), sellerBond = u64(), buyerDeposit = u64();
  const deliverBy = i64(), lateWindow = i64(), payWindow = i64(), openedAt = i64(), mark = i64(), confirm = i64();
  const balancePaid = data[o++] === 1;
  o += 2; // bump, vault_bump
  const outcome = OUTCOMES[data[o++]] ?? 'open';
  const owedSeller = u64();
  return {
    seller, buyer, mint, nonce, outcome, owedSeller, openedAt, balancePaid,
    terms: { price, sellerBond, buyerDeposit, deliverBy, lateWindow, payWindow },
    sellerMark: mark === 0n ? null : mark,
    buyerConfirm: confirm === 0n ? null : confirm,
  };
}

/** Solana clock via the RPC: the Clock sysvar (what the program uses), falling back to getSlot + getBlockTime. */
export function rpcClock(rpcUrl: string, f: typeof fetch = fetch): () => Promise<bigint> {
  const call = async (method: string, params: unknown[]) => {
    const r = await f(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = (await r.json()) as { result?: unknown; error?: { message: string } };
    if (j.result === undefined || j.result === null) throw new Error(`rpc ${method}: ${j.error?.message ?? r.status}`);
    return j.result;
  };
  return async () => {
    try {
      const v = (await call('getAccountInfo', ['SysvarC1ock11111111111111111111111111111111', { encoding: 'base64', commitment: 'confirmed' }])) as { value: { data: [string, string] } | null };
      if (v.value) {
        const b = Uint8Array.from(atob(v.value.data[0]), (c) => c.charCodeAt(0));
        if (b.length >= 40) return new DataView(b.buffer).getBigInt64(32, true);
      }
    } catch { /* fall back */ }
    return BigInt((await call('getBlockTime', [await call('getSlot', [{ commitment: 'confirmed' }])])) as number);
  };
}

const iso = (t: bigint) => new Date(Number(t) * 1000).toISOString();

export interface BondStatusDeps { accounts: AccountsFetcher; clock: () => Promise<bigint>; wallet?: string | null }

/** bond_deal_status: facts about one deal account, with amounts in units and times in ISO (Solana clock). */
export async function bondDealStatus(d: BondStatusDeps, deal: string) {
  const [acc] = await d.accounts([deal]);
  if (!acc) return { result: 'not_found' as const, message: 'No account at this address. A settled deal is closed once both sides have claimed.' };
  if (acc.owner !== BOND_PROGRAM) return { result: 'not_a_deal' as const, message: `This account is not owned by the Agent402 Bond program (${BOND_PROGRAM}).` };
  const a = decodeDealAccount(acc.data);
  if (!a) return { result: 'not_a_deal' as const, message: 'This account is not an Agent402 Bond deal.' };
  const now = await d.clock();
  const m = BOND_MINTS[a.mint] ?? { symbol: 'tokens', decimals: 0 };
  const amt = (v: bigint) => ({ atomic: v.toString(), display: formatUnits(v, m.symbol, m.decimals) });
  const time = (t: bigint | null) => (t === null ? null : { unix: t.toString(), iso: iso(t) });
  const role = d.wallet === a.buyer ? 'buyer' : d.wallet === a.seller ? 'seller' : null;
  const base = {
    deal, program: BOND_PROGRAM, seller: a.seller, buyer: a.buyer, ...(role ? { yourRole: role } : {}),
    asset: { mint: a.mint, symbol: m.symbol, decimals: m.decimals },
    price: amt(a.terms.price), sellerBond: amt(a.terms.sellerBond), buyerDeposit: amt(a.terms.buyerDeposit),
    balanceToPay: amt(a.terms.price - a.terms.buyerDeposit),
    openedAt: time(a.openedAt), deliverBy: time(a.terms.deliverBy),
    sellerMarkedAt: time(a.sellerMark), buyerConfirmedAt: time(a.buyerConfirm), balancePaid: a.balancePaid,
    clock: time(now),
  };
  if (a.outcome !== 'open') {
    return {
      result: 'settled' as const, ...base, outcome: a.outcome,
      owedToSeller: amt(a.owedSeller),
      note: 'Settled. Each side claims its own share (claim_buyer, then claim_seller); anyone may send the claims.',
    };
  }
  const preview = settlePreview(a, now);
  const from = settleableFrom(a, now);
  return {
    result: 'open' as const, ...base,
    deadlines: { lateUntil: time(t2(a.terms)), buyerConfirmOrPayUntil: time(buyerDeadline(a)), settleableBy: time(settleBy(a)) },
    // What the bond loses to lateness if the buyer confirmed now (delivery time = the seller mark, or now)
    lateDeductionIfConfirmed: amt(lateDeduction({ ...a, buyerConfirm: a.buyerConfirm ?? now })),
    possibleActions: possibleActions(a, now).map((x) => ({ action: x.action, who: x.who, ...(x.until !== undefined ? { until: iso(x.until) } : {}) })),
    settlement: preview
      ? { now: true, outcome: preview.outcome, toSeller: amt(preview.toSeller), toBuyer: amt(preview.toBuyer) }
      : { now: false, earliest: from === null ? null : iso(from), note: 'Not settleable yet. If nobody acts, settlement opens at "earliest".' },
    notes: [
      'Predicted from the program rules; the program on chain decides. The program does not judge quality; quality disputes are resolved between the parties.',
      'Never send tokens directly to a deal vault: anything beyond the locked amount is paid to the buyer.',
    ],
  };
}
