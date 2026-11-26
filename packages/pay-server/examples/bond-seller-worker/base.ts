// Optional: also take USDC on Base for POST /x402/job. Off unless X402_BASE_PAY_TO is set; then the 402 lists the
// Solana option first and the Base option second (official @x402/evm `exact`, EIP-3009 only). With it unset the 402 is unchanged.
// No key goes here: X402_BASE_PAY_TO is a public 0x address. BASE_RPC_URL is read-only (the on-chain recheck after settle).
// There is no default facilitator for Base mainnet: set X402_BASE_FACILITATOR_URL to one whose /supported lists `exact` on eip155:8453.
export interface BaseEnv {
  X402_BASE_PAY_TO?: string;
  BASE_RPC_URL?: string;
  X402_BASE_FACILITATOR_URL?: string;
}

export interface BaseOption {
  payTo: string;
  rpcUrl: string;
  facilitators: { name: string; url: string }[];
}

/** The `base` option for paidRouteHandler, or undefined when X402_BASE_PAY_TO is unset. Throws on a half-set config. */
export function baseOption(env: BaseEnv): BaseOption | undefined {
  const payTo = env.X402_BASE_PAY_TO?.trim();
  if (!payTo) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo) || /^0x0{40}$/.test(payTo)) throw new Error('X402_BASE_PAY_TO must be a 0x address (40 hex digits, not the zero address)');
  const rpcUrl = env.BASE_RPC_URL?.trim();
  if (!rpcUrl || !/^https:\/\//.test(rpcUrl)) throw new Error('BASE_RPC_URL must be an https URL when X402_BASE_PAY_TO is set');
  const f = env.X402_BASE_FACILITATOR_URL?.trim();
  if (!f || !/^https:\/\//.test(f)) throw new Error('X402_BASE_FACILITATOR_URL must be an https URL when X402_BASE_PAY_TO is set');
  return { payTo, rpcUrl, facilitators: [{ name: new URL(f).host, url: f }] };
}
