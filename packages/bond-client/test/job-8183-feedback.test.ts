import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { jobFeedback } from '../src/job-8183.js';

const base = { program: 'Dpvdw53zwFbNhNp4KiTBXS1SNge467M8frtHn2Gr36Ev', deal: '11111111111111111111111111111111', amount: 50_000n, decimals: 6, asset: 'USDC' };

describe('job feedback (8004-style, data only)', () => {
  it('Completed: score 100, value is the job amount, file hash is the SHA-256 of the file', async () => {
    const f = await jobFeedback({ ...base, status: 'Completed', settleTx: 'sig1', endpoint: 'https://api.example/x402/job' });
    expect(f.params).toMatchObject({ value: '0.05', score: 100, tag1: 'agent402-job', tag2: 'completed', endpoint: 'https://api.example/x402/job' });
    expect(Buffer.from(f.params.feedbackFileHash).toString('hex')).toBe(createHash('sha256').update(f.fileJson).digest('hex'));
    expect(f.file).toMatchObject({ type: 'agent402.job-feedback', status: 'Completed', amount: '50000', settleTx: 'sig1' });
    expect(f.file).not.toHaveProperty('reason');
  });
  it('Expired scores 0; Rejected scores 0 only for a machine-checkable reason, otherwise no score', async () => {
    expect((await jobFeedback({ ...base, status: 'Expired' })).params).toMatchObject({ score: 0, tag2: 'expired' });
    const m = await jobFeedback({ ...base, status: 'Rejected', reason: 'schema_mismatch' });
    expect(m.params).toMatchObject({ score: 0, tag2: 'rejected:schema_mismatch' });
    expect(m.file).toMatchObject({ reason: 'schema_mismatch', machineCheckable: true });
    const q = await jobFeedback({ ...base, status: 'Rejected', reason: 'quality_below_brief' });
    expect(q.params).not.toHaveProperty('score');
    expect((await jobFeedback({ ...base, status: 'Rejected' })).params.tag2).toBe('rejected:other');
    for (const r of ['deadline_missed', 'offchain_unfulfilled', 'other']) expect(new TextEncoder().encode(`rejected:${r}`).length).toBeLessThanOrEqual(32);
  });
  it('refuses non-final status and bad inputs', async () => {
    await expect(jobFeedback({ ...base, status: 'Funded' })).rejects.toThrow(/not final/);
    await expect(jobFeedback({ ...base, status: 'Submitted' })).rejects.toThrow(/not final/);
    await expect(jobFeedback({ ...base, status: 'Completed', endpoint: 'http://a' })).rejects.toThrow(/https/);
    await expect(jobFeedback({ ...base, status: 'Completed', feedbackUri: 'https://a/' + 'x'.repeat(260) })).rejects.toThrow(/250/);
    await expect(jobFeedback({ ...base, status: 'Completed', decimals: 19 })).rejects.toThrow(/decimals/);
    expect((await jobFeedback({ ...base, status: 'Completed', amount: 1_000_000n })).params.value).toBe('1');
    expect((await jobFeedback({ ...base, status: 'Completed', amount: 0n })).params.value).toBe('0');
  });
});
