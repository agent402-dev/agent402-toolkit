// Try Agent402 Bond with your own AI agent, on a LOCAL mainnet fork (Surfpool). No real funds.
// Starts a demo seller (HTTP, Bond Job Protocol v1) and a funded throwaway buyer wallet, then prints the MCP settings
// that let your agent (Claude Code, Claude Desktop or any MCP client) buy the job with @agent402-dev/pay-mcp.
//
//   surfpool start --network mainnet --no-tui      (another terminal)
//   npx tsx examples/bond-local/start.ts           (from packages/pay-mcp; add --check to run a scripted buyer and exit)
//
// Everything here is throwaway: keys are created now, funded with Surfpool cheatcodes on your machine, and the fork's
// state disappears when Surfpool stops. It refuses to run against any non-local RPC.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import * as bond from '@agent402-dev/bond-client';
import { bondJobService, createBondSeller, JobFailed } from '@agent402-dev/pay-server/bond';
import { serveHttp } from '@agent402-dev/bond-seller-mcp/http';

const RPC = process.env.BOND_RPC ?? 'http://127.0.0.1:8899';
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(RPC)) throw new Error('local Surfpool only (BOND_RPC must be localhost)');
const PORT = Number(process.env.BOND_LOCAL_PORT ?? 8790);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const U = 1_000_000n;
const CHECK = process.argv.includes('--check');

async function cheat(method: string, params: unknown[]) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).catch(() => null);
  if (!r) throw new Error(`cannot reach ${RPC}: start Surfpool first (surfpool start --network mainnet --no-tui)`);
  const j = (await r.json()) as { error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
}

// 1) Throwaway seller and buyer, each with 2 SOL and 100 USDC on the fork
const sellerKp = Keypair.generate(), buyerKp = Keypair.generate();
for (const k of [sellerKp, buyerKp]) {
  await cheat('surfnet_setAccount', [k.publicKey.toBase58(), { lamports: 2 * LAMPORTS_PER_SOL }]);
  await cheat('surfnet_setTokenAccount', [k.publicKey.toBase58(), bond.MINTS.mainnet.USDC.toBase58(), { amount: Number(100n * U) }, bond.TOKEN_PROGRAM_ID.toBase58()]);
}
const dir = resolve('.bond-local');
mkdirSync(dir, { recursive: true });
const buyerKeyPath = join(dir, 'buyer.json');
writeFileSync(buyerKeyPath, JSON.stringify(Array.from(buyerKp.secretKey)));

// 2) Demo seller: word count of a short text, 2 USDC, seller bond 0.2, buyer deposit 0.5
const seller = createBondSeller({
  rpcUrl: RPC,
  signer: { publicKey: sellerKp.publicKey, async signTransaction(tx) { tx.partialSign(sellerKp); return tx; } },
  terms: { price: 2n * U, sellerBond: U / 5n, buyerDeposit: U / 2n, deliverSeconds: 600n, lateWindow: 0n, payWindow: 86_400n },
});
const jobs = bondJobService({
  seller,
  description: 'Demo job: send any short text; get its word count and longest word. Local fork only.',
  publicOrigin: ORIGIN,
  validateInput: (input) => (input.trim() ? null : 'send some text'),
  doJob: async (input) => {
    const words = input.split(/\s+/).filter(Boolean);
    if (words.length > 2000) throw new JobFailed('at most 2000 words');
    return { words: words.length, longest: words.reduce((a, b) => (b.length > a.length ? b : a), '') };
  },
});
const server = await serveHttp(jobs.handle, PORT, '127.0.0.1');
// The seller works on opened deals, marks delivery, then settles and claims after the buyer pays
const timer = setInterval(async () => {
  for (const s of await jobs.processOpenJobs().catch(() => [])) if (s.status !== 'not_open') console.log(`  seller: deal ${s.deal} ${s.status}`);
}, 3000);

const env = {
  X402_KEYPAIR_PATH: buyerKeyPath,
  X402_RPC_URL: RPC,
  X402_ALLOWED_DOMAINS: `127.0.0.1:${PORT}`,
  X402_BOND_SELLERS: sellerKp.publicKey.toBase58(),
  X402_BOND_MAX_USD: '5',
  X402_MAX_USD_PER_DAY: '10',
};

