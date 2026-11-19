import { readFileSync } from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { checkSummary, DISCLAIMER_KO, NotAMintError, type AccountFetcher } from '../src/engine/index.js';
import { guardrailViolations } from '../src/engine/guardrail.js';
import { metaplexMetadataPda, METAPLEX_METADATA_PROGRAM, SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from '../src/engine/programs.js';

// ---------- 실제 메인넷 픽스처 (npm run verify:week1 로 저장) ----------
interface Fixture {
  mint: string;
  slots: number[];
  accounts: Record<string, { owner: string; data: string } | null>;
}
const load = (s: string): Fixture => JSON.parse(readFileSync(new URL(`./fixtures/${s}.json`, import.meta.url), 'utf8'));
const fixtureFetcher = (f: Fixture): AccountFetcher => async (addrs) => ({
  slot: f.slots[0],
  accounts: addrs.map((a) => {
    if (!(a in f.accounts)) throw new Error(`fixture missing ${a}`);
    const x = f.accounts[a];
    return x ? { owner: x.owner, data: Buffer.from(x.data, 'base64') } : null;
  }),
});
const run = async (s: string) => {
  const f = load(s);
  return checkSummary(f.mint, fixtureFetcher(f), () => new Date('2026-11-19T00:00:00Z'));
};

describe('mainnet fixtures', () => {
  it('A402: 민트·프리즈 없음, TokenMetadata 권한 없음, 포인터 권한은 deployer 에 남아 있음', async () => {
    const r = await run('A402');
    expect(r.tokenProgram).toBe('token-2022');
    expect(r.authorities.mint).toEqual({ status: 'revoked', address: null });
    expect(r.authorities.freeze).toEqual({ status: 'none', address: null });
    expect(r.token2022Extensions).toEqual(['MetadataPointer', 'TokenMetadata']);
    expect(r.notableExtensions).toEqual([]);
    const md = r.authorities.metadataUpdate;
    expect(md.sources[0]).toMatchObject({ standard: 'token-2022', updateAuthority: null, symbol: 'A402' });
    expect(md.holders).toEqual([
      { role: 'metadata-pointer-authority', address: 'BCNZ2G41K62Wm3WuGMv6rRvKC4j9vrnsznK8xKH1EN9M' },
    ]);
    expect(md.status).toBe('present');
  });

  it('USDC: 발행·동결 권한 있음, Metaplex 수정 가능', async () => {
    const r = await run('USDC');
    expect(r.tokenProgram).toBe('spl-token');
    expect(r.authorities.mint.status).toBe('present');
    expect(r.authorities.freeze.status).toBe('present');
    expect(r.authorities.metadataUpdate.sources[0]).toMatchObject({ standard: 'metaplex', isMutable: true, symbol: 'USDC' });
    expect(r.authorities.metadataUpdate.status).toBe('present');
  });

  it('WIF: 모두 폐기, Metaplex isMutable=false → revoked (기록된 주소는 유지)', async () => {
    const r = await run('WIF');
    expect(r.authorities.mint.status).toBe('revoked');
    expect(r.authorities.freeze.status).toBe('none');
    const md = r.authorities.metadataUpdate;
    expect(md.status).toBe('revoked');
    expect(md.sources[0].isMutable).toBe(false);
    expect(md.sources[0].updateAuthority).toBeNull();
    expect(md.sources[0].recordedUpdateAuthority).toBeTruthy();
  });

  it('BONK / JUP: SPL Token, 발행 권한 폐기, Metaplex 수정 가능', async () => {
    for (const s of ['BONK', 'JUP']) {
      const r = await run(s);
      expect(r.tokenProgram).toBe('spl-token');
      expect(r.authorities.mint.status).toBe('revoked');
      expect(r.authorities.metadataUpdate.status).toBe('present');
    }
  });

  it('PYUSD: Token-2022 확장 8개, 영향 확장 6개와 권한자', async () => {
    const r = await run('PYUSD');
    expect(r.token2022Extensions).toEqual([
      'MintCloseAuthority', 'PermanentDelegate', 'TransferFeeConfig', 'ConfidentialTransferMint',
      'ConfidentialTransferFeeConfig', 'TransferHook', 'MetadataPointer', 'TokenMetadata',
    ]);
    expect(r.notableExtensions.map((n) => n.name)).toEqual([
      'MintCloseAuthority', 'PermanentDelegate', 'TransferFeeConfig', 'ConfidentialTransferMint',
      'ConfidentialTransferFeeConfig', 'TransferHook',
    ]);
    const pd = r.notableExtensions.find((n) => n.name === 'PermanentDelegate')!;
    expect(pd.authorities.delegate).toBeTruthy();
  });

  it('6개 모두 가드레일 통과 + 고지 문구 포함', async () => {
    for (const s of ['A402', 'USDC', 'BONK', 'WIF', 'JUP', 'PYUSD']) {
      const r = await run(s);
      expect(guardrailViolations(r), s).toEqual([]);
      expect(r.notes).toContain(DISCLAIMER_KO);
    }
  });
});

// ---------- 합성 계정 ----------
const pk = () => Keypair.generate().publicKey;

function splMint(opts: { mintAuth?: PublicKey | null; freeze?: PublicKey | null; size?: number } = {}): Buffer {
  const b = Buffer.alloc(opts.size ?? 82);
  if (opts.mintAuth) { b.writeUInt32LE(1, 0); opts.mintAuth.toBuffer().copy(b, 4); }
  b.writeBigUInt64LE(1000n, 36);
  b.writeUInt8(6, 44);
  b.writeUInt8(1, 45);
  if (opts.freeze) { b.writeUInt32LE(1, 46); opts.freeze.toBuffer().copy(b, 50); }
  return b;
}
function t22Mint(exts: { type: number; data: Buffer }[]): Buffer {
  const base = splMint({ size: 165 });
  const parts = [base, Buffer.from([1])];
  for (const e of exts) {
    const h = Buffer.alloc(4);
    h.writeUInt16LE(e.type, 0);
    h.writeUInt16LE(e.data.length, 2);
    parts.push(h, e.data);
  }
  return Buffer.concat(parts);
}
function borshStr(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  const l = Buffer.alloc(4);
  l.writeUInt32LE(b.length);
  return Buffer.concat([l, b]);
}
function metaplexAcc(mint: PublicKey, ua: PublicKey, isMutable: boolean): Buffer {
  return Buffer.concat([
    Buffer.from([4]), ua.toBuffer(), mint.toBuffer(),
    borshStr('Name\0\0\0'), borshStr('SYM\0'), borshStr('https://x\0\0'),
    Buffer.from([0, 0]), Buffer.from([1]), Buffer.from([1, 0, 0, 0]), Buffer.alloc(34), // creators: 1개
    Buffer.from([0]), Buffer.from([isMutable ? 1 : 0]),
  ]);
}
const mapFetcher = (m: Record<string, { owner: PublicKey; data: Buffer } | null>): AccountFetcher => async (addrs) => ({
  slot: 1,
  accounts: addrs.map((a) => (m[a] ? { owner: m[a]!.owner.toBase58(), data: m[a]!.data } : null)),
});

describe('synthetic accounts', () => {
  it('SPL 민트 + 권한 주소 그대로 노출, 메타데이터 없음 → not_found', async () => {
    const mint = pk(), ma = pk(), fa = pk();
    const r = await checkSummary(mint.toBase58(), mapFetcher({ [mint.toBase58()]: { owner: SPL_TOKEN_PROGRAM, data: splMint({ mintAuth: ma, freeze: fa }) } }));
    expect(r.authorities.mint).toEqual({ status: 'present', address: ma.toBase58() });
    expect(r.authorities.freeze).toEqual({ status: 'present', address: fa.toBase58() });
    expect(r.authorities.metadataUpdate.status).toBe('not_found');
    expect(r.token2022Extensions).toEqual([]);
  });

  it('Metaplex isMutable=false → revoked, 크리에이터 배열을 건너뛰고 isMutable 을 읽음', async () => {
    const mint = pk(), ua = pk();
    const r = await checkSummary(mint.toBase58(), mapFetcher({
      [mint.toBase58()]: { owner: SPL_TOKEN_PROGRAM, data: splMint() },
      [metaplexMetadataPda(mint).toBase58()]: { owner: METAPLEX_METADATA_PROGRAM, data: metaplexAcc(mint, ua, false) },
    }));
    const md = r.authorities.metadataUpdate;
    expect(md.status).toBe('revoked');
    expect(md.sources[0]).toMatchObject({ name: 'Name', symbol: 'SYM', uri: 'https://x', recordedUpdateAuthority: ua.toBase58() });
  });

  it('PausableConfig·NonTransferable·DefaultAccountState(frozen)·PermanentDelegate 해석', async () => {
    const mint = pk(), auth = pk(), del = pk();
    const data = t22Mint([
      { type: 26, data: Buffer.concat([auth.toBuffer(), Buffer.from([1])]) },
      { type: 9, data: Buffer.alloc(0) },
      { type: 6, data: Buffer.from([2]) },
      { type: 12, data: del.toBuffer() },
    ]);
    const r = await checkSummary(mint.toBase58(), mapFetcher({ [mint.toBase58()]: { owner: TOKEN_2022_PROGRAM, data } }));
    expect(r.token2022Extensions).toEqual(['PausableConfig', 'NonTransferable', 'DefaultAccountState', 'PermanentDelegate']);
    const by = Object.fromEntries(r.notableExtensions.map((n) => [n.name, n]));
    expect(by.PausableConfig.authorities.authority).toBe(auth.toBase58());
    expect(by.PausableConfig.config.paused).toBe(true);
    expect(by.DefaultAccountState.config.state).toBe('frozen');
    expect(by.PermanentDelegate.authorities.delegate).toBe(del.toBase58());
    expect(guardrailViolations(r)).toEqual([]);
  });

  it('모르는 확장 번호는 unknownExtensions + 확인 불가 메모', async () => {
    const mint = pk();
    const data = t22Mint([{ type: 99, data: Buffer.alloc(3) }]);
    const r = await checkSummary(mint.toBase58(), mapFetcher({ [mint.toBase58()]: { owner: TOKEN_2022_PROGRAM, data } }));
    expect(r.unknownExtensions).toEqual([99]);
    expect(r.notes.some((n) => n.includes('확인 불가'))).toBe(true);
  });

  it('포인터가 해석할 수 없는 외부 계정을 가리키면 unverifiable', async () => {
    const mint = pk(), target = pk();
    const data = t22Mint([{ type: 18, data: Buffer.concat([Buffer.alloc(32), target.toBuffer()]) }]);
    const r = await checkSummary(mint.toBase58(), mapFetcher({
      [mint.toBase58()]: { owner: TOKEN_2022_PROGRAM, data },
      [target.toBase58()]: { owner: pk(), data: Buffer.alloc(10) },
    }));
    expect(r.authorities.metadataUpdate.status).toBe('unverifiable');
  });

  it('민트가 아닌 계정은 NotAMintError', async () => {
    const a = pk();
    await expect(checkSummary(a.toBase58(), mapFetcher({ [a.toBase58()]: { owner: SPL_TOKEN_PROGRAM, data: Buffer.alloc(165) } })))
      .rejects.toBeInstanceOf(NotAMintError);
    await expect(checkSummary(a.toBase58(), mapFetcher({ [a.toBase58()]: { owner: pk(), data: Buffer.alloc(82) } })))
      .rejects.toBeInstanceOf(NotAMintError);
  });

  it('가드레일: 엔진 문구에 금지어가 있으면 잡고, 주소·토큰 이름은 무시', () => {
    expect(guardrailViolations({ notes: [DISCLAIMER_KO, 'this token is safe'] })).toContain('forbidden term: safe');
    expect(guardrailViolations({ notes: [DISCLAIMER_KO], a: 'BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG', name: 'SCAM coin' })).toEqual([]);
    expect(guardrailViolations({ notes: [] })).toContain('missing disclaimer');
    // 트랜잭션 서명(88자 base58) 안의 우연한 글자열도 무시
    expect(guardrailViolations({ notes: [DISCLAIMER_KO], txs: ['5rugXq3Ckd1N4wF9yTbkA7sZpQmVe2hRuLc8GjWx6YiUoP1nBtDa3fKs9vHgMzE4JqRwSxCyNdTb2aLu7kPmVnH'] })).toEqual([]);
    expect(guardrailViolations({ notes: [DISCLAIMER_KO, 'early buy wallets look like a rug'] })).toContain('forbidden term: rug');
  });
});
