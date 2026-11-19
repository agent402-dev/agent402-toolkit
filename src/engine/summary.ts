import { PublicKey } from '@solana/web3.js';
import { decodeMint, NotAMintError, type TokenProgramKind } from './mint.js';
import {
  decodeMetadataPointer,
  decodeNotable,
  decodeTokenMetadata,
  extensionName,
  isUnknownExtension,
  type NotableExtension,
} from './extensions.js';
import { decodeMetaplexMetadata } from './metaplex.js';
import { METAPLEX_METADATA_PROGRAM, metaplexMetadataPda } from './programs.js';

export const DISCLAIMER_KO = '공개 온체인 데이터에 따른 사실 정보이며 투자 권유가 아닙니다.';
export const DISCLAIMER_EN = 'Factual information from public on-chain data. Not investment advice.';

export interface RawAccount {
  owner: string;
  data: Buffer;
}
/** 주소 목록을 같은 슬롯 기준으로 읽어 오는 함수. 없는 계정은 null. */
export type AccountFetcher = (addresses: string[]) => Promise<{ slot: number; accounts: (RawAccount | null)[] }>;

export interface MetadataSource {
  standard: 'token-2022' | 'metaplex' | 'unknown';
  account: string;
  /** 지금 이 메타데이터를 바꿀 수 있는 권한자. 없거나 바꿀 수 없으면 null */
  updateAuthority: string | null;
  /** Metaplex 만: false 면 권한자가 있어도 더 이상 바꿀 수 없음 */
  isMutable?: boolean;
  /** Metaplex 만: 계정에 기록된 권한자 주소 (isMutable=false 여도 남아 있음) */
  recordedUpdateAuthority?: string;
  name?: string;
  symbol?: string;
  uri?: string;
}

export interface SummaryReport {
  mint: string;
  checkedAt: string;
  slot: number;
  tokenProgram: TokenProgramKind;
  supply: string;
  decimals: number;
  authorities: {
    mint: { status: 'revoked' | 'present'; address: string | null };
    freeze: { status: 'none' | 'present'; address: string | null };
    metadataUpdate: {
      status: 'revoked' | 'present' | 'not_found' | 'unverifiable';
      /** 메타데이터를 바꿀 수 있는 주소와 그 역할 */
      holders: { role: string; address: string }[];
      metadataPointer: { authority: string | null; metadataAddress: string | null } | null;
      sources: MetadataSource[];
    };
  };
  token2022Extensions: string[];
  /** 보유자의 전송·잔액·표시 금액에 영향을 줄 수 있는 확장과 그 설정 */
  notableExtensions: NotableExtension[];
  /** 이 판독기가 모르는 확장 번호 (확인 불가) */
  unknownExtensions: number[];
  evidence: { account: string; role: string; owner: string | null }[];
  notes: string[];
}

export class MintNotFoundError extends Error {}

