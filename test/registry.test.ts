// 공식 MCP Registry 메타데이터: server.json 의 name = package.json mcpName, 버전 일치, 설명 100자 이하, 환경변수는 실제 코드가 읽는 것만
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const json = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

describe.each([
  ['check-mcp', '@agent402-dev/check-mcp', 'io.github.agent402-dev/a402-check-mcp'],
  ['pay-mcp', '@agent402-dev/pay-mcp', 'io.github.agent402-dev/a402-pay-mcp'],
])('Registry %s', (dir, npmName, mcpName) => {
  const pkg = json(`../packages/${dir}/package.json`);
  const server = json(`../packages/${dir}/server.json`);
  const src = ['server.ts', 'tools.ts', 'policy.ts'].map((f) => { try { return readFileSync(new URL(`../packages/${dir}/src/${f}`, import.meta.url), 'utf8'); } catch { return ''; } }).join('\n');
  it('이름·버전·패키지 일치', () => {
    expect(pkg.name).toBe(npmName);
    expect(pkg.publishConfig).toEqual({ access: 'public' });
    expect(pkg.mcpName).toBe(mcpName);
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0]).toMatchObject({ registryType: 'npm', identifier: npmName, version: pkg.version, transport: { type: 'stdio' } });
    expect(server.repository).toMatchObject({ url: 'https://github.com/agent402-dev/agent402-toolkit', source: 'github', subfolder: `packages/${dir}` });
  });
  it('설명 100자 이하, 평가·권유 표현 없음', () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
    const all = JSON.stringify(server);
    expect(all).not.toMatch(/\b(safe|risk|risky|scam|rug|score|grade|recommend(ed)?|best|guarantee[ds]?)\b/i);
  });
  it('환경변수는 코드가 실제로 읽는 이름만, RPC 주소는 비밀값', () => {
    for (const v of server.packages[0].environmentVariables) {
      expect(src).toContain(v.name);
      if (/RPC_URL/.test(v.name)) expect(v.isSecret).toBe(true);
    }
  });
});
