// A402 Check MCP 도구 (무료):
//  - token_check_summary: 호스팅 API 무료 요약 (항목 1~4, 키 불필요, IP 당 하루 20회)
//  - token_check: 사용자 자신의 Solana RPC 로 로컬에서 전체 리포트 (항목 1~8). 결제 없음
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ChainReader, HistoryReader } from 'a402-check-engine/chain';
import { checkFull, LOCAL_LIMITS } from 'a402-check-engine/full';
import { MintNotFoundError } from 'a402-check-engine/summary';
import { NotAMintError } from 'a402-check-engine/mint';

export const DEFAULT_API = 'https://a402-check.agent402-ebc.workers.dev';
const DISCLAIMER = '공개 온체인 데이터에 따른 사실 정보이며 투자 권유가 아닙니다. / Factual information from public on-chain data. Not investment advice.';
const MINT = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'Solana base58 mint address');

export interface ToolDeps {
  apiBase: string;
  /** 호스팅 API 호출용 fetch */
  fetch: typeof fetch;
  /** 로컬 전체 리포트용 판독기 (사용자 RPC). 없으면 token_check 는 설정 방법만 안내 */
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

/** 전체 리포트를 이 컴퓨터에서 실행 (사용자 RPC). RPC 주소·키는 응답·오류에 넣지 않음 */
export async function fullTool(d: ToolDeps, mint: string): Promise<ToolResult> {
  if (!d.reader) {
    return text({
      error: 'rpc_not_configured',
      message: 'token_check 는 자신의 Solana 메인넷 RPC 로 이 컴퓨터에서 실행합니다 (무료). MCP 설정에 A402_CHECK_RPC_URL 을 넣으세요. 키 없는 공개 RPC 는 항목 5~8 에 쓰는 호출(getTokenLargestAccounts·getProgramAccounts)을 막는 경우가 많습니다. 항목 1~4 만 필요하면 token_check_summary 를 쓰세요',
      notes: [DISCLAIMER],
    }, true);
  }
  try {
    const report = await checkFull(mint, d.reader(), d.now ?? (() => new Date()), LOCAL_LIMITS);
    return text({ ranLocally: true, report });
  } catch (e) {
    if (e instanceof MintNotFoundError) return text({ error: 'mint_not_found', message: '이 주소에 계정이 없습니다', notes: [DISCLAIMER] }, true);
    if (e instanceof NotAMintError) return text({ error: 'not_a_mint', message: '이 주소는 SPL Token / Token-2022 민트가 아닙니다', notes: [DISCLAIMER] }, true);
    return text({ error: 'upstream_unavailable', message: '설정한 RPC 에서 온체인 데이터를 읽지 못했습니다. RPC 주소·요금제 한도를 확인하세요', notes: [DISCLAIMER] }, true);
  }
}

export function createServer(d: ToolDeps): McpServer {
  const server = new McpServer({ name: 'a402-check', version: '0.2.0' });
  server.tool(
    'token_check_summary',
    'Free factual check of a Solana token mint (items 1-4) via the hosted A402 Check API: mint authority, freeze authority, metadata update authority (Token-2022 and Metaplex), and Token-2022 extensions with their authority addresses. No API key needed; limited to 20 calls per IP per day. Returns facts and evidence addresses only — no judgments, ratings, or investment advice.',
    { mint: MINT },
    async ({ mint }) => summaryTool(d, mint),
  );
  server.tool(
    'token_check',
    'Free full factual report on a Solana token mint (items 1-8), computed on this machine with your own Solana RPC (set A402_CHECK_RPC_URL): authorities, Token-2022 extensions, holder concentration (pools, locks, wallets separated), liquidity lock (Meteora DAMM v2, Raydium CPMM), operator locks (Streamflow), and buys right after trading opened. No payment. Returns facts and evidence addresses only — no judgments, ratings, or investment advice.',
    { mint: MINT },
    async ({ mint }) => fullTool(d, mint),
  );
  return server;
}
