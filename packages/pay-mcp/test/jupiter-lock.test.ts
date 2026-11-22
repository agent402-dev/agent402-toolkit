// Jupiter Lock escrow decoder (pay-mcp locks): layout from the program's on-chain IDL, schedule math, irrevocability
import { Keypair, type PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { decodeJupiterLock, isIrrevocable, lockedAt } from '@agent402-dev/pay-mcp/locks';

const VESTING_ESCROW_SIZE = 296;
const VESTING_ESCROW_DISCRIMINATOR = [244, 119, 183, 4, 73, 116, 135, 195];

const pk = () => Keypair.generate().publicKey;
interface Fields { recipient: PublicKey; mint: PublicKey; creator: PublicKey; base: PublicKey; update: number; cancel: number; flag: number; cliff: bigint; freq: bigint; cliffAmt: bigint; perPeriod: bigint; periods: bigint; claimed: bigint; start: bigint; cancelledAt: bigint }
function account(f: Fields): Uint8Array {
  const b = Buffer.alloc(VESTING_ESCROW_SIZE);
  Buffer.from(VESTING_ESCROW_DISCRIMINATOR).copy(b, 0);
  f.recipient.toBuffer().copy(b, 8); f.mint.toBuffer().copy(b, 40); f.creator.toBuffer().copy(b, 72); f.base.toBuffer().copy(b, 104);
  b.writeUInt8(254, 136); b.writeUInt8(f.update, 137); b.writeUInt8(f.cancel, 138); b.writeUInt8(f.flag, 139);
  [f.cliff, f.freq, f.cliffAmt, f.perPeriod, f.periods, f.claimed, f.start, f.cancelledAt].forEach((v, i) => b.writeBigUInt64LE(v, 144 + i * 8));
  return b;
}
const DAY = 86_400n;
const T0 = 1_800_000_000n;
const base: Fields = { recipient: pk(), mint: pk(), creator: pk(), base: pk(), update: 0, cancel: 0, flag: 1, cliff: T0 + 90n * DAY, freq: 30n * DAY, cliffAmt: 1_000_000n, perPeriod: 500_000n, periods: 12n, claimed: 0n, start: T0, cancelledAt: 0n };

describe('Jupiter Lock escrow', () => {
  it('decodes the fields at the IDL offsets', () => {
    const l = decodeJupiterLock(account(base))!;
    expect(l).toMatchObject({
      recipient: base.recipient.toBase58(), mint: base.mint.toBase58(), updateRecipient: 'none', cancel: 'none',
      cliffTime: base.cliff, frequency: 30n * DAY, cliffUnlockAmount: 1_000_000n, amountPerPeriod: 500_000n, numberOfPeriod: 12n, cancelledAt: 0n,
    });
  });
  it('accepts only accounts with the VestingEscrow discriminator and size', () => {
    const wrong = account(base); wrong[0] ^= 1;
    expect(decodeJupiterLock(wrong)).toBeNull();
    expect(decodeJupiterLock(account(base).subarray(0, 200))).toBeNull();
  });
  it('still locked: everything before the cliff, minus the cliff amount at the cliff, minus one amount per period, 0 after the end', () => {
    const l = decodeJupiterLock(account(base))!;
    expect(lockedAt(l, T0)).toBe(7_000_000n);
    expect(lockedAt(l, base.cliff - 1n)).toBe(7_000_000n);
    expect(lockedAt(l, base.cliff)).toBe(6_000_000n);
    expect(lockedAt(l, base.cliff + 30n * DAY - 1n)).toBe(6_000_000n);
    expect(lockedAt(l, base.cliff + 60n * DAY)).toBe(5_000_000n);
    expect(lockedAt(l, base.cliff + 999n * DAY)).toBe(0n);
  });
  it('fixed only if nobody can cancel or change the recipient and it was not cancelled', () => {
    expect(isIrrevocable(decodeJupiterLock(account(base))!)).toBe(true);
    expect(isIrrevocable(decodeJupiterLock(account({ ...base, cancel: 1 }))!)).toBe(false);
    expect(decodeJupiterLock(account({ ...base, cancel: 3 }))!.cancel).toBe('either');
    expect(isIrrevocable(decodeJupiterLock(account({ ...base, update: 2 }))!)).toBe(false);
    const cancelled = decodeJupiterLock(account({ ...base, cancelledAt: T0 + DAY }))!;
    expect(isIrrevocable(cancelled)).toBe(false);
    expect(lockedAt(cancelled, T0)).toBe(0n);
  });
});
