import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Denormalizes the owning map record onto cargo, stamped once at creation time (see
 * `CargoService.create`). Previously a cargo's map was only derivable by joining through
 * `destinationZoneId` → `zones.map_record_id`, which breaks once that zone is deleted (allowed
 * once no cargo is actively in flight through it) — this column survives that. Nullable and
 * unbackfilled here on purpose; the next migration backfills what it safely can.
 */
export class AddCargoMapRecordId1821000000000 implements MigrationInterface {
  name = 'AddCargoMapRecordId1821000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE cargos ADD COLUMN IF NOT EXISTS map_record_id uuid NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_cargos_map_record_id ON cargos (map_record_id)`,
    );
    await queryRunner.query(`
      ALTER TABLE cargos
      ADD CONSTRAINT fk_cargos_map_record_id
      FOREIGN KEY (map_record_id) REFERENCES map_records(id) ON DELETE SET NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE cargos DROP CONSTRAINT IF EXISTS fk_cargos_map_record_id`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS idx_cargos_map_record_id`);
    await queryRunner.query(
      `ALTER TABLE cargos DROP COLUMN IF EXISTS map_record_id`,
    );
  }
}
