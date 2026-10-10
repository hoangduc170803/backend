import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSessionIdToRefreshTokens1808000000000 implements MigrationInterface {
  name = 'AddSessionIdToRefreshTokens1808000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "session_id" uuid NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" DROP COLUMN IF EXISTS "session_id"`,
    );
  }
}
