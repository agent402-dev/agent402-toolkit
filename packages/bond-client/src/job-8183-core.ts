/**
 * Dependency-free parts of the 8183-style job layer: reason codes (client metadata, never stored on chain),
 * the status of a settled Bond v2 outcome, and the small result schema used for machine checks.
 * Shared by bond-client (web3.js) and pay-mcp / bond-seller-mcp. Internal review only, not independently audited.
 */
export const OUTCOME_NAMES = ['Accepted', 'Unconfirmed', 'SellerDefault', 'Cancelled', 'Agreed', 'Arbitrated', 'Released'] as const;
export type OutcomeName = (typeof OUTCOME_NAMES)[number];

// ---------------- reason codes ----------------

export const REASON_CODES = [
  'deadline_missed', 'not_delivered', 'receipt_mismatch', 'schema_mismatch',
  'data_incorrect', 'quality_below_brief', 'scope_dispute', 'originality', 'offchain_unfulfilled', 'other',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];
/** Reasons a client can decide from data alone (the rest need a person or an evaluator). */
export const MACHINE_REASONS: readonly ReasonCode[] = ['deadline_missed', 'not_delivered', 'receipt_mismatch', 'schema_mismatch'];
export const isReasonCode = (v: unknown): v is ReasonCode => typeof v === 'string' && (REASON_CODES as readonly string[]).includes(v);
export const isMachineReason = (r: ReasonCode) => MACHINE_REASONS.includes(r);
/** A missing or unknown reason becomes `other`, so a reject is never left blank. */
export const normalizeReason = (v: unknown): ReasonCode => (isReasonCode(v) ? v : 'other');

/** Counts per reason plus machine / non-machine totals (for the daily Bond figures). */
export function countReasons(reasons: readonly unknown[]) {
  const by = Object.fromEntries(REASON_CODES.map((c) => [c, 0])) as Record<ReasonCode, number>;
  for (const r of reasons) by[normalizeReason(r)]++;
  const machine = MACHINE_REASONS.reduce((n, c) => n + by[c], 0);
  return { by, machine, notMachine: reasons.length - machine, total: reasons.length };
}

// ---------------- status ----------------

export type JobStatus = 'Funded' | 'Submitted' | 'Completed' | 'Rejected' | 'Expired';

/** 8183-style status of a settled outcome. Agreed / Arbitrated count as Completed when the seller gets more than its own bond back. */
export function statusOfOutcome(o: OutcomeName, owedSeller: bigint, sellerBond: bigint): JobStatus {
  switch (o) {
    case 'Accepted': return 'Completed';
    case 'SellerDefault': return 'Expired';
    case 'Unconfirmed': case 'Cancelled': case 'Released': return 'Rejected';
    case 'Agreed': case 'Arbitrated': return owedSeller > sellerBond ? 'Completed' : 'Rejected';
  }
}

// ---------------- machine-checkable conditions ----------------

/** A small JSON schema subset agreed at quote time: type, required, properties, items, enum. */
export interface JobSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  required?: string[];
  properties?: Record<string, JobSchema>;
  items?: JobSchema;
  enum?: unknown[];
}
const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** Problems of `value` against `schema` (empty = matches). Unknown keywords are ignored. */
export function schemaProblems(value: unknown, schema: JobSchema, path = '$'): string[] {
  const out: string[] = [];
  if (schema.type) {
    const t = typeOf(value);
    const ok = schema.type === 'integer' ? Number.isInteger(value) : schema.type === t;
    if (!ok) return [`${path} must be ${schema.type}`];
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) out.push(`${path} is not an allowed value`);
  if (typeOf(value) === 'object') {
    const o = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in o)) out.push(`${path}.${k} is missing`);
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in o) out.push(...schemaProblems(o[k], s, `${path}.${k}`));
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => out.push(...schemaProblems(v, schema.items!, `${path}[${i}]`)));
  return out;
}

/** Whether a delivered result (a string) parses as JSON and matches the schema. */
export function matchesJobSchema(result: string, schema: JobSchema): string[] {
  let v: unknown;
  try { v = JSON.parse(result); } catch { return ['result is not JSON']; }
  return schemaProblems(v, schema);
}


// ---------------- sample check (client layer only; moves no funds) ----------------

/** Evidence kind recorded with `data_incorrect` when a re-fetched sample differs from what the seller signed. */
export const SAMPLE_EVIDENCE = 'sample_mismatch' as const;

/** Data origin a seller signed in its receipt (`source` in the pay-server receipt). */
export interface SignedSource { url: string; fetchedAt: string; sha256: string; immutable: boolean }

/**
 * Compares the SHA-256 (hex) of bytes the buyer re-fetched from `source.url` with what the seller signed.
 * A mismatch becomes `data_incorrect` with evidence `sample_mismatch`; it counts as machine-checkable only when the
 * seller marked the source immutable (live data may change between fetches). Nothing is signed or moved: the buyer
 * can only not accept (Bond v2 then settles as Unconfirmed); moving the seller's bond still needs agreement or an arbiter.
 */
