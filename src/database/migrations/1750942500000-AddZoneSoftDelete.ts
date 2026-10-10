import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddZoneSoftDelete1750942500000 implements MigrationInterface {
  name = 'AddZoneSoftDelete1750942500000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE zones
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_zones_deleted_at
      ON zones(deleted_at)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_zones_deleted_at
    `);

    await queryRunner.query(`
      ALTER TABLE zones
      DROP COLUMN IF EXISTS deleted_at
    `);
  }
}
