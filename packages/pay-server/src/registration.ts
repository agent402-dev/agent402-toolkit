// Seller registration (Agent402 standard, asset-neutral): the JSON document a seller serves at https://<host>/.well-known/agent402.json
// It lists the receiving addresses and lock accounts, and each lock's recipient key signs it (so nobody can claim someone else's lock).
// @agent402-dev/pay-mcp reads it when a buyer requires a seller lock. Signing happens offline with the lock recipient's key; the gate never needs it.
import { b64url, type ReceiptSigner } from './receipt.js';

export const REGISTRATION_PATH = '/.well-known/agent402.json';
export const REGISTRATION_KIND = 'agent402.seller-registration';

export interface RegistrationPayload {
  v: 1;
  kind: typeof REGISTRATION_KIND;
  /** Host buyers call (e.g. api.example.com), lowercase */
  host: string;
  payTo: string[];
  locks: { protocol: 'jupiter-lock' | 'streamflow'; account: string }[];
  receiptSigners?: string[];
  issuedAt: string;
  expiresAt?: string;
}

export interface RegistrationDocument { v: 1; payload: string; signatures: { signer: string; sig: string }[] }

/** Signs a registration with each given key (usually the recipient key of every lock) */
export async function signRegistration(
  p: Omit<RegistrationPayload, 'v' | 'kind' | 'issuedAt'> & { issuedAt?: string },
  signers: ReceiptSigner[],
): Promise<RegistrationDocument> {
  const payload: RegistrationPayload = { v: 1, kind: REGISTRATION_KIND, ...p, host: p.host.toLowerCase(), issuedAt: p.issuedAt ?? new Date().toISOString() };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const signatures = await Promise.all(signers.map(async (s) => ({ signer: s.publicKey, sig: b64url(await s.sign(bytes)) })));
  return { v: 1, payload: b64url(bytes), signatures };
}
