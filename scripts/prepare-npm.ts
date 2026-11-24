// Build the npm packages into out/npm/<package> with tsc. Does not publish (the release workflow or a human does).
// Usage: npx tsx scripts/prepare-npm.ts   then, in each folder: npm pack --dry-run
// Six packages: @agent402-dev/check-engine, check-mcp (depends on the engine), pay-server, pay-mcp, bond-client, bond-seller-mcp (depends on pay-server). Each README is packages/<p>/README.md as is (same file on GitHub and npm).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve('out/npm');
// Each package's version comes from packages/<dir>/package.json
const versionOf = (dir: string) => (JSON.parse(readFileSync(`packages/${dir}/package.json`, 'utf8')) as { version: string }).version;
const REPO_URL = 'git+https://github.com/agent402-dev/agent402-toolkit.git';
const common = (dir: string) => ({
  version: versionOf(dir),
  author: 'Agent402',
  license: 'Apache-2.0',
  type: 'module',
  engines: { node: '>=20' },
  repository: { type: 'git', url: REPO_URL, directory: `packages/${dir}` },
  homepage: `https://github.com/agent402-dev/agent402-toolkit/tree/main/packages/${dir}#readme`,
  bugs: { url: 'https://github.com/agent402-dev/agent402-toolkit/issues' },
  publishConfig: { access: 'public' }, // scoped packages are private by default
});
const tsconfig = {
  compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, esModuleInterop: true, skipLibCheck: true,
    declaration: true, outDir: 'dist', rootDir: 'src', types: ['node'], sourceMap: false,
  },
  include: ['src'],
};
/** Expose all of dist as subpaths (e.g. @agent402-dev/check-engine/full → dist/full.js) */
const allExports = {
  '.': { types: './dist/index.d.ts', default: './dist/index.js' },
  './*': { types: './dist/*.d.ts', default: './dist/*.js' },
};
const devDeps = (p: string) => (JSON.parse(readFileSync(`packages/${p}/package.json`, 'utf8')) as { dependencies: Record<string, string> }).dependencies;

function make(dir: string, pkg: Record<string, unknown>, localDeps: string[] = []) {
  const out = join(root, dir);
  if (existsSync(out)) rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(`packages/${dir}/src`, join(out, 'src'), { recursive: true });
  cpSync(`packages/${dir}/README.md`, join(out, 'README.md'));
  cpSync(existsSync('docs/legal/LICENSE-Apache-2.0.txt') ? 'docs/legal/LICENSE-Apache-2.0.txt' : 'LICENSE', join(out, 'LICENSE'));
  cpSync(existsSync('docs/legal/NOTICE') ? 'docs/legal/NOTICE' : 'NOTICE', join(out, 'NOTICE'));
  writeFileSync(join(out, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2) + '\n');
  writeFileSync(join(out, 'package.json'), JSON.stringify({ ...pkg, ...common(dir), files: ['dist', 'README.md', 'LICENSE', 'NOTICE'] }, null, 2) + '\n');
  // Toolkit packages this one depends on: copy their fresh dist into node_modules to compile (not packed)
  for (const d of localDeps) {
    const nm = join(out, 'node_modules', '@agent402-dev', d);
    mkdirSync(nm, { recursive: true });
    cpSync(join(root, d, 'package.json'), join(nm, 'package.json'));
    cpSync(join(root, d, 'dist'), join(nm, 'dist'), { recursive: true });
  }
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', join(out, 'tsconfig.json')], { stdio: 'inherit' });
  console.log(`built: ${out}`);
}
const deps = (p: string, map: Record<string, string> = {}) =>
  Object.fromEntries(Object.entries(devDeps(p)).map(([k, v]) => [k, map[k] ?? v]));

make('check-engine', {
  name: '@agent402-dev/check-engine',
  description: 'Factual on-chain checks for Solana token mints: authorities, Token-2022 extensions, holder concentration, liquidity locks, operator locks, early buys. Facts and evidence addresses only.',
  keywords: ['solana', 'token', 'spl-token', 'token-2022', 'onchain'],
  main: './dist/index.js',
  types: './dist/index.d.ts',
  exports: allExports,
  dependencies: deps('check-engine'),
});

