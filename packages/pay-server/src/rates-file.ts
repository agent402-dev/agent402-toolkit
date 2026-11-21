// Node-only rate store: a single JSON file (keeps only the last 3 days of samples). Do not use on Workers (node:fs)
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DailyRate, PriceSample } from './pricing.js';
import type { RateStore } from './rates.js';

interface FileShape { samples: PriceSample[]; rates: Record<string, DailyRate> }

export function fileRateStore(path: string, keepDays = 3): RateStore {
  const read = (): FileShape => {
    if (!existsSync(path)) return { samples: [], rates: {} };
    return JSON.parse(readFileSync(path, 'utf8')) as FileShape;
  };
  const write = (s: FileShape) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(s));
    renameSync(tmp, path); // so the original is not corrupted if writing is interrupted
  };
  return {
    async addSample(x) {
      const s = read();
      const cutoff = new Date(Date.parse(x.at) - keepDays * 86_400_000).toISOString();
      s.samples = [...s.samples.filter((y) => y.at >= cutoff), x];
      write(s);
    },
    async samples(day) { return read().samples.filter((x) => x.at.slice(0, 10) === day); },
    async getRate(date) { return read().rates[date] ?? null; },
    async putRate(r) {
      const s = read();
      s.rates[r.date] = r;
      for (const d of Object.keys(s.rates).sort().slice(0, -keepDays)) delete s.rates[d];
      write(s);
    },
  };
}
