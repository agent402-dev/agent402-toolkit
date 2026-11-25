// A402 Check MCP tools (free):
//  - token_check_summary: free summary from the hosted API (sections 1 to 4, no key needed, 20 per IP per day)
//  - token_check: full report (sections 1 to 8) run locally with your own Solana RPC. No payment
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ChainReader, HistoryReader } from '@agent402-dev/check-engine/chain';
import { checkFull, LOCAL_LIMITS } from '@agent402-dev/check-engine/full';
import { MintNotFoundError } from '@agent402-dev/check-engine/summary';
import { NotAMintError } from '@agent402-dev/check-engine/mint';
import { registerSkills } from './skills.js';

export const DEFAULT_API = 'https://a402-check.agent402-ebc.workers.dev';
const DISCLAIMER = 'Factual information from public on-chain data. Not investment advice.';
const MINT = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'Solana base58 mint address');

export interface ToolDeps {
  apiBase: string;
  /** fetch for calling the hosted API */
  fetch: typeof fetch;
  /** Reader for the full local report (your RPC). If missing, token_check only explains how to set it up */
  reader: (() => ChainReader & HistoryReader) | null;
  now?: () => Date;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (obj: unknown, isError = false): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], ...(isError ? { isError } : {}) });

async function readJson(res: Response): Promise<unknown> {
  const t = await res.text();
  try { return JSON.parse(t); } catch { return { raw: t.slice(0, 500) }; }
}

export async function summaryTool(d: ToolDeps, mint: string): Promise<ToolResult> {
  const res = await d.fetch(`${d.apiBase}/v1/check/${mint}/summary`);
  const body = await readJson(res);
  if (res.ok) return text(body);
  return text({ status: res.status, ...(body as object), remainingToday: res.headers.get('x-ratelimit-remaining') }, true);
}

/** Runs the full report on this computer (your RPC). RPC addresses and keys are never put in responses or errors */
export async function fullTool(d: ToolDeps, mint: string): Promise<ToolResult> {
  if (!d.reader) {
    return text({
      error: 'rpc_not_configured',
      message: 'token_check runs on this computer with your own Solana mainnet RPC (free). Add A402_CHECK_RPC_URL to your MCP settings. Public RPCs without a key often block the calls used for sections 5 to 8 (getTokenLargestAccounts, getProgramAccounts). If you only need sections 1 to 4, use token_check_summary',
      notes: [DISCLAIMER],
    }, true);
  }
  try {
    const report = await checkFull(mint, d.reader(), d.now ?? (() => new Date()), LOCAL_LIMITS);
    return text({ ranLocally: true, report });
  } catch (e) {
    if (e instanceof MintNotFoundError) return text({ error: 'mint_not_found', message: 'There is no account at this address', notes: [DISCLAIMER] }, true);
    if (e instanceof NotAMintError) return text({ error: 'not_a_mint', message: 'This address is not an SPL Token / Token-2022 mint', notes: [DISCLAIMER] }, true);
    return text({ error: 'upstream_unavailable', message: 'Could not read on-chain data from the configured RPC. Check the RPC address and plan limits', notes: [DISCLAIMER] }, true);
  }
}

export function createServer(d: ToolDeps): McpServer {
  const server = new McpServer({ name: 'a402-check', version: '0.3.1' });
  server.tool(
    'token_check_summary',
    'Free factual check of a Solana token mint (items 1-4) via the hosted A402 Check API: mint authority, freeze authority, metadata update authority (Token-2022 and Metaplex), and Token-2022 extensions with their authority addresses. No API key needed; limited to 20 calls per IP per day. Returns facts and evidence addresses only — no judgments, ratings, or investment advice. Errors: HTTP 404 when no mint exists at the address, 429 when the daily limit is reached (remainingToday). For holders, liquidity locks and early buys use token_check.',
    { mint: MINT.describe('Solana token mint address (base58).') },
    async ({ mint }) => summaryTool(d, mint),
  );
  server.tool(
    'token_check',
    'Free full factual report on a Solana token mint (items 1-8), computed on this machine with your own Solana RPC (set A402_CHECK_RPC_URL): authorities, Token-2022 extensions, holder concentration (pools, locks, wallets separated), liquidity lock (Meteora DAMM v2, Raydium CPMM), operator locks (Streamflow), and buys right after trading opened. No payment. Returns facts and evidence addresses only — no judgments, ratings, or investment advice. Errors: rpc_not_configured (no A402_CHECK_RPC_URL; use token_check_summary), mint_not_found, not_a_mint, upstream_unavailable (RPC failed or blocked the calls).',
    { mint: MINT.describe('Solana token mint address (base58).') },
    async ({ mint }) => fullTool(d, mint),
  );
  registerSkills(server); // Skills over MCP: the fact-checking workflow as a skill (hosts without the extension ignore it)
  return server;
}
