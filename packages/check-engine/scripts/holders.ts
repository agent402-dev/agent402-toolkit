// Usage: npm run holders -- <mint address> [--scan]
//   --scan : if getTokenLargestAccounts is blocked, fall back to getProgramAccounts (only for tokens with few holder accounts)
import 'dotenv/config';
import { checkHolders, makeConnection, rpcHolderReader } from '@agent402-dev/check-engine/index';

const mint = process.argv[2];
if (!mint) {
  console.error('usage: npm run holders -- <mint> [--scan]');
  process.exit(1);
}
const reader = rpcHolderReader(makeConnection(), { allowScanFallback: process.argv.includes('--scan') });
console.log(JSON.stringify(await checkHolders(mint, reader), null, 2));
