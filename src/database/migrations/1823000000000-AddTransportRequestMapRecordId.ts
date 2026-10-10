import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTransportRequestMapRecordId1823000000000 implements MigrationInterface {
  name = 'AddTransportRequestMapRecordId1823000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE transport_requests ADD COLUMN IF NOT EXISTS map_record_id uuid NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_transport_requests_map_status ON transport_requests (map_record_id, status)`,
    );
    await queryRunner.query(`
      ALTER TABLE transport_requests
      ADD CONSTRAINT fk_transport_requests_map_record_id
      FOREIGN KEY (map_record_id) REFERENCES map_records(id) ON DELETE SET NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE transport_requests DROP CONSTRAINT IF EXISTS fk_transport_requests_map_record_id`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_transport_requests_map_status`,
    );
    await queryRunner.query(
      `ALTER TABLE transport_requests DROP COLUMN IF EXISTS map_record_id`,
    );
  }
}
