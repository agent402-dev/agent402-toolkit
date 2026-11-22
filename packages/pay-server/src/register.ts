// `agent402-pay-server register`: makes the signed seller registration (/.well-known/agent402.json) from key files on this computer.
// Keys are read locally and never sent anywhere. Sign with the key that receives each lock (not the receiving wallet's key, unless it is the same).
import { readFileSync } from 'node:fs';
import { receiptSignerFromBytes } from './receipt.js';
import { signRegistration, type RegistrationDocument, type RegistrationPayload } from './registration.js';

export const REGISTER_HELP = `agent402-pay-server register  — make a signed seller registration (asset-neutral)

  --host <host>                    host buyers call, e.g. api.example.com (required)
  --pay-to <address>[,<address>]   receiving addresses (required)
  --lock <protocol>:<account>      a lock account; protocol jupiter-lock or streamflow (repeat for more)
  --key <file>                     Solana CLI key file of a lock recipient; signs the registration (repeat for more)
  --receipt-signer <public key>    receipt key buyers should expect (optional, repeatable)
  --expires-days <n>               expiry in days (optional)
  --out <file>                     write here (never overwrites); default: print to the terminal

Serve the output at https://<host>/.well-known/agent402.json. Keys stay on this computer.`;

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function buildRegistration(argv: string[], now = new Date(), read = (p: string) => readFileSync(p, 'utf8')): Promise<RegistrationDocument> {
  const all = (name: string) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));
  const one = (name: string) => all(name)[0];
  const host = one('--host');
  if (!host || /[/:]/.test(host.replace(/:\d+$/, ''))) throw new Error('--host is required (a host name such as api.example.com, no scheme or path)');
  const payTo = (one('--pay-to') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!payTo.length || payTo.some((a) => !BASE58.test(a))) throw new Error('--pay-to needs one or more Solana addresses');
  const locks = all('--lock').map((l) => {
    const [protocol, account] = l.split(':');
    if ((protocol !== 'jupiter-lock' && protocol !== 'streamflow') || !BASE58.test(account ?? '')) throw new Error(`--lock ${l}: use jupiter-lock:<account> or streamflow:<account>`);
    return { protocol, account } as RegistrationPayload['locks'][number];
  });
  const keyFiles = all('--key');
  if (locks.length && !keyFiles.length) throw new Error('--key is required: the lock recipient must sign, or buyers will not count the lock');
  const signers = await Promise.all(keyFiles.map(async (f) => {
    const bytes = Uint8Array.from(JSON.parse(read(f)) as number[]);
    try { return await receiptSignerFromBytes(bytes); } finally { bytes.fill(0); }
  }));
  const receiptSigners = all('--receipt-signer');
  if (receiptSigners.some((a) => !BASE58.test(a))) throw new Error('--receipt-signer needs a base58 public key');
  const days = Number(one('--expires-days'));
  return signRegistration({
    host, payTo, locks, issuedAt: now.toISOString(),
    ...(receiptSigners.length ? { receiptSigners } : {}),
    ...(days > 0 ? { expiresAt: new Date(now.getTime() + days * 86_400_000).toISOString() } : {}),
  }, signers);
}
