import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDispatchPolicyBatteryWeight1794000000000 implements MigrationInterface {
  name = 'AddDispatchPolicyBatteryWeight1794000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS dispatch_policies (
        id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name                      VARCHAR(100) NOT NULL,
        weight_urgency            DOUBLE PRECISION NOT NULL DEFAULT 1.0,
        weight_proximity          DOUBLE PRECISION NOT NULL DEFAULT 1.0,
        weight_inventory_position DOUBLE PRECISION NOT NULL DEFAULT 1.0,
        max_agv_per_block         SMALLINT NOT NULL DEFAULT 1,
        is_active                 BOOLEAN NOT NULL DEFAULT FALSE,
        created_by                UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      ALTER TABLE dispatch_policies
      ADD COLUMN IF NOT EXISTS weight_battery DOUBLE PRECISION NOT NULL DEFAULT 0
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_dispatch_policies_single_active
      ON dispatch_policies (is_active)
      WHERE is_active
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS ux_dispatch_policies_single_active`,
    );
    await queryRunner.query(`
      ALTER TABLE dispatch_policies
      DROP COLUMN IF EXISTS weight_battery
    `);
  }
}
