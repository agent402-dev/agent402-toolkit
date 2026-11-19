import { PublicKey } from '@solana/web3.js';
import { DISCLAIMER_KO } from './summary.js';

/** 응답에 들어가면 안 되는 판단·등급 표현 — 이 엔진은 사실과 근거만 돌려준다는 원칙을 검사하기 위한 목록 */
export const FORBIDDEN_TERMS = [
  '안전', '위험', '러그', '스캠', '점수', '등급', '투자하',
  'safe', 'risk', 'rug', 'scam', 'score', 'grade', 'honeypot',
];

/** 온체인에서 그대로 가져온 값 (토큰 발행자가 정한 문자열) — 우리 판단이 아니므로 검사하지 않음 */
const ONCHAIN_TEXT_KEYS = new Set(['name', 'symbol', 'uri']);

function isPubkey(s: string): boolean {
  if (s.length < 32 || s.length > 44) return false;
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

/** 주소·트랜잭션 서명 같은 base58 식별자 (공백 없는 32~90자) — 우리가 쓴 문구가 아님 */
function isBase58Id(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,90}$/.test(s);
}

/** 엔진이 직접 쓴 문자열(키 이름 포함)만 모읍니다. 주소와 온체인 문자열은 제외. */
function authoredStrings(v: unknown, key: string | null, out: string[]): void {
  if (typeof v === 'string') {
    if (key && ONCHAIN_TEXT_KEYS.has(key)) return;
    if (isPubkey(v) || isBase58Id(v)) return;
    out.push(v);
  } else if (Array.isArray(v)) {
    for (const x of v) authoredStrings(x, key, out);
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      authoredStrings(x, k, out);
    }
  }
}

/** 응답이 가드레일을 지키는지 검사. 위반 목록을 돌려줍니다 (빈 배열 = 통과). */
export function guardrailViolations(report: unknown): string[] {
  const strings: string[] = [];
  authoredStrings(report, null, strings);
  const text = strings.join('\n').toLowerCase();
  const v: string[] = [];
  for (const t of FORBIDDEN_TERMS) if (text.includes(t.toLowerCase())) v.push(`forbidden term: ${t}`);
  if (!JSON.stringify(report).includes(DISCLAIMER_KO)) v.push('missing disclaimer');
  return v;
}
