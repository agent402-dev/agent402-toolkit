import { PublicKey } from '@solana/web3.js';
import { Reader } from './bytes.js';
import { SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from './programs.js';

/** 기본 민트 레이아웃 크기 (SPL Token, Token-2022 공통) */
export const MINT_BASE_SIZE = 82;
/** Token-2022: 확장이 있으면 계정 크기를 165 바이트(토큰 계정 크기)까지 채운 뒤 AccountType 1바이트, 이어서 TLV */
const ACCOUNT_TYPE_OFFSET = 165;
const ACCOUNT_TYPE_MINT = 1;

export type TokenProgramKind = 'spl-token' | 'token-2022';

export interface TlvEntry {
  type: number;
  data: Buffer;
}

export interface DecodedMint {
  program: TokenProgramKind;
  mintAuthority: string | null;
  supply: bigint;
  decimals: number;
  isInitialized: boolean;
  freezeAuthority: string | null;
  tlv: TlvEntry[];
}

export class NotAMintError extends Error {}

function readCOptionPubkey(r: Reader): string | null {
  const tag = r.u32();
  const key = r.pubkey();
  if (tag === 0) return null;
  if (tag !== 1) throw new NotAMintError(`invalid COption tag ${tag}`);
  return key.toBase58();
}

export function programKind(owner: PublicKey): TokenProgramKind | null {
  if (owner.equals(SPL_TOKEN_PROGRAM)) return 'spl-token';
  if (owner.equals(TOKEN_2022_PROGRAM)) return 'token-2022';
  return null;
}

/** 민트 계정 원본 바이트를 해석합니다. owner 가 토큰 프로그램이 아니거나 민트가 아니면 NotAMintError. */
export function decodeMint(data: Buffer, owner: PublicKey): DecodedMint {
  const program = programKind(owner);
  if (!program) throw new NotAMintError(`account owner ${owner.toBase58()} is not a token program`);
  if (data.length < MINT_BASE_SIZE) throw new NotAMintError(`account too small for a mint (${data.length} bytes)`);
  if (program === 'spl-token' && data.length !== MINT_BASE_SIZE) {
    throw new NotAMintError(`SPL Token account of ${data.length} bytes is not a mint`);
  }

  const r = new Reader(data);
  const mintAuthority = readCOptionPubkey(r);
  const supply = r.u64();
  const decimals = r.u8();
  const isInitialized = r.bool();
  const freezeAuthority = readCOptionPubkey(r);
  if (!isInitialized) throw new NotAMintError('mint is not initialized');

  const tlv: TlvEntry[] = [];
  if (program === 'token-2022' && data.length > MINT_BASE_SIZE) {
    if (data.length <= ACCOUNT_TYPE_OFFSET) throw new NotAMintError('token-2022 account with invalid extension layout');
    const accountType = data[ACCOUNT_TYPE_OFFSET];
    if (accountType !== ACCOUNT_TYPE_MINT) throw new NotAMintError(`token-2022 account type ${accountType} is not a mint`);
    const t = new Reader(data, ACCOUNT_TYPE_OFFSET + 1);
    while (t.remaining() >= 4) {
      const type = t.u16();
      const len = t.u16();
      if (type === 0) break; // Uninitialized: 이후는 빈 공간
      tlv.push({ type, data: Buffer.from(t.bytes(len)) });
    }
  }

  return { program, mintAuthority, supply, decimals, isInitialized, freezeAuthority, tlv };
}
