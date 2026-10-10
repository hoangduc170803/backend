import type { MigrationInterface, QueryRunner } from 'typeorm';

export class StoreMapLibraryContent1810000000000 implements MigrationInterface {
  name = 'StoreMapLibraryContent1810000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE map_records
      ADD COLUMN IF NOT EXISTS location_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS block_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS xml_content TEXT,
      ADD COLUMN IF NOT EXISTS preview JSONB,
      ADD COLUMN IF NOT EXISTS last_loaded_at TIMESTAMPTZ
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_map_records_uploaded_at
      ON map_records (uploaded_at DESC)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_map_records_uploaded_at
    `);
    await queryRunner.query(`
      ALTER TABLE map_records
      DROP COLUMN IF EXISTS last_loaded_at,
      DROP COLUMN IF EXISTS preview,
      DROP COLUMN IF EXISTS xml_content,
      DROP COLUMN IF EXISTS block_count,
      DROP COLUMN IF EXISTS location_count
    `);
  }
}
