import type { MigrationInterface, QueryRunner } from 'typeorm';

export class DropDispatchPolicyUrgencyWeight1797000000000 implements MigrationInterface {
  name = 'DropDispatchPolicyUrgencyWeight1797000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE dispatch_policies DROP COLUMN IF EXISTS weight_urgency`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE dispatch_policies
      ADD COLUMN IF NOT EXISTS weight_urgency DOUBLE PRECISION NOT NULL DEFAULT 1.0
    `);
  }
}
