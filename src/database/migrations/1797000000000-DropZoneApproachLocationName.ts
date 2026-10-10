import type { MigrationInterface, QueryRunner } from 'typeorm';

export class DropZoneApproachLocationName1797000000000 implements MigrationInterface {
  name = 'DropZoneApproachLocationName1797000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE zones
      DROP COLUMN IF EXISTS approach_location_name
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE zones
      ADD COLUMN IF NOT EXISTS approach_location_name VARCHAR(255)
    `);
  }
}
