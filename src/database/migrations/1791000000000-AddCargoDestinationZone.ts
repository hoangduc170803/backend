import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drop-off slot is no longer chosen when the request is created. Instead a cargo
 * reserves a *seat* in its destination zone (`destination_zone_id`) and the
 * concrete slot (`destination_location_name`, already nullable) is committed at
 * the approach barrier — see DropoffCommitLoop. The index supports
 * the per-zone capacity/occupancy counts.
 */
export class AddCargoDestinationZone1791000000000 implements MigrationInterface {
  name = 'AddCargoDestinationZone1791000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "cargos" ADD COLUMN IF NOT EXISTS "destination_zone_id" uuid`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_cargos_destination_zone_id" ON "cargos" ("destination_zone_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_cargos_destination_zone_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cargos" DROP COLUMN IF EXISTS "destination_zone_id"`,
    );
  }
}
