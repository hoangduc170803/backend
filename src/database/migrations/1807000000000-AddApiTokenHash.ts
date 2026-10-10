import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets a token be either system-generated (JWT, identified by `jti`) or an opaque string an
 * admin pastes in from another system (identified by `token_hash`, a SHA-256 of the raw
 * value — the raw string itself is never stored, same convention as refresh/reset tokens).
 */
export class AddApiTokenHash1807000000000 implements MigrationInterface {
  name = 'AddApiTokenHash1807000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "api_tokens" ALTER COLUMN "jti" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "token_hash" varchar(64)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "api_tokens_token_hash_uq" ON "api_tokens" ("token_hash") WHERE "token_hash" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "api_tokens_token_hash_uq"`);
    await queryRunner.query(
      `ALTER TABLE "api_tokens" DROP COLUMN IF EXISTS "token_hash"`,
    );
    await queryRunner.query(
      `ALTER TABLE "api_tokens" ALTER COLUMN "jti" SET NOT NULL`,
    );
  }
}
