// Amount display: USDC and PREQ (and the deprecated A402) all have 6 decimals. Token amounts are always shown with units
export const DECIMALS = 6;

/** Base-unit integer → "140,000 PREQ" */
export function formatUnits(atomic: string | bigint, symbol: string): string {
  const s = atomic.toString().padStart(DECIMALS + 1, '0');
  const int = s.slice(0, -DECIMALS).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = s.slice(-DECIMALS).replace(/0+$/, '');
  return `${int}${frac ? '.' + frac : ''} ${symbol}`;
}

/** "140,000 PREQ (140000000000 smallest units)" */
export const withSmallest = (atomic: string | bigint, symbol: string) => `${formatUnits(atomic, symbol)} (${atomic} smallest units)`;