make('check-mcp', {
  name: '@agent402-dev/check-mcp',
  description: 'MCP server (stdio) returning factual on-chain information about Solana token mints, with evidence addresses. Free. No judgments or investment advice.',
  keywords: ['mcp', 'solana', 'token', 'token-2022', 'onchain'],
  mcpName: 'io.github.agent402-dev/a402-check-mcp', // checked by the MCP Registry (must equal the name in server.json)
  bin: { 'agent402-check-mcp': './dist/server.js' },
  exports: { './*': { types: './dist/*.d.ts', default: './dist/*.js' } },
  dependencies: deps('check-mcp', { '@agent402-dev/check-engine': `^${versionOf('check-engine')}` }),
}, ['check-engine']);

// Bond client: web3.js and spl-token are peers, so the user's instances are used
const bondPeers = (JSON.parse(readFileSync('packages/bond-client/package.json', 'utf8')) as { peerDependencies: Record<string, string> }).peerDependencies;
make('bond-client', {
  name: '@agent402-dev/bond-client',
  description: 'Instruction builders for the Agent402 Bond Solana program (beta): seller bond and buyer deposit for one deal, outcomes by signatures and the Solana clock. Holds no keys and sends nothing.',
  keywords: ['solana', 'escrow', 'bond', 'usdc', 'agent'],
  main: './dist/index.js',
  types: './dist/index.d.ts',
  exports: {
    '.': { types: './dist/index.d.ts', default: './dist/index.js' },
    './rules': { types: './dist/rules.d.ts', default: './dist/rules.js' },
    './job': { types: './dist/job.d.ts', default: './dist/job.js' },
    './v2': { types: './dist/v2.d.ts', default: './dist/v2.js' },
    './job-v2': { types: './dist/job-v2.d.ts', default: './dist/job-v2.js' },
  },
  peerDependencies: bondPeers,
  // users of ./rules and ./job-v2 only (pay-mcp) do not need web3.js
  peerDependenciesMeta: { '@solana/web3.js': { optional: true } },
});

make('pay-server', {
  name: '@agent402-dev/pay-server',
  description: 'Server helpers for x402 on Solana: accept USDC and optionally PREQ (Token-2022) through external facilitators. Verify, run your handler, then settle. Holds no funds and takes no private keys.',
  keywords: ['x402', 'solana', 'usdc', 'token-2022', 'payments'],
  bin: { 'agent402-pay-server': './dist/cli.js' },
  main: './dist/index.js',
  types: './dist/index.d.ts',
  exports: allExports,
  // ./bond (seller helpers) uses bond-client
  dependencies: deps('pay-server', { '@agent402-dev/bond-client': `^${versionOf('bond-client')}` }),
}, ['bond-client']);

make('pay-mcp', {
  name: '@agent402-dev/pay-mcp',
  description: "MCP server that lets an AI agent pay x402 APIs (USDC, PREQ) from the user's own wallet on the user's machine, within limits and allowlists. With no configuration, every payment is refused.",
  keywords: ['mcp', 'x402', 'solana', 'usdc', 'agent', 'payments'],
  mcpName: 'io.github.agent402-dev/a402-pay-mcp',
  bin: { 'agent402-pay-mcp': './dist/server.js' },
  exports: { './*': { types: './dist/*.d.ts', default: './dist/*.js' } },
  // bond_deal_status uses only bond-client's rules; web3.js is not loaded
  dependencies: deps('pay-mcp', { '@agent402-dev/bond-client': `^${versionOf('bond-client')}` }),
}, ['bond-client']);

make('bond-seller-mcp', {
  name: '@agent402-dev/bond-seller-mcp',
  description: 'MCP server that lets an AI agent sell jobs backed by Agent402 Bond deals on Solana (USDC or PREQ), from your own seller wallet on your machine.',
  keywords: ['mcp', 'solana', 'escrow', 'bond', 'usdc', 'agent'],
  mcpName: 'io.github.agent402-dev/bond-seller-mcp',
  bin: { 'agent402-bond-seller-mcp': './dist/server.js' },
  exports: { './*': { types: './dist/*.d.ts', default: './dist/*.js' } },
  dependencies: deps('bond-seller-mcp', {
    '@agent402-dev/bond-client': `^${versionOf('bond-client')}`,
    '@agent402-dev/pay-server': `^${versionOf('pay-server')}`,
  }),
}, ['bond-client', 'pay-server']);
