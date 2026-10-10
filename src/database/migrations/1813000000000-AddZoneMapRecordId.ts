import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the authoritative map-identity column for zones. `plant_model_name` alone can't
 * distinguish two uploaded records that share a name (see PLAN §2, §6.1) — `map_record_id` can.
 * Nullable and unbackfilled here on purpose: the next migration backfills what it safely can and
 * leaves the rest for manual review, per the plan's phased rollout.
 */
export class AddZoneMapRecordId1813000000000 implements MigrationInterface {
  name = 'AddZoneMapRecordId1813000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE zones ADD COLUMN IF NOT EXISTS map_record_id uuid NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_zones_map_record_id ON zones (map_record_id)`,
    );
    await queryRunner.query(`
      ALTER TABLE zones
      ADD CONSTRAINT fk_zones_map_record_id
      FOREIGN KEY (map_record_id) REFERENCES map_records(id) ON DELETE SET NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE zones DROP CONSTRAINT IF EXISTS fk_zones_map_record_id`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS idx_zones_map_record_id`);
    await queryRunner.query(
      `ALTER TABLE zones DROP COLUMN IF EXISTS map_record_id`,
    );
  }
}
