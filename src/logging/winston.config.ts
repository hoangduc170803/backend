import { LoggerService } from '@nestjs/common';
import { WinstonModule, utilities } from 'nest-winston';
import { inspect } from 'node:util';
import { format, transports } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

const LEVELS = { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, verbose: 5 };
const MOST_VERBOSE_LEVEL = 'verbose';

function stackText(stack: unknown): string {
  const frames = (Array.isArray(stack) ? stack : [stack]).filter(Boolean);
  return frames.length > 0 ? `\n${frames.join('\n')}` : '';
}

function contextText(context: unknown): string {
  return typeof context === 'string'
    ? context
    : inspect(context, { depth: 3, breakLength: Infinity });
}

const fileLine = format.printf(
  ({ timestamp, level, message, context, stack }) => {
    const scope = context ? ` [${contextText(context)}]` : '';
    return `${String(timestamp)} ${level.toUpperCase().padEnd(7)}${scope} ${String(message)}${stackText(stack)}`;
  },
);

export function createWesLogger(): LoggerService {
  const dirname = process.env.WES_LOG_DIR ?? 'logs';
  const maxSize = process.env.WES_LOG_MAX_SIZE ?? '10m';
  const maxFiles = Number(process.env.WES_LOG_MAX_FILES ?? 10);

  return WinstonModule.createLogger({
    levels: LEVELS,
    level: MOST_VERBOSE_LEVEL,
    transports: [
      new transports.Console({
        format: format.combine(
          format.timestamp(),
          utilities.format.nestLike('WES', { colors: true, prettyPrint: true }),
        ),
      }),
      new DailyRotateFile({
        dirname,
        filename: 'wes-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxSize,
        maxFiles,
        auditFile: `${dirname}/.wes-log-audit.json`,
        format: format.combine(
          format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
          format.uncolorize(),
          fileLine,
        ),
      }),
    ],
  });
}
