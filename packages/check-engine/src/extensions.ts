import { Reader } from './bytes.js';
import type { TlvEntry } from './mint.js';

/** Token-2022 extension number to name (spl token-2022 ExtensionType order) */
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
  * Extensions that can affect holders' transfers, balances or displayed amounts.
  * Records only the fact of what the extension allows, not a judgement (good or bad).
 */
export interface NotableExtension {
  name: string;
  /** What this extension allows (factual description) */
  effect: string;
  /** Authority addresses that can change settings or perform the action. null if none */
  authorities: Record<string, string | null>;
  /** Current settings for each extension */
  config: Record<string, unknown>;
}

const DEFAULT_ACCOUNT_STATES = ['uninitialized', 'initialized', 'frozen'] as const;

/** Metadata and pointer values from the decoded result (used in section 3) */
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

/** Decodes one notable extension. null if it is not a notable extension. */
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
        effect: 'A fee at the configured rate (basis points, capped) is withheld on every transfer, and the withdraw authority can withdraw it. The config authority can change the fee rate (applies from a later epoch)',
        authorities: { transferFeeConfigAuthority, withdrawWithheldAuthority },
        config: { olderTransferFee: older, newerTransferFee: newer, withheldAmountOnMint: withheldAmount.toString() },
      };
    }
    case 3:
      return {
        name,
        effect: 'The authority can close the mint account when supply is 0',
        authorities: { closeAuthority: r.optionalNonZeroPubkey() },
        config: {},
      };
    case 4: {
      const authority = r.optionalNonZeroPubkey();
      const autoApproveNewAccounts = r.bool();
      const auditorElgamalPubkey = r.bytes(32).some((b) => b !== 0) ? 'set' : null;
      return {
        name,
        effect: 'Confidential transfers (hidden amounts) can be used. The authority can set per-account approval for confidential transfers and the auditor key',
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
            ? 'New token accounts start frozen. The freeze authority must thaw them before they can transfer'
            : 'Sets the default state of new token accounts (current value is config.state)',
        authorities: {},
        config: { state },
      };
    }
    case 9:
      return { name, effect: 'Tokens cannot be transferred to another account', authorities: {}, config: {} };
    case 10: {
      const rateAuthority = r.optionalNonZeroPubkey();
      const initializationTimestamp = r.i64();
      const preUpdateAverageRate = r.i16();
      const lastUpdateTimestamp = r.i64();
      const currentRate = r.i16();
      return {
        name,
        effect: 'The displayed amount (UI amount) reflects an interest rate. The ledger amount does not change. The authority can change the rate',
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
        effect: 'The permanent delegate can move or burn tokens from any holder account without the owner signature',
        authorities: { delegate: r.optionalNonZeroPubkey() },
        config: {},
      };
    case 14: {
      const authority = r.optionalNonZeroPubkey();
      const programId = r.optionalNonZeroPubkey();
      return {
        name,
        effect: 'A designated program runs on every transfer and can reject the transfer. The authority can change the program',
        authorities: { authority },
        config: { programId },
      };
    }
    case 16:
      return {
        name,
        effect: 'Confidential transfer fee settings. The authority can change the confidential fee withdraw settings',
        authorities: { authority: r.optionalNonZeroPubkey() },
        config: {},
      };
    case 24:
      return {
        name,
        effect: 'Confidential (hidden amount) mint and burn can be used',
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
        effect: 'The displayed amount (UI amount) is multiplied by a multiplier. The ledger amount does not change. The authority can change the multiplier',
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
        effect: 'The authority can pause minting, transfers and burning of this token',
        authorities: { authority },
        config: { paused },
      };
    }
    case 28:
      return {
        name,
        effect: 'Burning requires the authority signature',
        authorities: { authority: r.optionalNonZeroPubkey() },
        config: {},
      };
    default:
      return null;
  }
}

/** Extension numbers not in the name table: unknown, so shown separately as "unavailable" */
export function isUnknownExtension(type: number): boolean {
  return !(type in EXTENSION_NAMES);
}
