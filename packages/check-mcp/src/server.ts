#!/usr/bin/env node
// A402 Check MCP server (stdio, free). Configured with environment variables:
//   A402_CHECK_API     — hosted API address (default: public Worker) — token_check_summary
//   A402_CHECK_RPC_URL — your own Solana mainnet RPC — token_check (full local report). If unset, only explains how to set it up
// No payment features. RPC addresses and keys are never printed (stdout is for the MCP protocol only)
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fetchChainReader } from '@agent402-dev/check-engine/rpc-lite';
import { createServer, DEFAULT_API } from './tools.js';

const rpcUrl = (process.env.A402_CHECK_RPC_URL ?? '').trim();
const server = createServer({
  apiBase: (process.env.A402_CHECK_API ?? DEFAULT_API).replace(/\/$/, ''),
  fetch,
  reader: rpcUrl ? () => fetchChainReader(rpcUrl) : null,
});
await server.connect(new StdioServerTransport());
