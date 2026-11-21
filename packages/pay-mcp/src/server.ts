#!/usr/bin/env node
// @agent402-dev/pay-mcp (stdio). Configured with environment variables: policy.ts PolicyEnv and the following:
//   X402_KEYPAIR_PATH  payment wallet key file (Solana CLI JSON). Without it, no payments (x402_quote only)
//   X402_RPC_URL       RPC used to build payment transactions (public RPC if unset)
//   X402_HISTORY_PATH  payment history JSONL (default ~/.agent402/payments.jsonl)
// Allowlists (X402_ALLOWED_DOMAINS, X402_TRUSTED_PAY_TO) default to empty = reject everything
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { jsonlHistory } from './history.js';
import { policyFromEnv } from './policy.js';
import { createPayServer } from './tools.js';
import { loadWallet, type Wallet } from './wallet.js';

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
const history = jsonlHistory(process.env.X402_HISTORY_PATH ?? join(homedir(), '.agent402', 'payments.jsonl'), () => policy.mints);
await createPayServer({ policy, wallet, history, fetch }).connect(new StdioServerTransport());
