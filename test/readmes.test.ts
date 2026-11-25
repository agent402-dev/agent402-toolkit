// Shared rules for the public READMEs (root + packages): disclaimer, the 4 things it does not do, unrelated to similar names, no rating or recommendation wording, units for token (PREQ, A402) amounts, English only
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const files = {
  root: '../README.md',
  'check-engine': '../packages/check-engine/README.md',
  'check-mcp': '../packages/check-mcp/README.md',
  'pay-server': '../packages/pay-server/README.md',
  'pay-mcp': '../packages/pay-mcp/README.md',
  'bond-seller-mcp': '../packages/bond-seller-mcp/README.md',
};
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe.each(Object.entries(files))('README %s', (_name, path) => {
  const md = read(path);
  it('disclaimer, English only', () => {
    expect(md).toContain('Not investment advice.');
    expect(md).not.toMatch(/[\uAC00-\uD7A3]/);
  });
  it('the 4 things it does not do + no judgement', () => {
    expect(md).toMatch(/does not operate a facilitator/i);
    expect(md).toMatch(/does not hold funds/i);
    expect(md).toMatch(/does not exchange/i);
    expect(md).toMatch(/does not accept or send payments on anyone's behalf/i);
    expect(md).toMatch(/does not judge, score or rate/i);
  });
  it('unrelated to similar names', () => {
    expect(md).toMatch(/Not related to `agent402\.tools`, `@agents402` or other similarly named/);
  });
  it('no rating or recommendation wording', () => {
    // Check without negations such as "does not judge, score or rate"
    const body = md.replace(/does not judge, score or rate[^.\n]*/gi, '');
    expect(body).not.toMatch(/\b(safe|safest|safety|risky|risk|scam|rug|rugpull|best|recommend(ed)?|guarantee[ds]?|trustworthy|reliable|score|grade|rating|bullish|bearish)\b/i);
    expect(body).not.toMatch(/\b(to the moon|lambo)\b/i);
  });
  it.each(['PREQ', 'A402'])('%s amounts with units (number + token, or a base unit explanation)', (tok) => {
    // No bare base-unit number before the token: e.g. "140000000000 PREQ" is not allowed
    expect(md).not.toMatch(new RegExp(`\\b\\d{7,}\\s*${tok}\\b`));
    // A README that covers that token's limit variables states the base unit conversion
    if (new RegExp(`${tok}_ATOMIC`).test(md)) expect(md).toMatch(new RegExp(`1 ${tok} = 1,000,000`));
    for (const line of md.split('\n').filter((l) => new RegExp(`${tok}[A-Z_]*ATOMIC`).test(l) && l.startsWith('|'))) {
      expect(line).toMatch(/smallest unit/);
    }
  });
  it('a README that explains `amount` states the base unit conversion of the payment token (PREQ)', () => {
    if (/`amount`/.test(md)) expect(md).toMatch(/1 PREQ = 1,000,000/);
  });
  it('package names are scoped only (no old a402-* npm names)', () => {
    expect(md).not.toMatch(/(^|[^\/.\w-])a402-(check-engine|check-mcp|pay-server|pay-mcp)\b/m);
  });
  it('no personal info or old repository names', () => {
    expect(md).not.toMatch(/github\.com\/agent402-dev\/a402-check-engine/);
    expect(md).not.toMatch(/[A-Za-z]:\\Users\\/);
  });
});

describe('docs/getting-started.md How to pay FAQ', () => {
  const md = read('../docs/getting-started.md');
  const faq = md.slice(md.indexOf('### How to pay (FAQ)'), md.indexOf('## Seller: get paid by AI agents'));
  const policy = read('../packages/pay-mcp/src/policy.ts');
  it('section exists, linked from the top, English only, disclaimer kept', () => {
    expect(faq.length).toBeGreaterThan(200);
    expect(md).toContain('(#how-to-pay-faq)');
    expect(md).not.toMatch(/[가-힣]/);
    expect(md).toContain('Not investment advice.');
  });
  it('402 example parses and its amount matches the stated display value', () => {
    const json = JSON.parse(faq.split('```json')[1].split('```')[0]);
    expect(json.x402Version).toBe(2);
    const a = json.accepts[0];
    expect(a.network).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    expect(a.asset).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(Number(a.amount) / 1_000_000).toBe(0.05);
    expect(faq).toContain('"amountDisplay": "0.05 USDC"');
  });
  it('quote before fetch, and every env variable named exists in pay-mcp', () => {
    expect(faq.indexOf('`x402_quote`')).toBeLessThan(faq.indexOf('`x402_fetch`'));
    for (const v of new Set(faq.match(/X402_[A-Z_]+/g) ?? [])) expect(policy).toContain(v);
    expect(policy).toContain('pay_to_not_trusted');
  });
});

describe('pay-server README: check your own 402 without a wallet', () => {
  const md = read('../packages/pay-server/README.md');
  const sec = md.slice(md.indexOf('## Check your own 402 without a wallet'), md.indexOf('## Signed receipts'));
  const policy = read('../packages/pay-mcp/src/policy.ts');
  const agent = read('../packages/pay-mcp/src/agent.ts');
  const server = read('../packages/pay-mcp/src/server.ts');
  it('section exists, no key file in the example config, quote only', () => {
    expect(sec.length).toBeGreaterThan(300);
    const cfg = JSON.parse(sec.split('```json')[1].split('```')[0]);
    expect(Object.keys(cfg.env).sort()).toEqual(['X402_ALLOWED_DOMAINS', 'X402_TRUSTED_PAY_TO']);
    expect(server).toMatch(/X402_KEYPAIR_PATH.*Without it, no payments \(x402_quote only\)/);
    expect(sec).toContain('`x402_quote`');
    expect(sec).not.toContain('`x402_fetch`');
  });
  it('every reason and env variable named exists in pay-mcp', () => {
    for (const r of ['domain_not_allowed', 'pay_to_not_trusted', 'invalid_payment_required_header', 'wrong_network', 'unsupported_scheme', 'asset_not_allowed', 'over_per_payment_limit']) {
      expect(sec).toContain(`\`${r}\``);
      expect(policy + agent).toContain(r);
    }
    for (const v of new Set(sec.match(/X402_[A-Z_]+/g) ?? [])) expect(policy + server).toContain(v);
  });
  it('stated default per-payment limit matches pay-mcp', () => {
    const m = policy.match(/maxUsdPerPayment: num\(env\.X402_MAX_USD, ([\d.]+)\)/);
    expect(m).not.toBeNull();
    expect(sec).toContain(`default ${m![1]} USD`);
  });
});

describe('links to the seller 402 self-check', () => {
  const slug = (h: string) => h.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
  const psrv = read('../packages/pay-server/README.md');
  const anchors = new Set((psrv.match(/^#{2,3} .+$/gm) ?? []).map((h) => slug(h.replace(/^#+ /, ''))));
  it.each([
    ['getting-started', '../docs/getting-started.md', '../packages/pay-server/README.md#'],
    ['seller template', '../examples/bond-seller-worker/README.md', '../../README.md#'],
    ['pay-mcp llms-install', '../packages/pay-mcp/llms-install.md', 'https://github.com/agent402-dev/agent402-toolkit/blob/main/packages/pay-server/README.md#'],
  ])('%s links to an existing pay-server anchor and uses x402_quote with POST /x402/job', (_n, path, prefix) => {
    let md: string;
    try { md = read(path); } catch { md = read(path.replace('../examples/', '../packages/pay-server/examples/')); }
    const target = 'check-your-own-402-without-a-wallet';
    expect(md).toContain(`](${prefix}${target})`);
    expect(anchors.has(target)).toBe(true);
    expect(md).toMatch(/`x402_quote` with `POST https:\/\/<your-worker>\/x402\/job` and no body/);
  });
});

describe('Claude Code plugin install lines', () => {
  it.each([
    ['getting-started', '../docs/getting-started.md', 'agent402-pay'],
    ['pay-mcp', '../packages/pay-mcp/README.md', 'agent402-pay'],
    ['bond-seller-mcp', '../packages/bond-seller-mcp/README.md', 'agent402-sell'],
    ['check-mcp', '../packages/check-mcp/README.md', 'agent402-check'],
  ])('%s: marketplace add + install %s@agent402, the plugin is listed in the root README', (_n, path, plugin) => {
    const md = read(path);
    expect(md).toContain('`claude plugin marketplace add agent402-dev/agent402-toolkit`, then `claude plugin install ' + plugin + '@agent402`');
    expect(read(files.root)).toContain(plugin + '@agent402');
    if (_n !== 'getting-started') expect(md).toContain('Codex: `codex plugin marketplace add agent402-dev/agent402-toolkit`, then `codex plugin add ' + plugin + '@agent402` (needs git on PATH)');
  });
});

describe('Codex plugin install lines', () => {
  const codexMarket = ['../claude-plugins/.agents/plugins/marketplace.json', '../.agents/plugins/marketplace.json']
    .map((p) => new URL(p, import.meta.url)).find((u) => existsSync(u));
  it('root README and getting-started: marketplace add + codex plugin add, git noted', () => {
    expect(read(files.root)).toContain('`codex plugin marketplace add agent402-dev/agent402-toolkit`, then `codex plugin add agent402-pay@agent402`, `agent402-sell@agent402` or `agent402-check@agent402`. Needs git on PATH.');
    expect(read('../docs/getting-started.md')).toContain('`codex plugin marketplace add agent402-dev/agent402-toolkit`, then `codex plugin add agent402-pay@agent402` (needs git on PATH)');
  });
  it('both marketplace files exist and give each plugin the same name, order and description', () => {
    const claudeMarket = ['../claude-plugins/.claude-plugin/marketplace.json', '../.claude-plugin/marketplace.json']
      .map((p) => new URL(p, import.meta.url)).find((u) => existsSync(u));
    expect(codexMarket).toBeTruthy();
    expect(claudeMarket).toBeTruthy();
    type M = { name: string; plugins: { name: string; description: string }[] };
    const [a, b] = [codexMarket!, claudeMarket!].map((u) => JSON.parse(readFileSync(u, 'utf8')) as M);
    expect(a.name).toBe(b.name);
    expect(a.plugins.map((p) => [p.name, p.description])).toEqual(b.plugins.map((p) => [p.name, p.description]));
    for (const p of a.plugins) expect(p.description.length, p.name).toBeGreaterThan(20);
  });
  it('every name@marketplace in those lines exists in the Codex marketplace file', () => {
    expect(codexMarket).toBeTruthy();
    const m = JSON.parse(readFileSync(codexMarket!, 'utf8')) as { name: string; plugins: { name: string }[] };
    const text = read(files.root) + read('../docs/getting-started.md');
    const named = [...text.matchAll(/codex plugin add ([a-z0-9-]+)@([a-z0-9-]+)`(?:, `([a-z0-9-]+)@[a-z0-9-]+` or `([a-z0-9-]+)@[a-z0-9-]+`)?/g)];
    expect(named.length).toBe(3); // root README, getting-started buyer and seller sections
    for (const n of named) {
      expect(n[2]).toBe(m.name);
      for (const p of n.slice(1).filter((x, i) => i !== 1 && x)) expect(m.plugins.map((x) => x.name)).toContain(p);
    }
  });
});

describe('bond-seller-mcp llms-install.md (install guide for agents)', () => {
  const guide = read('../packages/bond-seller-mcp/llms-install.md');
  const src = ['config.ts', 'tools.ts'].map((f) => read(`../packages/bond-seller-mcp/src/${f}`)).join('\n');
  it('server entry has no settings; every tool and variable it names exists in the code', () => {
    const blocks = [...guide.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
    expect(JSON.parse(blocks[0]).mcpServers['bond-seller']).toEqual({ command: 'npx', args: ['-y', '@agent402-dev/bond-seller-mcp'] });
    const tools = [...new Set(guide.match(/`sell_[a-z]+`/g) ?? [])].map((t) => t.slice(1, -1));
    expect(tools.length).toBeGreaterThan(2);
    for (const t of tools) expect(src).toContain(`'${t}'`);
    for (const v of new Set(guide.match(/\bBOND_SELL[A-Z_]+/g) ?? [])) expect(src).toMatch(new RegExp(`\\b${v}\\b`));
  });
  it('asks the user first, values come from the user, disclaimer, English only', () => {
    expect(guide).toContain('Ask the user before doing this.');
    expect(guide).toContain('Every value below must come from the user');
    expect(guide).toContain('Internal review only, not independently audited.');
    expect(guide).not.toMatch(/\b(safe|risky|rug|scam)\b/i);
    expect(guide).not.toMatch(/[가-힣]/);
  });
});

// Relative links in the public docs point at files and headings that exist. Runs on the exported public tree only
// (the private tree keeps some of these files elsewhere), so pub-verify is where it counts.
const PUB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isPublic = existsSync(join(PUB_ROOT, '.claude-plugin', 'marketplace.json')) && existsSync(join(PUB_ROOT, 'README.md'));
describe.skipIf(!isPublic)('public docs: relative links resolve', () => {
  const slug = (h: string) => h.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
  const anchorsOf = (f: string) => new Set((readFileSync(f, 'utf8').replace(/```[\s\S]*?```/g, '').match(/^#{1,6} .+$/gm) ?? []).map((h) => slug(h.replace(/^#+ /, ''))));
  const sub = (d: string, f: string) => (existsSync(join(PUB_ROOT, d)) ? readdirSync(join(PUB_ROOT, d)).map((n) => join(d, n, f)) : []);
  const docs = ['README.md', 'docs/getting-started.md', ...sub('packages', 'README.md'), ...sub('packages', 'llms-install.md'), ...sub('plugins', 'README.md'), 'plugins/README.md']
    .filter((f) => existsSync(join(PUB_ROOT, f)));
  it('finds the docs to check', () => expect(docs.length).toBeGreaterThan(8));
  it.each(docs)('%s', (f) => {
    const file = join(PUB_ROOT, f);
    const md = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
    const broken: string[] = [];
    for (const m of md.matchAll(/\]\(([^)\s]+)\)/g)) {
      const link = m[1];
      if (/^[a-z]+:/i.test(link)) continue;
      const [path, anchor] = link.split('#');
      const target = path ? resolve(dirname(file), decodeURIComponent(path)) : file;
      if (!target.startsWith(PUB_ROOT) || !existsSync(target)) { broken.push(link); continue; }
      if (anchor && statSync(target).isFile() && target.endsWith('.md') && !anchorsOf(target).has(anchor)) broken.push(link);
    }
    expect(broken).toEqual([]);
  });
});

describe('getting-started links the bond-seller-mcp install guide', () => {
  it('seller section links ../packages/bond-seller-mcp/llms-install.md, which exists', () => {
    const md = read('../docs/getting-started.md');
    const seller = md.slice(md.indexOf('## Seller: get paid by AI agents'));
    expect(seller).toContain('](../packages/bond-seller-mcp/llms-install.md)');
    expect(() => read('../packages/bond-seller-mcp/llms-install.md')).not.toThrow();
  });
});

describe('root README and getting-started link the plugins overview', () => {
  it('both link plugins/README.md (resolved by the public link check)', () => {
    expect(read(files.root)).toContain('[`plugins/README.md`](plugins/README.md)');
    expect(read('../docs/getting-started.md')).toContain('[`plugins/README.md`](../plugins/README.md)');
  });
});

// Bond wording in the public docs follows TERMS-v2: the bond protects the buyer only when delivery is not marked in
// time. No "escrow that holds the payment until accepted", no guarantee or money-back promise. Public tree only.
describe.skipIf(!isPublic)('public docs: Bond wording matches TERMS-v2', () => {
  const sub = (d: string, f: string) => (existsSync(join(PUB_ROOT, d)) ? readdirSync(join(PUB_ROOT, d)).map((n) => join(d, n, f)) : []);
  const blog = existsSync(join(PUB_ROOT, 'docs/blog')) ? readdirSync(join(PUB_ROOT, 'docs/blog')).filter((n) => n.endsWith('.md')).map((n) => join('docs/blog', n)) : [];
  const docs = ['README.md', 'docs/getting-started.md', ...sub('packages', 'README.md'), ...sub('packages', 'llms-install.md'), ...sub('plugins', 'README.md'), 'plugins/README.md', ...blog]
    .filter((f) => existsSync(join(PUB_ROOT, f)));
  it('TERMS-v2 keeps the sentence the wording is checked against', () => {
    expect(readFileSync(join(PUB_ROOT, 'docs/bond/TERMS-v2.md'), 'utf8')).toContain('The bond protects the buyer only when the seller does not mark delivery in time.');
    expect(docs.length).toBeGreaterThan(10);
  });
  it.each(docs)('%s', (f) => {
    const md = readFileSync(join(PUB_ROOT, f), 'utf8').replace(/```[\s\S]*?```/g, '');
    expect(md).not.toMatch(/\b(held|kept|holds|keeps)\b[^.\n]{0,40}\buntil\b[^.\n]{0,30}\baccept/i);
    expect(md).not.toMatch(/\bguarantee[ds]?\b|\bmoney-back\b|\bescrow service\b/i);
  });
});

describe('getting-started links each plugin skill name to its SKILL.md', () => {
  it('buy-bonded-job and sell-bonded-job link the plugin SKILL.md files (resolved by the public link check)', () => {
    const md = read('../docs/getting-started.md');
    expect(md).toContain('[`buy-bonded-job`](../plugins/agent402-pay/skills/buy-bonded-job/SKILL.md)');
    const seller = md.slice(md.indexOf('## Seller: get paid by AI agents'));
    expect(seller).toContain('[`sell-bonded-job`](../plugins/agent402-sell/skills/sell-bonded-job/SKILL.md)');
    for (const f of ['agent402-pay/skills/buy-bonded-job', 'agent402-sell/skills/sell-bonded-job'])
      expect(['../claude-plugins/plugins/', '../plugins/'].some((d) => existsSync(new URL(`${d}${f}/SKILL.md`, import.meta.url)))).toBe(true);
  });
});
