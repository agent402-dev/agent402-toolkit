// 금액 표시: USDC·A402 모두 소수 6자리. A402 금액은 항상 단위와 함께 보여 줌
export const DECIMALS = 6;

/** 최소 단위 정수 → "140,000 A402" */
export function formatUnits(atomic: string | bigint, symbol: string): string {
  const s = atomic.toString().padStart(DECIMALS + 1, '0');
  const int = s.slice(0, -DECIMALS).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = s.slice(-DECIMALS).replace(/0+$/, '');
  return `${int}${frac ? '.' + frac : ''} ${symbol}`;
}

/** "140,000 A402 (140000000000 smallest units)" */
export const withSmallest = (atomic: string | bigint, symbol: string) => `${formatUnits(atomic, symbol)} (${atomic} smallest units)`;
