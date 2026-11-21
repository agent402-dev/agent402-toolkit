import { PublicKey } from '@solana/web3.js';
import type { ChainReader, HistoryReader, SignatureInfo, TxRecord } from '../chain.js';
import { decodeMint } from '../mint.js';
import { DISCLAIMER_EN, MintNotFoundError } from '../summary.js';
import { percentOf } from '../holders/index.js';
import { findSupportedPools, tokenBalances, type Dex, type PoolCandidate } from '../liquidity/pools.js';

export interface EarlyBuyer {
  /** Owner address of the account that received the token */
  wallet: string;
  /** Whether the address is on-curve (signs with a private key). false means a program-derived address (PDA) */
  onCurve: boolean;
  /** Total received through swaps with the pool in the window (base units) */
  bought: string;
  boughtPercentOfSupply: number;
  /** Total given through swaps with the same pool in the window (liquidity additions not included) */
  soldInWindow: string;
  /** bought − soldInWindow (0 if negative) */
  netBought: string;
  netBoughtPercentOfSupply: number;
  /** Amount of this token added as liquidity to the same pool in the window */
  addedToLiquidity: string;
  /** Amount of this token received by removing liquidity from the same pool in the window */
  removedFromLiquidity: string;
  firstBuySlot: number;
  firstBuyTime: string;
  /** Seconds from trading start to the first buy */
  secondsAfterStart: number;
  buyCount: number;
  /** Evidence transactions (up to 5) */
  txs: string[];
}

export interface EarlyBuysReport {
  mint: string;
  checkedAt: string;
  /** complete: all trades in the window checked / partial: only some / unverifiable: could not check */
  status: 'complete' | 'partial' | 'unverifiable';
  dex: Dex | null;
  pool: string | null;
  poolCreatedAt: string | null;
  poolCreationSlot: number | null;
  poolCreationTx: string | null;
  /** The later of the trading start recorded in the pool (activation / open_time) and the pool creation time */
  tradingStart: string | null;
  /** Block where trading first opened (when the trading start is later than pool creation). Otherwise the pool creation block */
  tradingOpenSlot: number | null;
  windowMinutes: number;
  /** Number of addresses that received the token through swaps with the pool in the window */
  wallets: number;
  /** Sum of (buys − sells in the same window) for those addresses, as % of supply. Liquidity additions and removals are not counted */
  supplyPercent: number;
  /** Total bought without subtracting sells, as % of supply */
  grossSupplyPercent: number;
  /** This token added as liquidity to the same pool by buying addresses in the window, as % of supply */
  liquidityAddedPercent: number;
  /** This token received by buying addresses from removing liquidity in the same pool in the window, as % of supply */
  liquidityRemovedPercent: number;
  /** Whether there was a buy in the sameBlockBasis block. null if that block could not be determined */
  sameBlock: boolean | null;
  /** trading-open-block: block where trading first opened / pool-creation-block: pool creation block */
  sameBlockBasis: 'trading-open-block' | 'pool-creation-block';
  buysInSameBlock: number;
  /** Cases where two or more different addresses bought in the same slot */
  sameSlotGroups: { slot: number; wallets: string[] }[];
  firstTradeSlot: number | null;
  /** Number of addresses that bought in the slot of the first buy */
  walletsInFirstTradeSlot: number;
  /** Cumulative per minute after the start (buys − sells) */
  cumulativeByMinute: { minute: number; wallets: number; supplyPercent: number }[];
  buyers: EarlyBuyer[];
  /** Counts of window transactions classified relative to this pool */
  activity: { buys: number; sells: number; liquidityAdds: number; liquidityRemoves: number; other: number };
  stats: { signaturesScanned: number; transactionsInWindow: number; transactionsParsed: number; transactionsUnreadable: number };
  /** Scope of the check (as is): limits and amounts actually read. Explains in numbers why status is partial or unverifiable */
  coverage: {
    /** Trades read in the window / all trades in the window (total is null if pool history was not read to the end) */
    transactionsRead: number;
    transactionsInWindow: number | null;
    maxTransactions: number;
    /** Signatures walked back / limit */
    signaturesScanned: number;
    maxSignatures: number;
    reachedPoolCreation: boolean;
  };
  evidence: { account: string; role: string }[];
  notes: string[];
}

