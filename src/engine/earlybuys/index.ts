import { PublicKey } from '@solana/web3.js';
import type { ChainReader, HistoryReader, SignatureInfo, TxRecord } from '../chain.js';
import { decodeMint } from '../mint.js';
import { DISCLAIMER_EN, DISCLAIMER_KO, MintNotFoundError } from '../summary.js';
import { percentOf } from '../holders/index.js';
import { findSupportedPools, tokenBalances, type Dex, type PoolCandidate } from '../liquidity/pools.js';

export interface EarlyBuyer {
  /** 토큰을 받은 계정의 소유자 주소 */
  wallet: string;
  /** 온커브 주소(개인키 서명 주소) 여부. false 면 프로그램 파생 주소(PDA) */
  onCurve: boolean;
  /** 창 안에서 풀과의 교환으로 받은 수량 합계 (원 단위) */
  bought: string;
  boughtPercentOfSupply: number;
  /** 창 안에서 같은 풀과의 교환으로 내준 수량 합계 (유동성 추가는 포함하지 않음) */
  soldInWindow: string;
  /** bought − soldInWindow (0 미만이면 0) */
  netBought: string;
  netBoughtPercentOfSupply: number;
  /** 창 안에서 같은 풀에 유동성으로 넣은 이 토큰 수량 */
  addedToLiquidity: string;
  /** 창 안에서 같은 풀의 유동성을 빼며 받은 이 토큰 수량 */
  removedFromLiquidity: string;
  firstBuySlot: number;
  firstBuyTime: string;
  /** 거래 시작 시각으로부터 첫 매수까지 초 */
  secondsAfterStart: number;
  buyCount: number;
  /** 근거 트랜잭션 (최대 5개) */
  txs: string[];
}

export interface EarlyBuysReport {
  mint: string;
  checkedAt: string;
  /** complete: 창 안 거래를 모두 확인 / partial: 일부만 / unverifiable: 확인 불가 */
  status: 'complete' | 'partial' | 'unverifiable';
  dex: Dex | null;
  pool: string | null;
  poolCreatedAt: string | null;
  poolCreationSlot: number | null;
  poolCreationTx: string | null;
  /** 풀에 기록된 거래 시작 시점(activation / open_time)과 풀 생성 시각 중 늦은 쪽 */
  tradingStart: string | null;
  /** 거래가 처음 열린 블록 (거래 시작 시점이 풀 생성보다 늦을 때). 아니면 풀 생성 블록 */
  tradingOpenSlot: number | null;
  windowMinutes: number;
  /** 창 안에서 풀과의 교환으로 토큰을 받은 주소 수 */
  wallets: number;
  /** 그 주소들의 (매수 − 같은 창 안 매도) 합계의 공급 대비 %. 유동성 추가·제거는 반영하지 않음 */
  supplyPercent: number;
  /** 매도를 빼지 않은 매수 수량 합계의 공급 대비 % */
  grossSupplyPercent: number;
  /** 매수 주소들이 창 안에서 같은 풀에 유동성으로 넣은 이 토큰 합계의 공급 대비 % */
  liquidityAddedPercent: number;
  /** 매수 주소들이 창 안에서 같은 풀의 유동성을 빼며 받은 이 토큰 합계의 공급 대비 % */
  liquidityRemovedPercent: number;
  /** sameBlockBasis 블록에서 매수가 있었는지. 그 블록을 확정하지 못하면 null */
  sameBlock: boolean | null;
  /** trading-open-block: 거래가 처음 열린 블록 / pool-creation-block: 풀 생성 블록 */
  sameBlockBasis: 'trading-open-block' | 'pool-creation-block';
  buysInSameBlock: number;
  /** 서로 다른 주소 2개 이상이 같은 슬롯에서 매수한 경우 */
  sameSlotGroups: { slot: number; wallets: string[] }[];
  firstTradeSlot: number | null;
  /** 첫 매수가 있었던 슬롯에서 매수한 주소 수 */
  walletsInFirstTradeSlot: number;
  /** 시작 후 1분 단위 누적 (매수 − 매도 기준) */
  cumulativeByMinute: { minute: number; wallets: number; supplyPercent: number }[];
  buyers: EarlyBuyer[];
  /** 창 안 트랜잭션을 이 풀 기준으로 분류한 건수 */
  activity: { buys: number; sells: number; liquidityAdds: number; liquidityRemoves: number; other: number };
  stats: { signaturesScanned: number; transactionsInWindow: number; transactionsParsed: number; transactionsUnreadable: number };
  /** 조사 범위 (사실대로): 상한과 실제로 읽은 양. status 가 partial·unverifiable 인 이유를 숫자로 */
  coverage: {
    /** 창 안 거래 중 읽은 건수 / 창 안 거래 전체 건수 (풀 기록을 끝까지 못 갔으면 전체는 null) */
    transactionsRead: number;
    transactionsInWindow: number | null;
    maxTransactions: number;
    /** 거슬러 올라간 서명 수 / 상한 */
    signaturesScanned: number;
    maxSignatures: number;
    reachedPoolCreation: boolean;
  };
  evidence: { account: string; role: string }[];
  notes: string[];
}

