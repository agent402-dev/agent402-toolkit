// One spending operation at a time per process: limit check → human confirmation → sign → send → record.
// Without this, two tool calls in parallel could both pass the daily cap before either is recorded.
let tail: Promise<unknown> = Promise.resolve();

export function withSpendLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  return run;
}
