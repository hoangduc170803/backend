import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPasswordChangedAt1806000000000 implements MigrationInterface {
  name = 'AddPasswordChangedAt1806000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_changed_at" timestamptz NOT NULL DEFAULT now()`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "password_changed_at"`,
    );
  }
}
