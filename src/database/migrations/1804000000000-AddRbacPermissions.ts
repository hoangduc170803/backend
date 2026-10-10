import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Dynamic RBAC: a `permissions` catalogue, freely-composed `roles` (detached from the
 * `user_role_enum`), a `role_permissions` matrix, plus `api_tokens` for permanent tokens.
 * Permission rows and the baseline grants for the system roles are seeded at boot by
 * `PermissionCatalogueService`, not here — this migration only shapes the schema and adds
 * the `viewer` system role.
 */
export class AddRbacPermissions1804000000000 implements MigrationInterface {
  name = 'AddRbacPermissions1804000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "permissions" (
        "key"          varchar(64) PRIMARY KEY,
        "cluster"      varchar(32) NOT NULL,
        "is_dangerous" boolean NOT NULL DEFAULT false,
        "sort"         int NOT NULL DEFAULT 0,
        "label_vi"     varchar(160),
        "label_en"     varchar(160),
        "label_ja"     varchar(160)
      )
    `);

    // Detach roles.name from the user_role_enum so role names can be arbitrary.
    await queryRunner.query(
      `ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "key" varchar(48)`,
    );
    await queryRunner.query(
      `ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "is_system" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "created_at" timestamptz NOT NULL DEFAULT now()`,
    );
    await queryRunner.query(
      `ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now()`,
    );
    await queryRunner.query(
      `ALTER TABLE "roles" ALTER COLUMN "name" TYPE varchar(64) USING "name"::text`,
    );
    await queryRunner.query(
      `UPDATE "roles" SET "key" = lower("name") WHERE "key" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "roles" SET "is_system" = true WHERE "key" IN ('admin', 'operator', 'viewer')`,
    );
    await queryRunner.query(
      `UPDATE "roles" SET "name" = 'Quản trị viên' WHERE "key" = 'admin'`,
    );
    await queryRunner.query(
      `UPDATE "roles" SET "name" = 'Điều hành viên' WHERE "key" = 'operator'`,
    );
    await queryRunner.query(
      `ALTER TABLE "roles" ALTER COLUMN "key" SET NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "roles_key_uq" ON "roles" ("key")`,
    );

    await queryRunner.query(`
      INSERT INTO "roles" ("name", "key", "description", "is_system")
      VALUES ('Người xem', 'viewer', 'Chỉ xem, không thao tác vận hành', true)
      ON CONFLICT ("key") DO NOTHING
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "role_permissions" (
        "role_id"        smallint NOT NULL REFERENCES "roles" ("id") ON DELETE CASCADE,
        "permission_key" varchar(64) NOT NULL REFERENCES "permissions" ("key") ON DELETE CASCADE,
        PRIMARY KEY ("role_id", "permission_key")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "api_tokens" (
        "id"           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "user_id"      uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
        "jti"          uuid NOT NULL UNIQUE,
        "label"        varchar(120),
        "created_by"   uuid,
        "created_at"   timestamptz NOT NULL DEFAULT now(),
        "last_used_at" timestamptz,
        "revoked_at"   timestamptz
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "api_tokens_user_idx" ON "api_tokens" ("user_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "api_tokens"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "role_permissions"`);
    await queryRunner.query(`DELETE FROM "roles" WHERE "key" = 'viewer'`);
    await queryRunner.query(`DROP INDEX IF EXISTS "roles_key_uq"`);
    await queryRunner.query(
      `ALTER TABLE "roles" DROP COLUMN IF EXISTS "updated_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "roles" DROP COLUMN IF EXISTS "created_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "roles" DROP COLUMN IF EXISTS "is_system"`,
    );
    await queryRunner.query(`ALTER TABLE "roles" DROP COLUMN IF EXISTS "key"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "permissions"`);
  }
}
