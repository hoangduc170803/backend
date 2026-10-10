import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMapRecordDeletedAt1835000000000 implements MigrationInterface {
  name = 'AddMapRecordDeletedAt1835000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE map_records ADD COLUMN IF NOT EXISTS deleted_at timestamptz`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE map_records DROP COLUMN IF EXISTS deleted_at`,
    );
  }
}
