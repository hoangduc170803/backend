import { MigrationInterface, QueryRunner } from 'typeorm';

export class ScopeAgvUniquenessToMapRecord1828000000000 implements MigrationInterface {
  name = 'ScopeAgvUniquenessToMapRecord1828000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_agvs_code_plant_model_name`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_agvs_code_map_record
        ON agvs (code, map_record_id)
        WHERE map_record_id IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_agvs_name_map_record
        ON agvs (name, map_record_id)
        WHERE map_record_id IS NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_agvs_name_map_record`);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_agvs_code_map_record`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agvs_code_plant_model_name
        ON agvs (code, plant_model_name)
    `);
  }
}