export function sampleCheck(source: SignedSource, refetchedSha256: string) {
  const got = refetchedSha256.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(got)) throw new Error('sampleCheck: refetchedSha256 must be 64 hex characters');
  if (!/^[0-9a-f]{64}$/.test(source.sha256)) throw new Error('sampleCheck: source.sha256 must be 64 hex characters');
  const match = got === source.sha256;
  return match
    ? { match: true as const }
    : { match: false as const, code: 'data_incorrect' as ReasonCode, evidence: SAMPLE_EVIDENCE, machineCheckable: source.immutable === true, url: source.url, signedAt: source.fetchedAt };
}

/** Like countReasons, and also counts `data_incorrect` rejects proven by a sample of an immutable source (sampleProven). */
export function countReasonsWithEvidence(items: readonly { code: unknown; evidence?: unknown; immutable?: unknown }[]) {
  const base = countReasons(items.map((i) => i.code));
  const sampleProven = items.filter((i) => normalizeReason(i.code) === 'data_incorrect' && i.evidence === SAMPLE_EVIDENCE && i.immutable === true).length;
  return { ...base, sampleProven, machineWithSamples: base.machine + sampleProven };
}

// ---------------- reputation (8004-style feedback; builds data only, sends nothing) ----------------

export interface JobFeedbackInput {
  /** Bond v2 program and deal account (base58) */
  program: string; deal: string;
  /** Final 8183-style status; Funded / Submitted are not final and are refused */
  status: JobStatus;
  /** Job amount in the asset's smallest units, its decimals and symbol */
  amount: bigint; decimals: number; asset: string;
  /** Reject reason code (client metadata); a missing or unknown one becomes `other` */
  reason?: unknown;
  /** Settlement transaction signature, if known */
  settleTx?: string;
  /** Endpoint the job was bought from (https, at most 250 bytes) */
  endpoint?: string;
  /** Where the feedback file will be published (https, at most 250 bytes) */
  feedbackUri?: string;
}

const utf8Len = (s: string) => new TextEncoder().encode(s).length;
const decimalOf = (v: bigint, d: number) => {
  const neg = v < 0n; const a = neg ? -v : v; const p = 10n ** BigInt(d);
  const frac = d ? (a % p).toString().padStart(d, '0').replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${a / p}${frac ? '.' + frac : ''}`;
};

/**
 * Feedback for a finished job in the shape of the Solana 8004 registry's giveFeedback parameters (value, score, tag1,
 * tag2, endpoint, feedbackUri, feedbackFileHash), plus the JSON feedback file whose SHA-256 is the file hash.
 * value = the job amount (money at stake). score: Completed 100, Expired 0 (deadline missed), Rejected with a
 * machine-checkable reason 0, Rejected for any other reason no score (nobody has decided who was right).
 * Builds data only: writing it on mainnet is a separate, approved step.
 */
export async function jobFeedback(i: JobFeedbackInput) {
  if (i.status !== 'Completed' && i.status !== 'Rejected' && i.status !== 'Expired') throw new Error(`jobFeedback: status ${i.status} is not final`);
  if (!Number.isInteger(i.decimals) || i.decimals < 0 || i.decimals > 18) throw new Error('jobFeedback: decimals must be 0-18');
  if (i.amount < 0n) throw new Error('jobFeedback: amount must not be negative');
  for (const [k, v] of [['endpoint', i.endpoint], ['feedbackUri', i.feedbackUri]] as const) {
    if (v !== undefined && (!/^https:\/\/\S+$/.test(v) || utf8Len(v) > 250)) throw new Error(`jobFeedback: ${k} must be an https URL of at most 250 bytes`);
  }
  const reason = i.status === 'Rejected' ? normalizeReason(i.reason) : null;
  const score = i.status === 'Completed' ? 100 : i.status === 'Expired' ? 0 : isMachineReason(reason!) ? 0 : undefined;
  const tag2 = reason ? `rejected:${reason}` : i.status.toLowerCase();
  const file = {
    type: 'agent402.job-feedback', v: 1, program: i.program, deal: i.deal, status: i.status,
    ...(reason ? { reason, machineCheckable: isMachineReason(reason) } : {}),
    amount: i.amount.toString(), decimals: i.decimals, asset: i.asset,
    ...(i.settleTx ? { settleTx: i.settleTx } : {}),
  };
  const fileJson = JSON.stringify(file);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fileJson)));
  const params = {
    value: decimalOf(i.amount, i.decimals),
    ...(score !== undefined ? { score } : {}),
    tag1: 'agent402-job', tag2,
    ...(i.endpoint ? { endpoint: i.endpoint } : {}),
    ...(i.feedbackUri ? { feedbackUri: i.feedbackUri } : {}),
    feedbackFileHash: hash,
  };
  return { params, file, fileJson };
}
