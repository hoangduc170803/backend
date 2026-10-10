import { MigrationInterface, QueryRunner } from 'typeorm';

export class RaiseDefaultCriticalBattery1834000000000 implements MigrationInterface {
  name = 'RaiseDefaultCriticalBattery1834000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE agvs ALTER COLUMN critical_battery_threshold SET DEFAULT 35`,
    );
    await queryRunner.query(`
      UPDATE agvs
      SET critical_battery_threshold = 35,
          good_battery_threshold = GREATEST(good_battery_threshold, 35),
          sufficient_battery_threshold = GREATEST(sufficient_battery_threshold, 36),
          full_battery_threshold = GREATEST(
            full_battery_threshold,
            GREATEST(sufficient_battery_threshold, 36)
          )
      WHERE critical_battery_threshold = 20
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE agvs ALTER COLUMN critical_battery_threshold SET DEFAULT 20`,
    );
  }
}
