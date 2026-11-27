import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import * as client from '@agent402-dev/bond-client/v2';
import * as job from '@agent402-dev/bond-client/job-8183';
import { bondV2JobStatus, bondV2Reject, jobView } from '@agent402-dev/pay-mcp/bond-v2-job';
import * as tx from '@agent402-dev/pay-mcp/bond-v2-tx';
import type { BondV2Deps } from '@agent402-dev/pay-mcp/bond-v2';

const PROGRAM = client.BOND_V2_PROGRAM_ID.toBase58();
const T0 = 1_800_000_000n;
const seller = Keypair.generate().publicKey, buyer = Keypair.generate().publicKey;

function raw(state: number, markedAt = 0n, outcome = 0, owedSeller = 0n) {
  const b = Buffer.alloc(450);
  Buffer.from(client.ACCOUNT_DISC_V2.Deal).copy(b);
  seller.toBuffer().copy(b, 9); buyer.toBuffer().copy(b, 41); Keypair.generate().publicKey.toBuffer().copy(b, 73);
  b.writeBigUInt64LE(1_000_000n, 249); b.writeBigUInt64LE(100_000n, 257); b.writeBigUInt64LE(300_000n, 265);
  b.writeBigInt64LE(T0 + 3_600n, 273); b.writeBigInt64LE(3_600n, 281); b.writeBigInt64LE(3_600n, 289);
  b.writeBigInt64LE(T0, 307); b.writeBigInt64LE(markedAt, 315); b[331] = state; b[332] = outcome; b.writeBigUInt64LE(owedSeller, 333);
  return new Uint8Array(b);
}
function deps(data: Uint8Array, now: bigint, me: string | null) {
  const added: unknown[] = [];
  const d = {
    v2Program: PROGRAM, clock: async () => now, accounts: async () => [{ owner: PROGRAM, data }],
    signer: me ? { address: me, signBytes: async () => { throw new Error('must not sign'); } } : null,
    history: { add: (e: unknown) => added.push(e) }, policy: { network: 'solana', mints: { USDC: 'U' } },
  } as unknown as BondV2Deps;
  return { d, added };
}

describe('pay-mcp 8183-style job tools on Bond v2', () => {
  it('jobView agrees with bond-client jobStatus at every stage', () => {
    for (const [state, markedAt, outcome, owed, nowOff] of [[1, 0n, 0, 0n, 10n], [1, 0n, 0, 0n, 7_201n], [2, T0 + 60n, 0, 0n, 100n], [2, T0 + 60n, 0, 0n, 7_201n], [3, T0 + 60n, 0, 400_000n, 9_999n], [3, 0n, 2, 0n, 9_999n]] as const) {
      const r = raw(state, markedAt, outcome, owed);
      const a = jobView(tx.decodeDealV2(r)!, T0 + nowOff), b = job.jobStatus(client.decodeDealV2(r), T0 + nowOff);
      expect([a.status, a.outcome, a.settleable, a.canComplete, a.canSubmit, a.settleAfter], `${state}/${nowOff}`).toEqual([b.status, b.outcome, b.settleable, b.canComplete, b.canSubmit, b.settleAfter.toString()]);
    }
  });

  it('bond_v2_job_status is read-only and names the role', async () => {
    const { d, added } = deps(raw(2, T0 + 60n), T0 + 100n, buyer.toBase58());
    expect(await bondV2JobStatus(d, 'Deal1')).toMatchObject({ result: 'ok', role: 'client', status: 'Submitted', canComplete: true, completeBy: String(T0 + 7_200n) });
    expect(added).toEqual([]);
    expect((await bondV2JobStatus(deps(raw(1), T0, seller.toBase58()).d, 'Deal1') as { role: string }).role).toBe('provider');
  });

  it('bond_v2_reject: buyer only, never signs, keeps a reason record (default other)', async () => {
    const { d, added } = deps(raw(2, T0 + 60n), T0 + 100n, buyer.toBase58());
    const r = await bondV2Reject(d, 'Deal1', 'schema_mismatch', '  missing rows  ');
    expect(r).toMatchObject({ result: 'rejected', reason: 'schema_mismatch', machineCheckable: true, note: 'missing rows', expectedOutcome: 'Unconfirmed', settleAfter: String(T0 + 7_200n), signed: false });
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ url: 'bond:v2-reject:Deal1', signed: false, reasons: ['reason:schema_mismatch', 'note:missing rows'] });
    expect(await bondV2Reject(deps(raw(2, T0 + 60n), T0, buyer.toBase58()).d, 'Deal1')).toMatchObject({ reason: 'other', machineCheckable: false });
    expect(await bondV2Reject(deps(raw(1), T0, buyer.toBase58()).d, 'Deal1', 'not-a-code')).toMatchObject({ reason: 'other', expectedOutcome: 'SellerDefault' });
    expect(await bondV2Reject(deps(raw(2, T0 + 60n), T0, seller.toBase58()).d, 'Deal1')).toMatchObject({ result: 'refused' });
    expect(await bondV2Reject(deps(raw(3, T0 + 60n), T0, buyer.toBase58()).d, 'Deal1')).toMatchObject({ result: 'refused' });
    expect(await bondV2Reject(deps(raw(2), T0, null).d, 'Deal1')).toMatchObject({ result: 'refused' });
  });
});
