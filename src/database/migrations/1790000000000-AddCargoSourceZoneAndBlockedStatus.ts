import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Pickup row-dependency (WF-02 / SRS BR-10):
 *  - cargos.source_zone_id links a cargo to the PICKUP zone of its source.
 *  - transport_request_status_enum gains BLOCKED for tasks held behind an
 *    un-picked cargo in the same lane.
 *
 * PostgreSQL 16 allows ALTER TYPE ... ADD VALUE inside a transaction; the new
 * value is not used within this migration, so it is safe here.
 */
export class AddCargoSourceZoneAndBlockedStatus1790000000000 implements MigrationInterface {
  name = 'AddCargoSourceZoneAndBlockedStatus1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "cargos" ADD COLUMN IF NOT EXISTS "source_zone_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TYPE "transport_request_status_enum" ADD VALUE IF NOT EXISTS 'BLOCKED' BEFORE 'PICKING_UP'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "cargos" DROP COLUMN IF EXISTS "source_zone_id"`,
    );

    // Postgres can't drop an enum value, so recreate the type without BLOCKED.
    await queryRunner.query(
      `UPDATE "transport_requests" SET status = 'CANCELLED' WHERE status = 'BLOCKED'`,
    );
    await queryRunner.query(
      `ALTER TABLE "transport_requests" ALTER COLUMN status DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "transport_requests" ALTER COLUMN status TYPE VARCHAR(50)`,
    );
    await queryRunner.query(`DROP TYPE "transport_request_status_enum"`);
    await queryRunner.query(
      `CREATE TYPE "transport_request_status_enum" AS ENUM (
        'CREATED',
        'READY_TO_ASSIGN',
        'PICKING_UP',
        'DELIVERING',
        'DELIVERY_COMPLETED',
        'CANCELLED',
        'FAILED'
      )`,
    );
    await queryRunner.query(
      `ALTER TABLE "transport_requests" ALTER COLUMN status TYPE "transport_request_status_enum" USING status::"transport_request_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transport_requests" ALTER COLUMN status SET DEFAULT 'CREATED'`,
    );
  }
}
