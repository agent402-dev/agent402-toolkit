// Mainnet values of the payment token PREQ (Prequ), kept in this one file only.
// Set after the PREQ launch on 2026-11-21 (official addresses: https://claude.ai/artifact/S6UafAfViJk3DJeMsDMAja).
import { TOKEN_2022 } from './chain.js';

/** PREQ mint (Token-2022, 6 decimals) */
export const PREQ_MAINNET_MINT = 'aTbGw3gU5JyJkAdXLj8rYZ3mCXkPbyHjtTAyCX3jQLX';
/** Meteora DAMM v2 pool used for pricing (PREQ / WSOL) */
export const PREQ_MAINNET_POOL = '51F34MKDFBLr5GwKiiJMWV9HsHv63dkkP3ZMMxPN71xc';

export const PREQ_DECIMALS = 6;
export const PREQ_TOKEN_PROGRAM = TOKEN_2022;

/** Warning printed when A402 (v1) is enabled explicitly */
export const A402_DEPRECATION_WARNING = 'A402 (v1) is deprecated and no longer supported; use PREQ.';

/** Error explaining what to fill in when a value is empty */
export function requirePreqValue(name: 'PREQ_MAINNET_MINT' | 'PREQ_MAINNET_POOL', value: string): string {
  if (!value) {
    throw new Error(`${name} is not set: PREQ payments cannot be enabled yet. Fill ${name} in @agent402-dev/pay-server src/preq.ts after the PREQ launch (or pass your own asset/pool).`);
  }
  return value;
}
