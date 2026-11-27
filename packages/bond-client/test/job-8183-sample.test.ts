import { describe, expect, it } from 'vitest';
import { countReasonsWithEvidence, sampleCheck, SAMPLE_EVIDENCE } from '../src/job-8183.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const src = (immutable: boolean) => ({ url: 'https://data.example/block/1', fetchedAt: '2026-11-28T00:00:00Z', sha256: A, immutable });

describe('sample check (client layer, moves nothing)', () => {
  it('same hash matches; a different hash is data_incorrect + sample_mismatch, machine-checkable only for an immutable source', () => {
    expect(sampleCheck(src(true), A.toUpperCase())).toEqual({ match: true });
    expect(sampleCheck(src(true), B)).toMatchObject({ match: false, code: 'data_incorrect', evidence: SAMPLE_EVIDENCE, machineCheckable: true });
    expect(sampleCheck(src(false), B)).toMatchObject({ match: false, code: 'data_incorrect', machineCheckable: false });
    expect(() => sampleCheck(src(true), 'nothex')).toThrow(/64 hex/);
    expect(() => sampleCheck({ ...src(true), sha256: 'x' }, A)).toThrow(/64 hex/);
  });
  it('counts sample-proven data_incorrect rejects separately from the base reason counts', () => {
    const c = countReasonsWithEvidence([
      { code: 'data_incorrect', evidence: SAMPLE_EVIDENCE, immutable: true },
      { code: 'data_incorrect', evidence: SAMPLE_EVIDENCE, immutable: false },
      { code: 'deadline_missed' },
      { code: undefined },
    ]);
    expect(c).toMatchObject({ total: 4, machine: 1, notMachine: 3, sampleProven: 1, machineWithSamples: 2 });
    expect(c.by.data_incorrect).toBe(2);
    expect(c.by.other).toBe(1);
  });
});
