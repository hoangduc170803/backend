import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ScopeAgvCodeUniquenessToMap1811000000000 implements MigrationInterface {
  name = 'ScopeAgvCodeUniquenessToMap1811000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE agvs
      DROP CONSTRAINT IF EXISTS agvs_code_key
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agvs_code_plant_model_name
      ON agvs (code, plant_model_name)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_agvs_code_plant_model_name
    `);
    await queryRunner.query(`
      ALTER TABLE agvs
      ADD CONSTRAINT agvs_code_key UNIQUE (code)
    `);
  }
}
