import { DataSource, QueryRunner } from 'typeorm';

const LOCK_POLL_MS = 250;

export class AdvisoryLockBusyError extends Error {
  constructor(key: number) {
    super(`Another WES process holds advisory lock ${key}`);
  }
}

export async function runWithAdvisoryLock(
  dataSource: DataSource,
  key: number,
  waitMs: number,
  work: () => Promise<void>,
): Promise<boolean> {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    if (!(await acquire(runner, key, waitMs))) {
      if (waitMs > 0) throw new AdvisoryLockBusyError(key);
      return false;
    }
    try {
      await work();
      return true;
    } finally {
      await runner
        .query('SELECT pg_advisory_unlock($1)', [key])
        .catch(() => undefined);
    }
  } finally {
    await runner.release().catch(() => undefined);
  }
}

async function acquire(
  runner: QueryRunner,
  key: number,
  waitMs: number,
): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const [{ locked }] = (await runner.query(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [key],
    )) as { locked: boolean }[];
    if (locked) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}
