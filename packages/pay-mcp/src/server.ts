#!/usr/bin/env node
// @agent402-dev/pay-mcp. With no command it runs the MCP server (stdio), configured with environment variables: policy.ts PolicyEnv and the following:
//   X402_KEYPAIR_PATH  payment wallet key file (Solana CLI JSON). Without it, no payments (x402_quote only)
//   X402_RPC_URL       RPC used to build payment transactions (public RPC if unset)
//   X402_HISTORY_PATH  payment history JSONL (default ~/.agent402/payments.jsonl)
// Allowlists (X402_ALLOWED_DOMAINS, X402_TRUSTED_PAY_TO) default to empty = reject everything
// Commands: init (create a dedicated payment wallet key file), export-csv (payment history as CSV), help
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { historyToCsv } from './csv.js';
import { jsonlHistory } from './history.js';
import { initWallet } from './init.js';
import { policyFromEnv } from './policy.js';
import { createPayServer } from './tools.js';
import { loadWallet, type Wallet } from './wallet.js';

const DEFAULT_HISTORY = join(homedir(), '.agent402', 'payments.jsonl');
const HELP = `@agent402-dev/pay-mcp

  npx -y @agent402-dev/pay-mcp                     run the MCP server (stdio)
  npx -y @agent402-dev/pay-mcp init [--path <file>] [--network devnet]
                                                   create a dedicated payment wallet key file (default ~/.agent402/pay-wallet.json)
  npx -y @agent402-dev/pay-mcp export-csv [--history <file>] [--out <file>]
                                                   write the local payment history as CSV (stdout unless --out)
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
  await createPayServer({ policy, wallet, history, fetch }).connect(new StdioServerTransport());
}
