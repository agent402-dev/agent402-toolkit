// Job store in one JSON file (survives restarts, so delivery can still be marked). One process per file.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BondJob, BondJobStore } from '@agent402-dev/pay-server/bond';

export function fileBondStore(path: string): BondJobStore {
  let jobs: Record<string, BondJob> | null = null;
  const leases = new Map<string, number>();
  const load = () => {
    if (!jobs) jobs = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { jobs: Record<string, BondJob> }).jobs : {};
    return jobs;
  };
  const save = () => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, jobs: load() }, null, 1), { mode: 0o600 });
    renameSync(tmp, path);
  };
  return {
    async get(d) { return load()[d]; },
    async put(j) { load()[j.deal] = j; save(); },
    async list() { return Object.values(load()); },
    async delete(d) { delete load()[d]; save(); },
    async lock(d, ms) { const now = Date.now(); if ((leases.get(d) ?? 0) > now) return false; leases.set(d, now + ms); return true; },
    async unlock(d) { leases.delete(d); },
  };
}
