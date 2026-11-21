import { existsSync, readFileSync } from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  analyzeSwap, checkEarlyBuys,
  type ChainReader, type HistoryReader, type PoolSide, type SignatureInfo, type TxRecord,
} from '@agent402-dev/check-engine/index';
import { guardrailViolations } from '@agent402-dev/check-engine/guardrail';
import { DAMM_V2_PROGRAM } from '@agent402-dev/check-engine/liquidity/meteora-damm-v2';
import { SPL_TOKEN_PROGRAM } from '@agent402-dev/check-engine/programs';

// ---------- Mainnet fixture replay ----------
interface Rec {
  mint: string;
  slot: number;
  accounts: Record<string, { owner: string; data: string } | null>;
  programAccounts: { program: string; query: unknown; result: { address: string; data: string }[] }[];
  signatures: { address: string; before: string | null; result: SignatureInfo[] }[];
  transactions: Record<string, TxRecord | null>;
  blocks: { start: number; end: number; result: number[] }[];
  blockTimes: Record<string, number | null>;
}
const fx = (s: string) => new URL(`./fixtures/w4-${s}.json`, import.meta.url);
function replay(rec: Rec): ChainReader & HistoryReader {
  return {
    fetch: async (addrs) => ({
      slot: rec.slot,
      accounts: addrs.map((a) => {
        if (!(a in rec.accounts)) throw new Error(`fixture missing ${a}`);
        const x = rec.accounts[a];
        return x ? { owner: x.owner, data: Buffer.from(x.data, 'base64') } : null;
      }),
    }),
    largestTokenAccounts: async () => { throw new Error('not recorded'); },
    programAccounts: async (program, query) => {
      const m = rec.programAccounts.find((p) => p.program === program && JSON.stringify(p.query) === JSON.stringify(query));
      if (!m) throw new Error('fixture missing programAccounts');
      return m.result.map((r) => ({ address: r.address, data: Buffer.from(r.data, 'base64') }));
    },
    signaturesForAddress: async (address, o) => {
      const m = rec.signatures.find((s) => s.address === address && s.before === (o.before ?? null));
      if (!m) throw new Error('fixture missing signatures');
      return m.result;
    },
    transactions: async (sigs) => sigs.map((s) => {
      if (!(s in rec.transactions)) throw new Error(`fixture missing tx ${s}`);
      return rec.transactions[s];
    }),
    blocks: async (start, end) => {
      const m = rec.blocks.find((b) => b.start === start && b.end === end);
      if (!m) throw new Error(`fixture missing blocks ${start}-${end}`);
      return m.result;
    },
    blockTime: async (slot) => {
      if (!(String(slot) in rec.blockTimes)) throw new Error(`fixture missing blockTime ${slot}`);
      return rec.blockTimes[slot];
    },
  };
}
const load = (s: string): Rec => JSON.parse(readFileSync(fx(s), 'utf8'));
const now = () => new Date('2026-11-19T00:00:00Z');

describe.skipIf(!existsSync(fx('A402')))('A402 (reference data)', () => {
  it('start 13:48:13, 4 wallets within 3 minutes. 7WUby added liquidity rather than selling', async () => {
    const rec = load('A402');
    const r = await checkEarlyBuys(rec.mint, replay(rec), { now });
    expect(r.status).toBe('complete');
    expect(r.pool).toBe('DaHBw8dxnZaCaX5HdsiM1Hs1uQNwsW3QW3wcD6P4Z5oZ');
    expect(r.tradingStart).toBe('2026-11-18T13:48:13.000Z');
    expect(r.buyers.map((b) => b.wallet.slice(0, 5)).sort()).toEqual(['7WUby', 'J9Hef', 'rarad', 'rereM']);
    expect(r.cumulativeByMinute[2].wallets).toBe(4);
    expect(r.activity).toEqual({ buys: 4, sells: 0, liquidityAdds: 1, liquidityRemoves: 0, other: 0 });

    const w7 = r.buyers.find((b) => b.wallet.startsWith('7WUby'))!;
    expect(w7.soldInWindow).toBe('0');
    expect(w7.addedToLiquidity).toBe('5609090117651');
    // buys − sells = 19.96%; subtracting the 0.56% added as liquidity gives about 19.4% of the reference data
    expect(r.supplyPercent).toBeCloseTo(19.956, 3);
    expect(r.liquidityAddedPercent).toBeCloseTo(0.5609, 4);
    expect(r.supplyPercent - r.liquidityAddedPercent).toBeCloseTo(19.4, 1);

    // sameBlock: the pool has a trading start, so the basis is "block where trading first opened"
    expect(r.sameBlockBasis).toBe('trading-open-block');
    expect(r.tradingOpenSlot).toBe(470957018);
    expect(r.sameBlock).toBe(false);
    expect(r.sameSlotGroups).toEqual([{ slot: 470957640, wallets: expect.arrayContaining([
      'raradsXG6YeeU635nYeskzkNjzUwbbdugWbse7D1Q7A', 'rereMkDCpde7vPEqP82rrLiKoBvkEfKyNCzn1Ni3Pma',
    ]) }]);
    // The response must not contain wording that is not factual
    expect(JSON.stringify(r)).not.toMatch(/resold|resell/);
    expect(guardrailViolations(r)).toEqual([]);
  });
});

