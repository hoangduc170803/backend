import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The Operating client's Zone/Store create/edit form has always collected `operation` and
 * `maxVehicles`, but WES never stored either — both were silently dropped on write and the read
 * path derived `operation` from a system-wide kernel constant (`loadOperation`/`unloadOperation`)
 * and hardcoded `maxVehicles` to `null`. This adds real per-zone columns for both; nullable, so
 * an unset zone still falls back to the prior system-wide `operation` default.
 */
export class AddZoneOperationAndMaxVehicles1817000000000
  implements MigrationInterface
{
  name = 'AddZoneOperationAndMaxVehicles1817000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE zones
      ADD COLUMN IF NOT EXISTS operation VARCHAR(120),
      ADD COLUMN IF NOT EXISTS max_vehicles INTEGER
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE zones
      DROP COLUMN IF EXISTS operation,
      DROP COLUMN IF EXISTS max_vehicles
    `);
  }
}
