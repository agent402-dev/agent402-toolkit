#!/usr/bin/env node
// @agent402-dev/bond-seller-mcp. With no command it runs the MCP server (stdio). Settings: environment variables (README).
// Commands: init (create a dedicated seller wallet key file), help
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as bond from '@agent402-dev/bond-client';
import { sellerConfigFromEnv } from './config.js';
import { serveHttp } from './http.js';
import { buildSeller, loadKeypair, type BuiltSeller } from './seller.js';
import { createSellerServer, serialRunner } from './tools.js';

const log = (s: string) => console.error(`[bond-seller] ${s}`); // stdout is for MCP
const HELP = `@agent402-dev/bond-seller-mcp

  npx -y @agent402-dev/bond-seller-mcp               run the MCP server (stdio)
  npx -y @agent402-dev/bond-seller-mcp init [--path <file>]
                                                     create a dedicated seller wallet key file (default ~/.agent402/seller-wallet.json)
`;
const [cmd, ...args] = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

if (cmd === 'init') {
  const path = resolve(opt('--path') ?? join(homedir(), '.agent402', 'seller-wallet.json'));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const bytes = Uint8Array.from([...seed, ...pub]);
  try {
    const address = Keypair.fromSecretKey(bytes).publicKey.toBase58();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(Array.from(bytes)), { flag: 'wx', mode: 0o600 });
    console.log(`Created a seller wallet key file: ${path}\nAddress: ${address}\n\nUse a dedicated wallet with a small balance: some SOL for fees and deal rent (about 0.005 SOL per open deal, returned when it closes) and USDC for the bonds of the deals you allow at once.\nBack up the file. Anyone with it controls the wallet.`);
  } catch (e) {
    console.error((e as NodeJS.ErrnoException).code === 'EEXIST' ? `A file already exists at ${path}. It was not changed.` : (e as Error).message);
    process.exitCode = 1;
  } finally { bytes.fill(0); seed.fill(0); }
} else if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(HELP);
} else if (cmd) {
  console.error(`Unknown command: ${cmd}\n\n${HELP}`);
  process.exitCode = 2;
} else {
  const config = sellerConfigFromEnv(process.env);
  let built: BuiltSeller | null = null;
  if (!config.problems.length) {
    try { built = buildSeller(config, { keypair: loadKeypair(config.keypairPath!) }); }
    catch (e) { config.problems.push(`could not start the seller: ${(e as Error).message}`); }
  }
  for (const p of config.problems) log(p);
  let endpoint: string | undefined;
  const run = built ? serialRunner(built) : null;
  if (built && config.http) {
    await serveHttp(built.service.handle, config.http.port, config.http.host);
    endpoint = config.http.publicOrigin ?? `http://${config.http.host}:${config.http.port}`;
    log(`serving the Bond Job Protocol at ${config.http.host}:${config.http.port}`);
  }
  if (run) {
    const tick = () => run().then((steps) => { for (const s of steps) if (s.status === 'error') log(`${s.deal}: ${s.error}`); }, (e) => log(`loop: ${(e as Error).message}`));
    setInterval(tick, config.intervalSeconds * 1000).unref();
    void tick();
  }
  const rpc = async <T>(method: string, params: unknown[]) => {
    const r = await fetch(config.rpcUrl!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = (await r.json()) as { result?: T; error?: { message: string } };
    if (j.error || j.result === undefined) throw new Error(`rpc ${method}: ${j.error?.message ?? r.status}`);
    return j.result;
  };
  const balances = built ? async () => {
    const owner = built!.seller.seller;
    const sol = (await rpc<{ value: number }>('getBalance', [owner])).value;
    const ata = bond.associatedTokenAddress(new PublicKey(owner), bond.MINTS.mainnet.USDC, bond.TOKEN_PROGRAM_ID).toBase58();
    const t = await rpc<{ value: { amount: string } }>('getTokenAccountBalance', [ata]).catch(() => ({ value: { amount: '0' } }));
    return { sol: `${sol / 1e9} SOL`, usdc: `${Number(t.value.amount) / 1e6} USDC` };
  } : undefined;
  await createSellerServer({ config, built, balances, endpoint }, run).connect(new StdioServerTransport());
}
