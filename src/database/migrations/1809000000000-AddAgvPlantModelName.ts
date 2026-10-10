import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAgvPlantModelName1809000000000 implements MigrationInterface {
  name = 'AddAgvPlantModelName1809000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE agvs
      ADD COLUMN IF NOT EXISTS plant_model_name VARCHAR(255)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_agvs_plant_model_name
      ON agvs (plant_model_name)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_agvs_plant_model_name
    `);
    await queryRunner.query(`
      ALTER TABLE agvs
      DROP COLUMN IF EXISTS plant_model_name
    `);
  }
}