export interface EarlyBuysOptions {
  windowMinutes?: number;
  /** A specific pool. If not set, the supported pool with the largest balance of this token */
  pool?: string;
  /** Maximum pages to walk back through pool signatures (1 page = 1000 entries) */
  maxSignaturePages?: number;
  /** Maximum transactions to read in the window */
  maxTransactions?: number;
  now?: () => Date;
}

const iso = (sec: number | null) => (sec === null ? '' : new Date(sec * 1000).toISOString());
/** Maximum range getBlocks can query at once */
const MAX_BLOCK_RANGE = 500_000;

function deltas(tx: TxRecord, mint: string) {
  const m = new Map<number, { owner: string | null; pre: bigint; post: bigint }>();
  for (const b of tx.preTokenBalances) if (b.mint === mint) m.set(b.accountIndex, { owner: b.owner, pre: BigInt(b.amount), post: 0n });
  for (const b of tx.postTokenBalances) {
    if (b.mint !== mint) continue;
    const e = m.get(b.accountIndex) ?? { owner: b.owner, pre: 0n, post: 0n };
    e.post = BigInt(b.amount);
    e.owner = e.owner ?? b.owner;
    m.set(b.accountIndex, e);
  }
  return [...m.entries()].map(([i, e]) => ({ account: tx.accountKeys[i], owner: e.owner, delta: e.post - e.pre }));
}

export type PoolActivityKind = 'buy' | 'sell' | 'add-liquidity' | 'remove-liquidity' | 'other' | 'none';

export interface PoolSide {
  mint: string;
  vault: string;
  pairMint: string;
  pairVault: string;
  /** Vault owner (pool authority): excluded from the receiving and giving tallies */
  poolAuthority: string | null;
}

/**
  * Classifies one transaction by the movement of this pool's two vaults, and returns the amount of this token moved per owner.
  *  this token vault ↓, paired vault ↑ → buy     (owner whose balance rose = buyer)
  *  this token vault ↑, paired vault ↓ → sell    (owner whose balance fell = seller)
  *  both ↑                           → add-liquidity    (owner whose balance fell = adder)
  *  both ↓                           → remove-liquidity (owner whose balance rose = remover)
  *  only one moves                   → other (fee claims, etc. Not counted as a buy or sell)
 */
export function analyzeSwap(tx: TxRecord, side: PoolSide) {
  const ours = deltas(tx, side.mint);
  const vaultDelta = ours.find((d) => d.account === side.vault)?.delta ?? 0n;
  const pairDelta = deltas(tx, side.pairMint).find((d) => d.account === side.pairVault)?.delta ?? 0n;

  let kind: PoolActivityKind;
  if (vaultDelta === 0n) kind = 'none';
  else if (vaultDelta < 0n && pairDelta > 0n) kind = 'buy';
  else if (vaultDelta > 0n && pairDelta < 0n) kind = 'sell';
  else if (vaultDelta > 0n && pairDelta > 0n) kind = 'add-liquidity';
  else if (vaultDelta < 0n && pairDelta < 0n) kind = 'remove-liquidity';
  else kind = 'other';

  const byOwner = new Map<string, bigint>();
  for (const d of ours) {
    if (d.account === side.vault || !d.owner || d.owner === side.poolAuthority) continue;
    byOwner.set(d.owner, (byOwner.get(d.owner) ?? 0n) + d.delta);
  }
  const gained = [...byOwner].filter(([, x]) => x > 0n);
  const spent = [...byOwner].filter(([, x]) => x < 0n).map(([o, x]) => [o, -x] as [string, bigint]);
  return {
    kind,
    vaultDelta,
    pairDelta,
    buys: kind === 'buy' ? gained : [],
    sells: kind === 'sell' ? spent : [],
    liquidityAdds: kind === 'add-liquidity' ? spent : [],
    liquidityRemoves: kind === 'remove-liquidity' ? gained : [],
  };
}

