// @agent402-dev/pay-server/discovery — optional x402 Bazaar discovery metadata for a 402 response.
// Off by default: without `discovery` in the gate config, the 402 response is unchanged.
// With it, the 402 carries `extensions.bazaar` (input example + JSON Schema, output example) and optionally `resource.iconUrl`.
// Discovery catalogs index a route only after real settlements through a facilitator that supports the extension;
// this module only describes the route. It does not change prices, limits, payTo or any payment check.

/** Longest description discovery catalogs accept (longer ones are refused at verify/settle) */
export const DISCOVERY_DESCRIPTION_MAX = 500;

/** The `extensions.bazaar` declaration: example input, optional output example, and the JSON Schema they follow */
export interface BazaarDeclaration {
  info: { input: Record<string, unknown>; output?: Record<string, unknown> };
  schema: Record<string, unknown>;
}

export interface DiscoveryConfig {
  bazaar: BazaarDeclaration;
  /** Public https image (PNG, JPG, JPEG, WebP or GIF). SVG is not accepted by discovery catalogs */
  iconUrl?: string;
}

export interface BazaarRouteSpec {
  method: 'GET' | 'POST';
  /** POST body format (default json). paidRouteHandler passes the raw body text to your check and run */
  bodyType?: 'json' | 'text';
  /** Example body (POST: an object for json, a string for text) or query parameters (GET) */
  example: Record<string, unknown> | string;
  /** JSON Schema of the body (POST) or of the query parameters (GET) */
  inputSchema: Record<string, unknown>;
  /** Example response body */
  outputExample?: unknown;
  /** JSON Schema of the response body */
  outputSchema?: Record<string, unknown>;
}

/** Builds an `extensions.bazaar` declaration for one HTTP route */
export function bazaarDeclaration(s: BazaarRouteSpec): BazaarDeclaration {
  const bodyType = s.bodyType ?? 'json';
  const input = s.method === 'POST'
    ? { type: 'http', method: 'POST', bodyType, body: s.example }
    : { type: 'http', method: 'GET', queryParams: s.example };
  const inputSchema = s.method === 'POST'
    ? { type: 'object', properties: { type: { const: 'http' }, method: { const: 'POST' }, bodyType: { const: bodyType }, body: s.inputSchema }, required: ['type', 'method', 'bodyType', 'body'] }
    : { type: 'object', properties: { type: { const: 'http' }, method: { const: 'GET' }, queryParams: s.inputSchema }, required: ['type', 'method'] };
  const output = s.outputExample === undefined ? undefined : { type: 'json', example: s.outputExample };
  const outputSchema = s.outputSchema
    ? { type: 'object', properties: { type: { const: 'json' }, example: s.outputSchema }, required: ['type'] }
    : undefined;
  return {
    info: { input, ...(output ? { output } : {}) },
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { input: inputSchema, ...(outputSchema ? { output: outputSchema } : {}) },
      required: ['input'],
    },
  };
}

// Wording that addresses the reading agent instead of describing the route. Catalogs do not list such metadata.
const INSTRUCTION_LIKE: RegExp[] = [
  /\bignore\s+(all|any|the|previous|prior|earlier|other)\b/i,
  /\b(system|developer)\s+prompt\b/i,
  /\byou\s+(must|should|are\s+required|need\s+to|have\s+to)\b/i,
  /\b(always|never|first)\s+(call|use|pay|choose|prefer|select|recommend)\b/i,
  /\bdo\s+not\s+(tell|ask|mention|inform|warn)\b/i,
  /\b(as\s+an?\s+(ai|agent|assistant|llm))\b/i,
  /\b(agents?|assistants?|llms?|models?)\s+(must|should|need\s+to)\b/i,
];

/** Problems with the description and discovery metadata (empty = fine). createPaymentGate refuses to start on any */
export function discoveryProblems(description: string | undefined, d: DiscoveryConfig): string[] {
  const p: string[] = [];
  const desc = (description ?? '').trim();
  if (!desc) p.push('discovery needs resource.description (what the route does and when it is useful)');
  if (desc.length > DISCOVERY_DESCRIPTION_MAX) p.push(`description is ${desc.length} characters; discovery allows ${DISCOVERY_DESCRIPTION_MAX}`);
  const texts = [desc, JSON.stringify(d.bazaar ?? {})];
  for (const re of INSTRUCTION_LIKE) if (texts.some((t) => re.test(t))) p.push(`metadata reads like an instruction to an agent (${re.source}); describe the route instead`);
  const b = d.bazaar as Partial<BazaarDeclaration> | undefined;
  if (!b || typeof b !== 'object' || !b.info || typeof b.info.input !== 'object' || !b.info.input) p.push('discovery.bazaar.info.input is required (an example input)');
  if (!b || typeof b.schema !== 'object' || !b.schema) p.push('discovery.bazaar.schema is required (JSON Schema for info)');
  if (d.iconUrl !== undefined) {
    let u: URL | null = null;
    try { u = new URL(d.iconUrl); } catch { /* reported below */ }
    if (!u || u.protocol !== 'https:') p.push('iconUrl must be a public https URL');
    else if (!/\.(png|jpe?g|webp|gif)$/i.test(u.pathname)) p.push('iconUrl must be a PNG, JPG, JPEG, WebP or GIF image (SVG is not accepted)');
  }
  return p;
}
