import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddZoneKernelId1750000000000 implements MigrationInterface {
  name = 'AddZoneKernelId1750000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE SEQUENCE IF NOT EXISTS zone_kernel_id_seq START 1`,
    );

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE zone_type_enum AS ENUM ('PICKUP', 'DROPOFF');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE zone_status_enum AS ENUM ('ACTIVE', 'STALE');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS zones (
        id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name                   VARCHAR(255) NOT NULL,
        type                   zone_type_enum NOT NULL,
        kernel_id              INTEGER UNIQUE,
        approach_location_name VARCHAR(255),
        status                 zone_status_enum NOT NULL DEFAULT 'ACTIVE',
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(
      `ALTER TABLE zones ADD COLUMN IF NOT EXISTS kernel_id INTEGER UNIQUE`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS zone_members (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        zone_id        UUID NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
        location_name  VARCHAR(255) NOT NULL,
        position_index INT NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (zone_id, location_name),
        UNIQUE (zone_id, position_index)
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_zone_members_zone_id ON zone_members(zone_id)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_zone_members_zone_id`);
    await queryRunner.query(`DROP TABLE IF EXISTS zone_members`);
    await queryRunner.query(`DROP TABLE IF EXISTS zones`);
    await queryRunner.query(`DROP TYPE IF EXISTS zone_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS zone_type_enum`);
    await queryRunner.query(`DROP SEQUENCE IF EXISTS zone_kernel_id_seq`);
  }
}
