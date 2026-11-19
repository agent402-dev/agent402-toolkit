// 결제 지갑: 사용자 컴퓨터의 키 파일로 x402 exact 결제 트랜잭션에 서명 (공식 @x402 클라이언트).
// 키는 서버로 보내지 않음 — 부분 서명한 트랜잭션만 PAYMENT-SIGNATURE 헤더로. 이 모듈은 정책 검사를 통과한 조건 하나에만 서명
import { readFileSync } from 'node:fs';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { x402Client } from '@x402/fetch';
import { toClientSvmSigner } from '@x402/svm';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import type { PayPolicy } from './policy.js';

export interface Wallet {
  address: string;
  network: string;
  /** 정책 검사를 통과한 조건 하나에 서명 → PAYMENT-SIGNATURE 헤더 값 */
  sign(resource: PaymentRequired['resource'], requirement: PaymentRequirements): Promise<string>;
  /** 이 프로세스에서 서명한 횟수 */
  readonly signedCount: number;
  balances(): Promise<Record<string, string>>;
}

export async function loadWallet(keyPath: string, policy: PayPolicy, rpcUrl?: string): Promise<Wallet> {
  const bytes = Uint8Array.from(JSON.parse(readFileSync(keyPath, 'utf8')) as number[]);
  const signer = await createKeyPairSignerFromBytes(bytes);
  bytes.fill(0);
  let signed = 0;
  // 공식 클라이언트의 지출 한도도 같은 값으로 (두 번째 안전망)
  const client = x402Client.fromConfig({
    schemes: [{ network: policy.network as `${string}:${string}`, client: new ExactSvmScheme(toClientSvmSigner(signer), rpcUrl ? { rpcUrl } : undefined) }],
    spendControls: {
      maxAmountPerPayment: `$${policy.maxUsdPerPayment}`,
      // A402 는 허용 + 결제당 상한이 설정됐을 때만 공식 클라이언트에도 허용 (상한 없으면 공식 클라이언트도 거절)
      ...(policy.allowedAssets.includes('A402') && policy.maxA402PerPayment !== null
        ? { allowedAssets: [{ network: policy.network as `${string}:${string}`, asset: policy.mints.A402, maxAmountPerPayment: policy.maxA402PerPayment.toString() }] }
        : {}),
    },
  });
  const rpc = rpcUrl ?? (policy.network.includes('EtWTRAB') ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com');
  return {
    address: signer.address,
    network: policy.network,
    get signedCount() { return signed; },
    async sign(resource, requirement) {
      const payload = await client.createPaymentPayload({ x402Version: 2, resource, accepts: [requirement] } as PaymentRequired);
      signed++;
      return encodePaymentSignatureHeader(payload);
    },
    async balances() {
      const out: Record<string, string> = {};
      for (const [sym, mint] of Object.entries(policy.mints)) {
        try {
          const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [signer.address, { mint }, { encoding: 'jsonParsed' }] }) });
          const j = (await r.json()) as { result?: { value: { account: { data: { parsed: { info: { tokenAmount: { uiAmountString: string } } } } } }[] } };
          out[sym] = j.result?.value[0]?.account.data.parsed.info.tokenAmount.uiAmountString ?? '0';
        } catch { out[sym] = 'unavailable'; }
      }
      return out;
    },
  };
}