if (CHECK) {
  // Scripted buyer: the same pay-mcp tools your agent would call, through an in-memory MCP client
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { ElicitRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const { createPayServer } = await import('@agent402-dev/pay-mcp/tools');
  const { policyFromEnv } = await import('@agent402-dev/pay-mcp/policy');
  const { loadWallet } = await import('@agent402-dev/pay-mcp/wallet');
  const { jsonlHistory } = await import('@agent402-dev/pay-mcp/history');
  const { rpcAccounts } = await import('@agent402-dev/pay-mcp/locks');
  const { rpcClock } = await import('@agent402-dev/pay-mcp/bond');
  const { bondPolicyFromEnv, bondRpc } = await import('@agent402-dev/pay-mcp/bond-sign');
  const policy = policyFromEnv(env);
  const mcp = createPayServer({
    policy, wallet: await loadWallet(buyerKeyPath, policy, RPC), fetch, history: jsonlHistory(join(dir, 'history.jsonl'), () => policy.mints),
    accounts: rpcAccounts(RPC), clock: rpcClock(RPC), bondPolicy: bondPolicyFromEnv(env), bondRpc: bondRpc(RPC),
  });
  const client = new Client({ name: 'check', version: '1' }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: { confirm: true } })); // a human would answer here
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(b), client.connect(a)]);
  const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text);
  let ok = true;
  const lines: string[] = [];
  const step = (cond: boolean, label: string) => { ok &&= cond; const l = `${cond ? 'ok  ' : 'FAIL'} ${label}`; lines.push(l); console.log(l); };
  const q = await call('bond_job_quote', { url: ORIGIN });
  step(q.result === 'ok', `bond_job_quote: ${q.price}, deposit ${q.depositNow}`);
  const s = await call('bond_job_start', { url: ORIGIN, input: 'agents lock a bond before they work' });
  step(s.result === 'opened', `bond_job_start: deal ${s.deal ?? JSON.stringify(s.reasons)}`);
  let r = await call('bond_job_result', { url: ORIGIN, deal: s.deal });
  for (let i = 0; i < 20 && r.result === 'working'; i++) { await new Promise((x) => setTimeout(x, 1500)); r = await call('bond_job_result', { url: ORIGIN, deal: s.deal }); }
  step(r.result === 'delivered' && r.work?.words === 7, `bond_job_result: ${JSON.stringify(r.work ?? r.result)}`);
  const p = await call('bond_confirm_and_pay', { deal: s.deal });
  step(p.result === 'confirmed_and_paid', `bond_confirm_and_pay: paid ${p.paid ?? JSON.stringify(p.reasons)}`);
  let closed = false;
  for (let i = 0; i < 30 && !closed; i++) { closed = (await call('bond_deal_status', { deal: s.deal })).result === 'not_found'; if (!closed) await new Promise((x) => setTimeout(x, 1000)); }
  step(closed, 'the seller settled and claimed; deal closed');
  console.log(ok ? '\nall checks passed' : '\nsome checks failed');
  writeFileSync(join(dir, 'check-result.txt'), [...lines, ok ? 'all checks passed' : 'some checks failed', ''].join('\n'));
  clearInterval(timer); server.close();
  process.exit(ok ? 0 : 1);
}

console.log(`
Agent402 Bond, local fork (no real funds)
  seller  ${sellerKp.publicKey.toBase58()}   job URL ${ORIGIN}
  buyer   ${buyerKp.publicKey.toBase58()}   throwaway key ${buyerKeyPath}

Add this MCP server to your agent:

Claude Code:
  claude mcp add agent402-bond-local ${Object.entries(env).map(([k, v]) => `--env ${k}=${v}`).join(' ')} -- npx -y @agent402-dev/pay-mcp

Claude Desktop / other clients (mcpServers entry):
${JSON.stringify({ 'agent402-bond-local': { command: 'npx', args: ['-y', '@agent402-dev/pay-mcp'], env } }, null, 2)}

Then ask your agent, for example:
  "Use bond_job_quote on ${ORIGIN}. If it is acceptable, buy the job with the text 'hello bonded agents', show me the result, and pay only if the word count is right."

Your agent will ask you before it locks the deposit and before it pays. Ctrl+C stops the seller.
`);
