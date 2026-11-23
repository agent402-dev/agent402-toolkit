// Agent402 Bond signing tools for a buyer agent: open (sign the seller's open transaction), confirm + pay, settle + claims.
// Every rule is checked before signing. Defaults refuse everything: no sellers allowed and no per-deal cap until the user sets them.
// Bond outflows (deposit, balance) count toward the wallet's daily USDC cap and daily payment count, like x402 payments.
import { getPublicKeyFromAddress, verifySignature, type Address, type SignatureBytes } from '@solana/kit';
import { buyerDeadline, settlePreview } from '@agent402-dev/bond-client/rules';
import { BOND_PROGRAM, type BondStatusDeps, decodeDealAccount } from './bond.js';
import {
  assemble, compileMessage, confirmIx, dealPda, decodeOpenData, type DealKeys, type Ix, openIx, parseTx, payIx, settleAndClaimIxs,
  TOKEN_PROGRAM, txId,
} from './bond-tx.js';
import type { History, HistoryEntry } from './history.js';
import type { PayPolicy } from './policy.js';
import { formatUnits } from './units.js';

export interface BondPolicy {
  /** Sellers this wallet may open deals with. Empty = refuse all */
  sellers: string[];
  /** Max price per deal (USD). null = not set → refuse all */
  maxPriceUsd: number | null;
  /** Minimum seller bond as a share of the price (basis points). Default 500 = 5% */
  minBondBps: bigint;
  /** Max days from now to the delivery deadline. Default 30 */
  maxDays: number;
  /** Ask a human when the amount leaving the wallet is at or above this (USD). Default 0 = always ask */
  confirmAboveUsd: number;
}
export interface BondPolicyEnv {
  X402_BOND_SELLERS?: string;
  X402_BOND_MAX_USD?: string;
  X402_BOND_MIN_SELLER_BOND_BPS?: string;
  X402_BOND_MAX_DAYS?: string;
  X402_BOND_CONFIRM_ABOVE_USD?: string;
}
export function bondPolicyFromEnv(env: BondPolicyEnv): BondPolicy {
  const pos = (s: string | undefined) => (s && Number(s) > 0 ? Number(s) : null);
  return {
    sellers: (env.X402_BOND_SELLERS ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    maxPriceUsd: pos(env.X402_BOND_MAX_USD),
    minBondBps: env.X402_BOND_MIN_SELLER_BOND_BPS && /^\d+$/.test(env.X402_BOND_MIN_SELLER_BOND_BPS) ? BigInt(env.X402_BOND_MIN_SELLER_BOND_BPS) : 500n,
    maxDays: pos(env.X402_BOND_MAX_DAYS) ?? 30,
    confirmAboveUsd: env.X402_BOND_CONFIRM_ABOVE_USD && Number(env.X402_BOND_CONFIRM_ABOVE_USD) >= 0 ? Number(env.X402_BOND_CONFIRM_ABOVE_USD) : 0,
  };
}

/** Minimal Solana RPC used by the signing tools. */
export interface BondRpc {
  latestBlockhash(): Promise<string>;
  /** Sends base64 wire bytes, waits for "confirmed"; returns the signature or throws with the error */
  sendAndConfirm(tx: Uint8Array): Promise<string>;
}
export function bondRpc(url: string, f: typeof fetch = fetch): BondRpc {
  const call = async (method: string, params: unknown[]) => {
    const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = (await r.json()) as { result?: unknown; error?: { message: string } };
    if (j.error || j.result === undefined) throw new Error(`rpc ${method}: ${j.error?.message ?? r.status}`);
    return j.result;
  };
  return {
    async latestBlockhash() { return ((await call('getLatestBlockhash', [{ commitment: 'confirmed' }])) as { value: { blockhash: string } }).value.blockhash; },
    async sendAndConfirm(tx) {
      const sig = (await call('sendTransaction', [Buffer.from(tx).toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }])) as string;
      for (let i = 0; i < 90; i++) {
        const st = ((await call('getSignatureStatuses', [[sig]])) as { value: ({ err: unknown; confirmationStatus?: string } | null)[] }).value[0];
        if (st?.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(st.err)}`);
        if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return sig;
        await new Promise((res) => setTimeout(res, 1000));
      }
      throw new Error(`transaction ${sig} not confirmed in time (it may still land; check before retrying)`);
    },
  };
}

export type Confirm = (message: string) => Promise<'accept' | 'decline' | 'unsupported'>;
export interface BondSignDeps extends BondStatusDeps {
  policy: PayPolicy;
  bond: BondPolicy;
  /** Wallet address and a raw ed25519 signer over message bytes. Null = no wallet configured */
  signer: { address: string; signBytes(message: Uint8Array): Promise<Uint8Array> } | null;
  rpc: BondRpc;
  history: History;
  confirm: Confirm;
  now?: () => Date;
}

type Refused = { result: 'refused'; reasons: string[] } | { result: 'declined_by_user' | 'confirmation_required'; message: string };
const usdc = (v: bigint) => formatUnits(v, 'USDC');
const toUsd = (v: bigint) => Number(v) / 1e6;

function record(d: BondSignDeps, action: string, deal: string, e: Partial<HistoryEntry>) {
  d.history.add({ at: (d.now?.() ?? new Date()).toISOString(), url: `bond:${action}:${deal}`, host: 'agent402-bond', network: d.policy.network, mint: d.policy.mints.USDC, signed: false, result: 'refused', ...e });
}

/** Daily cap and payment count, shared with x402 payments. */
function dailyCheck(d: BondSignDeps, amount: bigint): string[] {
  const t = d.history.today(d.now?.());
  const out: string[] = [];
  if (t.count + 1 > d.policy.maxPaymentsPerDay) out.push(`daily payment count reached (${d.policy.maxPaymentsPerDay}, X402_MAX_PAYMENTS_PER_DAY)`);
  if (t.usd + toUsd(amount) > d.policy.maxUsdPerDay + 1e-9) out.push(`daily USDC cap: ${t.usd} USD used + ${toUsd(amount)} USD > ${d.policy.maxUsdPerDay} USD (X402_MAX_USD_PER_DAY)`);
  return out;
}

async function askHuman(d: BondSignDeps, amount: bigint, text: string): Promise<Refused | null> {
  if (toUsd(amount) < d.bond.confirmAboveUsd) return null;
  const a = await d.confirm(text);
  if (a === 'accept') return null;
  if (a === 'unsupported') return { result: 'confirmation_required', message: 'This needs human confirmation (X402_BOND_CONFIRM_ABOVE_USD) but the MCP client cannot ask. Nothing was signed.' };
  return { result: 'declined_by_user', message: 'Declined by the user. Nothing was signed.' };
}

/**
 * bond_open: the seller built an `open` transaction and signed it as fee payer; the buyer (this wallet) adds its signature.
 * The instruction is rebuilt from its own decoded terms and the wallet address, and must match byte for byte.
 */
export async function bondOpen(d: BondSignDeps, txBase64: string) {
  if (!d.signer) return { result: 'refused' as const, reasons: ['no wallet configured (X402_KEYPAIR_PATH)'] };
  const me = d.signer.address;
  let bytes: Uint8Array;
  let p: ReturnType<typeof parseTx>;
  try { bytes = Uint8Array.from(Buffer.from(txBase64, 'base64')); p = parseTx(bytes); } catch (e) { return { result: 'refused' as const, reasons: [`not a valid legacy transaction: ${(e as Error).message}`] }; }

  // Shape: exactly one Agent402 Bond `open`, two signers (seller pays fees and rent, this wallet), nothing else.
  const reasons: string[] = [];
  if (p.instructions.length !== 1) reasons.push(`expected exactly 1 instruction, got ${p.instructions.length}`);
  const ixIn = p.instructions[0];
  const decoded = ixIn && ixIn.programId === BOND_PROGRAM ? decodeOpenData(ixIn.data) : null;
  if (!decoded) reasons.push('the instruction is not an Agent402 Bond open');
  if (p.header.numRequiredSignatures !== 2) reasons.push('expected exactly 2 signers (seller and buyer)');
  if (reasons.length) { record(d, 'open', '-', { reasons }); return { result: 'refused' as const, reasons }; }
  const seller = p.keys[0];
  const { nonce, terms: t } = decoded!;
  // The seller (fee payer) must already have signed this exact message; otherwise sending would only fail.
  try {
    const ok = await verifySignature(await getPublicKeyFromAddress(seller as Address), p.signatures[0] as SignatureBytes, p.message);
    if (!ok) reasons.push('the seller signature is missing or invalid');
  } catch { reasons.push('the seller signature is missing or invalid'); }
  const keys: DealKeys = { seller, buyer: me, mint: d.policy.mints.USDC, tokenProgram: TOKEN_PROGRAM, nonce };
  const deal = await dealPda(seller, me, nonce);
  const expected = await openIx(keys, t);
  const same = ixIn.keys.length === expected.keys.length
    && ixIn.keys.every((k, i) => k.pubkey === expected.keys[i].pubkey && k.isSigner === expected.keys[i].isSigner && k.isWritable === expected.keys[i].isWritable)
    && Buffer.from(ixIn.data).equals(Buffer.from(expected.data));
  if (!same) reasons.push('the open instruction does not match the one rebuilt for this wallet (accounts, mint, token program or data differ)');
  if (p.keys.indexOf(me) !== 1) reasons.push('this wallet must be the second signer');

  // Policy
  const now = await d.clock();
  if (!d.bond.sellers.includes(seller)) reasons.push(`seller ${seller} is not in X402_BOND_SELLERS`);
  if (d.bond.maxPriceUsd === null) reasons.push('X402_BOND_MAX_USD is not set');
  else if (toUsd(t.price) > d.bond.maxPriceUsd) reasons.push(`price ${usdc(t.price)} is above X402_BOND_MAX_USD (${d.bond.maxPriceUsd} USD)`);
  if (t.sellerBond * 10_000n < t.price * d.bond.minBondBps) reasons.push(`seller bond ${usdc(t.sellerBond)} is below ${Number(d.bond.minBondBps) / 100}% of the price`);
  if (t.buyerDeposit > t.price) reasons.push('deposit is larger than the price');
  if (t.deliverBy <= now) reasons.push('delivery deadline is in the past');
  else if (t.deliverBy - now > BigInt(Math.round(d.bond.maxDays * 86_400))) reasons.push(`delivery deadline is more than ${d.bond.maxDays} days away (X402_BOND_MAX_DAYS)`);
  if (toUsd(t.price - t.buyerDeposit) > d.policy.maxUsdPerDay) reasons.push('the balance alone is above the daily USDC cap, so it could never be paid');
  reasons.push(...dailyCheck(d, t.buyerDeposit));
  if (reasons.length) { record(d, 'open', deal, { amount: t.buyerDeposit.toString(), payTo: seller, reasons }); return { result: 'refused' as const, deal, reasons }; }

  const summary = `Open an Agent402 Bond deal with seller ${seller}: price ${usdc(t.price)}, your deposit ${usdc(t.buyerDeposit)} now, balance ${usdc(t.price - t.buyerDeposit)} after you confirm receipt. Seller bond ${usdc(t.sellerBond)}. Delivery by ${new Date(Number(t.deliverBy) * 1000).toISOString()}.`;
  const h = await askHuman(d, t.price, summary);
  if (h) { record(d, 'open', deal, { amount: t.buyerDeposit.toString(), payTo: seller, result: h.result === 'declined_by_user' ? 'declined_by_user' : 'confirmation_required' }); return { ...h, deal }; }

  const sig = await d.signer.signBytes(p.message);
  const signed = assemble(p.message, [p.signatures[0], sig]);
  try {
    const id = await d.rpc.sendAndConfirm(signed);
    record(d, 'open', deal, { amount: t.buyerDeposit.toString(), payTo: seller, signed: true, result: 'paid', settlementTx: id });
    return { result: 'opened' as const, deal, transaction: id, deposit: usdc(t.buyerDeposit), balanceLater: usdc(t.price - t.buyerDeposit), deliverBy: new Date(Number(t.deliverBy) * 1000).toISOString() };
  } catch (e) {
    record(d, 'open', deal, { amount: t.buyerDeposit.toString(), payTo: seller, signed: true, result: 'failed', reasons: [(e as Error).message] });
    return { result: 'failed' as const, deal, reasons: [(e as Error).message] };
  }
}

async function readDeal(d: BondSignDeps, deal: string) {
  const [acc] = await d.accounts([deal]);
  if (!acc || acc.owner !== BOND_PROGRAM) return null;
  return decodeDealAccount(acc.data);
}

async function signAndSend(d: BondSignDeps, ixs: Ix[]) {
  const { message, signers } = compileMessage(d.signer!.address, ixs, await d.rpc.latestBlockhash());
  if (signers.length !== 1) throw new Error('unexpected extra signer');
  const sig = await d.signer!.signBytes(message);
  return { id: txId(sig), send: () => d.rpc.sendAndConfirm(assemble(message, [sig])) };
}

/** bond_confirm_and_pay: confirm receipt and pay the balance straight to the seller (buyer only). */
export async function bondConfirmAndPay(d: BondSignDeps, deal: string) {
  if (!d.signer) return { result: 'refused' as const, reasons: ['no wallet configured (X402_KEYPAIR_PATH)'] };
  const a = await readDeal(d, deal);
  if (!a) return { result: 'refused' as const, reasons: ['not an open Agent402 Bond deal'] };
  const reasons: string[] = [];
  const now = await d.clock();
  if (a.buyer !== d.signer.address) reasons.push('this wallet is not the buyer of this deal');
  if (a.outcome !== 'open') reasons.push(`deal is already decided (${a.outcome})`);
  if (a.buyerConfirm !== null) reasons.push('already confirmed');
  if (a.mint !== d.policy.mints.USDC) reasons.push('only USDC deals are supported');
  if (now > buyerDeadline(a)) reasons.push('the buyer deadline has passed');
  const balance = a.terms.price - a.terms.buyerDeposit;
  reasons.push(...dailyCheck(d, balance));
  if (reasons.length) { record(d, 'confirm_and_pay', deal, { amount: balance.toString(), payTo: a.seller, reasons }); return { result: 'refused' as const, deal, reasons }; }

  // Confirming transfers the whole price to the seller (the locked deposit and the balance), so the threshold is the price.
  const h = await askHuman(d, a.terms.price,
    `Confirm receipt for Agent402 Bond deal ${deal}: this pays the balance ${usdc(balance)} now and releases your locked deposit ${usdc(a.terms.buyerDeposit)} to seller ${a.seller} (total ${usdc(a.terms.price)}). Only confirm if you received what was agreed: the program does not judge quality.`);
  if (h) { record(d, 'confirm_and_pay', deal, { amount: balance.toString(), payTo: a.seller, result: h.result === 'declined_by_user' ? 'declined_by_user' : 'confirmation_required' }); return { ...h, deal }; }

  const keys: DealKeys = { seller: a.seller, buyer: a.buyer, mint: a.mint, tokenProgram: TOKEN_PROGRAM, nonce: a.nonce };
  const ixs = [confirmIx(a.buyer, deal), ...(balance > 0n ? [await payIx(keys, deal)] : [])];
  const tx = await signAndSend(d, ixs);
  try {
    const id = await tx.send();
    record(d, 'confirm_and_pay', deal, { amount: balance.toString(), payTo: a.seller, signed: true, result: 'paid', settlementTx: id });
    return { result: 'confirmed_and_paid' as const, deal, transaction: id, paid: usdc(balance), next: 'Anyone may now settle (bond_settle).' };
  } catch (e) {
    record(d, 'confirm_and_pay', deal, { amount: balance.toString(), payTo: a.seller, signed: true, result: 'failed', reasons: [(e as Error).message] });
    return { result: 'failed' as const, deal, reasons: [(e as Error).message] };
  }
}

/** bond_settle: settle a deal whose outcome is fixed and send both claims (this wallet pays only the network fee). */
export async function bondSettle(d: BondSignDeps, deal: string) {
  if (!d.signer) return { result: 'refused' as const, reasons: ['no wallet configured (X402_KEYPAIR_PATH)'] };
  const a = await readDeal(d, deal);
  if (!a) return { result: 'refused' as const, reasons: ['not an open Agent402 Bond deal (already closed?)'] };
  const me = d.signer.address;
  if (me !== a.buyer && me !== a.seller) return { result: 'refused' as const, deal, reasons: ['this wallet is neither buyer nor seller of this deal'] };
  if (a.mint !== d.policy.mints.USDC) return { result: 'refused' as const, deal, reasons: ['only USDC deals are supported by these tools'] };
  const keys: DealKeys = { seller: a.seller, buyer: a.buyer, mint: a.mint, tokenProgram: TOKEN_PROGRAM, nonce: a.nonce };
  const [settleIx, claimBuyerIx, claimSellerIx] = await settleAndClaimIxs(keys, deal);
  const mine = me === a.buyer ? claimBuyerIx : claimSellerIx;
  const preview = a.outcome === 'open' ? settlePreview(a, await d.clock()) : null;
  if (a.outcome === 'open' && !preview) return { result: 'refused' as const, deal, reasons: ['not settleable yet (see bond_deal_status for the earliest time)'] };
  // Normal path: settle (if still open) and both claims. If the other side's token account is closed or frozen,
  // that fails in simulation (no fee): then send only settle and this wallet's own claim.
  const head = a.outcome === 'open' ? [settleIx] : [];
  const attempts = [[...head, claimBuyerIx, claimSellerIx], [...head, mine]];
  const errors: string[] = [];
  for (const ixs of attempts) {
    const tx = await signAndSend(d, ixs);
    try {
      const id = await tx.send();
      record(d, 'settle', deal, { amount: '0', payTo: a.seller, signed: true, result: 'paid', settlementTx: id });
      return {
        result: 'settled' as const, deal, transaction: id, outcome: preview?.outcome ?? a.outcome,
        ...(preview ? { toSeller: usdc(preview.toSeller), toBuyer: usdc(preview.toBuyer) } : {}),
        ...(ixs.length < attempts[0].length ? { note: 'Only your own share was claimed; the other side can claim theirs later.' } : {}),
      };
    } catch (e) { errors.push((e as Error).message); }
  }
  record(d, 'settle', deal, { amount: '0', payTo: a.seller, signed: true, result: 'failed', reasons: errors });
  return { result: 'failed' as const, deal, reasons: errors };
}
