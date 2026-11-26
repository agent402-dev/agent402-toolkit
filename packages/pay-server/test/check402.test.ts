// Seller 402 check (queue 161): `agent402-pay-server check <url>` reads a 402 like a buyer, without a wallet.
// Shapes taken from the read-only compatibility run (queue 160): relative or http resource.url, v1 body only, MPP, zero amount.
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { check402Url, formatFindings, inspect402, type Answer } from '@agent402-dev/pay-server/check402';

const SOL = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const URL0 = 'https://seller.example/paid';
const sol = (o: Record<string, unknown> = {}) => ({ scheme: 'exact', network: SOL, asset: USDC, amount: '2000', payTo: '11111111111111111111111111111111', maxTimeoutSeconds: 60, extra: { feePayer: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4' }, ...o });
const base = (o: Record<string, unknown> = {}) => ({ scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '2000', payTo: '0x' + 'ab'.repeat(20), maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' }, ...o });
const pr = (o: Record<string, unknown> = {}) => ({ x402Version: 2, resource: { url: URL0, description: 'Price of one thing', mimeType: 'application/json' }, accepts: [sol()], ...o });
const answer = (p: unknown, extra: Partial<Answer> = {}): Answer => {
  const h = p === null ? null : encodePaymentRequiredHeader(p as never);
  return { status: 402, header: (n) => (n === 'payment-required' ? h : null), body: '{}', ...extra };
};
const codes = (a: Answer) => inspect402(a, URL0).map((x) => `${x.level}:${x.code}`);

describe('inspect402', () => {
  it('a well-formed Solana + Base 402 has nothing to fix', () => {
    const list = inspect402(answer(pr({ accepts: [sol(), base()] })), URL0);
    expect(list.filter((x) => x.level === 'fix')).toEqual([]);
    expect(list.filter((x) => x.code === 'price').map((x) => x.message)).toEqual(['accepts[0]: Solana mainnet, 0.002 USDC (amount "2000").', 'accepts[1]: Base, 0.002 USDC (amount "2000").']);
    expect(formatFindings(list)).toMatch(/Nothing to fix found\. Nothing was signed or paid\.$/);
  });
  it('flags the resource.url shapes seen in the compatibility run', () => {
    expect(codes(answer(pr({ resource: { url: '/paid?q=1', description: 'x', mimeType: 'application/json' } })))).toContain('fix:resource_url_relative');
    expect(codes(answer(pr({ resource: { url: 'http://seller.example/paid', description: 'x', mimeType: 'application/json' } })))).toContain('fix:resource_url_http');
    expect(codes(answer(pr({ resource: { url: 'https://other.example/paid', description: 'x', mimeType: 'application/json' } })))).toContain('note:resource_url_host');
  });
  it('flags option problems', () => {
    const c = codes(answer(pr({ accepts: [sol({ amount: '0' }), sol({ amount: '0.01' }), sol({ extra: {} }), base({ extra: {} }), sol({ network: 'solana' }), sol({ scheme: 'upto' }), sol({ payTo: '0xabc' })] })));
    for (const x of ['fix:amount_zero', 'fix:amount_format', 'fix:fee_payer', 'fix:eip712_domain', 'fix:network_name', 'fix:scheme', 'fix:payto_format']) expect(c).toContain(x);
    expect(codes(answer(pr({ accepts: [] })))).toContain('fix:accepts_empty');
    expect(codes(answer(pr({ accepts: [sol({ network: 'eip155:137' })] })))).toContain('note:network_other');
  });
  it('reads the non-v2 shapes', () => {
    expect(codes(answer(null, { body: JSON.stringify({ x402Version: 1, accepts: [{}] }) }))).toEqual(['fix:v1_body_only']);
    expect(codes(answer(null, { header: (n) => (n === 'www-authenticate' ? 'Payment id="1"' : null) }))).toEqual(['note:mpp']);
    expect(codes(answer(null))).toEqual(['fix:header_missing']);
    expect(codes({ status: 402, header: (n) => (n === 'payment-required' ? '%%%' : null), body: '' })).toEqual(['fix:header_undecodable']);
    expect(codes({ status: 200, header: () => null, body: '' })).toEqual(['fix:status']);
  });
  it('discovery and description notes', () => {
    expect(codes(answer(pr()))).toContain('note:discovery_missing');
    expect(codes(answer(pr({ resource: { url: URL0, description: 'x'.repeat(501), mimeType: 'a' } })))).toContain('fix:description_too_long');
    expect(codes(answer(pr({ extensions: { bazaar: { info: { input: { type: 'http', method: 'GET' } }, schema: {} } } })))).toContain('ok:discovery');
  });
});

describe('check402Url (local seller)', () => {
  it('sends one request without a payment header and inspects the answer', async () => {
    const seen: (string | undefined)[] = [];
    let url = '';
    const server = createServer((req, res) => {
      seen.push(req.headers['payment-signature'] as string | undefined, req.headers['x-payment'] as string | undefined);
      res.writeHead(402, { 'payment-required': encodePaymentRequiredHeader(pr({ resource: { url, description: 'x', mimeType: 'application/json' } }) as never) });
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const a = server.address();
    url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/paid`;
    try {
      const list = await check402Url(url);
      expect(list.filter((x) => x.level === 'fix')).toEqual([]);
      expect(seen).toEqual([undefined, undefined]);
    } finally { await new Promise<void>((r) => server.close(() => r())); }
  });
  it('refuses plain http outside localhost and reports redirects', async () => {
    expect((await check402Url('http://seller.example/paid'))[0].code).toBe('url_http');
    const fake = (async () => new Response(null, { status: 308, headers: { location: 'https://other.example/' } })) as unknown as typeof fetch;
    expect((await check402Url(URL0, {}, fake))[0].code).toBe('redirect');
  });
});
