import { BadRequestException } from '@nestjs/common';
import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

export function applyRegistryColumnFilters<T extends ObjectLiteral>(
  builder: SelectQueryBuilder<T>,
  raw: string | undefined,
  columns: Record<string, string>,
  dateKeys: readonly string[],
): void {
  if (!raw) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequestException('Invalid column filters.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BadRequestException('Invalid column filters.');
  }
  for (const [key, value] of Object.entries(parsed)) {
    const expression = columns[key];
    if (!expression || typeof value !== 'string' || value.length > 255) {
      throw new BadRequestException('Invalid column filter.');
    }
    if (!value.trim()) continue;
    if (dateKeys.includes(key)) {
      const instant = new Date(value);
      if (Number.isNaN(instant.getTime()))
        throw new BadRequestException('Invalid date filter.');
      builder.andWhere(
        `${expression} >= :${key}From AND ${expression} < :${key}To`,
        {
          [`${key}From`]: instant.toISOString(),
          [`${key}To`]: new Date(instant.getTime() + 60_000).toISOString(),
        },
      );
    } else {
      builder.andWhere(`${expression} ILIKE :column_${key}`, {
        [`column_${key}`]: `%${value.trim()}%`,
      });
    }
  }
}
