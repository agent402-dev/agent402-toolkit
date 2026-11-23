// Shared rules for the public READMEs (root + packages): disclaimer, the 4 things it does not do, unrelated to similar names, no rating or recommendation wording, units for token (PREQ, A402) amounts, English only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const files = {
  root: '../README.md',
  'check-engine': '../packages/check-engine/README.md',
  'check-mcp': '../packages/check-mcp/README.md',
  'pay-server': '../packages/pay-server/README.md',
  'pay-mcp': '../packages/pay-mcp/README.md',
  'bond-seller-mcp': '../packages/bond-seller-mcp/README.md',
};
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe.each(Object.entries(files))('README %s', (_name, path) => {
  const md = read(path);
  it('disclaimer, English only', () => {
    expect(md).toContain('Not investment advice.');
    expect(md).not.toMatch(/[\uAC00-\uD7A3]/);
  });
  it('the 4 things it does not do + no judgement', () => {
    expect(md).toMatch(/does not operate a facilitator/i);
    expect(md).toMatch(/does not hold funds/i);
    expect(md).toMatch(/does not exchange/i);
    expect(md).toMatch(/does not accept or send payments on anyone's behalf/i);
    expect(md).toMatch(/does not judge, score or rate/i);
  });
  it('unrelated to similar names', () => {
    expect(md).toMatch(/Not related to `agent402\.tools`, `@agents402` or other similarly named/);
  });
  it('no rating or recommendation wording', () => {
    // Check without negations such as "does not judge, score or rate"
    const body = md.replace(/does not judge, score or rate[^.\n]*/gi, '');
    expect(body).not.toMatch(/\b(safe|safest|safety|risky|risk|scam|rug|rugpull|best|recommend(ed)?|guarantee[ds]?|trustworthy|reliable|score|grade|rating|bullish|bearish)\b/i);
    expect(body).not.toMatch(/\b(to the moon|lambo)\b/i);
  });
  it.each(['PREQ', 'A402'])('%s amounts with units (number + token, or a base unit explanation)', (tok) => {
    // No bare base-unit number before the token: e.g. "140000000000 PREQ" is not allowed
    expect(md).not.toMatch(new RegExp(`\\b\\d{7,}\\s*${tok}\\b`));
    // A README that covers that token's limit variables states the base unit conversion
    if (new RegExp(`${tok}_ATOMIC`).test(md)) expect(md).toMatch(new RegExp(`1 ${tok} = 1,000,000`));
    for (const line of md.split('\n').filter((l) => new RegExp(`${tok}[A-Z_]*ATOMIC`).test(l) && l.startsWith('|'))) {
      expect(line).toMatch(/smallest unit/);
    }
  });
  it('a README that explains `amount` states the base unit conversion of the payment token (PREQ)', () => {
    if (/`amount`/.test(md)) expect(md).toMatch(/1 PREQ = 1,000,000/);
  });
  it('package names are scoped only (no old a402-* npm names)', () => {
    expect(md).not.toMatch(/(^|[^\/.\w-])a402-(check-engine|check-mcp|pay-server|pay-mcp)\b/m);
  });
  it('no personal info or old repository names', () => {
    expect(md).not.toMatch(/github\.com\/agent402-dev\/a402-check-engine/);
    expect(md).not.toMatch(/[A-Za-z]:\\Users\\/);
  });
});
