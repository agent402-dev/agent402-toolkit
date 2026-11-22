// Seller registration (Agent402 standard, asset-neutral): https://<seller host>/.well-known/agent402.json
// { "v": 1, "payload": "<base64url JSON>", "signatures": [{ "signer": "<base58 key>", "sig": "<base64url Ed25519 signature over the payload bytes>" }] }
// Payload: { v: 1, kind: "agent402.seller-registration", host, payTo: [...], locks: [{ protocol: "jupiter-lock" | "streamflow", account }], receiptSigners?: [...], issuedAt, expiresAt? }
// Each lock counts only if its recipient key signed the payload, so nobody can claim someone else's lock.
import { getBase58Encoder } from '@solana/kit';

export const REGISTRATION_PATH = '/.well-known/agent402.json';
export const REGISTRATION_KIND = 'agent402.seller-registration';

export interface RegistrationPayload {
  v: 1;
  kind: typeof REGISTRATION_KIND;
  host: string;
  payTo: string[];
  locks: { protocol: 'jupiter-lock' | 'streamflow'; account: string }[];
  receiptSigners?: string[];
  issuedAt: string;
  expiresAt?: string;
}

export type VerifiedRegistration = { ok: true; payload: RegistrationPayload; signers: Set<string> } | { ok: false; reason: string };

const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));

export async function verifyRegistration(doc: unknown, host: string, now: Date): Promise<VerifiedRegistration> {
  const d = doc as { v?: number; payload?: string; signatures?: { signer?: string; sig?: string }[] };
  if (!d || d.v !== 1 || typeof d.payload !== 'string' || !Array.isArray(d.signatures)) return { ok: false, reason: 'registration_malformed' };
  const bytes = b64(d.payload);
  let p: RegistrationPayload;
  try { p = JSON.parse(new TextDecoder().decode(bytes)); } catch { return { ok: false, reason: 'registration_malformed' }; }
  if (p.v !== 1 || p.kind !== REGISTRATION_KIND || !Array.isArray(p.payTo) || !Array.isArray(p.locks)) return { ok: false, reason: 'registration_unknown_format' };
  if (String(p.host).toLowerCase() !== host.toLowerCase()) return { ok: false, reason: `registration_host_mismatch: ${p.host}` };
  if (p.expiresAt && Date.parse(p.expiresAt) <= now.getTime()) return { ok: false, reason: 'registration_expired' };
  const signers = new Set<string>();
  for (const s of d.signatures.slice(0, 16)) {
    if (typeof s?.signer !== 'string' || typeof s.sig !== 'string') continue;
    try {
      const key = await crypto.subtle.importKey('raw', getBase58Encoder().encode(s.signer) as BufferSource, { name: 'Ed25519' }, false, ['verify']);
      if (await crypto.subtle.verify('Ed25519', key, b64(s.sig) as BufferSource, bytes as BufferSource)) signers.add(s.signer);
    } catch { /* invalid key or signature: ignored */ }
  }
  return { ok: true, payload: p, signers };
}
