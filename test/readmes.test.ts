// 공개 README 5개 (루트 + 패키지 4개) 공통 규칙: 고지 문구, "하지 않는 것" 4가지, 비슷한 이름과 무관, 평가·권유 표현 없음, A402 금액 단위
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const files = {
  root: '../README.md',
  'check-engine': '../packages/check-engine/README.md',
  'check-mcp': '../packages/check-mcp/README.md',
  'pay-server': '../packages/pay-server/README.md',
  'pay-mcp': '../packages/pay-mcp/README.md',
};
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe.each(Object.entries(files))('README %s', (_name, path) => {
  const md = read(path);
  it('고지 문구 (영·한)', () => {
    expect(md).toContain('Not investment advice.');
    expect(md).toContain('공개 온체인 데이터에 따른 사실 정보이며 투자 권유가 아닙니다.');
  });
  it('하지 않는 것 4가지 + 판단 안 함', () => {
    expect(md).toMatch(/does not operate a facilitator/i);
    expect(md).toMatch(/does not hold funds/i);
    expect(md).toMatch(/does not exchange/i);
    expect(md).toMatch(/does not accept or send payments on anyone's behalf/i);
    expect(md).toMatch(/does not judge, score or rate/i);
  });
  it('비슷한 이름과 무관', () => {
    expect(md).toMatch(/Not related to `agent402\.tools`, `@agents402` or other similarly named/);
  });
  it('평가·권유 표현 없음', () => {
    // "does not judge, score or rate" 같은 부정 문장은 빼고 검사
    const body = md.replace(/does not judge, score or rate[^.\n]*/gi, '');
    expect(body).not.toMatch(/\b(safe|safest|safety|risky|risk|scam|rug|rugpull|best|recommend(ed)?|guarantee[ds]?|trustworthy|reliable|score|grade|rating|bullish|bearish)\b/i);
    expect(body).not.toMatch(/안전|위험|러그|스캠|점수|등급|추천/);
  });
  it('A402 금액은 단위와 함께 (숫자 + A402, 또는 최소 단위 설명)', () => {
    // A402 앞뒤에 단위 없는 맨 숫자가 붙지 않음: "140000000000 A402" 같은 최소 단위 숫자 + A402 금지
    expect(md).not.toMatch(/\b\d{7,}\s*A402\b/);
    // A402 한도·금액 변수를 다루는 README 는 최소 단위 환산을 적음
    if (/A402_ATOMIC|`amount`/.test(md)) expect(md).toMatch(/1 A402 = 1,000,000/);
    for (const line of md.split('\n').filter((l) => /A402[A-Z_]*ATOMIC/.test(l) && l.startsWith('|'))) {
      expect(line).toMatch(/smallest unit/);
    }
  });
  it('개인 정보·오래된 저장소 이름 없음', () => {
    expect(md).not.toMatch(/github\.com\/agent402-dev\/a402-check-engine/);
    expect(md).not.toMatch(/[A-Za-z]:\\Users\\/);
  });
});
