import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadEnv(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const env: Record<string, string> = {};
  for (const rawLine of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf('=');
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim();
    const val = line
      .slice(sep + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .replace(/^'(.*)'$/, '$1');
    env[key] = val;
  }
  return env;
}

const env = loadEnv(resolve(__dirname, '../../.env'));
const get = (k: string, fallback = '') => env[k] ?? process.env[k] ?? fallback;
const compiledExtension = __filename.endsWith('.ts') ? 'ts' : 'js';

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: get('DATABASE_URL'),
  host: get('PGHOST', 'localhost'),
  port: parseInt(get('PGPORT', '5432'), 10),
  username: get('PGUSER', 'postgres'),
  password: get('PGPASSWORD', 'postgres'),
  database: get('PGDATABASE', 'wes'),
  entities: [resolve(__dirname, `../**/*.entity.${compiledExtension}`)],
  migrations: [resolve(__dirname, `./migrations/*.${compiledExtension}`)],
  synchronize: false,
});
