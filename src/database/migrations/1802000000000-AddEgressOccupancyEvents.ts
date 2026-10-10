import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEgressOccupancyEvents1802000000000 implements MigrationInterface {
  name = 'AddEgressOccupancyEvents1802000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "egress_occupancy_events" (
        "id" BIGSERIAL PRIMARY KEY,
        "vehicle_name" VARCHAR(50) NOT NULL,
        "point_name" VARCHAR(50) NOT NULL,
        "egress_kind" VARCHAR(20) NOT NULL,
        "lane_indexes" JSONB NOT NULL DEFAULT '[]',
        "cells_out_of_lane" INT,
        "zone_id" UUID,
        "zone_name" VARCHAR(255),
        "task_id" UUID,
        "request_code" VARCHAR(50),
        "cargo_id" UUID,
        "item_code" VARCHAR(255),
        "transport_order_name" VARCHAR(120),
        "snapshot" JSONB NOT NULL DEFAULT '{}',
        "entered_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "left_at" TIMESTAMPTZ,
        "dwell_ms" BIGINT,
        "observed_at" TIMESTAMPTZ
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_egress_occupancy_events_vehicle_entered"
      ON "egress_occupancy_events" ("vehicle_name", "entered_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_egress_occupancy_events_still_there"
      ON "egress_occupancy_events" ("entered_at") WHERE "left_at" IS NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_egress_occupancy_events_still_there"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_egress_occupancy_events_vehicle_entered"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "egress_occupancy_events"`);
  }
}
