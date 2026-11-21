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

export const DISCLAIMER_EN = 'Factual information from public on-chain data. Not investment advice.';

export interface RawAccount {
  owner: string;
  data: Buffer;
}
/** Reads a list of addresses at the same slot. Missing accounts are null. */
export type AccountFetcher = (addresses: string[]) => Promise<{ slot: number; accounts: (RawAccount | null)[] }>;

export interface MetadataSource {
  standard: 'token-2022' | 'metaplex' | 'unknown';
  account: string;
  /** Authority that can change this metadata now. null if none or if it can no longer be changed */
  updateAuthority: string | null;
  /** Metaplex only: if false, the metadata can no longer be changed even if an authority exists */
  isMutable?: boolean;
  /** Metaplex only: authority address recorded in the account (kept even if isMutable=false) */
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
      /** Addresses that can change the metadata and their roles */
      holders: { role: string; address: string }[];
      metadataPointer: { authority: string | null; metadataAddress: string | null } | null;
      sources: MetadataSource[];
    };
  };
  token2022Extensions: string[];
  /** Extensions that can affect holders' transfers, balances or displayed amounts, and their settings */
  notableExtensions: NotableExtension[];
  /** Extension numbers this reader does not know (unavailable) */
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
  const mintKey = new PublicKey(mintAddress); // throws here on a malformed address
  const mint = mintKey.toBase58();
  const metaplexPda = metaplexMetadataPda(mintKey).toBase58();

  const first = await fetch([mint, metaplexPda]);
  const [mintAcc, metaplexAcc] = first.accounts;
  let slot = first.slot;
  if (!mintAcc) throw new MintNotFoundError(`account ${mint} not found`);

  const decoded = decodeMint(mintAcc.data, new PublicKey(mintAcc.owner));
  const evidence: SummaryReport['evidence'] = [{ account: mint, role: 'mint', owner: mintAcc.owner }];
  const notes: string[] = [DISCLAIMER_EN];

  // Section 4: extensions
  const token2022Extensions = decoded.tlv.map((e) => extensionName(e.type));
  const notableExtensions = decoded.tlv.map(decodeNotable).filter((x): x is NotableExtension => x !== null);
  const unknownExtensions = decoded.tlv.filter((e) => isUnknownExtension(e.type)).map((e) => e.type);
  if (unknownExtensions.length) {
    notes.push(`This mint has Token-2022 extension numbers this reader cannot decode: ${unknownExtensions.join(', ')} (unavailable)`);
  }

  // Section 3: metadata update authority
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
    evidence.push({ account: metaplexPda, role: 'metaplex-metadata (none)', owner: metaplexAcc?.owner ?? null });
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
      notes.push(`Could not decode the format of account ${ptrAddr} that the metadata pointer points to (unavailable)`);
    }
  }
  if (ptrAddr === mint && !tokenMetaTlv) {
    notes.push('The metadata pointer points to the mint itself, but the mint has no TokenMetadata extension');
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
      'Metaplex metadata cannot clear its authority address, so isMutable=false is treated as "revoked" (cannot be changed). The address recorded in recordedUpdateAuthority is still shown',
    );
  }
  if (metadataPointer?.authority) {
    notes.push('metadata-pointer-authority is the address that can change which account the metadata pointer points to');
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
