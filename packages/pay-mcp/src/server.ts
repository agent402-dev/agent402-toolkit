#!/usr/bin/env node
// a402-pay-mcp (stdio). 설정은 환경변수 — policy.ts PolicyEnv 와 아래:
//   X402_KEYPAIR_PATH  결제 지갑 키 파일 (Solana CLI JSON). 없으면 결제하지 않음 (x402_quote 만)
//   X402_RPC_URL       결제 트랜잭션을 만들 때 쓸 RPC (없으면 공개 RPC)
//   X402_HISTORY_PATH  결제 기록 JSONL (기본 ~/.agent402/payments.jsonl)
// 허용 목록(X402_ALLOWED_DOMAINS, X402_TRUSTED_PAY_TO) 기본값은 비어 있음 = 전부 거절
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { jsonlHistory } from './history.js';
import { policyFromEnv } from './policy.js';
import { createPayServer } from './tools.js';
import { loadWallet, type Wallet } from './wallet.js';

const policy = policyFromEnv(process.env);
const wallet: Wallet | null = process.env.X402_KEYPAIR_PATH
  ? await loadWallet(process.env.X402_KEYPAIR_PATH, policy, process.env.X402_RPC_URL).catch((e) => {
    console.error(`[a402-pay] could not load wallet, starting without payments: ${(e as Error).message}`);
    return null;
  })
  : null;
const history = jsonlHistory(process.env.X402_HISTORY_PATH ?? join(homedir(), '.agent402', 'payments.jsonl'), () => policy.mints);
await createPayServer({ policy, wallet, history, fetch }).connect(new StdioServerTransport());
