// Layer on top of the official @x402/core x402ResourceServer.
// The official code handles: reading /supported, building payment requirements (parsePrice, filling feePayer and transactionVersions),
//                          matching payments to requirements (findMatchingRequirements), and calling facilitator verify and settle
// What we handle (x402.ts): fallback when a facilitator is down, choosing payment assets per request, the replay-protection ledger, on-chain decisions and rechecks
import { x402ResourceServer, type FacilitatorClient } from '@x402/core/server';
import type { Network, PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { ExactSvmScheme } from '@x402/svm/exact/server';

/** Official resource server wrapping one facilitator (initialized from that facilitator's /supported) */
export async function createCoreServer(client: FacilitatorClient, network: string): Promise<x402ResourceServer> {
  const server = new x402ResourceServer(client).register(network as Network, new ExactSvmScheme());
  await server.initialize();
  return server;
}

/** Server that only matches requirements, without a facilitator (one per network) */
const matchers = new Map<string, x402ResourceServer>();
function matcher(network: string): x402ResourceServer {
  let m = matchers.get(network);
  if (!m) { m = new x402ResourceServer([]).register(network as Network, new ExactSvmScheme()); matchers.set(network, m); }
  return m;
}

/** The current requirement equal to the one the payment chose (accepted), using the official matching rules */
export function matchRequirement(current: PaymentRequirements[], payload: PaymentPayload, network: string): PaymentRequirements | undefined {
  try { return matcher(network).findMatchingRequirements(current, payload); } catch { return undefined; }
}

export interface CoreOffer {
  asset: string;
  amount: string;
  extra: Record<string, unknown>;
}

/** Builds payment requirements with the official server (the caller decides the payment assets per request) */
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
  * Failure reason the facilitator sent in a settle exception, if any. For logging and messages only: even with a failure response, the facilitator may have sent the tx
  * and then timed out waiting for confirmation, so the result is always decided on-chain
 */
export function settleFailureReason(e: unknown): string | null {
  const err = e as { name?: string; statusCode?: number; errorReason?: string };
  if (err?.name === 'SettleError' && err.errorReason) return `${err.errorReason}${typeof err.statusCode === 'number' ? ` (HTTP ${err.statusCode})` : ''}`;
  return null;
}

/** Whether a verify exception is a "definite rejection" (4xx + invalidReason) */
export function definiteVerifyRejection(e: unknown): { reason: string; message?: string } | null {
  const err = e as { name?: string; statusCode?: number; invalidReason?: string; invalidMessage?: string };
  if (err?.name === 'VerifyError' && typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500 && err.invalidReason) {
    return { reason: err.invalidReason, message: err.invalidMessage };
  }
  return null;
}