export interface EarlyBuysOptions {
  windowMinutes?: number;
  /** 특정 풀 지정. 없으면 지원 풀 중 이 토큰 잔액이 가장 큰 풀 */
  pool?: string;
  /** 풀 서명을 거슬러 올라갈 최대 쪽수 (1쪽 = 1000건) */
  maxSignaturePages?: number;
  /** 창 안에서 읽을 최대 트랜잭션 수 */
  maxTransactions?: number;
  now?: () => Date;
}

const iso = (sec: number | null) => (sec === null ? '' : new Date(sec * 1000).toISOString());
/** getBlocks 한 번에 물을 수 있는 최대 범위 */
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
  /** 금고 소유자(풀 권한자) — 받는 쪽/내는 쪽 집계에서 제외 */
  poolAuthority: string | null;
}

/**
 * 한 트랜잭션에서 이 풀의 두 금고 움직임으로 종류를 정하고, 이 토큰을 주고받은 소유자별 수량을 돌려줍니다.
 *  이 토큰 금고 ↓, 짝 금고 ↑ → buy     (늘어난 소유자 = 매수자)
 *  이 토큰 금고 ↑, 짝 금고 ↓ → sell    (줄어든 소유자 = 매도자)
 *  둘 다 ↑                  → add-liquidity    (줄어든 소유자 = 넣은 주소)
 *  둘 다 ↓                  → remove-liquidity (늘어난 소유자 = 뺀 주소)
 *  한쪽만 움직임             → other (수수료 청구 등. 매수·매도로 세지 않음)
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
 * 확정 블록 중 블록 시각이 t 이상인 첫 블록. 범위가 너무 크거나 못 찾으면 null.
 * 한 번에 최대 K 개 지점의 블록 시각을 동시에 물어 구간을 좁힘 (RPC 일괄 요청과 함께 쓰면 HTTP 2~3번)
 */
