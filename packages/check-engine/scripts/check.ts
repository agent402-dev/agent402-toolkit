// 사용법: npm run check -- <민트 주소>
import 'dotenv/config';
import { checkSummary, makeConnection, rpcFetcher } from '@agent402-dev/check-engine/index';

const mint = process.argv[2];
if (!mint) {
  console.error('usage: npm run check -- <mint>');
  process.exit(1);
}
const report = await checkSummary(mint, rpcFetcher(makeConnection()));
console.log(JSON.stringify(report, null, 2));
