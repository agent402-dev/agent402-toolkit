// Summary of a seller's x402 discovery metadata (extensions.bazaar, resource.iconUrl) for x402_quote.
// Read only and shape only: lengths, presence and formats. The seller's own text is never repeated (it is data, not instructions),
// and nothing here affects the payment rules, the chosen option or the quote.

/** Longest description discovery catalogs accept */
export const DISCOVERY_DESCRIPTION_MAX = 500;

export interface DiscoverySummary {
  /** extensions.bazaar is present */
  bazaar: boolean;
  /** resource.description length in characters (0 when missing) */
  descriptionLength: number;
  /** Within the length discovery catalogs accept */
  descriptionWithinLimit: boolean;
  inputExample: boolean;
  /** Request method the input example declares (GET = query parameters, POST = body); null when missing or another value */
  inputMethod: 'GET' | 'POST' | null;
  outputExample: boolean;
  schema: boolean;
  /** Icon format from the URL path (png, jpg, jpeg, webp, gif, svg, other), or null when there is no iconUrl */
  iconFormat: string | null;
  /** The icon URL uses https */
  iconHttps: boolean | null;
  /** Things discovery catalogs are known to reject (short codes) */
  notes: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function discoverySummary(pr: { resource?: unknown; extensions?: unknown }): DiscoverySummary {
  const resource = isObj(pr.resource) ? pr.resource : {};
  const desc = typeof resource.description === 'string' ? resource.description.trim() : '';
  const bz = isObj(pr.extensions) && isObj(pr.extensions.bazaar) ? pr.extensions.bazaar : null;
  const info = bz && isObj(bz.info) ? bz.info : null;
  let iconFormat: string | null = null;
  let iconHttps: boolean | null = null;
  if (typeof resource.iconUrl === 'string') {
    try {
      const u = new URL(resource.iconUrl);
      iconHttps = u.protocol === 'https:';
      const m = /\.([a-z0-9]+)$/i.exec(u.pathname);
      const ext = m ? m[1].toLowerCase() : '';
      iconFormat = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext) ? ext : 'other';
    } catch { iconFormat = 'other'; iconHttps = false; }
  }
  const s: DiscoverySummary = {
    bazaar: bz !== null,
    descriptionLength: desc.length,
    descriptionWithinLimit: desc.length > 0 && desc.length <= DISCOVERY_DESCRIPTION_MAX,
    inputExample: !!info && isObj(info.input),
    inputMethod: info && isObj(info.input) && (info.input.method === 'GET' || info.input.method === 'POST') ? info.input.method : null,
    outputExample: !!info && info.output !== undefined,
    schema: !!bz && isObj(bz.schema),
    iconFormat,
    iconHttps,
    notes: [],
  };
  if (desc.length === 0) s.notes.push('no_description');
  else if (desc.length > DISCOVERY_DESCRIPTION_MAX) s.notes.push('description_too_long');
  if (bz && !s.inputExample) s.notes.push('bazaar_without_input_example');
  if (bz && !s.schema) s.notes.push('bazaar_without_schema');
  if (iconFormat === 'svg' || iconFormat === 'other') s.notes.push('icon_format_not_accepted');
  if (iconHttps === false) s.notes.push('icon_not_https');
  return s;
}
