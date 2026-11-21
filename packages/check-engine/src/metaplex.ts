import { Reader } from './bytes.js';

/** Decodes only the first part of a Metaplex Token Metadata account (Key::MetadataV1 = 4). */
export interface MetaplexMetadata {
  updateAuthority: string;
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  isMutable: boolean;
}

const KEY_METADATA_V1 = 4;

export function decodeMetaplexMetadata(data: Buffer): MetaplexMetadata {
  const r = new Reader(data);
  const key = r.u8();
  if (key !== KEY_METADATA_V1) throw new Error(`not a Metaplex MetadataV1 account (key ${key})`);
  const updateAuthority = r.pubkey().toBase58();
  const mint = r.pubkey().toBase58();
  const name = r.string();
  const symbol = r.string();
  const uri = r.string();
  r.u16(); // seller_fee_basis_points
  if (r.bool()) {
    const n = r.u32();
    r.bytes(n * 34); // Creator { address: Pubkey, verified: bool, share: u8 }
  }
  r.bool(); // primary_sale_happened
  const isMutable = r.bool();
  return { updateAuthority, mint, name, symbol, uri, isMutable };
}