export async function checkSummary(
  mintAddress: string,
  fetch: AccountFetcher,
  now: () => Date = () => new Date(),
): Promise<SummaryReport> {
  const mintKey = new PublicKey(mintAddress); // 형식 오류면 여기서 예외
  const mint = mintKey.toBase58();
  const metaplexPda = metaplexMetadataPda(mintKey).toBase58();

  const first = await fetch([mint, metaplexPda]);
  const [mintAcc, metaplexAcc] = first.accounts;
  let slot = first.slot;
  if (!mintAcc) throw new MintNotFoundError(`account ${mint} not found`);

  const decoded = decodeMint(mintAcc.data, new PublicKey(mintAcc.owner));
  const evidence: SummaryReport['evidence'] = [{ account: mint, role: 'mint', owner: mintAcc.owner }];
  const notes: string[] = [DISCLAIMER_KO, DISCLAIMER_EN];

  // 항목 4: 확장
  const token2022Extensions = decoded.tlv.map((e) => extensionName(e.type));
  const notableExtensions = decoded.tlv.map(decodeNotable).filter((x): x is NotableExtension => x !== null);
  const unknownExtensions = decoded.tlv.filter((e) => isUnknownExtension(e.type)).map((e) => e.type);
  if (unknownExtensions.length) {
    notes.push(`이 판독기가 해석하지 못하는 Token-2022 확장 번호가 있습니다: ${unknownExtensions.join(', ')} (확인 불가)`);
  }

  // 항목 3: 메타데이터 수정 권한
  const sources: MetadataSource[] = [];
  const pointerTlv = decoded.tlv.find((e) => e.type === 18);
  const metadataPointer = pointerTlv ? decodeMetadataPointer(pointerTlv.data) : null;
  const tokenMetaTlv = decoded.tlv.find((e) => e.type === 19);
  if (tokenMetaTlv) {
    const tm = decodeTokenMetadata(tokenMetaTlv.data);
    sources.push({
      standard: 'token-2022',
      account: mint,
      updateAuthority: tm.updateAuthority,
      name: tm.name,
      symbol: tm.symbol,
      uri: tm.uri,
    });
  }

  const pushMetaplex = (account: string, acc: RawAccount, role: string) => {
    evidence.push({ account, role, owner: acc.owner });
    const mp = decodeMetaplexMetadata(acc.data);
    if (mp.mint !== mint) throw new Error(`Metaplex metadata ${account} belongs to ${mp.mint}, not ${mint}`);
    sources.push({
      standard: 'metaplex',
      account,
      updateAuthority: mp.isMutable ? mp.updateAuthority : null,
      isMutable: mp.isMutable,
      recordedUpdateAuthority: mp.updateAuthority,
      name: mp.name,
      symbol: mp.symbol,
      uri: mp.uri,
    });
  };

  if (metaplexAcc && metaplexAcc.owner === METAPLEX_METADATA_PROGRAM.toBase58()) {
    pushMetaplex(metaplexPda, metaplexAcc, 'metaplex-metadata');
  } else {
    evidence.push({ account: metaplexPda, role: 'metaplex-metadata (없음)', owner: metaplexAcc?.owner ?? null });
  }

  let unverifiable = false;
  const ptrAddr = metadataPointer?.metadataAddress ?? null;
  if (ptrAddr && ptrAddr !== mint && ptrAddr !== metaplexPda) {
    const extra = await fetch([ptrAddr]);
    slot = Math.max(slot, extra.slot);
    const acc = extra.accounts[0];
    if (acc && acc.owner === METAPLEX_METADATA_PROGRAM.toBase58()) {
      pushMetaplex(ptrAddr, acc, 'metadata-pointer-target');
    } else {
      unverifiable = true;
      evidence.push({ account: ptrAddr, role: 'metadata-pointer-target', owner: acc?.owner ?? null });
      sources.push({ standard: 'unknown', account: ptrAddr, updateAuthority: null });
      notes.push(`메타데이터 포인터가 가리키는 계정 ${ptrAddr} 의 형식을 해석하지 못했습니다 (확인 불가)`);
    }
  }
  if (ptrAddr === mint && !tokenMetaTlv) {
    notes.push('메타데이터 포인터가 민트 자신을 가리키지만 TokenMetadata 확장이 없습니다');
  }

  const holders: { role: string; address: string }[] = [];
  for (const s of sources) {
    if (s.updateAuthority) holders.push({ role: `${s.standard}-update-authority`, address: s.updateAuthority });
  }
  if (metadataPointer?.authority) {
    holders.push({ role: 'metadata-pointer-authority', address: metadataPointer.authority });
  }
  let metaStatus: SummaryReport['authorities']['metadataUpdate']['status'];
  if (holders.length) metaStatus = 'present';
  else if (unverifiable) metaStatus = 'unverifiable';
  else if (sources.length === 0) metaStatus = 'not_found';
  else metaStatus = 'revoked';

  if (sources.some((s) => s.standard === 'metaplex')) {
    notes.push(
      'Metaplex 메타데이터는 권한자 주소를 지울 수 없어서, isMutable=false 이면 "revoked"(수정 불가)로 봅니다. 이때도 recordedUpdateAuthority 에 기록된 주소는 그대로 보여 줍니다',
    );
  }
  if (metadataPointer?.authority) {
    notes.push('metadata-pointer-authority 는 메타데이터 포인터가 가리키는 계정을 바꿀 수 있는 주소입니다');
  }

  return {
    mint,
    checkedAt: now().toISOString(),
    slot,
    tokenProgram: decoded.program,
    supply: decoded.supply.toString(),
    decimals: decoded.decimals,
    authorities: {
      mint: { status: decoded.mintAuthority ? 'present' : 'revoked', address: decoded.mintAuthority },
      freeze: { status: decoded.freezeAuthority ? 'present' : 'none', address: decoded.freezeAuthority },
      metadataUpdate: { status: metaStatus, holders, metadataPointer, sources },
    },
    token2022Extensions,
    notableExtensions,
    unknownExtensions,
    evidence,
    notes,
  };
}

export { NotAMintError };
