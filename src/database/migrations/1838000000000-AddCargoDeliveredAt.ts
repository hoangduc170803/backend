import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCargoDeliveredAt1838000000000 implements MigrationInterface {
  name = 'AddCargoDeliveredAt1838000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE cargos ADD COLUMN IF NOT EXISTS delivered_at timestamptz`,
    );
    await queryRunner.query(`
      UPDATE cargos AS cargo
      SET delivered_at = delivery.completed_at
      FROM (
        SELECT task.cargo_id, MAX(COALESCE(task.completed_at, task.updated_at)) AS completed_at
        FROM transport_requests task
        WHERE task.cargo_id IS NOT NULL
          AND task.status = 'DELIVERY_COMPLETED'
        GROUP BY task.cargo_id
      ) AS delivery
      WHERE delivery.cargo_id = cargo.id
        AND cargo.delivered_at IS NULL
        AND cargo.status IN ('DELIVERED', 'CANCELLED')
    `);
    await queryRunner.query(`
      UPDATE cargos
      SET delivered_at = updated_at
      WHERE status = 'DELIVERED' AND delivered_at IS NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE cargos DROP COLUMN IF EXISTS delivered_at`,
    );
  }
}