function unverifiable(mint: string, windowMinutes: number, now: Date, notes: string[], extra: Partial<EarlyBuysReport> = {}): EarlyBuysReport {
  return {
    mint, checkedAt: now.toISOString(), status: 'unverifiable', dex: null, pool: null, poolCreatedAt: null, poolCreationSlot: null,
    poolCreationTx: null, tradingStart: null, tradingOpenSlot: null, windowMinutes, wallets: 0, supplyPercent: 0, grossSupplyPercent: 0,
    liquidityAddedPercent: 0, liquidityRemovedPercent: 0, sameBlock: null, sameBlockBasis: 'pool-creation-block', buysInSameBlock: 0,
    sameSlotGroups: [], firstTradeSlot: null, walletsInFirstTradeSlot: 0, cumulativeByMinute: [], buyers: [],
    activity: { buys: 0, sells: 0, liquidityAdds: 0, liquidityRemoves: 0, other: 0 },
    stats: { signaturesScanned: 0, transactionsInWindow: 0, transactionsParsed: 0, transactionsUnreadable: 0 },
    coverage: { transactionsRead: 0, transactionsInWindow: null, maxTransactions: 0, signaturesScanned: 0, maxSignatures: 0, reachedPoolCreation: false },
    evidence: [{ account: mint, role: 'mint' }], notes, ...extra,
  };
}

/**
  * First confirmed block whose block time is at least t. null if the range is too large or not found.
  * Narrows the range by asking block times for up to K points at once (2 or 3 HTTP requests with RPC batching)
 */
async function firstBlockAtOrAfter(reader: HistoryReader, fromSlot: number, toSlot: number, t: number): Promise<number | null> {
  if (toSlot < fromSlot || toSlot - fromSlot > MAX_BLOCK_RANGE) return null;
  const slots = await reader.blocks(fromSlot, toSlot);
  // Points asked per step = RPC batch size (10), so one HTTP request per step
  const K = 10;
  // Invariant: every index < lo has time < t. hi is an index with time ≥ t, or slots.length (none yet)
  let lo = 0, hi = slots.length;
  while (lo < hi) {
    const len = hi - lo;
    const probes = len <= K
      ? Array.from({ length: len }, (_, k) => lo + k)
      : [...new Set(Array.from({ length: K }, (_, k) => lo + Math.floor((k * len) / K)))];
    const times = await Promise.all(probes.map((i) => reader.blockTime(slots[i])));
    if (times.some((x) => x === null)) return null;
    const j = times.findIndex((x) => x! >= t);
    if (j === -1) lo = probes[probes.length - 1] + 1;
    else { hi = probes[j]; if (j > 0) lo = probes[j - 1] + 1; }
  }
  return hi < slots.length ? slots[hi] : null;
}

