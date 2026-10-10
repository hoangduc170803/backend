import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';

const SINGLE_INSTANCE_LOCK_KEY = 815_004_700;

function readEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const env: Record<string, string> = {};
  for (const rawLine of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf('=');
    if (sep <= 0) continue;
    env[line.slice(0, sep).trim()] = line
      .slice(sep + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .replace(/^'(.*)'$/, '$1');
  }
  return env;
}

function lockConnection(): DataSource {
  const env = readEnvFile(resolve(__dirname, '../.env'));
  const get = (key: string, fallback?: string) =>
    process.env[key] ?? env[key] ?? fallback;
  return new DataSource({
    type: 'postgres',
    url: get('DATABASE_URL'),
    host: get('PGHOST', 'localhost'),
    port: Number(get('PGPORT', '5432')),
    username: get('PGUSER'),
    password: get('PGPASSWORD'),
    database: get('PGDATABASE'),
    extra: { max: 1, idleTimeoutMillis: 0 },
  });
}

export async function holdSingleInstanceLock(): Promise<DataSource | null> {
  const connection = lockConnection();
  try {
    await connection.initialize();
  } catch (err) {
    console.warn(
      `[single-instance] database unreachable, starting without the instance lock: ${(err as Error).message}`,
    );
    return null;
  }

  const session = connection.createQueryRunner();
  await session.connect();
  const [row] = (await session.query(
    'SELECT pg_try_advisory_lock($1) AS locked',
    [SINGLE_INSTANCE_LOCK_KEY],
  )) as { locked: boolean }[];
  if (row?.locked) return connection;

  await connection.destroy().catch(() => undefined);
  console.error(
    '[single-instance] Another WES backend is already running against this database ' +
      '(often an orphaned `node dist/main` left behind by a previous `pnpm start`). ' +
      'Stop it first — two instances dispatch the same tasks twice and leave orphan transport orders. ' +
      'Find it with: Get-CimInstance Win32_Process | ? CommandLine -match "wes.dist.main"',
  );
  process.exit(1);
}