describe.skipIf(!existsSync(fx('NEW-2')))('recent DAMM v2 pool (NEW-2)', () => {
  it('pool without a separate trading start → pool creation block basis, a buy in that block / partial when over the limit', async () => {
    const rec = load('NEW-2');
    const r = await checkEarlyBuys(rec.mint, replay(rec), { now });
    expect(r.sameBlockBasis).toBe('pool-creation-block');
    expect(r.tradingOpenSlot).toBe(r.poolCreationSlot);
    expect(r.sameBlock).toBe(true);
    expect(r.buysInSameBlock).toBeGreaterThan(0);
    expect(r.status).toBe('partial');
    expect(guardrailViolations(r)).toEqual([]);
  });
});

// ---------- Synthetic ----------
const k = () => Keypair.generate().publicKey.toBase58();

describe('analyzeSwap: classify by the movement of the two vaults', () => {
  const mint = k(), pairMint = k(), vault = k(), pairVault = k(), auth = k(), user = k(), user2 = k(), router = k();
  const side: PoolSide = { mint, vault, pairMint, pairVault, poolAuthority: auth };
  type Row = { acc: string; owner: string; mint: string; pre?: number; post?: number };
  const tx = (rows: Row[]): TxRecord => ({
    signature: 'sig', slot: 1, blockTime: 100, err: false,
    accountKeys: rows.map((r) => r.acc),
    preTokenBalances: rows.filter((r) => r.pre !== undefined).map((r) => ({ accountIndex: rows.indexOf(r), mint: r.mint, owner: r.owner, amount: String(r.pre) })),
    postTokenBalances: rows.filter((r) => r.post !== undefined).map((r) => ({ accountIndex: rows.indexOf(r), mint: r.mint, owner: r.owner, amount: String(r.post) })),
  });
  const V = (pre: number, post: number): Row => ({ acc: vault, owner: auth, mint, pre, post });
  const P = (pre: number, post: number): Row => ({ acc: pairVault, owner: auth, mint: pairMint, pre, post });

  it('buy: this token vault ↓, paired vault ↑ (including new token accounts, excluding intermediate accounts)', () => {
    const a = analyzeSwap(tx([V(1000, 900), P(50, 60),
      { acc: k(), owner: router, mint, pre: 0, post: 0 },
      { acc: k(), owner: user, mint, post: 60 },
      { acc: k(), owner: user2, mint, pre: 5, post: 45 }]), side);
    expect(a.kind).toBe('buy');
    expect(Object.fromEntries(a.buys)).toEqual({ [user]: 60n, [user2]: 40n });
  });
  it('sell: this token vault ↑, paired vault ↓', () => {
    const a = analyzeSwap(tx([V(900, 950), P(60, 55), { acc: k(), owner: user, mint, pre: 60, post: 10 }]), side);
    expect(a.kind).toBe('sell');
    expect(a.sells).toEqual([[user, 50n]]);
    expect(a.liquidityAdds).toEqual([]);
  });
  it('add-liquidity: both vaults ↑ → not a sell', () => {
    const a = analyzeSwap(tx([V(900, 950), P(60, 66), { acc: k(), owner: user, mint, pre: 60, post: 10 }]), side);
    expect(a.kind).toBe('add-liquidity');
    expect(a.sells).toEqual([]);
    expect(a.liquidityAdds).toEqual([[user, 50n]]);
  });
  it('remove-liquidity: both vaults ↓ → not a buy', () => {
    const a = analyzeSwap(tx([V(950, 900), P(66, 60), { acc: k(), owner: user, mint, pre: 10, post: 60 }]), side);
    expect(a.kind).toBe('remove-liquidity');
    expect(a.buys).toEqual([]);
    expect(a.liquidityRemoves).toEqual([[user, 50n]]);
  });
  it('other: only one vault moves (fee claims, etc.) → neither buy nor sell', () => {
    const a = analyzeSwap(tx([V(1000, 990), { acc: k(), owner: user, mint, pre: 0, post: 10 }]), side);
    expect(a.kind).toBe('other');
    expect(a.buys).toEqual([]);
  });
  it('none: a plain transfer with no vault movement', () => {
    const a = analyzeSwap(tx([{ acc: k(), owner: user, mint, pre: 60, post: 10 }, { acc: k(), owner: user2, mint, pre: 0, post: 50 }]), side);
    expect(a.kind).toBe('none');
  });
});

