// Example job for the seller template: CSV text in, JSON rows out.
// To sell it, import these two functions in ../index.ts and call them from checkInput() and doWork().
// Pure functions, no network and no keys, so the work is the same every time for the same input
// (Bond v2 commits to the exact result bytes).

export const CSV_MAX_BYTES = 1_000_000;
export const CSV_MAX_ROWS = 10_000;
export const CSV_MAX_COLUMNS = 200;

/** Parses RFC 4180 CSV: quoted fields, "" inside quotes, commas and line breaks inside quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // drop a byte order mark
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
      i += c === '\r' && s[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c; i++;
  }
  if (quoted) throw new Error('unclosed quote');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Refuses malformed requests before any deal or payment. Returns a reason, or null when the input is acceptable. */
export function checkCsvInput(input: string): string | null {
  if (!input.trim()) return 'send CSV text with a header row';
  if (new TextEncoder().encode(input).length > CSV_MAX_BYTES) return `CSV is larger than ${CSV_MAX_BYTES} bytes`;
  let rows: string[][];
  try { rows = parseCsv(input); } catch (e) { return `CSV could not be read: ${(e as Error).message}`; }
  const header = rows[0] ?? [];
  if (!header.length || header.every((h) => !h.trim())) return 'the first row must name the columns';
  if (header.length > CSV_MAX_COLUMNS) return `more than ${CSV_MAX_COLUMNS} columns`;
  const names = header.map((h) => h.trim());
  if (names.some((n) => !n)) return 'every column needs a name in the first row';
  if (new Set(names).size !== names.length) return 'column names must be different';
  if (rows.length - 1 > CSV_MAX_ROWS) return `more than ${CSV_MAX_ROWS} data rows`;
  return null;
}

export interface CsvJson { columns: string[]; rowCount: number; rows: Record<string, string>[]; ragged: number[] }

/** The work: rows as objects keyed by column name. Values stay text. Rows with a different field count are listed in `ragged` (1-based data row numbers). */
export function csvToJson(input: string): CsvJson {
  const [header, ...data] = parseCsv(input);
  const columns = header.map((h) => h.trim());
  const ragged: number[] = [];
  const rows = data.map((r, n) => {
    if (r.length !== columns.length) ragged.push(n + 1);
    return Object.fromEntries(columns.map((c, k) => [c, r[k] ?? '']));
  });
  return { columns, rowCount: rows.length, rows, ragged };
}
