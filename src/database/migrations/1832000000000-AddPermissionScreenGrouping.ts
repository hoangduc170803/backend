import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The role editor lists permissions per left-nav screen and per section of that screen, and
 * nests keys under a parent key (a key is effective only while its ancestors are granted). It
 * also distinguishes server-enforced actions from client-side visibility keys (screens, UI gestures,
 * dock columns). The catalogue rows themselves are still upserted at boot by
 * `PermissionCatalogueService`; this migration only shapes the columns.
 */
export class AddPermissionScreenGrouping1832000000000 implements MigrationInterface {
  name = 'AddPermissionScreenGrouping1832000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE permissions
        ADD COLUMN IF NOT EXISTS screen varchar(32) NOT NULL DEFAULT 'system',
        ADD COLUMN IF NOT EXISTS group_key varchar(48) NOT NULL DEFAULT 'actions',
        ADD COLUMN IF NOT EXISTS kind varchar(16) NOT NULL DEFAULT 'action',
        ADD COLUMN IF NOT EXISTS parent_key varchar(64) NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE permissions
        DROP COLUMN IF EXISTS parent_key,
        DROP COLUMN IF EXISTS kind,
        DROP COLUMN IF EXISTS group_key,
        DROP COLUMN IF EXISTS screen
    `);
  }
}
