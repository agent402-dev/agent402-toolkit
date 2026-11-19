// 공식 @x402/core x402ResourceServer 위에 얹는 부분 (2주차 시제품).
// 공식 코드가 맡는 것: /supported 읽기, 결제 조건 만들기(parsePrice·feePayer·transactionVersions 채우기),
//                      결제와 조건 맞추기(findMatchingRequirements), facilitator verify·settle 호출
// 우리가 맡는 것(x402.ts): facilitator 장애 시 예비로, 요청마다 결제 수단 고르기, 재사용 방지 장부, 체인 판정·재확인
import { x402ResourceServer, type FacilitatorClient } from '@x402/core/server';
import type { Network, PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { ExactSvmScheme } from '@x402/svm/exact/server';

/** facilitator 하나를 감싼 공식 리소스 서버 (그 facilitator 의 /supported 로 초기화) */
export async function createCoreServer(client: FacilitatorClient, network: string): Promise<x402ResourceServer> {
  const server = new x402ResourceServer(client).register(network as Network, new ExactSvmScheme());
  await server.initialize();
  return server;
}

/** facilitator 없이 조건 맞추기만 하는 서버 (네트워크별 하나) */
const matchers = new Map<string, x402ResourceServer>();
function matcher(network: string): x402ResourceServer {
  let m = matchers.get(network);
  if (!m) { m = new x402ResourceServer([]).register(network as Network, new ExactSvmScheme()); matchers.set(network, m); }
  return m;
}

/** 공식 매칭 규칙으로, 결제가 고른 조건(accepted)과 같은 지금 조건 */
export function matchRequirement(current: PaymentRequirements[], payload: PaymentPayload, network: string): PaymentRequirements | undefined {
  try { return matcher(network).findMatchingRequirements(current, payload); } catch { return undefined; }
}

export interface CoreOffer {
  asset: string;
  amount: string;
  extra: Record<string, unknown>;
}

/** 공식 서버로 결제 조건 만들기 (요청마다 결제 수단 목록은 호출자가 정함) */
export function buildCoreRequirements(server: x402ResourceServer, network: string, payTo: string, maxTimeoutSeconds: number, offers: CoreOffer[]): Promise<PaymentRequirements[]> {
  return server.buildPaymentRequirementsFromOptions(
    offers.map((o) => ({
      scheme: 'exact',
      network: network as Network,
      payTo,
      maxTimeoutSeconds,
      price: { asset: o.asset, amount: o.amount, extra: o.extra },
    })),
    {},
  );
}

/**
 * 정산 예외에 facilitator 가 적어 보낸 실패 이유 (있으면). 기록·안내용일 뿐 — 실패 응답이어도 facilitator 가 tx 를 보낸 뒤
 * 확정 대기 시간 초과로 실패를 돌려줄 수 있으므로, 결과는 언제나 체인에서 판정함
 */
export function settleFailureReason(e: unknown): string | null {
  const err = e as { name?: string; statusCode?: number; errorReason?: string };
  if (err?.name === 'SettleError' && err.errorReason) return `${err.errorReason}${typeof err.statusCode === 'number' ? ` (HTTP ${err.statusCode})` : ''}`;
  return null;
}

/** verify 예외가 "확실한 거절 응답"인지 (4xx + invalidReason) */
export function definiteVerifyRejection(e: unknown): { reason: string; message?: string } | null {
  const err = e as { name?: string; statusCode?: number; invalidReason?: string; invalidMessage?: string };
  if (err?.name === 'VerifyError' && typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500 && err.invalidReason) {
    return { reason: err.invalidReason, message: err.invalidMessage };
  }
  return null;
}