async function firstBlockAtOrAfter(reader: HistoryReader, fromSlot: number, toSlot: number, t: number): Promise<number | null> {
  if (toSlot < fromSlot || toSlot - fromSlot > MAX_BLOCK_RANGE) return null;
  const slots = await reader.blocks(fromSlot, toSlot);
  // 한 단계에 묻는 지점 수 = RPC 일괄 요청 크기(10) → 단계마다 HTTP 1회
  const K = 10;
  // 불변식: 인덱스 < lo 는 모두 시각 < t. hi 는 시각 ≥ t 인 인덱스이거나 slots.length(아직 없음)
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
  const notes: string[] = [DISCLAIMER_KO, DISCLAIMER_EN];

  const m = (await reader.fetch([mint])).accounts[0];
  if (!m) throw new MintNotFoundError(`account ${mint} not found`);
  const supply = decodeMint(m.data, new PublicKey(m.owner)).supply;

  // 1) 풀 선택
  const { candidates } = await findSupportedPools(mint, reader);
  const pool: PoolCandidate | undefined = opts.pool ? candidates.find((c) => c.address === opts.pool) : candidates[0];
  if (!pool) {
    notes.push('지원 DEX(Meteora DAMM v2, Raydium CPMM)에서 이 토큰의 풀을 찾지 못했습니다 (확인 불가)');
    return unverifiable(mint, windowMinutes, now, notes);
  }
  const vaultInfo = (await tokenBalances(reader, [pool.vault])).balances.get(pool.vault);
  const side: PoolSide = { mint, vault: pool.vault, pairMint: pool.pairMint, pairVault: pool.pairVault, poolAuthority: vaultInfo?.owner ?? null };

  // 2) 풀 서명을 생성 시점까지 거슬러 올라감
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
    notes.push(`풀 거래 기록을 최근부터 ${sigs.length}건(상한 ${maxPages * 1000}건)까지 거슬러 올라갔지만 거래 시작 시점에 닿지 못했습니다 (확인 불가)`);
    return unverifiable(mint, windowMinutes, now, notes, {
      ...base, stats: { signaturesScanned: sigs.length, transactionsInWindow: 0, transactionsParsed: 0, transactionsUnreadable: 0 },
      coverage: { transactionsRead: 0, transactionsInWindow: null, maxTransactions: maxTx, signaturesScanned: sigs.length, maxSignatures: maxPages * 1000, reachedPoolCreation: false },
    });
  }
  const chronological = [...sigs].reverse();
  const creation = chronological[0];
  const creationTime = creation.blockTime;

  // 3) 거래 시작 시각과 거래가 처음 열린 블록
  //    풀에 기록된 시작 시점이 풀 생성보다 늦으면 "거래가 처음 열린 블록", 아니면 "풀 생성 블록" 기준
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
    notes.push('거래 시작 시각을 구하지 못했습니다 (확인 불가)');
    return unverifiable(mint, windowMinutes, now, notes, base);
  }
  if (delayedStart && tradingOpenSlot === null) {
    notes.push('거래가 처음 열린 블록을 확정하지 못해 sameBlock 을 판정하지 않았습니다 (확인 불가)');
  }
  const end = startTime + windowMinutes * 60;

  // 4) 창 안의 성공한 거래 (+ 풀 생성 슬롯의 거래)
  const inWindow = chronological.filter(
    (s) => !s.err && s.signature !== creation.signature &&
      ((s.blockTime !== null && s.blockTime >= startTime! && s.blockTime < end) || s.slot === creation.slot),
  );
  const toRead = inWindow.slice(0, maxTx);
  const txs = await reader.transactions(toRead.map((s) => s.signature));
  const unreadable = txs.filter((t) => t === null).length;

  // 5) 집계
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
    notes.push(`창 안 거래 ${inWindow.length}건 중 시간순으로 앞의 ${maxTx}건만 조회했습니다 (일부). 매수 주소 수·비중은 이 ${maxTx}건 기준입니다`);
  }
  if (unreadable) notes.push(`읽지 못한 트랜잭션 ${unreadable}건이 있습니다 (일부)`);
  notes.push(
    '거래 분류: 한 트랜잭션에서 이 토큰 금고가 줄고 짝 토큰 금고가 늘면 매수, 반대면 매도, 둘 다 늘면 유동성 추가, 둘 다 줄면 유동성 제거, 한쪽만 움직이면 기타(매수·매도로 세지 않음). 매수자는 같은 트랜잭션에서 이 토큰 잔액이 늘어난 소유자입니다 (풀 권한자 제외)',
    'supplyPercent 는 (매수 − 같은 창 안 매도) 기준입니다. 유동성 추가·제거는 매도·매수가 아니므로 빼지 않고 liquidityAddedPercent·liquidityRemovedPercent 로 따로 보여 줍니다. grossSupplyPercent 는 매수만 더한 값입니다',
    delayedStart
      ? `sameBlock 은 거래가 처음 열린 블록(풀에 기록된 시작 시점 이후 첫 블록${tradingOpenSlot !== null ? `, 슬롯 ${tradingOpenSlot}` : ''})에서 매수가 있었는지입니다`
      : 'sameBlock 은 풀 생성 블록에서 매수가 있었는지입니다 (풀에 별도 거래 시작 시점이 없거나 생성 시각 이전)',
    'sameSlotGroups 는 서로 다른 주소가 같은 슬롯에서 매수한 경우입니다',
    '이 항목은 거래 시작 직후 매수했다는 사실만 보여 주며, 자동화 프로그램 사용 여부나 주소 간 관계는 판단하지 않습니다',
    '지원 DEX 풀 중 이 토큰 잔액이 가장 큰 풀 기준입니다. 토큰의 첫 거래가 다른 DEX·발행 플랫폼에서 일어났다면 그 거래는 포함되지 않습니다',
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
