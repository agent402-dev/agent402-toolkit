import { Reader } from './bytes.js';
import type { TlvEntry } from './mint.js';

/** Token-2022 확장 번호 → 이름 (spl token-2022 ExtensionType 순서) */
export const EXTENSION_NAMES: Record<number, string> = {
  1: 'TransferFeeConfig',
  2: 'TransferFeeAmount',
  3: 'MintCloseAuthority',
  4: 'ConfidentialTransferMint',
  5: 'ConfidentialTransferAccount',
  6: 'DefaultAccountState',
  7: 'ImmutableOwner',
  8: 'MemoTransfer',
  9: 'NonTransferable',
  10: 'InterestBearingConfig',
  11: 'CpiGuard',
  12: 'PermanentDelegate',
  13: 'NonTransferableAccount',
  14: 'TransferHook',
  15: 'TransferHookAccount',
  16: 'ConfidentialTransferFeeConfig',
  17: 'ConfidentialTransferFeeAmount',
  18: 'MetadataPointer',
  19: 'TokenMetadata',
  20: 'GroupPointer',
  21: 'TokenGroup',
  22: 'GroupMemberPointer',
  23: 'TokenGroupMember',
  24: 'ConfidentialMintBurn',
  25: 'ScaledUiAmountConfig',
  26: 'PausableConfig',
  27: 'PausableAccount',
  28: 'PermissionedBurn',
};

export function extensionName(type: number): string {
  return EXTENSION_NAMES[type] ?? `Unknown(${type})`;
}

/**
 * 보유자의 토큰 이동·잔액·표시 금액에 영향을 줄 수 있는 확장.
 * 판단(좋다/나쁘다)이 아니라 "이 확장이 무엇을 할 수 있게 하는가" 라는 사실만 적습니다.
 */
export interface NotableExtension {
  name: string;
  /** 이 확장이 허용하는 동작 (사실 서술) */
  effect: string;
  /** 설정을 바꾸거나 동작을 실행할 수 있는 권한자 주소. 없으면 null */
  authorities: Record<string, string | null>;
  /** 확장별 현재 설정값 */
  config: Record<string, unknown>;
}

const DEFAULT_ACCOUNT_STATES = ['uninitialized', 'initialized', 'frozen'] as const;

/** 해석 결과 중 메타데이터·포인터 관련 값 (항목 3 에서 사용) */
export interface MetadataPointerInfo {
  authority: string | null;
  metadataAddress: string | null;
}

export interface TokenMetadataInfo {
  updateAuthority: string | null;
  mint: string;
  name: string;
  symbol: string;
  uri: string;
}

export function decodeMetadataPointer(data: Buffer): MetadataPointerInfo {
  const r = new Reader(data);
  return { authority: r.optionalNonZeroPubkey(), metadataAddress: r.optionalNonZeroPubkey() };
}

export function decodeTokenMetadata(data: Buffer): TokenMetadataInfo {
  const r = new Reader(data);
  const updateAuthority = r.optionalNonZeroPubkey();
  const mint = r.pubkey().toBase58();
  const name = r.string();
  const symbol = r.string();
  const uri = r.string();
  return { updateAuthority, mint, name, symbol, uri };
}

function transferFee(r: Reader) {
  const epoch = r.u64();
  const maximumFee = r.u64();
  const basisPoints = r.u16();
  return { epoch: epoch.toString(), maximumFee: maximumFee.toString(), basisPoints };
}

