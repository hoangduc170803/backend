import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

const localEnvFile = resolve(__dirname, '../../.env');

function loadLocalEnv(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) {
    return {};
  }

  const env: Record<string, string> = {};
  const contents = readFileSync(filePath, 'utf8');

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');

    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .replace(/^'(.*)'$/, '$1');

    env[key] = value;
  }

  return env;
}

const localEnv = loadLocalEnv(localEnvFile);

function getDbConfig(
  config: ConfigService,
  key: string,
  fallback?: string,
): string | undefined {
  if (localEnv[key] !== undefined) {
    return localEnv[key];
  }

  return fallback === undefined
    ? config.get<string>(key)
    : config.get<string>(key, fallback);
}

/**
 * Database connection. Schema is hand-managed in `database/schema.sql`, so
 * `synchronize` is OFF — TypeORM only reads/writes the existing tables.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: getDbConfig(config, 'DATABASE_URL'),
        host: getDbConfig(config, 'PGHOST', 'localhost'),
        port: parseInt(getDbConfig(config, 'PGPORT', '5432') ?? '5432', 10),
        username: getDbConfig(config, 'PGUSER', 'postgres'),
        password: getDbConfig(config, 'PGPASSWORD', 'postgres'),
        database: getDbConfig(config, 'PGDATABASE', 'wes'),
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
  ],
})
export class DatabaseModule {}
