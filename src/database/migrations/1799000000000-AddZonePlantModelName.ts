import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddZonePlantModelName1799000000000 implements MigrationInterface {
  name = 'AddZonePlantModelName1799000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE zones
      ADD COLUMN IF NOT EXISTS plant_model_name VARCHAR(255)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_zones_plant_model_name
      ON zones (plant_model_name)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_zones_plant_model_name
    `);
    await queryRunner.query(`
      ALTER TABLE zones
      DROP COLUMN IF EXISTS plant_model_name
    `);
  }
}
