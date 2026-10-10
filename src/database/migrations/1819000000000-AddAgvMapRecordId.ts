import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the authoritative map-identity column for AGVs — same split as
 * `1813000000000-AddZoneMapRecordId`: `plant_model_name` alone can't distinguish two uploaded
 * records that share a name, `map_record_id` can. Nullable and unbackfilled here on purpose; the
 * next migration backfills what it safely can and leaves the rest for manual review.
 */
export class AddAgvMapRecordId1819000000000 implements MigrationInterface {
  name = 'AddAgvMapRecordId1819000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE agvs ADD COLUMN IF NOT EXISTS map_record_id uuid NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_agvs_map_record_id ON agvs (map_record_id)`,
    );
    await queryRunner.query(`
      ALTER TABLE agvs
      ADD CONSTRAINT fk_agvs_map_record_id
      FOREIGN KEY (map_record_id) REFERENCES map_records(id) ON DELETE SET NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE agvs DROP CONSTRAINT IF EXISTS fk_agvs_map_record_id`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS idx_agvs_map_record_id`);
    await queryRunner.query(
      `ALTER TABLE agvs DROP COLUMN IF EXISTS map_record_id`,
    );
  }
}
