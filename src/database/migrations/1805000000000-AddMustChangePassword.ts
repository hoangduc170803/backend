import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMustChangePassword1805000000000 implements MigrationInterface {
  name = 'AddMustChangePassword1805000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "must_change_password" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "must_change_password"`,
    );
  }
}
