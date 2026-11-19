// 사용법: npm run holders -- <민트 주소> [--scan]
//   --scan : getTokenLargestAccounts 가 막히면 getProgramAccounts 로 대체 (보유 계정이 적은 토큰만)
import 'dotenv/config';
import { checkHolders, makeConnection, rpcHolderReader } from '../src/engine/index.js';

const mint = process.argv[2];
if (!mint) {
  console.error('usage: npm run holders -- <mint> [--scan]');
  process.exit(1);
}
const reader = rpcHolderReader(makeConnection(), { allowScanFallback: process.argv.includes('--scan') });
console.log(JSON.stringify(await checkHolders(mint, reader), null, 2));
