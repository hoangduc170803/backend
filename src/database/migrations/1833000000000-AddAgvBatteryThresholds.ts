import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAgvBatteryThresholds1833000000000 implements MigrationInterface {
  name = 'AddAgvBatteryThresholds1833000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE agvs ADD COLUMN IF NOT EXISTS good_battery_threshold smallint NOT NULL DEFAULT 50`,
    );
    await queryRunner.query(
      `ALTER TABLE agvs ADD COLUMN IF NOT EXISTS full_battery_threshold smallint NOT NULL DEFAULT 95`,
    );
    await queryRunner.query(`
      UPDATE agvs
      SET sufficient_battery_threshold = LEAST(critical_battery_threshold + 1, 100)
      WHERE sufficient_battery_threshold <= critical_battery_threshold
    `);
    await queryRunner.query(`
      UPDATE agvs
      SET good_battery_threshold = critical_battery_threshold
      WHERE good_battery_threshold < critical_battery_threshold
    `);
    await queryRunner.query(`
      UPDATE agvs
      SET full_battery_threshold = sufficient_battery_threshold
      WHERE full_battery_threshold < sufficient_battery_threshold
    `);
    await queryRunner.query(`
      ALTER TABLE agvs
      ADD CONSTRAINT chk_agvs_battery_thresholds CHECK (
        critical_battery_threshold >= 0
        AND full_battery_threshold <= 100
        AND critical_battery_threshold < sufficient_battery_threshold
        AND sufficient_battery_threshold <= full_battery_threshold
        AND critical_battery_threshold <= good_battery_threshold
        AND good_battery_threshold <= 100
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE agvs DROP CONSTRAINT IF EXISTS chk_agvs_battery_thresholds`,
    );
    await queryRunner.query(
      `ALTER TABLE agvs DROP COLUMN IF EXISTS full_battery_threshold`,
    );
    await queryRunner.query(
      `ALTER TABLE agvs DROP COLUMN IF EXISTS good_battery_threshold`,
    );
  }
}