/** 영향 확장 하나를 해석합니다. 영향 확장이 아니면 null. */
export function decodeNotable(e: TlvEntry): NotableExtension | null {
  const name = extensionName(e.type);
  const r = new Reader(e.data);
  switch (e.type) {
    case 1: {
      const transferFeeConfigAuthority = r.optionalNonZeroPubkey();
      const withdrawWithheldAuthority = r.optionalNonZeroPubkey();
      const withheldAmount = r.u64();
      const older = transferFee(r);
      const newer = transferFee(r);
      return {
        name,
        effect: '전송할 때마다 설정된 비율(basis points, 최대치 있음)만큼 수수료가 떼어져 보관되고, 인출 권한자가 이를 인출할 수 있음. 설정 권한자는 수수료율을 바꿀 수 있음(다음 에포크 이후 적용)',
        authorities: { transferFeeConfigAuthority, withdrawWithheldAuthority },
        config: { olderTransferFee: older, newerTransferFee: newer, withheldAmountOnMint: withheldAmount.toString() },
      };
    }
    case 3:
      return {
        name,
        effect: '공급량이 0 일 때 권한자가 민트 계정을 닫을 수 있음',
        authorities: { closeAuthority: r.optionalNonZeroPubkey() },
        config: {},
      };
    case 4: {
      const authority = r.optionalNonZeroPubkey();
      const autoApproveNewAccounts = r.bool();
      const auditorElgamalPubkey = r.bytes(32).some((b) => b !== 0) ? 'set' : null;
      return {
        name,
        effect: '기밀 전송(금액 비공개)을 사용할 수 있음. 권한자는 계정별 기밀 전송 승인과 감사자 키를 설정할 수 있음',
        authorities: { authority },
        config: { autoApproveNewAccounts, auditorElgamalPubkey },
      };
    }
    case 6: {
      const s = r.u8();
      const state = DEFAULT_ACCOUNT_STATES[s] ?? `unknown(${s})`;
      return {
        name,
        effect:
          state === 'frozen'
            ? '새로 만들어지는 토큰 계정이 동결 상태로 시작함. 프리즈 권한자가 풀어 주어야 전송 가능'
            : '새 토큰 계정의 기본 상태를 지정함 (현재 값은 config.state)',
        authorities: {},
        config: { state },
      };
    }
    case 9:
      return { name, effect: '토큰을 다른 계정으로 전송할 수 없음', authorities: {}, config: {} };
    case 10: {
      const rateAuthority = r.optionalNonZeroPubkey();
      const initializationTimestamp = r.i64();
      const preUpdateAverageRate = r.i16();
      const lastUpdateTimestamp = r.i64();
      const currentRate = r.i16();
      return {
        name,
        effect: '표시 금액(UI amount)에 이자율이 반영됨. 실제 원장 수량은 바뀌지 않음. 권한자가 이자율을 바꿀 수 있음',
        authorities: { rateAuthority },
        config: {
          currentRateBps: currentRate,
          preUpdateAverageRateBps: preUpdateAverageRate,
          initializationTimestamp: initializationTimestamp.toString(),
          lastUpdateTimestamp: lastUpdateTimestamp.toString(),
        },
      };
    }
    case 12:
      return {
        name,
        effect: '영구 위임자가 어느 보유 계정에서든 소유자 서명 없이 토큰을 옮기거나 소각할 수 있음',
        authorities: { delegate: r.optionalNonZeroPubkey() },
        config: {},
      };
    case 14: {
      const authority = r.optionalNonZeroPubkey();
      const programId = r.optionalNonZeroPubkey();
      return {
        name,
        effect: '전송할 때마다 지정된 프로그램이 함께 실행되며, 그 프로그램이 전송을 거부할 수 있음. 권한자는 실행할 프로그램을 바꿀 수 있음',
        authorities: { authority },
        config: { programId },
      };
    }
    case 16:
      return {
        name,
        effect: '기밀 전송 수수료 설정. 권한자가 기밀 수수료 인출 설정을 바꿀 수 있음',
        authorities: { authority: r.optionalNonZeroPubkey() },
        config: {},
      };
    case 24:
      return {
        name,
        effect: '기밀(금액 비공개) 발행·소각을 사용할 수 있음',
        authorities: {},
        config: {},
      };
    case 25: {
      const authority = r.optionalNonZeroPubkey();
      const multiplier = r.f64();
      const newMultiplierEffectiveTimestamp = r.i64();
      const newMultiplier = r.f64();
      return {
        name,
        effect: '표시 금액(UI amount)에 배수가 곱해짐. 실제 원장 수량은 바뀌지 않음. 권한자가 배수를 바꿀 수 있음',
        authorities: { authority },
        config: {
          multiplier,
          newMultiplier,
          newMultiplierEffectiveTimestamp: newMultiplierEffectiveTimestamp.toString(),
        },
      };
    }
    case 26: {
      const authority = r.optionalNonZeroPubkey();
      const paused = r.bool();
      return {
        name,
        effect: '권한자가 이 토큰의 발행·전송·소각을 일시 정지할 수 있음',
        authorities: { authority },
        config: { paused },
      };
    }
    case 28:
      return {
        name,
        effect: '소각할 때 권한자의 서명이 필요함',
        authorities: { authority: r.optionalNonZeroPubkey() },
        config: {},
      };
    default:
      return null;
  }
}

/** 이름에 등록되지 않은 확장 번호 — 알 수 없으므로 "확인 불가" 로 별도 표시 */
export function isUnknownExtension(type: number): boolean {
  return !(type in EXTENSION_NAMES);
}
