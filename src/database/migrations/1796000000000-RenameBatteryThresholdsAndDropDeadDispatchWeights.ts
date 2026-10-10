import type { MigrationInterface, QueryRunner } from 'typeorm';

export class RenameBatteryThresholdsAndDropDeadDispatchWeights1796000000000 implements MigrationInterface {
  name = 'RenameBatteryThresholdsAndDropDeadDispatchWeights1796000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'agvs' AND column_name = 'operational_battery_threshold') THEN
          ALTER TABLE agvs RENAME COLUMN operational_battery_threshold TO critical_battery_threshold;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'agvs' AND column_name = 'charging_battery_threshold') THEN
          ALTER TABLE agvs RENAME COLUMN charging_battery_threshold TO sufficient_battery_threshold;
        END IF;
      END $$;
    `);
    await queryRunner.query(
      `ALTER TABLE agvs ALTER COLUMN sufficient_battery_threshold SET DEFAULT 60`,
    );
    await queryRunner.query(
      `UPDATE agvs SET sufficient_battery_threshold = 60`,
    );
    await queryRunner.query(
      `ALTER TABLE dispatch_policies DROP COLUMN IF EXISTS weight_proximity`,
    );
    await queryRunner.query(
      `ALTER TABLE dispatch_policies DROP COLUMN IF EXISTS weight_inventory_position`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE dispatch_policies
      ADD COLUMN IF NOT EXISTS weight_proximity DOUBLE PRECISION NOT NULL DEFAULT 1.0
    `);
    await queryRunner.query(`
      ALTER TABLE dispatch_policies
      ADD COLUMN IF NOT EXISTS weight_inventory_position DOUBLE PRECISION NOT NULL DEFAULT 1.0
    `);
    await queryRunner.query(
      `ALTER TABLE agvs ALTER COLUMN sufficient_battery_threshold SET DEFAULT 10`,
    );
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'agvs' AND column_name = 'sufficient_battery_threshold') THEN
          ALTER TABLE agvs RENAME COLUMN sufficient_battery_threshold TO charging_battery_threshold;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'agvs' AND column_name = 'critical_battery_threshold') THEN
          ALTER TABLE agvs RENAME COLUMN critical_battery_threshold TO operational_battery_threshold;
        END IF;
      END $$;
    `);
  }
}
