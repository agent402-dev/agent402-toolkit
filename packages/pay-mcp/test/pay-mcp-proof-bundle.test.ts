// pay-mcp proof bundle (D2): one verifiable JSON per payment (policy hash, pre-check, payment, seller receipt). Read only.
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { receiptSignerFromBytes, signReceipt } from '@agent402-dev/pay-server';
import { policyFromEnv } from '@agent402-dev/pay-mcp/policy';
import { buildProofBundle, canonicalJson, policyHash, verifyProofBundle } from '@agent402-dev/pay-mcp/proof-bundle';
import type { ChainTx } from '@agent402-dev/pay-mcp/verify-receipt';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', PAY_TO = '3re9JiNpwbf3y4c4ywT1mDRnVVHfHss14Pq2xaTaTGYH';
const NET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', TX = '5'.repeat(88), URL_ = 'https://api.example.com/x402/job?w=1';
const policy = policyFromEnv({ X402_ALLOWED_DOMAINS: 'api.example.com', X402_TRUSTED_PAY_TO: PAY_TO });
const payment = { resource: URL_, network: NET, asset: USDC, amount: '50000', payTo: PAY_TO, transaction: TX, at: '2026-11-28T00:00:00Z' };
const chain = (amount: number): ChainTx => ({ meta: { err: null,
  preTokenBalances: [{ mint: USDC, owner: PAY_TO, uiTokenAmount: { amount: '0' } }],
  postTokenBalances: [{ mint: USDC, owner: PAY_TO, uiTokenAmount: { amount: String(amount) } }] } });
async function receipt(amount = '50000') {
  const s = await receiptSignerFromBytes(Keypair.generate().secretKey);
  return signReceipt(s, { issuedAt: payment.at, request: { method: 'GET', path: '/x402/job?w=1', bodySha256: null }, response: { status: 200, bodySha256: 'a'.repeat(64) },
    payment: { network: NET, asset: USDC, amount, payTo: PAY_TO, transaction: TX } });
}

describe('proof bundle', () => {
  it('canonical JSON sorts keys and writes bigints as strings; the policy hash ignores start-up warnings', async () => {
    expect(canonicalJson({ b: 1n, a: [{ d: undefined, c: null }] })).toBe('{"a":[{"c":null}],"b":"1"}');
    expect(await policyHash({ ...policy, warnings: ['x'] })).toBe(await policyHash(policy));
    expect(await policyHash({ ...policy, maxUsdPerDay: 2 })).not.toBe(await policyHash(policy));
  });
  it('a bundle with a matching receipt verifies against the rules and the chain', async () => {
    const b = await buildProofBundle({ agent: { registry: 'solana:x:8oo4', asset: 'HYcW' }, policy, preflight: { url: URL_, fixes: 0, codes: [] }, payment, receipt: await receipt() });
    expect(b).toMatchObject({ v: 1, kind: 'agent402.payment-proof', policyHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const v = await verifyProofBundle(JSON.parse(JSON.stringify(b)), { policy, chainTx: chain(50000) });
    expect(v.reasons).toEqual([]);
    expect(v.verified).toBe(true);
  });
  it('flags other rules, a recipient or host outside them, a receipt for a different amount, a pre-check with fixes, and a short on-chain amount', async () => {
    const other = policyFromEnv({ X402_ALLOWED_DOMAINS: 'other.example', X402_TRUSTED_PAY_TO: 'Buyer1111111111111111111111111111111111111' });
    const b = await buildProofBundle({ policy, preflight: { url: URL_, fixes: 1, codes: ['resource_url_http'] }, payment, receipt: await receipt('1') });
    const v = await verifyProofBundle(b, { policy: other, chainTx: chain(1) });
    const failed = v.checks.filter((c) => !c.ok).map((c) => c.check);
    expect(failed).toEqual(expect.arrayContaining(['policy_hash', 'policy_domain', 'policy_recipient', 'preflight_clean', 'receipt_matches_payment']));
    expect(v.verified).toBe(false);
    expect((await verifyProofBundle({ ...b, kind: 'x' })).checks).toEqual([{ check: 'format', ok: false }]);
    await expect(buildProofBundle({ policy, payment: { ...payment, amount: '0.05' } })).rejects.toThrow(/integer/);
  });
  it('without a receipt or policy it says what was not checked', async () => {
    const v = await verifyProofBundle(await buildProofBundle({ policy, payment }), { chainTx: chain(50000) });
    expect(v.verified).toBe(true);
    expect(v.notChecked.join(' ')).toMatch(/spending rules.*receipt.*on chain/);
  });
});
