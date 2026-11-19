import { PublicKey } from '@solana/web3.js';

/** 순차 바이트 판독기. 범위를 벗어나면 예외를 던집니다. */
export class Reader {
  constructor(
    private readonly buf: Buffer,
    public offset = 0,
  ) {}

  private need(n: number): void {
    if (this.offset + n > this.buf.length) {
      throw new RangeError(`read past end: need ${n} at ${this.offset}, length ${this.buf.length}`);
    }
  }

  u8(): number {
    this.need(1);
    return this.buf.readUInt8(this.offset++);
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  u16(): number {
    this.need(2);
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }
  i16(): number {
    this.need(2);
    const v = this.buf.readInt16LE(this.offset);
    this.offset += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }
  u64(): bigint {
    this.need(8);
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }
  u128(): bigint {
    const lo = this.u64();
    const hi = this.u64();
    return (hi << 64n) | lo;
  }
  i64(): bigint {
    this.need(8);
    const v = this.buf.readBigInt64LE(this.offset);
    this.offset += 8;
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.buf.readDoubleLE(this.offset);
    this.offset += 8;
    return v;
  }
  pubkey(): PublicKey {
    this.need(32);
    const v = new PublicKey(this.buf.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return v;
  }
  /** Token-2022 의 OptionalNonZeroPubkey: 전부 0 이면 없음(null) */
  optionalNonZeroPubkey(): string | null {
    const k = this.pubkey();
    return k.equals(PublicKey.default) ? null : k.toBase58();
  }
  /** borsh 문자열 (u32 길이 + UTF-8). Metaplex 는 끝에 \0 패딩이 있어 잘라냅니다. */
  string(): string {
    const len = this.u32();
    this.need(len);
    const s = this.buf.subarray(this.offset, this.offset + len).toString('utf8');
    this.offset += len;
    return s.replace(/\0+$/, '');
  }
  bytes(n: number): Buffer {
    this.need(n);
    const v = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return v;
  }
  remaining(): number {
    return this.buf.length - this.offset;
  }
}
