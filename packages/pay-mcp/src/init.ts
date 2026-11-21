// `pay-mcp init`: creates a dedicated payment wallet key file on this computer and prints how to fund, back up and connect it.
// The key is generated locally and never sent anywhere. An existing file is never overwritten.
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { policyFromEnv } from './policy.js';

export const DEFAULT_WALLET_PATH = join(homedir(), '.agent402', 'pay-wallet.json');

export interface InitOptions { path?: string; network?: 'mainnet' | 'devnet' }
export interface InitResult { path: string; address: string; network: 'mainnet' | 'devnet'; text: string }

export async function initWallet(o: InitOptions = {}): Promise<InitResult> {
  const path = resolve(o.path ?? DEFAULT_WALLET_PATH);
  const network = o.network === 'devnet' ? 'devnet' : 'mainnet';
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  // Solana CLI key file format: 64 bytes = 32-byte secret seed + 32-byte public key
  const bytes = Uint8Array.from([...seed, ...pub]);
  let address: string;
  try {
    address = (await createKeyPairSignerFromBytes(bytes)).address; // also checks that the public key matches the seed
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(Array.from(bytes)), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`A file already exists at ${path}. It was not changed. Use --path to choose another file.`);
    throw e;
  } finally {
    bytes.fill(0);
    seed.fill(0);
  }
  const usdc = policyFromEnv({ X402_NETWORK: network }).mints.USDC;
  const connect = [
    'claude mcp add a402-pay',
    `-e X402_KEYPAIR_PATH="${path}"`,
    ...(network === 'devnet' ? ['-e X402_NETWORK=devnet'] : []),
    '-e X402_ALLOWED_DOMAINS=<api.example.com>',
    '-e X402_TRUSTED_PAY_TO=<recipient address>',
    '-e X402_MAX_USD=0.05 -e X402_MAX_USD_PER_DAY=1',
    '-- npx -y @agent402-dev/pay-mcp',
  ].join(' ');
  const text = [
    `Created a payment wallet for @agent402-dev/pay-mcp (${network}).`,
    '',
    `  Address:  ${address}`,
    `  Key file: ${path}`,
    '',
    '1. Fund it with a small amount of USDC only: what you are willing to let the agent spend (for example 1-5 USDC).',
    '   No SOL is needed: the x402 facilitator pays the network fee.',
    `   Send USDC on Solana ${network} to ${address}`,
    `   Solana Pay link: solana:${address}?spl-token=${usdc}`,
    '',
    '2. Back up the key file. Anyone who has this file can spend from this wallet.',
    '   There is no seed phrase: copy the file to an offline place you control.',
    '   Never upload it, commit it to a repository or paste it into a chat.',
    '',
    '3. Connect it (Claude Code shown). Payments stay refused until you set both allowlists:',
    `   ${connect}`,
    '',
    '   These limits allow at most 0.05 USDC per payment and 1 USDC per UTC day.',
    '   Optional: X402_MAX_USD_PER_RECIPIENT_PER_DAY caps the daily total per recipient;',
    '   X402_CONFIRM_ABOVE_USD asks you before larger payments (needs a client that supports MCP elicitation).',
    '   Check the wallet any time with the wallet_status tool.',
  ].join('\n');
  return { path, address, network, text };
}
