// @agent402-dev/pay-server/check402 — look at an x402 402 answer the way a buyer's agent will, without a wallet.
// Read only: one HTTP request to the URL you give (GET by default), nothing is signed or paid, no key is read.
// Each finding is one line: "fix" (a buyer will stop here), "note" (works, but worth a look) or "ok".
import { decodePaymentRequiredHeader } from '@x402/core/http';

export type Level = 'ok' | 'note' | 'fix';
export interface Finding { level: Level; code: string; message: string }

export interface Answer {
  status: number;
  header: (name: string) => string | null;
  body: string;
}

const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const KNOWN_USDC: Record<string, { label: string; usdc: string }> = {
  [SOLANA_MAINNET]: { label: 'Solana mainnet', usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  [SOLANA_DEVNET]: { label: 'Solana devnet', usdc: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' },
  'eip155:8453': { label: 'Base', usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
  'eip155:84532': { label: 'Base Sepolia', usdc: '0x036cbd53842c5426634e7929541ec2318f3dcf7e' },
};
const OLD_NAMES: Record<string, string> = { solana: SOLANA_MAINNET, 'solana-devnet': SOLANA_DEVNET, base: 'eip155:8453', 'base-sepolia': 'eip155:84532' };
const DESCRIPTION_MAX = 500;
const ICON_FORMATS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const f = (level: Level, code: string, message: string): Finding => ({ level, code, message });

function usdcText(amount: string): string {
  const n = BigInt(amount);
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}${frac ? '.' + frac : ''} USDC`;
}

function checkOption(r: Record<string, unknown>, i: number): Finding[] {
  const out: Finding[] = [];
  const p = `accepts[${i}]`;
  const network = typeof r.network === 'string' ? r.network : '';
  if (r.scheme !== 'exact') out.push(f('fix', 'scheme', `${p}: scheme is ${JSON.stringify(r.scheme ?? null)}; buyer tools pay the "exact" scheme.`));
  if (OLD_NAMES[network]) out.push(f('fix', 'network_name', `${p}: network "${network}" is a v1 name; x402 v2 uses CAIP-2 ("${OLD_NAMES[network]}").`));
  const known = KNOWN_USDC[network];
  if (!network) out.push(f('fix', 'network_missing', `${p}: network is missing.`));
  else if (!known && !OLD_NAMES[network]) out.push(f('note', 'network_other', `${p}: network ${network} is not Solana or Base; buyers limited to those skip this option.`));
  const asset = typeof r.asset === 'string' ? r.asset : '';
  const isUsdc = known && (network.startsWith('eip155:') ? asset.toLowerCase() === known.usdc : asset === known.usdc);
  if (!asset) out.push(f('fix', 'asset_missing', `${p}: asset is missing.`));
  else if (known && !isUsdc) out.push(f('note', 'asset_not_usdc', `${p}: asset is not USDC on ${known.label}; most buyers allow only USDC by default.`));
  const amount = typeof r.amount === 'string' ? r.amount : typeof r.maxAmountRequired === 'string' ? r.maxAmountRequired : '';
  if (typeof r.amount !== 'string' && typeof r.maxAmountRequired === 'string') out.push(f('fix', 'amount_field', `${p}: price is in maxAmountRequired (v1); x402 v2 uses "amount".`));
  if (!/^\d+$/.test(amount)) out.push(f('fix', 'amount_format', `${p}: amount must be a whole number string in the smallest unit (1 USDC = "1000000").`));
  else if (BigInt(amount) === 0n) out.push(f('fix', 'amount_zero', `${p}: amount is 0; buyers refuse a zero price.`));
  else if (isUsdc) out.push(f('ok', 'price', `${p}: ${known!.label}, ${usdcText(amount)} (amount "${amount}").`));
  const payTo = typeof r.payTo === 'string' ? r.payTo : '';
  if (!payTo) out.push(f('fix', 'payto_missing', `${p}: payTo is missing.`));
  else if (network.startsWith('eip155:') && !/^0x[0-9a-fA-F]{40}$/.test(payTo)) out.push(f('fix', 'payto_format', `${p}: payTo is not a 0x address.`));
  else if (network.startsWith('solana:') && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(payTo)) out.push(f('fix', 'payto_format', `${p}: payTo is not a Solana address.`));
  if (typeof r.maxTimeoutSeconds !== 'number' || r.maxTimeoutSeconds <= 0) out.push(f('note', 'timeout', `${p}: maxTimeoutSeconds is missing or not positive.`));
  const extra = isObj(r.extra) ? r.extra : {};
  if (network.startsWith('solana:') && typeof extra.feePayer !== 'string') out.push(f('fix', 'fee_payer', `${p}: extra.feePayer is missing; Solana "exact" buyers need the facilitator's fee payer address.`));
  if (network.startsWith('eip155:') && (typeof extra.name !== 'string' || typeof extra.version !== 'string')) out.push(f('fix', 'eip712_domain', `${p}: extra.name and extra.version (the token's EIP-712 domain, "USD Coin" / "2" for Base USDC) are missing.`));
  if (network.startsWith('eip155:') && extra.assetTransferMethod === 'permit2') out.push(f('note', 'permit2', `${p}: asks for Permit2 (extra.assetTransferMethod "permit2"). Buyers that sign only EIP-3009 transferWithAuthorization skip this option; USDC on Base supports EIP-3009.`));
  return out;
}

/** All findings for one answer. Pure */
export function inspect402(a: Answer, requestUrl: string): Finding[] {
  const out: Finding[] = [];
  if (a.status !== 402) {
    out.push(f('fix', 'status', `Answered HTTP ${a.status}, not 402. Check the URL, the method, and that the route asks for payment before it checks other input.`));
    return out;
  }
  const header = a.header('payment-required');
  let bodyJson: Record<string, unknown> | null = null;
  try { const j = JSON.parse(a.body); if (isObj(j)) bodyJson = j; } catch { /* not JSON */ }
  if (!header) {
    if (bodyJson && bodyJson.x402Version === 1 && Array.isArray(bodyJson.accepts)) out.push(f('fix', 'v1_body_only', 'The payment details are only in the JSON body (x402 v1). x402 v2 buyers read the PAYMENT-REQUIRED header; send both while v1 clients remain.'));
    else if (/^\s*payment\b/i.test(a.header('www-authenticate') ?? '')) out.push(f('note', 'mpp', 'This 402 uses WWW-Authenticate: Payment (Machine Payments Protocol), not x402. x402 buyers need a PAYMENT-REQUIRED header.'));
    else out.push(f('fix', 'header_missing', 'HTTP 402 without a PAYMENT-REQUIRED header.'));
    return out;
  }
  let pr: Record<string, unknown>;
  try { pr = decodePaymentRequiredHeader(header) as unknown as Record<string, unknown>; } catch {
    out.push(f('fix', 'header_undecodable', 'PAYMENT-REQUIRED is not base64 JSON that @x402/core can decode.'));
    return out;
  }
  out.push(f('ok', 'header', 'PAYMENT-REQUIRED header decodes.'));
  if (pr.x402Version !== 2) out.push(f('fix', 'version', `x402Version is ${JSON.stringify(pr.x402Version ?? null)}; the header format is x402 v2.`));
  const accepts = Array.isArray(pr.accepts) ? (pr.accepts as unknown[]).filter(isObj) : [];
  if (!accepts.length) out.push(f('fix', 'accepts_empty', 'accepts is empty: there is nothing a buyer can pay.'));
  accepts.forEach((r, i) => out.push(...checkOption(r, i)));
  // A $0 option next to a sign-in-with-x challenge is a wallet sign-in gate (a free route that asks who you are), not a price
  if (isObj(pr.extensions) && isObj(pr.extensions['sign-in-with-x'])) {
    for (let k = 0; k < out.length; k++) {
      const x = out[k]!;
      if (x.code !== 'amount_zero') continue;
      const p = x.message.split(':')[0];
      out[k] = f('note', 'amount_zero_siwx', `${p}: amount is 0 with a sign-in-with-x challenge: a wallet sign-in gate, not a price. Buyers that only pay (no SIWX sign-in) stop here; list a paid route if you want them to reach it.`);
    }
  }
  // resource
  const res = isObj(pr.resource) ? pr.resource : null;
  const url = res && typeof res.url === 'string' ? res.url : '';
  if (!url) out.push(f('note', 'resource_url_missing', 'resource.url is missing.'));
  else {
    let abs: URL | null = null;
    try { abs = new URL(url); } catch { /* relative */ }
    const req = new URL(requestUrl);
    if (!abs) out.push(f('fix', 'resource_url_relative', 'resource.url is a relative path. Some buyers check it against their domain allowlist and refuse; send the full https URL.'));
    else {
      if (abs.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(abs.hostname)) out.push(f('fix', 'resource_url_http', 'resource.url uses http. Behind a proxy, build it from the public https URL; some buyers refuse non-https resource URLs.'));
      if (abs.hostname !== req.hostname) out.push(f('note', 'resource_url_host', `resource.url is on another host (${abs.hostname}); buyers must allow that host too.`));
    }
  }
  const desc = res && typeof res.description === 'string' ? res.description.trim() : '';
  if (!desc) out.push(f('note', 'description_missing', 'resource.description is empty; discovery catalogs and agents use it to decide.'));
  else if (desc.length > DESCRIPTION_MAX) out.push(f('fix', 'description_too_long', `resource.description is ${desc.length} characters; discovery catalogs accept at most ${DESCRIPTION_MAX}.`));
  if (res && typeof res.mimeType !== 'string') out.push(f('note', 'mime_missing', 'resource.mimeType is missing.'));
  if (res && typeof res.iconUrl === 'string') {
    try {
      const u = new URL(res.iconUrl);
      const ext = (u.pathname.split('.').pop() ?? '').toLowerCase();
      if (u.protocol !== 'https:') out.push(f('fix', 'icon_http', 'resource.iconUrl is not https.'));
      if (!ICON_FORMATS.has(ext)) out.push(f('note', 'icon_format', `resource.iconUrl format "${ext}" may not be accepted (PNG, JPG, JPEG, WebP or GIF; not SVG).`));
    } catch { out.push(f('fix', 'icon_url', 'resource.iconUrl is not a valid URL.')); }
  }
  // discovery
  const bz = isObj(pr.extensions) && isObj(pr.extensions.bazaar) ? pr.extensions.bazaar : null;
  if (!bz) out.push(f('note', 'discovery_missing', 'No extensions.bazaar: discovery catalogs cannot show an input example (optional).'));
  else {
    const info = isObj(bz.info) ? bz.info : null;
    const input = info && isObj(info.input) ? info.input : null;
    if (!input) out.push(f('note', 'discovery_input', 'extensions.bazaar has no info.input example.'));
    else if (input.method !== 'GET' && input.method !== 'POST') out.push(f('note', 'discovery_method', 'extensions.bazaar info.input.method is not GET or POST.'));
    if (!isObj(bz.schema)) out.push(f('note', 'discovery_schema', 'extensions.bazaar has no schema.'));
    if (input && (input.method === 'GET' || input.method === 'POST')) out.push(f('ok', 'discovery', `Discovery metadata present (input ${input.method}).`));
  }
  return out;
}

export interface CheckOptions { method?: 'GET' | 'POST'; body?: string; timeoutMs?: number }

/** One request to the URL (redirects not followed), then inspect402. Never sends a payment header */
export async function check402Url(url: string, o: CheckOptions = {}, fetchImpl: typeof fetch = fetch): Promise<Finding[]> {
  let u: URL;
  try { u = new URL(url); } catch { return [f('fix', 'url', 'Not a valid URL.')]; }
  if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(u.hostname)) return [f('fix', 'url_http', 'Use the public https URL.')];
  const method = o.method ?? 'GET';
  const res = await fetchImpl(url, {
    method,
    redirect: 'manual',
    headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
    body: method === 'POST' ? (o.body ?? '{}') : undefined,
    signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
  });
  if ([301, 302, 303, 307, 308].includes(res.status)) return [f('fix', 'redirect', `Answered HTTP ${res.status} (redirect to ${res.headers.get('location') ?? '?'}). Buyers check the domain on each hop; list the final URL.`)];
  const body = (await res.text().catch(() => '')).slice(0, 20_000);
  const list = inspect402({ status: res.status, header: (n) => res.headers.get(n), body }, url);
  // A zero price on a request with no input is often a price that depends on the input: say how to look again
  if (method === 'GET' && list.some((x) => x.code === 'amount_zero')) list.push(f('note', 'amount_zero_no_input', 'This request sent no input. If the price depends on the input, run the check again with --post \'<example input>\' (or query parameters) to see the price buyers will get.'));
  return list;
}

/** Text report: one line per finding, "fix" first */
export function formatFindings(list: Finding[]): string {
  const order: Level[] = ['fix', 'note', 'ok'];
  const lines = [...list].sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level)).map((x) => `${x.level.padEnd(4)} ${x.message}`);
  const fixes = list.filter((x) => x.level === 'fix').length;
  lines.push(fixes ? `${fixes} thing(s) to fix before buyers' agents can pay.` : 'Nothing to fix found. Nothing was signed or paid.');
  return lines.join('\n');
}

/** JSON report for scripts and CI: the same findings, "fix" first, and the number of fixes */
export function findingsJson(url: string, list: Finding[]): string {
  const order: Level[] = ['fix', 'note', 'ok'];
  const findings = [...list].sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
  return JSON.stringify({ url, fixes: list.filter((x) => x.level === 'fix').length, findings, signedOrPaid: false }, null, 2);
}

export const CHECK_HELP = `agent402-pay-server check <url> [--post '<json body>'] [--json]
  Sends one request to your paid URL (GET, or POST with --post) without any payment header,
  and reads the 402 answer the way an x402 buyer's agent will. Nothing is signed or paid; no key is read.
  --json prints the findings as JSON (for scripts and CI) instead of text.
  Exit code 0 = nothing to fix, 1 = something to fix, 2 = usage error.`;