export async function checkEarlyBuys(
  mintAddress: string,
  reader: ChainReader & HistoryReader,
  opts: EarlyBuysOptions = {},
): Promise<EarlyBuysReport> {
  const mint = new PublicKey(mintAddress).toBase58();
  const windowMinutes = opts.windowMinutes ?? 5;
  const maxPages = opts.maxSignaturePages ?? 20;
  const maxTx = opts.maxTransactions ?? 400;
  const now = (opts.now ?? (() => new Date()))();
  const notes: string[] = [DISCLAIMER_EN];

  const m = (await reader.fetch([mint])).accounts[0];
  if (!m) throw new MintNotFoundError(`account ${mint} not found`);
  const supply = decodeMint(m.data, new PublicKey(m.owner)).supply;

  // 1) Pick the pool
  const { candidates } = await findSupportedPools(mint, reader);
  const pool: PoolCandidate | undefined = opts.pool ? candidates.find((c) => c.address === opts.pool) : candidates[0];
  if (!pool) {
    notes.push('No pool for this token was found on supported DEXes (Meteora DAMM v2, Raydium CPMM) (unavailable)');
    return unverifiable(mint, windowMinutes, now, notes);
  }
  const vaultInfo = (await tokenBalances(reader, [pool.vault])).balances.get(pool.vault);
  const side: PoolSide = { mint, vault: pool.vault, pairMint: pool.pairMint, pairVault: pool.pairVault, poolAuthority: vaultInfo?.owner ?? null };

  // 2) Walk pool signatures back to creation
  const sigs: SignatureInfo[] = [];
  let before: string | undefined;
  let reachedStart = false;
  for (let page = 0; page < maxPages; page++) {
    const batch = await reader.signaturesForAddress(pool.address, { before, limit: 1000 });
    sigs.push(...batch);
    if (batch.length < 1000) { reachedStart = true; break; }
    before = batch[batch.length - 1].signature;
  }
  const base = { dex: pool.dex, pool: pool.address } as const;
  if (!reachedStart) {
    notes.push(`Walked back ${sigs.length} pool transactions from the latest (limit ${maxPages * 1000}) without reaching the trading start (unavailable)`);
    return unverifiable(mint, windowMinutes, now, notes, {
      ...base, stats: { signaturesScanned: sigs.length, transactionsInWindow: 0, transactionsParsed: 0, transactionsUnreadable: 0 },
      coverage: { transactionsRead: 0, transactionsInWindow: null, maxTransactions: maxTx, signaturesScanned: sigs.length, maxSignatures: maxPages * 1000, reachedPoolCreation: false },
    });
  }
  const chronological = [...sigs].reverse();
  const creation = chronological[0];
  const creationTime = creation.blockTime;

  // 3) Trading start time and the block where trading first opened
  //    If the start recorded in the pool is later than pool creation, use "block where trading first opened", otherwise "pool creation block"
  let startTime: number | null = creationTime;
  let delayedStart = false;
  let tradingOpenSlot: number | null = creation.slot;
  if (pool.activation.kind === 'timestamp') {
    const a = Number(pool.activation.value);
    if (creationTime !== null && a > creationTime) {
      delayedStart = true;
      startTime = a;
      const firstAfter = chronological.find((s) => s.blockTime !== null && s.blockTime >= a);
      tradingOpenSlot = await firstBlockAtOrAfter(reader, creation.slot, firstAfter?.slot ?? creation.slot + MAX_BLOCK_RANGE, a);
    }
  } else {
    const a = Number(pool.activation.value);
    if (a > creation.slot) {
      delayedStart = true;
      const open = await reader.blocks(a, a + 1000);
      tradingOpenSlot = open[0] ?? null;
      startTime = tradingOpenSlot !== null ? await reader.blockTime(tradingOpenSlot) : null;
    }
  }
  if (startTime === null) {
    notes.push('Could not determine the trading start time (unavailable)');
    return unverifiable(mint, windowMinutes, now, notes, base);
  }
  if (delayedStart && tradingOpenSlot === null) {
    notes.push('Could not determine the block where trading first opened, so sameBlock was not evaluated (unavailable)');
  }
  const end = startTime + windowMinutes * 60;

  // 4) Successful trades in the window (+ trades in the pool creation slot)
  const inWindow = chronological.filter(
    (s) => !s.err && s.signature !== creation.signature &&
      ((s.blockTime !== null && s.blockTime >= startTime! && s.blockTime < end) || s.slot === creation.slot),
  );
  const toRead = inWindow.slice(0, maxTx);
  const txs = await reader.transactions(toRead.map((s) => s.signature));
  const unreadable = txs.filter((t) => t === null).length;

  // 5) Tally
  type W = { bought: bigint; sold: bigint; added: bigint; removed: bigint; firstSlot: number; firstTime: number; count: number; txs: string[] };
  const buyers = new Map<string, W>();
  const sold = new Map<string, bigint>();
  const added = new Map<string, bigint>();
  const removed = new Map<string, bigint>();
  const activity = { buys: 0, sells: 0, liquidityAdds: 0, liquidityRemoves: 0, other: 0 };
  let firstTradeSlot: number | null = null;
  const events: { slot: number; time: number; wallet: string; amount: bigint }[] = [];
  const sellEvents: { time: number; wallet: string; amount: bigint }[] = [];
  const add = (map: Map<string, bigint>, o: string, x: bigint) => map.set(o, (map.get(o) ?? 0n) + x);

  for (const tx of txs) {
    if (!tx || tx.err) continue;
    const a = analyzeSwap(tx, side);
    const t = tx.blockTime ?? startTime;
    if (a.kind === 'buy') activity.buys++;
    else if (a.kind === 'sell') activity.sells++;
    else if (a.kind === 'add-liquidity') activity.liquidityAdds++;
    else if (a.kind === 'remove-liquidity') activity.liquidityRemoves++;
    else if (a.kind === 'other') activity.other++;
    for (const [o, x] of a.sells) { add(sold, o, x); sellEvents.push({ time: t, wallet: o, amount: x }); }
    for (const [o, x] of a.liquidityAdds) add(added, o, x);
    for (const [o, x] of a.liquidityRemoves) add(removed, o, x);
    for (const [owner, amount] of a.buys) {
      if (firstTradeSlot === null || tx.slot < firstTradeSlot) firstTradeSlot = tx.slot;
      events.push({ slot: tx.slot, time: t, wallet: owner, amount });
      const b = buyers.get(owner) ?? { bought: 0n, sold: 0n, added: 0n, removed: 0n, firstSlot: tx.slot, firstTime: t, count: 0, txs: [] };
      b.bought += amount;
      b.count++;
      if (tx.slot < b.firstSlot) { b.firstSlot = tx.slot; b.firstTime = t; }
      if (b.txs.length < 5) b.txs.push(tx.signature);
      buyers.set(owner, b);
    }
  }

  const net = (b: bigint, s: bigint) => (b > s ? b - s : 0n);
  const list: EarlyBuyer[] = [...buyers.entries()]
    .map(([wallet, b]) => {
      const s = sold.get(wallet) ?? 0n;
      return {
        wallet,
        onCurve: PublicKey.isOnCurve(new PublicKey(wallet).toBuffer()),
        bought: b.bought.toString(),
        boughtPercentOfSupply: percentOf(b.bought, supply),
        soldInWindow: s.toString(),
        netBought: net(b.bought, s).toString(),
        netBoughtPercentOfSupply: percentOf(net(b.bought, s), supply),
        addedToLiquidity: (added.get(wallet) ?? 0n).toString(),
        removedFromLiquidity: (removed.get(wallet) ?? 0n).toString(),
        firstBuySlot: b.firstSlot,
        firstBuyTime: iso(b.firstTime),
        secondsAfterStart: Math.max(0, b.firstTime - startTime!),
        buyCount: b.count,
        txs: b.txs,
      };
    })
    .sort((x, y) => (BigInt(y.bought) > BigInt(x.bought) ? 1 : BigInt(y.bought) < BigInt(x.bought) ? -1 : 0));

  const sumOf = (f: (b: EarlyBuyer) => string) => list.reduce((s, b) => s + BigInt(f(b)), 0n);
  const netBefore = (cut: number) => {
    const per = new Map<string, bigint>();
    for (const e of events) if (e.time < cut) per.set(e.wallet, (per.get(e.wallet) ?? 0n) + e.amount);
    let total = 0n;
    for (const [w, b] of per) total += net(b, sellEvents.filter((x) => x.wallet === w && x.time < cut).reduce((a, x) => a + x.amount, 0n));
    return { wallets: per.size, total };
  };
  const cumulativeByMinute = Array.from({ length: windowMinutes }, (_, i) => {
    const r = netBefore(startTime! + (i + 1) * 60);
    return { minute: i + 1, wallets: r.wallets, supplyPercent: percentOf(r.total, supply) };
  });
  const bySlot = new Map<number, Set<string>>();
  for (const e of events) bySlot.set(e.slot, (bySlot.get(e.slot) ?? new Set()).add(e.wallet));
  const sameSlotGroups = [...bySlot].filter(([, w]) => w.size >= 2).sort(([a], [b]) => a - b).map(([slot, w]) => ({ slot, wallets: [...w] }));
  const buysInSameBlock = tradingOpenSlot === null ? 0 : events.filter((e) => e.slot === tradingOpenSlot).length;

  const complete = inWindow.length <= maxTx && unreadable === 0;
  if (inWindow.length > maxTx) {
    notes.push(`Only the first ${maxTx} of ${inWindow.length} trades in the window (by time) were read (partial). Buyer count and share are based on these ${maxTx} trades`);
  }
  if (unreadable) notes.push(`${unreadable} transactions could not be read (partial)`);
  notes.push(
    'Trade classification: in one transaction, if this token vault decreases and the paired vault increases it is a buy, the reverse is a sell, both increasing is a liquidity addition, both decreasing is a liquidity removal, and only one moving is other (not counted as a buy or sell). The buyer is the owner whose balance of this token increased in the same transaction (excluding the pool authority)',
    'supplyPercent is based on (buys − sells in the same window). Liquidity additions and removals are not sells or buys, so they are not subtracted and are shown separately as liquidityAddedPercent and liquidityRemovedPercent. grossSupplyPercent adds buys only',
    delayedStart
      ? `sameBlock is whether there was a buy in the block where trading first opened (the first block after the start recorded in the pool${tradingOpenSlot !== null ? `, slot ${tradingOpenSlot}` : ''})`
      : 'sameBlock is whether there was a buy in the pool creation block (the pool has no separate trading start, or it is before creation)',
    'sameSlotGroups lists cases where different addresses bought in the same slot',
    'This section only shows the fact that addresses bought right after trading started. It does not judge whether automated programs were used or how addresses are related',
    'Based on the supported DEX pool with the largest balance of this token. If the token first traded on another DEX or launch platform, those trades are not included',
  );

  return {
    mint,
    checkedAt: now.toISOString(),
    status: complete ? 'complete' : 'partial',
    ...base,
    poolCreatedAt: iso(creationTime),
    poolCreationSlot: creation.slot,
    poolCreationTx: creation.signature,
    tradingStart: iso(startTime),
    tradingOpenSlot,
    windowMinutes,
    wallets: list.length,
    supplyPercent: percentOf(sumOf((b) => b.netBought), supply),
    grossSupplyPercent: percentOf(sumOf((b) => b.bought), supply),
    liquidityAddedPercent: percentOf(sumOf((b) => b.addedToLiquidity), supply),
    liquidityRemovedPercent: percentOf(sumOf((b) => b.removedFromLiquidity), supply),
    sameBlock: tradingOpenSlot === null ? null : buysInSameBlock > 0,
    sameBlockBasis: delayedStart ? 'trading-open-block' : 'pool-creation-block',
    buysInSameBlock,
    sameSlotGroups,
    firstTradeSlot,
    walletsInFirstTradeSlot: new Set(events.filter((e) => e.slot === firstTradeSlot).map((e) => e.wallet)).size,
    cumulativeByMinute,
    buyers: list,
    activity,
    stats: { signaturesScanned: sigs.length, transactionsInWindow: inWindow.length, transactionsParsed: txs.length - unreadable, transactionsUnreadable: unreadable },
    coverage: {
      transactionsRead: txs.length - unreadable, transactionsInWindow: inWindow.length, maxTransactions: maxTx,
      signaturesScanned: sigs.length, maxSignatures: maxPages * 1000, reachedPoolCreation: true,
    },
    evidence: [
      { account: mint, role: 'mint' },
      { account: pool.address, role: `${pool.dex}-pool` },
      { account: pool.vault, role: 'pool-token-vault' },
      { account: pool.pairVault, role: `pool-pair-vault:${pool.pairMint}` },
      { account: creation.signature, role: 'pool-creation-tx' },
    ],
    notes,
  };
}