describe('checkEarlyBuys boundaries', () => {
  /** Synthetic chain with one DAMM v2 pool */
  function chain(opts: { sigPages: SignatureInfo[][]; activation?: number; blocks?: Record<number, number>; txs?: Record<string, TxRecord> }) {
    const mint = Keypair.generate().publicKey, pool = k(), vault = k(), pairVault = k(), pairMint = k(), auth = k();
    const mintData = Buffer.alloc(82); mintData.writeBigUInt64LE(1000n, 36); mintData.writeUInt8(1, 45);
    const poolData = Buffer.alloc(1112);
    Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]).copy(poolData, 0);
    mint.toBuffer().copy(poolData, 168);
    new PublicKey(pairMint).toBuffer().copy(poolData, 200);
    new PublicKey(vault).toBuffer().copy(poolData, 232);
    new PublicKey(pairVault).toBuffer().copy(poolData, 264);
    poolData.writeBigUInt64LE(BigInt(opts.activation ?? 0), 472);
    poolData.writeUInt8(1, 480); // activation_type = timestamp
    const vaultData = Buffer.alloc(165); mint.toBuffer().copy(vaultData, 0); new PublicKey(auth).toBuffer().copy(vaultData, 32);
    const blocks = opts.blocks ?? {};
    // Kept in ctx so signatures and transactions built from the vault addresses can be added after building the chain
    const ctx = { sigPages: opts.sigPages, txs: opts.txs ?? {} };
    let page = 0;
    const r: ChainReader & HistoryReader = {
      fetch: async (addrs) => ({ slot: 1, accounts: addrs.map((a) =>
        a === mint.toBase58() ? { owner: SPL_TOKEN_PROGRAM.toBase58(), data: mintData }
          : a === vault ? { owner: SPL_TOKEN_PROGRAM.toBase58(), data: vaultData } : null) }),
      largestTokenAccounts: async () => ({ addresses: [], method: 't' }),
      programAccounts: async (program, q) =>
        program === DAMM_V2_PROGRAM && q.memcmp[0].offset === 168 ? [{ address: pool, data: poolData }] : [],
      signaturesForAddress: async () => ctx.sigPages[page++] ?? [],
      transactions: async (sigs) => sigs.map((s) => ctx.txs[s] ?? null),
      blocks: async (a, b) => Object.keys(blocks).map(Number).filter((s) => s >= a && s <= b).sort((x, y) => x - y),
      blockTime: async (s) => blocks[s] ?? null,
    };
    return { mint: mint.toBase58(), reader: r, ctx, vault, pairVault, pairMint, auth };
  }
  const sig = (i: number, t: number): SignatureInfo => ({ signature: `s${i}`, slot: i, blockTime: t, err: false });

  it('unverifiable when the trade history is longer than the limit', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => sig(i, 1000));
    const { mint, reader } = chain({ sigPages: [full, full] });
    const r = await checkEarlyBuys(mint, reader, { maxSignaturePages: 2, now });
    expect(r.status).toBe('unverifiable');
    expect(r.sameBlock).toBeNull();
    expect(guardrailViolations(r)).toEqual([]);
  });

  it('activation earlier than creation (0) → pool creation block basis; partial if some transactions could not be read', async () => {
    const { mint, reader } = chain({ sigPages: [[sig(3, 5030), sig(2, 5010), sig(1, 5000)]] });
    const r = await checkEarlyBuys(mint, reader, { now });
    expect(r.tradingStart).toBe(new Date(5000 * 1000).toISOString());
    expect(r.sameBlockBasis).toBe('pool-creation-block');
    expect(r.tradingOpenSlot).toBe(1);
    expect(r.status).toBe('partial');
  });

  it('activation later than creation → the first block after that time is the "block where trading first opened"; only buys in that block count for sameBlock', async () => {
    // creation slot 10 (t=1000), trading start t=1100. Block times: 11→1050, 13→1099, 14→1100 (opened block), 16→1101
    const blocks = { 10: 1000, 11: 1050, 13: 1099, 14: 1100, 16: 1101 };
    const run = async (buySlot: number, buyTime: number) => {
      const c = chain({ sigPages: [], activation: 1100, blocks });
      c.ctx.sigPages = [[{ signature: 'buy', slot: buySlot, blockTime: buyTime, err: false }, sig(10, 1000)]];
      c.ctx.txs = {
        buy: {
          signature: 'buy', slot: buySlot, blockTime: buyTime, err: false,
          accountKeys: [c.vault, c.pairVault, k()],
          preTokenBalances: [
            { accountIndex: 0, mint: c.mint, owner: c.auth, amount: '500' },
            { accountIndex: 1, mint: c.pairMint, owner: c.auth, amount: '50' },
          ],
          postTokenBalances: [
            { accountIndex: 0, mint: c.mint, owner: c.auth, amount: '480' },
            { accountIndex: 1, mint: c.pairMint, owner: c.auth, amount: '60' },
            { accountIndex: 2, mint: c.mint, owner: k(), amount: '20' },
          ],
        },
      };
      return checkEarlyBuys(c.mint, c.reader, { now });
    };
    const inOpen = await run(14, 1100);
    expect(inOpen.sameBlockBasis).toBe('trading-open-block');
    expect(inOpen.tradingOpenSlot).toBe(14);
    expect(inOpen.sameBlock).toBe(true);
    const later = await run(16, 1101);
    expect(later.tradingOpenSlot).toBe(14);
    expect(later.sameBlock).toBe(false);
    expect(later.buyers).toHaveLength(1);
  });
});
