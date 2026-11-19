#!/usr/bin/env node
// A402 Check MCP 서버 (stdio, 무료). 설정은 환경변수:
//   A402_CHECK_API     — 호스팅 API 주소 (기본: 공개 Worker) — token_check_summary
//   A402_CHECK_RPC_URL — 자신의 Solana 메인넷 RPC — token_check (로컬 전체 리포트). 없으면 설정 방법만 안내
// 결제 기능 없음. RPC 주소·키는 출력하지 않음 (stdout 은 MCP 프로토콜 전용)
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
