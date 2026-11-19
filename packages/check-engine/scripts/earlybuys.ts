// 사용법: npm run earlybuys -- <민트 주소> [분=5] [--pool <풀 주소>]
import 'dotenv/config';
import { checkEarlyBuys, makeConnection, rpcChainReader, rpcHistoryReader } from '@agent402-dev/check-engine/index';

const [mint, minutes] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const poolIdx = process.argv.indexOf('--pool');
if (!mint) {
  console.error('usage: npm run earlybuys -- <mint> [minutes] [--pool <pool>]');
  process.exit(1);
}
const conn = makeConnection();
const reader = { ...rpcChainReader(conn), ...rpcHistoryReader(conn) };
const r = await checkEarlyBuys(mint, reader, {
  windowMinutes: minutes ? Number(minutes) : undefined,
  pool: poolIdx > 0 ? process.argv[poolIdx + 1] : undefined,
});
console.log(JSON.stringify(r, null, 2));
