import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Point/location names are unique only inside a map and may be reused by other maps. */
export class ScopeCargoReservationToMap1825000000000
  implements MigrationInterface
{
  name = 'ScopeCargoReservationToMap1825000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS ux_cargos_reserved_location_name
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX ux_cargos_reserved_location_name
      ON cargos (map_record_id, reserved_location_name)
      WHERE map_record_id IS NOT NULL
        AND reserved_location_name IS NOT NULL
        AND deleted_at IS NULL
        AND status = 'ACTIVE'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS ux_cargos_reserved_location_name
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX ux_cargos_reserved_location_name
      ON cargos (reserved_location_name)
      WHERE reserved_location_name IS NOT NULL
        AND deleted_at IS NULL
        AND status = 'ACTIVE'
    `);
  }
}
