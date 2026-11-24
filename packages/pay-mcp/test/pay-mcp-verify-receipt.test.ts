// pay-mcp verify_receipt: standalone receipt checks (signature, signer, request, response, on chain) and the MCP tool.
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHash } from 'node:crypto';
import { receiptSignerFromBytes, signReceipt } from '@agent402-dev/pay-server';
import { policyFromEnv } from '@agent402-dev/pay-mcp/policy';
import { verifyReceipt, type ChainTx } from '@agent402-dev/pay-mcp/verify-receipt';
import { createPayServer } from '@agent402-dev/pay-mcp/tools';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', PAY_TO = '3re9JiNpwbf3y4c4ywT1mDRnVVHfHss14Pq2xaTaTGYH', BUYER = 'Buyer1111111111111111111111111111111111111';
const TX = '5'.repeat(88);
const kp = Keypair.generate();
const sha256Hex = async (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const body = '{"rows":3}', reqBody = '{"signatures":["a"]}';
async function make(over: Partial<{ amount: string; transaction: string | null }> = {}) {
  const s = await receiptSignerFromBytes(kp.secretKey);
  return signReceipt(s, {
    issuedAt: '2026-11-24T05:00:00Z',
    request: { method: 'POST', path: '/x402/receipts', bodySha256: await sha256Hex(new TextEncoder().encode(reqBody)) },
    response: { status: 200, bodySha256: await sha256Hex(new TextEncoder().encode(body)) },
    payment: { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', asset: USDC, amount: '50000', payTo: PAY_TO, transaction: TX, ...over },
  });
}
const chain = (amount: number, err: unknown = null): ChainTx => ({ meta: { err,
  preTokenBalances: [{ mint: USDC, owner: PAY_TO, uiTokenAmount: { amount: '0' } }, { mint: USDC, owner: BUYER, uiTokenAmount: { amount: '100000' } }],
  postTokenBalances: [{ mint: USDC, owner: PAY_TO, uiTokenAmount: { amount: String(amount) } }, { mint: USDC, owner: BUYER, uiTokenAmount: { amount: String(100000 - amount) } }] } });

describe('verify_receipt', () => {
  it('everything given matches → verified, nothing left unchecked', async () => {
    const r = await verifyReceipt(await make(), { expectedSigner: kp.publicKey.toBase58(), method: 'post', url: 'https://x.example/x402/receipts', requestBody: reqBody, responseBody: body, chainTx: chain(50000) });
    expect(r.verified).toBe(true);
    expect(r.notChecked).toEqual([]);
    expect(r.checks?.map((c) => c.check)).toEqual(['signature', 'signer_expected', 'request_method', 'request_path', 'request_body', 'response_body', 'payment_on_chain']);
  });
  it('signature only, and says what was not checked', async () => {
    const r = await verifyReceipt(await make());
    expect(r.verified).toBe(true);
    expect(r.notChecked).toHaveLength(4);
  });
  it('tampered receipt, wrong signer, other response, short payment, failed tx', async () => {
    const t = await make();
    const [head, sig] = t.split('.');
    const fields = JSON.parse(Buffer.from(head, 'base64url').toString());
    fields.payment.amount = '1';
    const forged = `${Buffer.from(JSON.stringify(fields)).toString('base64url')}.${sig}`;
    expect((await verifyReceipt(forged)).reasons?.[0]).toMatch(/^signature/);
    expect((await verifyReceipt(t, { expectedSigner: Keypair.generate().publicKey.toBase58() })).reasons?.[0]).toMatch(/^signer_expected/);
    expect((await verifyReceipt(t, { responseBody: '{"rows":4}' })).reasons).toEqual(['response_body']);
    expect((await verifyReceipt(t, { chainTx: chain(10000) })).reasons?.[0]).toMatch(/payTo received 10000/);
    expect((await verifyReceipt(t, { chainTx: chain(50000, { InstructionError: [0, 'x'] }) })).reasons?.[0]).toMatch(/failed on chain/);
    expect((await verifyReceipt(t, { chainTx: null })).reasons?.[0]).toMatch(/not found/);
    expect((await verifyReceipt(await make({ transaction: null }), { chainTx: chain(50000) })).reasons?.[0]).toMatch(/names no settlement/);
    expect((await verifyReceipt('not-a-receipt')).result).toBe('malformed');
  });
  it('MCP tool: seller-published key and chain reader', async () => {
    const t = await make();
    const f = (async (u: string) => (String(u) === 'https://seller.example/' ? Response.json({ x402: { receiptSigner: kp.publicKey.toBase58() } }) : new Response('no', { status: 404 }))) as typeof fetch;
    const seen: string[] = [];
    const server = createPayServer({ policy: policyFromEnv({}), wallet: null, history: { add() {}, list: () => [], today: () => ({ count: 0, usd: 0, preq: 0n, a402: 0n }), recipientToday: () => ({ count: 0, usd: 0, preq: 0n }) }, fetch: f,
      readTx: async (s) => { seen.push(s); return chain(50000); } });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '1' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const ok = await client.callTool({ name: 'verify_receipt', arguments: { receipt: t, sellerUrl: 'https://seller.example/x402/receipts', responseBody: body } });
    const b = JSON.parse((ok.content as { text: string }[])[0].text);
    expect(ok.isError).toBeFalsy();
    expect(b.checks.map((c: { check: string }) => c.check)).toEqual(['signature', 'signer_published_by_seller', 'response_body', 'payment_on_chain']);
    expect(seen).toEqual([TX]);
    const http = await client.callTool({ name: 'verify_receipt', arguments: { receipt: t, sellerUrl: 'http://seller.example/' } });
    expect(http.isError).toBe(true);
  });
});
