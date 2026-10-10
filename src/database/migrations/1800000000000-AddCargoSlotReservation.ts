import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCargoSlotReservation1800000000000 implements MigrationInterface {
  name = 'AddCargoSlotReservation1800000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE cargos
      ADD COLUMN IF NOT EXISTS reserved_location_name VARCHAR(255)
    `);
    await queryRunner.query(`
      ALTER TABLE cargos
      ADD COLUMN IF NOT EXISTS slot_decision_seq INTEGER NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_cargos_reserved_location_name
      ON cargos (reserved_location_name)
      WHERE reserved_location_name IS NOT NULL
        AND deleted_at IS NULL
        AND status = 'ACTIVE'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_cargos_destination_location_name
      ON cargos (destination_location_name)
      WHERE destination_location_name IS NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_cargos_destination_location_name
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS ux_cargos_reserved_location_name
    `);
    await queryRunner.query(`
      ALTER TABLE cargos
      DROP COLUMN IF EXISTS slot_decision_seq
    `);
    await queryRunner.query(`
      ALTER TABLE cargos
      DROP COLUMN IF EXISTS reserved_location_name
    `);
  }
}
