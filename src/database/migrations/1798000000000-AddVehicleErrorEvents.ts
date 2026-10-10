import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVehicleErrorEvents1798000000000 implements MigrationInterface {
  name = 'AddVehicleErrorEvents1798000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "vehicle_error_events" (
        "id" BIGSERIAL PRIMARY KEY,
        "vehicle_name" VARCHAR(50) NOT NULL,
        "kind" VARCHAR(30) NOT NULL,
        "fatal_error_types" JSONB NOT NULL DEFAULT '[]',
        "warning_error_types" JSONB NOT NULL DEFAULT '[]',
        "vehicle_state" VARCHAR(30) NOT NULL,
        "point_name" VARCHAR(50),
        "transport_order_name" VARCHAR(80),
        "metadata" JSONB NOT NULL DEFAULT '{}',
        "occurred_at" TIMESTAMPTZ NOT NULL,
        "observed_at" TIMESTAMPTZ
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_vehicle_error_events_vehicle_occurred"
      ON "vehicle_error_events" ("vehicle_name", "occurred_at")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_vehicle_error_events_vehicle_occurred"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "vehicle_error_events"`);
  }
}
