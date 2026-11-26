// Base (EVM) per-request payments wired into the payment flow (queue 85/86): off by default, and when allowed,
// every existing rule applies before signing, the signed authorization is checked again before sending,
// limits are shared with Solana, Solana is preferred when both pass, and the key never appears in output.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { getAddress, verifyTypedData, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createAgent } from '@agent402-dev/pay-mcp/agent';
import { evmConfigFromEnv } from '@agent402-dev/pay-mcp/evm-config';
import { EvmAuthorizationMismatch, evmWalletFromKey, loadEvmWallet, readEvmKeyFile } from '@agent402-dev/pay-mcp/evm-wallet';
import { jsonlHistory } from '@agent402-dev/pay-mcp/history';
import { NETWORKS, policyFromEnv, type PolicyEnv } from '@agent402-dev/pay-mcp/policy';

const TRUSTED_SOL = Keypair.generate().publicKey.toBase58();
const EVM_PAY_TO = '0x2222222222222222222222222222222222222222';
const SOL_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const HOST = 'api.good.test';
const BASE_ENV: PolicyEnv = { X402_NETWORK: 'devnet', X402_ALLOWED_DOMAINS: HOST, X402_TRUSTED_PAY_TO: `${TRUSTED_SOL},${EVM_PAY_TO}` };
const ON = { X402_NETWORK: 'devnet', X402_ALLOWED_NETWORKS: 'solana,base', X402_EVM_KEY_PATH: '/not/read/here' };

const sol = (amount = '20000'): PaymentRequirements => ({ scheme: 'exact', network: NETWORKS.devnet as never, asset: SOL_USDC, amount, payTo: TRUSTED_SOL, maxTimeoutSeconds: 60, extra: { feePayer: 'FEE' } });
const base = (o: Partial<PaymentRequirements> = {}, extra: Record<string, unknown> = {}): PaymentRequirements =>
  ({ scheme: 'exact', network: 'eip155:84532' as never, asset: SEPOLIA_USDC, amount: '20000', payTo: EVM_PAY_TO, maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2', ...extra }, ...o });

function setup(accepts: PaymentRequirements[], o: { env?: PolicyEnv; evmEnv?: Record<string, string> | null; key?: Hex | null; skewSeconds?: number; confirm?: (m: string) => Promise<'accept' | 'decline'> } = {}) {
  const policy = policyFromEnv({ ...BASE_ENV, ...(o.env ?? {}) });
  const dir = mkdtempSync(join(tmpdir(), 'paymcp-evm-pay-'));
  const historyPath = join(dir, 'h.jsonl');
  const history = jsonlHistory(historyPath, () => policy.mints);
  const evm = o.evmEnv === null ? undefined : evmConfigFromEnv(o.evmEnv ?? ON);
  const key = o.key === undefined ? generatePrivateKey() : o.key;
  const evmWallet = key && evm?.evmNetwork
    ? evmWalletFromKey(key, evm.evmNetwork, policy, o.skewSeconds ? { nowSeconds: () => Math.floor(Date.now() / 1000) + o.skewSeconds! } : {})
    : null;
  let solSigned = 0;
  const wallet = { address: 'BUYER', network: NETWORKS.devnet, get signedCount() { return solSigned; }, async sign() { solSigned++; return 'SOLANA-SIG'; }, async balances() { return {}; }, async signBytes(): Promise<Uint8Array> { throw new Error('unused'); } };
  const pr = { x402Version: 2, resource: { url: `https://${HOST}/paid`, description: 'x' }, accepts };
  const sent: string[] = [];
  const f = (async (_u: unknown, init?: RequestInit) => {
    const sig = new Headers(init?.headers).get('payment-signature');
    if (sig) { sent.push(sig); return new Response('{"ok":true}', { status: 200 }); }
    return new Response('{}', { status: 402, headers: { 'payment-required': encodePaymentRequiredHeader(pr as never) } });
  }) as typeof fetch;
  const agent = createAgent({ policy, wallet, history, fetch: f, confirm: o.confirm ?? (async () => 'accept'), evm, evmWallet });
  return { agent, history, historyPath, sent, solSigned: () => solSigned, evmWallet, key };
}

const SEPOLIA_DOMAIN = { name: 'USDC', version: '2', chainId: 84532, verifyingContract: getAddress(SEPOLIA_USDC) };
const TYPES = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
] } as const;

