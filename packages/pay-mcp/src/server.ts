#!/usr/bin/env node
// @agent402-dev/pay-mcp. With no command it runs the MCP server (stdio), configured with environment variables: policy.ts PolicyEnv and the following:
//   X402_KEYPAIR_PATH  payment wallet key file (Solana CLI JSON). Without it, no payments (x402_quote only)
//   X402_RPC_URL       RPC used to build payment transactions (public RPC if unset)
//   X402_HISTORY_PATH  payment history JSONL (default ~/.agent402/payments.jsonl)
// Allowlists (X402_ALLOWED_DOMAINS, X402_TRUSTED_PAY_TO) default to empty = reject everything
// Commands: init (create a dedicated payment wallet key file), export-csv (payment history as CSV), verify-receipt, help
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { historyToCsv } from './csv.js';
import { jsonlHistory } from './history.js';
import { rpcAccounts } from './locks.js';
import { rpcClock } from './bond.js';
import { bondPolicyFromEnv, bondRpc } from './bond-sign.js';
import { initWallet } from './init.js';
import { policyFromEnv } from './policy.js';
import { createPayServer } from './tools.js';
import { rpcReadTx, verifyReceipt, type ChainTx } from './verify-receipt.js';

/** X402_BOND_DIRECTORY_URL: unset = the default directory, "off" = bond_find_sellers refuses, otherwise an https URL */
function directoryUrlFromEnv(v: string | undefined): string | null | undefined {
  const t = v?.trim();
  if (!t) return undefined;
  if (t.toLowerCase() === 'off') return null;
  if (!t.startsWith('https://')) { console.error('X402_BOND_DIRECTORY_URL must be an https URL or "off"; the seller directory is off'); return null; }
  return t;
}
import { loadWallet, type Wallet } from './wallet.js';

const DEFAULT_HISTORY = join(homedir(), '.agent402', 'payments.jsonl');
const HELP = `@agent402-dev/pay-mcp

  npx -y @agent402-dev/pay-mcp                     run the MCP server (stdio)
  npx -y @agent402-dev/pay-mcp init [--path <file>] [--network devnet]
                                                   create a dedicated payment wallet key file (default ~/.agent402/pay-wallet.json)
  npx -y @agent402-dev/pay-mcp export-csv [--history <file>] [--out <file>]
                                                   write the local payment history as CSV (stdout unless --out)
  npx -y @agent402-dev/pay-mcp verify-receipt --receipt <value or @file> [--signer <base58>] [--response-file <file>]
         [--method GET|POST] [--url <url or path>] [--request-body-file <file>] [--rpc <url>|--no-chain]
                                                   check a seller's signed x402 receipt; exit 0 only if every given check passes
`;

const [cmd, ...args] = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

if (cmd === 'init') {
  try {
    const r = await initWallet({ path: opt('--path'), network: opt('--network') === 'devnet' ? 'devnet' : 'mainnet' });
    console.log(r.text);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
} else if (cmd === 'export-csv') {
  const history = jsonlHistory(opt('--history') ?? process.env.X402_HISTORY_PATH ?? DEFAULT_HISTORY, () => ({ USDC: '', PREQ: '', A402: '' }));
  const entries = history.list(Number.MAX_SAFE_INTEGER).reverse(); // oldest first
  const csv = historyToCsv(entries);
  const outPath = opt('--out');
  if (!outPath) process.stdout.write(csv);
  else {
    try {
      writeFileSync(outPath, csv, { flag: 'wx' });
      console.error(`Wrote ${entries.length} payment record(s) to ${outPath}`);
    } catch (e) {
      console.error((e as NodeJS.ErrnoException).code === 'EEXIST' ? `A file already exists at ${outPath}. It was not changed.` : (e as Error).message);
      process.exitCode = 1;
    }
  }
} else if (cmd === 'verify-receipt') {
  const { readFileSync } = await import('node:fs');
  const val = (v: string | undefined) => (v?.startsWith('@') ? readFileSync(v.slice(1), 'utf8').trim() : v);
  const receipt = val(opt('--receipt'));
  if (!receipt) { console.error(`--receipt is required\n\n${HELP}`); process.exitCode = 2; }
  else {
    const { createHash } = await import('node:crypto');
    const file = (f?: string) => (f ? readFileSync(f, 'utf8') : undefined);
    const rf = opt('--response-file');
    // hash the file's exact bytes (works for any content type)
    const responseBodySha256 = rf ? createHash('sha256').update(readFileSync(rf)).digest('hex') : undefined;
    const rpc = args.includes('--no-chain') ? null : opt('--rpc') ?? process.env.X402_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
    let chainTx: ChainTx | null | undefined;
    try {
      const tx = JSON.parse(Buffer.from(receipt.split('.')[0] ?? '', 'base64url').toString()).payment?.transaction;
      if (rpc && typeof tx === 'string') chainTx = await rpcReadTx(rpc)(tx);
    } catch { chainTx = undefined; }
    const r = await verifyReceipt(receipt, { expectedSigner: opt('--signer'), method: opt('--method'), url: opt('--url'),
      requestBody: file(opt('--request-body-file')), responseBodySha256, chainTx });
    console.log(JSON.stringify(r, null, 2));
    process.exitCode = r.verified ? 0 : 1;
  }
} else if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(HELP);
} else if (cmd) {
  console.error(`Unknown command: ${cmd}\n\n${HELP}`);
  process.exitCode = 2;
} else {
  // If PREQ is allowed but its mint is empty, stop here with an error (policyFromEnv)
  const policy = policyFromEnv(process.env);
  // If A402 (v1) is enabled explicitly, print the deprecation warning (stderr; stdout is for MCP)
  for (const w of policy.warnings) console.error(`[a402-pay] WARNING: ${w}`);
  const wallet: Wallet | null = process.env.X402_KEYPAIR_PATH
    ? await loadWallet(process.env.X402_KEYPAIR_PATH, policy, process.env.X402_RPC_URL).catch((e) => {
      console.error(`[a402-pay] could not load wallet, starting without payments: ${(e as Error).message}`);
      return null;
    })
    : null;
  const history = jsonlHistory(process.env.X402_HISTORY_PATH ?? DEFAULT_HISTORY, () => policy.mints);
  const rpc = process.env.X402_RPC_URL ?? (policy.network.includes('EtWTRAB') ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com');
  await createPayServer({ policy, wallet, history, fetch, accounts: rpcAccounts(rpc), clock: rpcClock(rpc), bondPolicy: bondPolicyFromEnv(process.env), bondRpc: bondRpc(rpc),
    bondDirectoryUrl: directoryUrlFromEnv(process.env.X402_BOND_DIRECTORY_URL), readTx: rpcReadTx(rpc) }).connect(new StdioServerTransport());
}
