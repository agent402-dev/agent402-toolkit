// Official MCP Registry metadata: server.json name = package.json mcpName, versions match, description up to 100 chars, env vars only those the code actually reads
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const json = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

describe.each([
  ['check-mcp', '@agent402-dev/check-mcp', 'io.github.agent402-dev/a402-check-mcp'],
  ['pay-mcp', '@agent402-dev/pay-mcp', 'io.github.agent402-dev/a402-pay-mcp'],
  ['bond-seller-mcp', '@agent402-dev/bond-seller-mcp', 'io.github.agent402-dev/bond-seller-mcp'],
])('Registry %s', (dir, npmName, mcpName) => {
  const pkg = json(`../packages/${dir}/package.json`);
  const server = json(`../packages/${dir}/server.json`);
  const src = ['server.ts', 'tools.ts', 'policy.ts', 'bond-sign.ts', 'config.ts'].map((f) => { try { return readFileSync(new URL(`../packages/${dir}/src/${f}`, import.meta.url), 'utf8'); } catch { return ''; } }).join('\n');
  it('name, version and package match', () => {
    expect(pkg.name).toBe(npmName);
    expect(pkg.publishConfig).toEqual({ access: 'public' });
    expect(pkg.mcpName).toBe(mcpName);
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0]).toMatchObject({ registryType: 'npm', identifier: npmName, version: pkg.version, transport: { type: 'stdio' } });
    expect(server.repository).toMatchObject({ url: 'https://github.com/agent402-dev/agent402-toolkit', source: 'github', subfolder: `packages/${dir}` });
  });
  it('description up to 100 chars, no rating or recommendation wording', () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
    const all = JSON.stringify(server);
    expect(all).not.toMatch(/\b(safe|risk|risky|scam|rug|score|grade|recommend(ed)?|best|guarantee[ds]?)\b/i);
  });
  it('env vars are only names the code actually reads; the RPC address is a secret', () => {
    for (const v of server.packages[0].environmentVariables) {
      expect(src).toContain(v.name);
      if (/RPC_URL/.test(v.name)) expect(v.isSecret).toBe(true);
    }
  });
});