describe('Base (EVM) payments', () => {
  it('① no networks settings or Base not allowed: Base refused, nothing signed', async () => {
    for (const evmEnv of [null, { X402_NETWORK: 'devnet' }]) {
      const t = setup([base()], { evmEnv });
      const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
      expect(r.result).toBe('refused');
      expect(r.options?.[0].reasons.join(' ')).toMatch(/wrong_network: eip155:84532 \(Base payments are off/);
      expect(t.sent).toHaveLength(0);
    }
  });

  it('Base allowed but no key: refused with evm_key_missing, nothing signed', async () => {
    const t = setup([base()], { key: null });
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.result).toBe('refused');
    expect(r.reasons).toEqual(['evm_key_missing: set X402_EVM_KEY_PATH']);
    expect(t.sent).toHaveLength(0);
  });

  it('② allowed: one EIP-3009 signature that verifies against the fixed USDC domain, with the checked values', async () => {
    const t = setup([base()]);
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.result).toBe('paid');
    expect(r.payment?.network).toBe('eip155:84532');
    expect(r.choice).toEqual({ chain: 'base', reason: 'only option passing' });
    expect(t.sent).toHaveLength(1);
    const p = decodePaymentSignatureHeader(t.sent[0]);
    const { authorization: a, signature } = p.payload as { authorization: Record<string, string>; signature: Hex };
    const from = privateKeyToAccount(t.key!).address;
    expect(getAddress(a.from)).toBe(from);
    expect(getAddress(a.to)).toBe(getAddress(EVM_PAY_TO));
    expect(a.value).toBe('20000');
    const left = Number(a.validBefore) - Math.floor(Date.now() / 1000);
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(300);
    const ok = await verifyTypedData({ address: from, domain: SEPOLIA_DOMAIN, types: TYPES, primaryType: 'TransferWithAuthorization', signature,
      message: { from, to: getAddress(a.to), value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce as Hex } });
    expect(ok).toBe(true);
    // Base mainnet domain does not verify (chainId and name differ)
    const wrong = await verifyTypedData({ address: from, domain: { ...SEPOLIA_DOMAIN, chainId: 8453 }, types: TYPES, primaryType: 'TransferWithAuthorization', signature,
      message: { from, to: getAddress(a.to), value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce as Hex } });
    expect(wrong).toBe(false);
    expect(t.history.list(1)[0]).toMatchObject({ result: 'paid', network: 'eip155:84532', signed: true });
  });

  it('③ refused before signing: untrusted payTo, over limit, other token, other chain, permit2, other domain, long validity', async () => {
    const cases: [PaymentRequirements, RegExp][] = [
      [base({ payTo: '0x3333333333333333333333333333333333333333' }), /pay_to_not_trusted/],
      [base({ amount: '60000' }), /over_per_payment_limit/],
      [base({ asset: '0x4444444444444444444444444444444444444444' }), /asset_not_allowed: unknown token/],
      [base({ network: 'eip155:8453' as never, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }, { name: 'USD Coin' }), /wrong_network: eip155:8453/],
      [base({}, { assetTransferMethod: 'permit2' }), /unsupported_transfer_method: permit2/],
      [base({}, { name: 'Other Token' }), /eip712_domain_mismatch/],
      [base({ maxTimeoutSeconds: 86400 }), /timeout_too_long/],
    ];
    for (const [req, re] of cases) {
      const t = setup([req]);
      const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
      expect(r.result, String(re)).toBe('refused');
      expect(r.reasons?.join(' ')).toMatch(re);
      expect(t.sent).toHaveLength(0);
      expect(t.evmWallet!.signedCount).toBe(0);
    }
  });

  it('④ daily USD limit is shared: Solana spending today counts against a Base payment', async () => {
    const t = setup([base()], { env: { X402_MAX_USD_PER_DAY: '0.03' } });
    t.history.add({ at: new Date().toISOString(), url: 'https://x/', host: 'x', network: NETWORKS.devnet, asset: 'USDC', mint: SOL_USDC, amount: '20000', payTo: TRUSTED_SOL, result: 'paid', signed: true });
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.result).toBe('refused');
    expect(r.reasons?.join(' ')).toMatch(/over_daily_usd_limit: 0.02 \+ 0.02 > 0.03/);
    expect(t.sent).toHaveLength(0);
  });

  it('confirmation above the configured amount applies to Base too', async () => {
    const asked: string[] = [];
    const t = setup([base()], { env: { X402_CONFIRM_ABOVE_USD: '0.01' }, confirm: async (m) => { asked.push(m); return 'decline'; } });
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.result).toBe('declined_by_user');
    expect(asked[0]).toMatch(/Pay 0.02 USDC on Base to 0x2222/);
    expect(t.evmWallet!.signedCount).toBe(0);
    expect(t.sent).toHaveLength(0);
  });

  it('⑥ both chains pass: Solana by default; Base when X402_PREFER_NETWORK=base; quote shows the choice', async () => {
    const t = setup([base(), sol()]);
    const q = await t.agent.quote({ url: `https://${HOST}/paid` });
    expect(q.payment?.network).toBe(NETWORKS.devnet);
    expect(q.choice).toEqual({ chain: 'solana', reason: 'preferred network' });
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.payment?.network).toBe(NETWORKS.devnet);
    expect(t.solSigned()).toBe(1);
    expect(t.evmWallet!.signedCount).toBe(0);

    const b = setup([sol(), base()], { evmEnv: { ...ON, X402_PREFER_NETWORK: 'base' } });
    const q2 = await b.agent.quote({ url: `https://${HOST}/paid` });
    expect(q2.choice).toEqual({ chain: 'base', reason: 'preferred network' });
    const r2 = await b.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r2.payment?.network).toBe('eip155:84532');
    expect(b.solSigned()).toBe(0);
  });

  it('after signing, values that no longer match are not sent (recorded refused, signed)', async () => {
    // A clock 2 hours behind makes the authorization's validity look longer than allowed
    const t = setup([base()], { skewSeconds: -7200 });
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.result).toBe('refused');
    expect(r.reasons?.[0]).toMatch(/^evm_authorization_mismatch/);
    expect(t.sent).toHaveLength(0);
    expect(t.history.list(1)[0]).toMatchObject({ result: 'refused', signed: true });
    await expect(t.evmWallet!.sign({ url: 'x', description: 'x' } as never, base())).rejects.toBeInstanceOf(EvmAuthorizationMismatch);
  });

  it('⑤ the key never appears in results, history or errors', async () => {
    const t = setup([base()]);
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    const q = await t.agent.quote({ url: `https://${HOST}/paid` });
    const hex = t.key!.slice(2).toLowerCase();
    for (const s of [JSON.stringify(r), JSON.stringify(q), readFileSync(t.historyPath, 'utf8'), JSON.stringify(t.evmWallet), ...t.sent]) {
      expect(s.toLowerCase()).not.toContain(hex);
    }
    const dir = mkdtempSync(join(tmpdir(), 'paymcp-evm-key-'));
    const bad = join(dir, 'k');
    writeFileSync(bad, `${t.key}extra`);
    expect(() => readEvmKeyFile(bad)).toThrow(/expected one line/);
    try { readEvmKeyFile(bad); } catch (e) { expect(String(e).toLowerCase()).not.toContain(hex); }
    expect(() => readEvmKeyFile(join(dir, 'missing'))).toThrow(/cannot read the key file \(ENOENT\)/);
    const good = join(dir, 'g');
    writeFileSync(good, `${t.key}\n`);
    const w = await loadEvmWallet(good, 'eip155:84532', policyFromEnv(BASE_ENV));
    expect(w.address).toBe(privateKeyToAccount(t.key!).address);
    await expect(w.signBytes(new Uint8Array(1))).rejects.toThrow(/Solana only/);
  });
});
