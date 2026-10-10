import { MigrationInterface, QueryRunner } from 'typeorm';

export class IndexTransportOrderEndedAt1837000000000 implements MigrationInterface {
  name = 'IndexTransportOrderEndedAt1837000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_transport_request_orders_ended ON transport_request_orders (ended_at DESC) WHERE ended_at IS NOT NULL`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_transport_request_orders_ended`,
    );
  }
}
